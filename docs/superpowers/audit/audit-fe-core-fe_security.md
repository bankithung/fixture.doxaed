# Frontend Security Audit — fe-core lens
**Area:** `frontend/src`
**Date:** 2026-06-04
**Scope:** dangerouslySetInnerHTML/XSS, sensitive data in localStorage, missing CSRF header on mutations, open redirects, UI-only authorisation.

---

## Findings

### F1 — MutationCache has no 401/403 interception (high)

**File:** `frontend/src/api/queryClient.ts:35-43`

```ts
queryCache: new QueryCache({
  onError: (error) => {
    if (error instanceof ApiError) {
      if (error.isUnauthenticated) emit({ type: "unauthenticated" });
      else if (error.isPasswordReauthRequired)
        emit({ type: "password_reauth_required" });
    }
  },
}),
```

The `QueryClient` configures a `QueryCache` with an `onError` that fires the auth bus when a **query** returns 401/403. No `MutationCache` with equivalent logic is present. Mutations — including member removal, permission saves, ownership transfer, and invitation creation — that return 401 (session expiry mid-form) or 403 (re-auth required) will **not** redirect to `/login` or open the `PasswordReauthModal`. The user gets a toast error and stays on the page with their session silently expired. The backend will still reject the request, but the client is left in an inconsistent state that could cause confusion.

**Recommendation:** Add `MutationCache` to the `QueryClient` with the same `onError` handler:
```ts
import { MutationCache } from "@tanstack/react-query";
// ...
mutationCache: new MutationCache({
  onError: (error) => {
    if (error instanceof ApiError) {
      if (error.isUnauthenticated) emit({ type: "unauthenticated" });
      else if (error.isPasswordReauthRequired)
        emit({ type: "password_reauth_required" });
    }
  },
}),
```

---

### F2 — Pending 2FA credentials have no timeout (medium)

**File:** `frontend/src/features/auth/authStore.ts:35,68-74`

```ts
let pendingCredentials: { email: string; password: string } | null = null;
// ...
pendingCredentials = {
  email: payload.email,
  password: payload.password,
};
```

When a login response returns `requires_2fa: true`, the plaintext email+password are stashed in module scope to be re-sent in the TOTP confirmation call. There is no expiry or cancellation timer. If the user abandons the 2FA page (e.g., closes the tab or navigates away without completing login), `pendingCredentials` remains allocated for the lifetime of the module — until either (a) the user completes TOTP, (b) the user logs in again, or (c) the page is hard-reloaded. For a shared device, this is a transient credential exposure in memory.

The comment acknowledges this is intentional to prevent devtools exposure. However, given the backend session that would be established is server-side, the safest fix is to add a `setTimeout` to null out `pendingCredentials` after ~5 minutes, matching a reasonable 2FA prompt window.

**Recommendation:** On setting `pendingCredentials`, schedule `setTimeout(() => { pendingCredentials = null; }, 5 * 60 * 1000)` and clear the timer on TOTP success/failure.

---

### F3 — `isUnauthenticated` matches some 403s by substring (low-medium)

**File:** `frontend/src/types/api.ts:32-45`

```ts
get isUnauthenticated(): boolean {
  if (this.status === 401) return true;
  if (this.status === 403) {
    const detail = typeof this.payload.detail === "string"
      ? this.payload.detail.toLowerCase()
      : "";
    return (
      detail.includes("authentication credentials") ||
      detail.includes("not authenticated")
    );
  }
  return false;
}
```

A DRF 403 whose `detail` message happens to contain "authentication credentials" or "not authenticated" (e.g., a custom permission class that reuses that phrasing for a different reason) will incorrectly trigger the `unauthenticated` bus event, clearing user state and redirecting to `/login`. This is an incorrect false-positive that could log out a legitimately authenticated user mid-task.

In practice, DRF's standard `IsAuthenticated` emits exactly those strings, so the current behaviour is correct for that class. But the string-matching approach is fragile — any future custom permission that includes that substring would mis-fire.

**Recommendation:** Standardise on a structured `code` field in all backend 403 responses (e.g. `{"code": "not_authenticated"}`) and check only `this.payload.code === "not_authenticated"` rather than substring matching `detail`.

---

### F4 — QR data-URI rendered without scheme validation (low)

**File:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:100-107`

```tsx
{qrDataUri ? (
  <div className="flex justify-center">
    <img
      src={qrDataUri}
      alt={t("QR code for authenticator app")}
      className="h-48 w-48 rounded border bg-white p-2"
    />
  </div>
) : null}
```

`qrDataUri` is the verbatim string from `res.qr_data_uri` (backend response). There is no client-side validation that this is a `data:image/png;base64,...` URI before assigning it to `<img src>`. React itself prevents script injection via an `<img>` tag, and there is no `dangerouslySetInnerHTML` involved, so classic XSS is not achievable. However, if the backend were misconfigured or the channel was MITMed (pre-TLS), an arbitrary `http://attacker.com/track.png` URL could be injected, leaking the request (including cookies via `credentials:"include"`) to a third-party server. Note: the `apiFetch` wrapper sets `credentials:"include"` on all fetches, but `<img>` element loads use the browser's default credential mode (`"same-origin"` for `src`), not `credentials:"include"`, so cross-origin cookie leakage via img is not the risk here.

**Recommendation:** Before setting state, assert `res.qr_data_uri.startsWith("data:image/")`. Reject and show an error if the assertion fails.

---

### F5 — UI-only authorisation check on sensitive settings pages (low / info)

**Files:**
- `frontend/src/features/orgs/OrgSettingsPage.tsx:140-151`
- `frontend/src/features/orgs/OrgBrandingPage.tsx:101-112`
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:268-272`
- `frontend/src/features/orgs/OrgAuditLogPage.tsx:66,79`

All of these pages gate rendering (including API call initiation) based on values from the cached auth store:

```ts
const canEdit =
  isOrgOwner || isAdminish || effectiveModules.has(REQUIRED_MODULE);
// ...
if (!canEdit) {
  return <NoPermissionCard />;
}
```

The frontend checks are **UX-only** — the `enabled: Boolean(orgSlug) && canEdit` flag on `useQuery` prevents an API call from being issued, and the mutation is never called. The **only** protection against a manipulated client is the server-side check. If an attacker modifies the Zustand store (e.g., via devtools or by replaying a request directly), the server must reject unauthorized requests.

**Assessment:** The backend does enforce these permissions (Django `IsOrgMember` + module gate). This is therefore correct architecture (server is authoritative). The finding is recorded as info to confirm the backend is not accidentally trusting any frontend-sourced header for authorisation.

**Recommendation (confirmation, not change):** Verify that every guarded mutation endpoint — `PATCH /api/orgs/{uuid}/`, `PUT /api/orgs/{slug}/permissions/`, `DELETE /api/orgs/{uuid}/members/{id}/`, `GET /api/orgs/{slug}/members/` — enforces the module gate server-side regardless of the request source.

---

### F6 — `safeNext` redirect guard not applied to the `InviteAcceptPage` login link (low)

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:76`

```tsx
<Link
  to={`${routes.login()}?next=${encodeURIComponent(`/accept?token=${token}`)}`}
```

The `token` value comes from `useSearchParams()` and is user-controlled. It is correctly `encodeURIComponent`-wrapped in the `next` query parameter, and the redirect target itself is the hardcoded path `/accept?token=...` which starts with `/` and is not `//`. However, `token` is not validated beyond `params.get("token") ?? ""`. A specially crafted `?token=` value could contain characters that, after encoding, construct an unusual `next` parameter. More importantly: the `safeNext()` guard in `LoginPage` does check that `next` starts with `/` and does NOT start with `//`, which would already reject protocol-relative URLs. So this is correctly protected. The risk is low.

**Recommendation:** No change needed; document that the `safeNext()` guard in `LoginPage.tsx:29-33` is the defence boundary.

---

## What is NOT a finding

- **`dangerouslySetInnerHTML`:** Searched the entire `frontend/src` tree. Not present anywhere. React JSX is used exclusively.
- **`localStorage` / `sessionStorage` for sensitive data:** No usage found. Auth state lives in Zustand (in-memory), user object is populated from the server on each bootstrap.
- **CSRF header on mutations:** `apiFetch` (client.ts:59-61) attaches `X-CSRFToken` from the `csrftoken` cookie on all `POST`, `PUT`, `PATCH`, `DELETE` calls. The `skipCsrf: true` option exists but is only referenced in the test file and is never called with `true` in production code.
- **Open redirect via `?next=` on LoginPage:** `safeNext()` at `LoginPage.tsx:29-33` enforces that the value starts with `/` and does not start with `//`, blocking protocol-relative and absolute external URLs.
- **`eval()` / `document.write()`:** Not present anywhere in `frontend/src`.
- **Credentials in `localStorage`:** The 2FA pending credentials are in module scope (memory), not Web Storage.

---

## Gaps (forward-looking, not present bugs)

| # | Area | What's Missing | Needed For | Effort | Blocking? |
|---|------|----------------|-----------|--------|-----------|
| G1 | `queryClient.ts` | `MutationCache.onError` 401/403 handler | Correct session-expiry UX on mutations | S | No (security UX gap) |
| G2 | Phase 1B live (WebSocket scorer) | CSRF is irrelevant for WebSocket upgrades, but the WS connection needs the same session cookie validation. The current SSE/WS split (invariant #11) will need server-side session verification on the upgrade handshake. | Live scoring | M | No (Phase 1B) |
| G3 | Phase 1B tournament/match pages | Every new protected surface must replicate the module-gate pattern from Phase 1A. Without a shared hook (`useRequiresModule()`), copy-paste drift will make some surfaces UI-gated but not API-gated or vice-versa. | Phase 1B | M | No |
| G4 | Content-Security-Policy header | No CSP header is set in the frontend build or Nginx config. React mitigates inline XSS, but a CSP would block injected scripts from third-party CDNs, exfiltration via `img`/`fetch`, and provides defence-in-depth. | Production hardening | M | No |
| G5 | `qr_data_uri` scheme validation | See F4. Trivial check before `setQrDataUri()` call. | 2FA enrolment hardening | S | No |
| G6 | `pendingCredentials` timeout | See F2. Module-scope plaintext password lingers if 2FA is abandoned. | Auth hygiene | S | No |
