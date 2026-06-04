# Security Audit: fe-permissions (Frontend Security Lens)

**Date:** 2026-06-04
**Scope:** `frontend/src/features/permissions/` and all code directly supporting it (api/permissions.ts, api/client.ts, lib/csrf.ts, lib/routes.ts, features/layout/ProtectedRoute.tsx, features/layout/computeNavItems.ts, features/auth/LoginPage.tsx — read in full)
**Lens:** dangerouslySetInnerHTML/XSS · sensitive data in localStorage · missing CSRF header on mutations · open redirects · UI-only authz

---

## Findings

### F-01 — MEDIUM — UI-only conflict-of-interest gate (no backend enforcement)

**File:** `frontend/src/features/permissions/ConflictOfInterestBanner.tsx` (entire component)
**Also:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:61,80-83`
**Backend:** `backend/apps/organizations/serializers.py:99` · `backend/apps/organizations/services/ownership.py` (entire file)

**Evidence (frontend):**
```tsx
// OwnershipTransferModal.tsx:80-83
const blocked =
  !toUserId ||
  reason.trim().length < 8 ||
  (conflictDetected && !conflictAck);
```
The `blocked` flag is the only barrier preventing the transfer mutation from firing when `conflictDetected` is true. A user can bypass the checkbox gate entirely by calling the API directly (curl/fetch) because:

**Evidence (backend):**
```python
# serializers.py:99
conflict_acknowledged = serializers.BooleanField(required=False)
```
The field is `required=False` and is accepted by the serializer but is **never read, validated, or logged** anywhere in `ownership_svc.transfer_ownership()` (see `backend/apps/organizations/services/ownership.py` — the function signature does not accept `conflict_acknowledged` at all, and the views at lines 332 and 651 do not pass it to the service). The spec says the platform "logs the acknowledgement to AuditEvent" but the audit emission at `ownership.py:99` writes a hard-coded `reason="ownership transfer"` with no reference to conflict status.

**Why it matters:** The conflict-of-interest acknowledgement provides no actual authz control — it is pure theatre. Any user with org-owner permission (correctly required by `IsOrgOwner`) can skip the banner entirely. This is flagged as a **UI-only authz** finding; the spec (v1Users.md Appendix B.22) says the acknowledgement is "logged to AuditEvent" — that logging does not happen.

**Recommendation:** In `ownership_svc.transfer_ownership()`, accept and pass through `conflict_acknowledged: bool | None`. In the view, read `ser.validated_data.get("conflict_acknowledged")` and pass it. In `emit_audit`, include it in `payload_after`. If policy intent is to block transfer when conflict is detected but not acknowledged, add a server-side `ValidationError` on that path. At minimum, the audit payload must record the flag so the log is accurate.

---

### F-02 — MEDIUM — UI-only authz gate on Permissions nav item (role check mirrors backend but relies on stale /me/ data)

**File:** `frontend/src/features/layout/computeNavItems.ts:61-67`

**Evidence:**
```ts
const canManagePermissions =
  roles.includes("admin") || isOrgOwner;
```

The nav-item visibility check is client-side only, computed from `user.memberships[]` fetched at login. If a user's role is downgraded server-side (e.g. admin → co_organizer) while their session is active, the nav item remains visible because the stale `User` object in Zustand still shows `roles: ["admin"]`. The backend correctly gates `MatrixView` with `IsOrgAdminOrOwner`, so the _data_ is protected. However:

1. The stale role data means the "Permissions" nav link stays visible after demotion until the next page refresh / `/me` re-fetch.
2. More critically: `effective_modules` in the cached `User` object drives ALL module-gated items throughout the shell. A module revocation on the server is not reflected until `refreshMe()` is called — there is no proactive TTL on the `/me` query beyond TanStack's `staleTime: 30_000` (30 s) which only triggers on re-focus (disabled: `refetchOnWindowFocus: false`).

**Why it matters:** A user whose permissions are revoked can navigate to gated surfaces (they receive a correct 403 from the backend) but the nav chrome keeps showing the now-disallowed items for the duration of the session. Not a data leak (backend enforces), but a UX-deceptive inconsistency. The stale effective_modules window is unlimited until the tab is refreshed.

**Recommendation:** Set `refetchOnWindowFocus: true` for the auth bootstrap query, or call `refreshMe()` on the `queryClient` error bus when a 403 from a gated route is received (type `"forbidden"`). Also ensure `computeNavItems` re-runs every time the store updates (it already does — Zustand selector means it re-renders on store change — but the _data_ must be fresh).

---

### F-03 — LOW — `?next=` redirect validated, but double-slash bypass pattern should be hardened

**File:** `frontend/src/features/auth/LoginPage.tsx:28-33`

**Evidence:**
```ts
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}
```

The guard correctly rejects absolute URLs and protocol-relative `//` redirects. However it does not normalise path-traversal sequences (e.g. `?next=/.\\/evil.com` or `?next=%2F%2Fevil.com`). React Router's `navigate()` will pass the raw string to `history.pushState`. In all tested modern browsers the path traversal patterns are treated as same-origin paths, so this is currently not exploitable in practice. However the guard should be defence-in-depth.

**Why it matters:** Low confidence of exploit given React Router's same-origin navigation, but the decode of `%2F%2F` (yielding `//evil.com`) is not caught. `decodeURIComponent("?next=%2F%2Fevil.com")` = `//?next=//evil.com` — browsers would navigate to `evil.com`. The `encodeURIComponent` in `ProtectedRoute.tsx:47` mitigates this on the _encoding_ side, but a manually crafted URL still reaches `safeNext` with a decoded string via `useSearchParams`.

**Recommendation:** After the `//` check, also reject strings that contain `://` after URL-decoding, or normalize with `new URL(raw, location.origin).pathname` and compare origins.

---

### F-04 — INFO — `Math.random()` fallback for `event_id` in ModuleMatrixPage (non-cryptographic)

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:24-28`
**Also:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:30-33` (same pattern)

**Evidence:**
```ts
function newEventId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ev_${Math.random().toString(36).slice(2)}`;
}
```

The `event_id` is used as an idempotency key at the backend (Invariant #3). The fallback uses `Math.random()` which is not cryptographically random and could produce collisions under load. In all modern SPA browsers `crypto.randomUUID()` is always available, so this path is dead code in practice — but it should not exist as a silent fallback because:
- In SSR or test environments the fallback fires silently.
- A collision causes the backend to return the first response (200 with stale data) and silently discard the new mutation.

**Why it matters:** Info severity — `crypto.randomUUID` is universally available in target browsers and the fallback is unreachable in production. However, idempotency-key collisions caused by a predictable Math.random PRNG could be a correctness/security issue in non-browser contexts.

**Recommendation:** Remove the fallback; throw an explicit error if `crypto.randomUUID` is unavailable so the failure is visible rather than silent.

---

### F-05 — INFO — No dangerouslySetInnerHTML, innerHTML, eval(), or document.write found

**Files:** All TSX/TS files under `frontend/src/features/permissions/` and their dependency chain.

**Evidence:** Full grep across the feature area and api/client.ts, lib/* returned zero matches. User-supplied strings (`row.user_full_name`, `row.user_email`, `m.label`, `m.description`) are interpolated as React children (JSX text nodes), not rendered as HTML. React escapes these automatically.

**Recommendation:** No action required. Continue enforcing the no-`dangerouslySetInnerHTML` convention in code review.

---

### F-06 — INFO — No sensitive data in localStorage or sessionStorage

**Files:** All files under `frontend/src/`.

**Evidence:** Full grep for `localStorage`, `sessionStorage`, and `window.name` returned zero matches. Session state (user object, requires2FA, bootstrapped) lives in Zustand in-memory store only. The Django session cookie is HttpOnly (set server-side) and never read by JS. Pending 2FA credentials are held in module-scope variable `pendingCredentials` (not persisted) in `authStore.ts:35`.

**Recommendation:** No action required.

---

### F-07 — INFO — CSRF header correctly attached on all unsafe verbs

**File:** `frontend/src/api/client.ts:59-61`

**Evidence:**
```ts
if (!skipCsrf && UNSAFE_METHODS.has(method)) {
  const csrf = getCsrfToken();
  if (csrf) headers.set("X-CSRFToken", csrf);
}
```

`UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])` — covers all mutation verbs. The `permissionsApi.setGrants` PUT call and `orgsApi.transferOwnership` POST call both go through `apiFetch` without `skipCsrf: true`. The CSRF token is read from the `csrftoken` cookie (same origin, set by Django middleware). The test at `frontend/src/api/__tests__/apiFetch.test.ts:83` confirms this behaviour.

**Recommendation:** No action required.

---

## Gaps (Forward-Looking)

| # | Item | Missing | Effort | Blocking |
|---|------|---------|--------|----------|
| G-1 | Backend enforcement of `conflict_acknowledged` | The serializer accepts the field but the service and audit event ignore it entirely. Audit log says "ownership transfer" regardless of conflict status. | S | No (correctness gap) |
| G-2 | Proactive permission refresh after server-side role change | No mechanism to push a "role revoked" signal to the SPA. Nav items remain stale for the session. | M | No |
| G-3 | `?next=` percent-encoding bypass not caught | `%2F%2F` decoded by browser before reaching `safeNext`; currently not exploitable via React Router but not hardened. | S | No |
| G-4 | No test for conflict-acknowledged bypass (API-direct call) | Backend test suite (`test_ownership_transfer.py`) should include a case where `conflict_acknowledged` is omitted/false and assert the audit event records the absence. | S | No |
| G-5 | `newEventId()` fallback is dead code but silently masks `crypto` unavailability | Should throw; currently produces weak ID. | XS | No |
| G-6 | Phase 1B permission surfaces (tournament grants, match-level module gates) don't exist yet | All tournament/match module grants are spec'd but no corresponding frontend or backend exists. When built, the same patterns must be applied. | XL | No |
