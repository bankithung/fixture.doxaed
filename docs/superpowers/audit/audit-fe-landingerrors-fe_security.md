# Security Audit — Frontend Features (fe-landingerrors lens)

**Date:** 2026-06-04
**Auditor:** automated security review
**Scope:** `frontend/src/features/**`, `frontend/src/api/**`, `frontend/src/lib/**`
**Lens:** dangerouslySetInnerHTML / XSS, sensitive data in localStorage, missing CSRF on mutations, open redirects, UI-only authorization

---

## Finding 1 — MEDIUM — Client-side-only authorization gate on OrgSettingsPage and OrgBrandingPage

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:140–151`, `frontend/src/features/orgs/OrgBrandingPage.tsx:101–112`

**Evidence:**
```tsx
const isAdminish = (membership?.roles ?? []).some(
  (r): boolean =>
    r === "admin" || r === "co_organizer" || r === "game_coordinator" ||
    (r as string) === "owner",
);
const isOrgOwner = Boolean(membership?.is_org_owner);
const canEdit = isOrgOwner || isAdminish || effectiveModules.has(REQUIRED_MODULE);
```

**Why it matters:** `canEdit` controls whether the `PATCH /api/orgs/{uuid}/` mutation fires and whether the form renders at all. This check runs entirely off the cached JWT-free `/me/` payload stored in Zustand. The backend DOES enforce `IsOrgAdminOrOwner` independently, so the API call will 403 if the attacker tampers with Zustand state. However, the current gate also **disables the query** (`enabled: Boolean(orgSlug) && canEdit`) — an attacker who forces `canEdit=true` by patching the store in DevTools will cause the page to issue the GET **and** render the form, then attempt the PATCH. The PATCH will be rejected by the server, but the GET fetch of org details (including `name`, `slug`, `status`, `time_zone`) will succeed for any authenticated org member regardless of role because `GET /api/orgs/{slug}/` is open to all members. This is a mismatch: the `canEdit` gate is supposed to block casual access to the settings form, but a member who is not an admin still receives the full org detail payload on the GET, which is likely already accessible via other paths. The real risk is the **asymmetry**: the page promises "you can't edit" but actually the GET still fires for all members once `canEdit` is defeated.

**Recommendation:** Keep the UI gate as a UX convenience, but ensure the backend rejects GET of sensitive fields to non-admins, OR document that `GET /api/orgs/{slug}/` is intentionally public to all members (which is fine) and annotate `canEdit` as a **rendering hint only, not a security control**. Add a comment in the code: `// UI-only gate; server enforces IsOrgAdminOrOwner on PATCH`. Confidence: HIGH.

---

## Finding 2 — MEDIUM — Open redirect via unvalidated `?next=` parameter: incomplete validation

**File:** `frontend/src/features/auth/LoginPage.tsx:28–33`

**Evidence:**
```tsx
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}
```

**Why it matters:** The guard blocks `//evil.com` and `http://`. However it does NOT sanitize:
- Paths containing null bytes or control characters: e.g. `/%00/evil`.
- Paths whose first segment looks local but whose scheme is encoded: React Router's `navigate()` calls `window.history.pushState` which would interpret the path as local, so this is actually relatively safe in practice under `BrowserRouter`.
- **The bigger gap:** `encodeURIComponent(location.pathname + location.search)` is used by `ProtectedRoute` to build the `?next=` value, so a victim visiting `/o/evilorg/../../login?next=%2Faccept%3Ftoken%3Dattacker_token` could be redirected post-login to accept an attacker's invite token. React Router resolves relative segments before push, mitigating the `../` case, but the pattern of POST-login redirect to an attacker-controlled invitation accept is worth checking end-to-end.

**Recommendation:** After `safeNext`, also assert the path matches a known route prefix or at minimum does not contain `@`, `:`, or non-ASCII characters. Consider an allowlist of top-level path prefixes (`/o/`, `/me`, `/orgs`). Confidence: MEDIUM.

---

## Finding 3 — MEDIUM — Invitation token exposed in UI without server-backed re-verification

**File:** `frontend/src/features/orgs/InviteCreateModal.tsx:246–279`

**Evidence:**
```tsx
const token = invitation.token ?? "";
const link = token ? shareLinkFor(token) : "";
// ...
<CopyField label={t("Invitation token")} value={token} ... />
<CopyField label={t("Share link")} value={link} ... />
```
`shareLinkFor` builds: `${window.location.origin}/accept?token=${encodeURIComponent(token)}`

**Why it matters:** The raw one-shot invitation token is displayed in plaintext in the UI. This is by design (admins need to copy it), but consider:
1. The token is held in React component state and also surfaced in a read-only `<input>` element that is easily inspectable in browser DevTools or by browser extensions (password managers may capture it).
2. `InvitationsListPanel` (the companion panel) conditionally re-displays the token if `invitation.token` is still present in the list API response — the backend should never return tokens on list responses (and the type definition notes this), but if it ever does, the token is globally visible to any member with `canManage`.

**Recommendation:** Verify the backend list endpoint (`GET /api/orgs/{slug}/invitations/`) always omits `token`. Add a frontend assertion: if `invitation.token` appears in the list response, log a console warning and strip it before storing. Confidence: HIGH.

---

## Finding 4 — LOW — `window.confirm()` used for destructive removal action

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

**Why it matters:** `window.confirm` is a synchronous blocking dialog. In modern browsers it is suppressible via popup-blockers. More critically, the `displayName` variable comes from `m.full_name` which is server-supplied and rendered into the confirm string via `t()` string interpolation. If a malicious user registers with a name containing special characters (e.g. backticks, HTML), these are not rendered as HTML in `window.confirm` strings, but the content still appears unsanitized. The primary concern is that the authorization to perform the removal is checked exclusively client-side (the button is conditionally rendered with `canManage && !isOwner`), and `window.confirm` could be bypassed by calling `removeMember.mutate(m)` directly. Server-side, the `DELETE /api/orgs/{orgUuid}/members/{membershipId}/` endpoint must enforce `IsOrgAdminOrOwner` independently.

**Recommendation:** Replace `window.confirm` with an in-page confirmation dialog (the project already has `Dialog` from shadcn/ui) to avoid the popup-blocker bypass risk and improve UX. Confirm the server endpoint enforces authorization independently of the client gate. Confidence: HIGH.

---

## Finding 5 — LOW — Error stack trace exposed to all users in production via ErrorPage

**File:** `frontend/src/features/errors/ErrorPage.tsx:61–74`

**Evidence:**
```tsx
<pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
  {error.message}
  {error.stack ? `\n\n${error.stack}` : ""}
</pre>
```

**Why it matters:** `error.stack` contains the JavaScript call stack, including internal library names, minified variable names, source-map-deducible paths, and potentially internal API call arguments that appear in stack frames. In production this leaks internal architecture hints to any user who triggers a render error. The comment says "a real reporter (Sentry) wires in here in a later slice", but until then the raw stack is visible to end users.

**Recommendation:** Gate the `<details>` block on `import.meta.env.DEV` (or an `IS_DEVELOPMENT` env var) so production renders only the generic "Something went wrong" message without the stack. Log to `console.error` only in dev; in prod wire to an error reporter. Confidence: HIGH.

---

## Finding 6 — LOW — `qr_data_uri` rendered directly as `<img src>` without origin check

**File:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:101–107`

**Evidence:**
```tsx
{qrDataUri ? (
  <div className="flex justify-center">
    <img
      src={qrDataUri}
      alt={t("QR code for authenticator app")}
      ...
    />
  </div>
) : null}
```
Where `qrDataUri` is set from `res.qr_data_uri` returned by `POST /api/accounts/auth/2fa/enroll/`.

**Why it matters:** If the backend returns a `qr_data_uri` that is a remote URL rather than a `data:image/png;base64,...` data URI, the browser will make a cross-origin request to that URL leaking timing information. If the backend is ever misconfigured or intercepted (MITM on HTTP), it could return a `javascript:` URI. In practice the backend generates the data URI server-side (pyotp + qrcode), so this is low risk, but the frontend does no validation.

**Recommendation:** Assert the received value starts with `data:image/` before assigning it to `qrDataUri`. Add a guard: `if (!res.qr_data_uri.startsWith('data:image/')) { throw new Error('unexpected qr format'); }`. Confidence: MEDIUM.

---

## Finding 7 — INFO — CSRF token silently skipped when cookie is absent

**File:** `frontend/src/api/client.ts:59–61`

**Evidence:**
```tsx
if (!skipCsrf && UNSAFE_METHODS.has(method)) {
  const csrf = getCsrfToken();
  if (csrf) headers.set("X-CSRFToken", csrf);
}
```

**Why it matters:** If `getCsrfToken()` returns `null` (cookie absent — e.g. cold load before Django sets it), the CSRF header is silently omitted and the request is sent without it. The backend will 403 the request, but the error surfaces as a generic API failure rather than a clear "CSRF token missing" diagnostic. More critically, there is no pre-flight assertion that the cookie is present before submitting login, signup, or any mutation.

**Recommendation:** When `getCsrfToken()` returns null on an unsafe verb (and `skipCsrf` is not set), consider logging a warning or triggering a GET to refresh the CSRF cookie before retrying. At minimum, surface a clear user-visible error ("Session expired, please refresh") rather than a generic failure when the CSRF cookie is absent. Confidence: HIGH.

---

## Finding 8 — INFO — No `localStorage` or `sessionStorage` used (POSITIVE)

No calls to `localStorage`, `sessionStorage`, or `IndexedDB` were found anywhere in `frontend/src`. Authentication state is held in Zustand in-memory only. The session cookie is HttpOnly (managed by Django). Recovery codes from 2FA enrollment are displayed in-memory and not stored. This is the correct pattern.

---

## Finding 9 — INFO — No `dangerouslySetInnerHTML` anywhere (POSITIVE)

A full scan of `frontend/src` found zero uses of `dangerouslySetInnerHTML`, `innerHTML`, or `eval()`. All dynamic content from server (org names, email addresses, user names, event types in the audit log) is rendered as React text nodes, not injected HTML. XSS via injected markup is not possible through these paths.

---

## Finding 10 — INFO — Pending credentials held in module scope (documented risk)

**File:** `frontend/src/features/auth/authStore.ts:35`

**Evidence:**
```ts
let pendingCredentials: { email: string; password: string } | null = null;
```

**Why it matters:** The comment explicitly notes these are held in module scope to avoid appearing in Zustand DevTools or persisted state. However, if a browser extension or XSS payload can access the module scope (which is possible if any XSS vector exists — none were found currently), the plaintext password would be accessible. This is a conscious design decision and the mitigation (no XSS vectors found, short-lived window) is appropriate, but the lifetime of `pendingCredentials` extends until `completeTotp()` succeeds or `logout()` is called. If the user abandons the TOTP form, credentials remain in scope.

**Recommendation:** Add a timeout (e.g. 5 minutes) after which `pendingCredentials` is automatically nulled and the 2FA challenge is abandoned, directing the user back to the login form. Confidence: HIGH.

---

## Gaps (forward-looking)

| Item | Missing | Needed for | Effort | Blocking |
|------|---------|------------|--------|---------|
| Content Security Policy (CSP) header | Not configured at Vite/nginx level; no `<meta http-equiv="Content-Security-Policy">` seen | XSS defense-in-depth | M | No |
| Subresource Integrity (SRI) for CDN assets | No external CDN assets found yet, but will be needed when fonts/analytics ship | Supply chain | S | No |
| Rate-limit feedback in UI on auth endpoints | Login/signup show generic "failed" on 429; no user-visible rate-limit message | Brute-force UX | S | No |
| CSRF preflight on cold start | No mechanism to ensure CSRF cookie is present before first mutation fires | Correctness | S | No |
| Production error reporting (Sentry) | Mentioned in ErrorBoundary comment but not wired | Error monitoring | M | No |
| Pending credentials timeout (2FA abandonment) | No TTL on `pendingCredentials` in authStore.ts | Credential hygiene | S | No |
| `qr_data_uri` origin assertion | Frontend does not validate data-URI prefix before rendering as `<img src>` | Defense-in-depth | XS | No |
| Confirm dialog for member removal | Uses `window.confirm` (blockable) instead of in-app Dialog | UX + accessibility | S | No |
| Superuser bypass via client-only `is_superuser` check | `ProtectedRoute` uses `user.is_superuser` from cached payload to skip org-membership redirect; no server assertion | RBAC correctness | M | No |
