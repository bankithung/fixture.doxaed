# Security Audit: frontend/src/features/orgs — Frontend Security Lens

**Date:** 2026-06-04
**Auditor:** Claude Code (automated static analysis)
**Scope:** `frontend/src/features/orgs/**` (all .tsx/.ts files)
**Lens:** dangerouslySetInnerHTML/XSS, sensitive data in localStorage, missing CSRF header on mutations, open redirects, UI-only authorization

---

## Summary

7 findings across the scope. No `dangerouslySetInnerHTML` usage was found anywhere in the feature folder or the wider frontend src. No `localStorage`/`sessionStorage` usage was found. CSRF is handled centrally and correctly by `api/client.ts` for all unsafe HTTP verbs. The main concerns are: (1) a high-severity client-side-only authorization bypass on the member-remove action, (2) a medium-severity server-side `detail` string reflected verbatim in the UI without sanitization, (3) a medium-severity UI-only authz gate on org branding fetch, (4) a medium-severity missing `encodeURIComponent` on `orgSlug` in URL-template fetch paths, (5) a low-severity information-disclosure risk from verbatim `e.payload.detail` in the ownership transfer error, and two gaps.

---

## Findings

---

### F-01 — UI-only authorization on member remove action (high)

**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:317–325`

**Evidence:**
```tsx
const onRemove = (m: OrgMember): void => {
  const displayName = m.full_name?.trim() || m.email;
  if (
    typeof window !== "undefined" &&
    !window.confirm(t(`Remove ${displayName} from this organization?`))
  ) {
    return;
  }
  removeMember.mutate(m);
};
```

`canManage` is computed (line 272) from the client-side auth-store membership object:
```tsx
const isAdminish =
  Boolean(membership?.is_org_owner) ||
  (membership?.roles ?? []).some((r) => r === "admin");
const canManage = isAdminish || effectiveModules.has(ADMIN_MODULE);
```

The "Remove member" button is conditionally rendered only when `canManage && !isOwner` (line 144), but the underlying `removeMember.mutate` call itself is not protected by any server-side re-check at the call site. The `window.confirm` is the only user-facing gate at trigger time. Any user who can reach the page and craft a call (e.g., by manipulating local state or calling the API directly) would skip the client-side guard entirely.

**Why it matters:** The client-side `canManage` flag is derived from the `/me` session payload. An attacker who modifies local Zustand state (trivially possible in a browser devtool or by replaying a request with a stolen session) could send `DELETE /api/orgs/{uuid}/members/{id}/` for any membership ID they can enumerate. The backend `IsOrgAdminOrOwner` permission class on `OrgDetailView` is the real gate — but the UI provides false assurance, and there is no evidence that `removeMember` checks `canManage` before calling the API.

**Recommendation:** Confirm `IsOrgAdminOrOwner` (or equivalent) is enforced on `DELETE /api/orgs/{org_uuid}/members/{membership_id}/` server-side (it appears to be — `OrgDetailView` uses `IsAuthenticated` + `IsOrgMember` permission classes). Add a comment to `onRemove` noting that the server enforces RBAC independently. Consider removing the `window.confirm` (a blocking native dialog) and replacing it with a modal confirmation component — `window.confirm` is blocked in some environments and is an a11y anti-pattern. Confidence: high.

---

### F-02 — `orgSlug` interpolated directly into fetch URL without encoding (medium)

**Files:**
- `frontend/src/features/orgs/OrgSettingsPage.tsx:158`
- `frontend/src/features/orgs/OrgBrandingPage.tsx:116`
- `frontend/src/api/orgs.ts:72,74,79,81,109`

**Evidence (OrgSettingsPage.tsx:158):**
```tsx
queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
```

**Evidence (api/orgs.ts:72):**
```ts
members: (slug: string) =>
  api.get<MembersResponse>(`/api/orgs/${slug}/members/`),
```

`orgSlug` originates from `useParams<{ orgSlug: string }>()` (React Router URL parameter). React Router decodes the path segment, so a slug containing special characters like `/` or `#` would be re-injected raw into the fetch URL template string. For example, a crafted URL `/o/foo%2Fbar/settings` would produce `orgSlug = "foo/bar"` after decoding, which would turn into a fetch to `/api/orgs/foo/bar/` — a path traversal that could hit an unintended route.

**Why it matters:** While Django's URL routing will likely 404 on unexpected paths, this is an unintended path that bypasses the intended slug-only lookup. Combined with `routes.orgDashboard` using `encodeURIComponent(slug)` but the fetch paths not encoding the slug, there is an asymmetry. The backend is the last line of defense, but path-traversal via slug should be blocked at the client boundary too.

**Recommendation:** Wrap slug interpolations in `encodeURIComponent` in both `OrgSettingsPage.tsx` and `api/orgs.ts`. Example: `api.get(\`/api/orgs/${encodeURIComponent(orgSlug)}/\`)`. The `routes.*` helpers already do this for navigation (e.g., `routes.orgDashboard` uses `encodeURIComponent`). Apply the same convention to API path construction. Confidence: medium (depends on whether React Router fully decodes encoded slashes, which is environment-specific).

---

### F-03 — Raw server `e.payload.detail` string rendered in DOM without sanitization (medium)

**Files:**
- `frontend/src/features/orgs/OrgAuditLogPage.tsx:135`
- `frontend/src/features/orgs/OrgSettingsPage.tsx:201`
- `frontend/src/features/orgs/InviteAcceptPage.tsx:54`
- `frontend/src/features/orgs/InviteCreateModal.tsx:112`
- `frontend/src/features/orgs/OwnershipTransferModal.tsx:74`

**Evidence (OrgAuditLogPage.tsx:134–136):**
```tsx
<CardDescription>
  {query.error.payload.detail ?? t("Try refreshing the page.")}
</CardDescription>
```

The `payload.detail` value is a string from the server's JSON error response rendered directly as a React child. React does escape content placed in JSX text nodes (no `dangerouslySetInnerHTML` is used), so stored-XSS via this path is not possible. However, the raw server string may contain internal implementation details, stack traces, or sensitive model identifiers (e.g., "No Organization matching query {'id': 'xxx', 'deleted_at__isnull': True}" — a Django-style error detail). This is an information-disclosure risk.

**Why it matters:** A misconfigured Django `DEBUG=True` in a staging environment, or a backend bug that leaks a DB query detail in `detail`, would surface it verbatim to the user. The pattern is consistent across all 5 files in the orgs feature, making it a systemic concern.

**Recommendation:** Normalize server error strings through a frontend helper that maps known `code` values to user-friendly messages, only falling back to `payload.detail` for explicitly whitelisted error codes. Alternatively, ensure the backend never emits implementation-detail strings in `detail` (strict API error normalization in DRF). At minimum, add a max-length truncation before display. Confidence: high.

---

### F-04 — UI-only authz gate on OrgBrandingPage query (medium)

**File:** `frontend/src/features/orgs/OrgBrandingPage.tsx:111–118`

**Evidence:**
```tsx
const canEdit =
  isOrgOwner || isAdminish || effectiveModules.has(REQUIRED_MODULE);

const orgQuery = useQuery({
  queryKey: ["org", orgSlug, "detail"],
  queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
  enabled: Boolean(orgSlug) && canEdit,
});
```

The `enabled: canEdit` gate prevents the query from running if `canEdit` is false at load time. However, `canEdit` is derived entirely from the client-side Zustand auth store. If an attacker manipulates the local auth state to set `is_org_owner: true` or adds a role, the `useQuery` will fire. The server's `GET /api/orgs/{slug}/` is protected by `IsAuthenticated + IsOrgMember` (visible in `OrgDetailView`), so the server will reject a request from a user who is not actually a member. But the pattern of `enabled: canEdit` gives a false sense of security — it is not a substitute for a server-side authz check.

**Why it matters:** All org fetch pages (OrgSettingsPage, OrgBrandingPage) follow this pattern. If any of the data fetched were more sensitive than organization name/slug/timezone, client-side gating would be insufficient. The server guards are correct; the client-side gate is a performance optimization but should not be documented or relied upon as a security boundary.

**Recommendation:** Add a code comment at each `enabled: canEdit` line: "This is a UX optimization, not a security gate. The server enforces IsOrgMember independently." Consider adding a test that verifies a non-member GET returns 403 from the server regardless of what the client sends. Confidence: high (pattern risk, not an active exploit, given server-side enforcement).

---

### F-05 — `window.confirm` blocks UI thread and fails in headless/programmatic contexts (low)

**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:318–325`

**Evidence:**
```tsx
if (
  typeof window !== "undefined" &&
  !window.confirm(t(`Remove ${displayName} from this organization?`))
) {
  return;
}
```

`window.confirm` is a synchronous, blocking native browser dialog. It is suppressed in cross-origin iframes (returns `true` immediately, which would **bypass** the guard and trigger the remove without user consent), and it fails silently in some automated test environments.

**Why it matters:** In a cross-origin iframe context (e.g., if the platform is ever embedded), `window.confirm` returns `false` by default in some browsers but `true` in others, making the guard unreliable. More critically, if `window.confirm` returns `true` (as it does in some headless environments), the remove fires without user confirmation.

**Recommendation:** Replace `window.confirm` with an accessible modal confirmation dialog (already have `Dialog` from `@/components/ui/dialog`). Confidence: high.

---

### F-06 — Invitation token exposed in share link via `window.location.origin` (low / info)

**Files:**
- `frontend/src/features/orgs/InviteCreateModal.tsx:64–69`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:35–40`

**Evidence (InviteCreateModal.tsx:64–69):**
```ts
function shareLinkFor(token: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  return `${origin}/accept?token=${encodeURIComponent(token)}`;
}
```

The invitation token is a one-shot secret surfaced as a full URL share link in the UI. The token itself is `encodeURIComponent`-encoded correctly. However, the share link is displayed in a read-only `<Input>` element that auto-selects on focus (via `onFocus={(e) => e.currentTarget.select()}`), which means browsers may auto-complete or suggest these values from history. Additionally, the link is stored in the TanStack Query cache (as part of the `OrgInvitation` object) until the query is invalidated, which could persist it in memory for the session duration.

**Why it matters:** One-shot tokens should be minimally exposed. The comment in `InvitationListItem` correctly notes "Token is only ever returned at creation, never on list responses." The implementation respects this. The risk is browser autocomplete leaking the token value. This is low severity given the one-shot nature, but worth documenting.

**Recommendation:** Add `autoComplete="off"` to the token `<Input>` field in `CopyField`. Consider clearing the `sent` state (and thus the token from the React tree) when the modal is closed via the "Done" button, rather than relying solely on `open` state reset. Confidence: medium.

---

### F-07 — `?next=` parameter in InviteAcceptPage does not use `safeNext` validation (low)

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:76`

**Evidence:**
```tsx
to={`${routes.login()}?next=${encodeURIComponent(`/accept?token=${token}`)}`}
```

`LoginPage` has a `safeNext` function (LoginPage.tsx:29–33) that validates the `next` parameter:
```ts
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}
```

The value constructed by `InviteAcceptPage` (`/accept?token=...`) starts with `/` and does not start with `//`, so it passes validation. The `token` itself comes from `params.get("token")` — a user-controlled query parameter. If a malicious invite link were crafted with `token=<payload>`, the `encodeURIComponent` wrapping ensures the token value does not escape the `next=` parameter value. So this is correctly handled end-to-end. However, the construction pattern is non-obvious and should be tested explicitly.

**Why it matters:** The existing test at `LoginPage.test.tsx:129` covers `?next=https://evil.example.com/x` but does not cover a crafted token value in the invite flow. If `safeNext` were removed or weakened in a future refactor, this path could become an open redirect.

**Recommendation:** Add an explicit test that verifies `LoginPage` with `?next=/accept?token=malicious_token_value` strips or safely handles the token. Also add a test verifying that `?next=//evil.example.com` is rejected even when embedded within the invite flow. Confidence: medium.

---

## Not Found (Clean)

- **`dangerouslySetInnerHTML`:** Zero occurrences in `frontend/src/features/orgs/` and across all of `frontend/src/`.
- **`localStorage` / `sessionStorage`:** Zero occurrences anywhere in `frontend/src/`. Auth state is in Zustand in-memory store only; no persistence to web storage.
- **CSRF header missing on mutations:** The `api/client.ts` wrapper attaches `X-CSRFToken` on all `POST`, `PUT`, `PATCH`, and `DELETE` verbs via `getCsrfToken()` reading the `csrftoken` Django cookie. Backend sets `CSRF_COOKIE_HTTPONLY = False` explicitly to allow JS reads. `CSRF_COOKIE_SAMESITE` is not explicitly set but Django defaults to `"Lax"`, which is correct for same-origin SPA patterns. All org mutations (invitations, revoke, remove member, settings patch, ownership transfer) go through this wrapper.
- **Open redirects via `window.location.*`:** The only `window.location` usages are `window.location.origin` for constructing share links (not redirects). Post-invite redirect goes through `navigate(routes.orgDashboard(orgSlug))` using the server-returned `org_slug` — not a user-supplied URL.
- **Raw `innerHTML` / `document.write` / `eval()`:** None found.

---

## Gaps (Forward-looking)

### G-01 — No test asserting server-side authz on member remove independent of client gate

**Missing:** A backend integration test asserting that `DELETE /api/orgs/{uuid}/members/{id}/` returns 403 when called by a non-admin authenticated user, even if that user is a member of the org. This is the server-side wall behind F-01. The client-side `canManage` gate is a UX optimization; without this test, a regression in the Django permission class would go undetected.

**Effort:** S. **Blocking:** No (Phase 1A RBAC tests likely cover this partially).

### G-02 — No CSP (Content Security Policy) header in place

**Missing:** `frontend/` and `backend/fixture/settings/` have no Content-Security-Policy header configuration. Without CSP, any future `dangerouslySetInnerHTML` or injected script (from a third-party library) would have unrestricted execution. The platform is currently clean (finding: no `dangerouslySetInnerHTML` anywhere), but CSP provides defense-in-depth.

**Effort:** M. **Blocking:** No (XSS is not currently possible; add before production hardening).
