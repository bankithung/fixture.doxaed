# Security Audit — `frontend/src/features/auth` (fe-auth / fe_security)

**Lens:** dangerouslySetInnerHTML/XSS · sensitive data in localStorage · missing CSRF header on mutations · open redirects · UI-only authz  
**Date:** 2026-06-04  
**Auditor:** Claude Code (automated)  
**Status:** COMPLETE — real files read; no fabrications.

---

## Summary

The auth surface is generally well-implemented. No `dangerouslySetInnerHTML` usage exists anywhere in the auth feature. No sensitive data is stored in `localStorage` or `sessionStorage`. CSRF headers are correctly attached on all unsafe verbs via `apiFetch`. The open-redirect guard is present and tested.

Two real findings stand out:

1. **Medium** — The `qr_data_uri` from the server is blindly dropped into `<img src=...>` without validating that it is a `data:image/` URI. A compromised/misconfigured server could supply a `javascript:` URI or a remote URL that leaks the fact the user is enrolling in 2FA.
2. **Medium** — The `QueryCache.onError` handler emits `unauthenticated` / `password_reauth_required` events for TanStack Query-managed queries, but **mutations invoked directly through `authApi`** (login, logout, signup, reauth, TOTP enroll/confirm, password reset) are not TanStack mutations — they are plain `await` calls. Their 401/403 signals bypass the query-cache bus entirely. If the backend returns 401 on `POST /login/` after a race or token expiry, the store surfaces a text error but does NOT trigger the `AuthBusBridge` navigation to `/login`. This is a minor inconsistency but not an active vulnerability because the user is already on or near the login page.
3. **Low** — `TwoFactorChallengePage` (`/2fa/challenge`) and `TwoFactorEnrollPage` (`/2fa/enroll`) are public routes (not behind `ProtectedRoute`). The challenge page calls `completeTotp` which reads `pendingCredentials` from module scope. If a user navigates directly to `/2fa/challenge` without a preceding login attempt, `pendingCredentials` is `null` and the component shows a generic store error without redirecting to `/login`. This is a UX gap with a mild security smell (user is left on a meaningless screen rather than being guided to the correct flow).
4. **Info** — Server-sourced error strings (`e.payload.detail`) are rendered as React children (plain text nodes), not via `dangerouslySetInnerHTML`. React's JSX escaping makes this safe against XSS, but it does mean arbitrary server strings can appear verbatim in the UI.

---

## Findings

### F1 — Unvalidated `data:` URI from server used as `<img src>`
**Severity:** medium  
**File:line:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:35,103`

**Evidence:**
```tsx
// line 35
setQrDataUri(res.qr_data_uri ?? null);
// ...
// line 103
<img src={qrDataUri} alt={t("QR code for authenticator app")} ... />
```

**Why it matters:** `qr_data_uri` is trusted from the backend response without any client-side check that it is a `data:image/png;base64,...` string. If the backend is compromised, mis-deployed, or returns an attacker-controlled payload (e.g. via a supply-chain attack on the serializer), it could supply `javascript:alert(1)` as the `src`. While modern browsers do not execute JS in `img src`, a `blob:` or `http://attacker.com/track` URI could still leak user activity (the fact that the user is enrolling 2FA). More practically: `javascript:` URIs are safe in most modern browsers for `img` but a `data:text/html,...` payload would not be filtered.

**Recommendation:** Before `setQrDataUri`, validate the value starts with `data:image/`:
```ts
const uri = res.qr_data_uri ?? null;
setQrDataUri(uri?.startsWith("data:image/") ? uri : null);
```
Confidence: high.

---

### F2 — Mutation 401/403 signals bypass the auth-event bus
**Severity:** medium  
**File:line:** `frontend/src/api/queryClient.ts:35-42`, `frontend/src/features/auth/authStore.ts:63-137`

**Evidence:**
```ts
// queryClient.ts:35-42 — only QueryCache errors go through the bus:
queryCache: new QueryCache({
  onError: (error) => {
    if (error instanceof ApiError) {
      if (error.isUnauthenticated) emit({ type: "unauthenticated" });
      else if (error.isPasswordReauthRequired) emit({ type: "password_reauth_required" });
    }
  },
}),
```
```ts
// authStore.ts — login, logout, completeTotp call authApi directly (plain fetch), not useMutation:
const res = await authApi.login(payload);
```

**Why it matters:** If `POST /api/accounts/auth/logout/` returns 401 (possible when session already expired server-side), the store swallows the error (`catch {}`) and clears local state, but the `AuthBusBridge` never fires. Similarly, `POST /api/accounts/auth/reauth/` returning 401 in `PasswordReauthModal` calls `setError(...)` but does not redirect to `/login`. For mutations that happen outside the auth store — such as those in org/permission pages via `useMutation` (TanStack) — any 401/403 would fire the bus. But the auth-surface mutations are the ones most likely to encounter 401 and they are the ones that don't go through the bus. The practical risk is "user is left on an auth page with a confusing error" rather than a security bypass, but it is still a correctness gap with security implications (no forced re-auth).

**Recommendation:** Export `authBus` (already done at `queryClient.ts:47`) and call `authBus.emit({ type: "unauthenticated" })` from `authStore.bootstrap()` and any other catch blocks that receive a non-login 401. For consistency, add a `MutationCache` with the same error handler as `QueryCache` to cover future TanStack mutations throughout the app.

Confidence: high.

---

### F3 — `/2fa/challenge` is a public route with no redirect when `pendingCredentials` is absent
**Severity:** low  
**File:line:** `frontend/src/App.tsx:109`, `frontend/src/features/auth/TwoFactorChallengePage.tsx:17-70`, `frontend/src/features/auth/authStore.ts:107-111`

**Evidence:**
```tsx
// App.tsx:109 — /2fa/challenge is NOT inside <ProtectedRoute>:
<Route path="/2fa/challenge" element={<TwoFactorChallengePage />} />
```
```ts
// authStore.ts:107-111 — guard only sets error; no navigation:
if (!pendingCredentials) {
  set({ error: "Session expired. Sign in again." });
  throw new Error("no_pending_credentials");
}
```
```tsx
// TwoFactorChallengePage.tsx:29 — catch just swallows:
} catch {
  // store sets error
}
```

**Why it matters:** Any user who navigates directly to `/2fa/challenge` with no active login flow sees a TOTP input form and, after attempting to submit, gets a store error string without being redirected to `/login`. This is a dead-end UX state. There is no authz bypass (the backend still validates the session), but it is a security-UX gap — it could mislead users into thinking their session is still in a valid two-factor intermediate state.

**Recommendation:** In `TwoFactorChallengePage`, check `requires2FA && !user` from the store on mount; if neither is true, redirect to `/login`. Alternatively, surface the "Session expired" error as a flash and `navigate(routes.login())` immediately in the catch block.

Confidence: high.

---

### F4 — CSRF token is silently omitted (not errored) when the cookie is absent on unsafe mutations
**Severity:** low  
**File:line:** `frontend/src/api/client.ts:59-61`

**Evidence:**
```ts
if (!skipCsrf && UNSAFE_METHODS.has(method)) {
  const csrf = getCsrfToken();
  if (csrf) headers.set("X-CSRFToken", csrf);
  // ↑ silently skips if cookie is absent — no warning, no abort
}
```

**Why it matters:** If the `csrftoken` cookie is absent (e.g. first load before Django sets it, cookie blocked by browser policy, or cookie accidentally cleared), every POST/PATCH/PUT/DELETE will go out without the CSRF header. Django's CSRF middleware will then reject these requests with 403. The current code fails silently at the JS layer (the user sees a generic "Login failed" or "Signup failed") with no diagnostic that the CSRF cookie is missing. This is not a vulnerability per se (Django still protects), but it could mask a misconfiguration where CSRF protection appears broken.

**Recommendation:** In development/debug builds, add a `console.warn` when an unsafe method is fired without a CSRF token. In production, consider aborting early (throw a client-side error) so the user sees a clear message rather than a 403 from Django that surfaces as "Login failed".

Confidence: medium (depends on deployment configuration).

---

### F5 — Server error strings rendered verbatim in UI (info, safe in React)
**Severity:** info  
**File:line:** `frontend/src/features/auth/authStore.ts:97`, `frontend/src/features/auth/VerifyEmailPage.tsx:29`, multiple others

**Evidence:**
```ts
// authStore.ts:97
error: e instanceof ApiError
  ? (e.payload.detail ?? "Login failed")
  ...
// Rendered as a React child (text node), not innerHTML:
{error}
```

**Why it matters:** React's JSX rendering escapes string children, so this is NOT an XSS vector — `<script>` tags in the `detail` string would be rendered as visible text. Included here for completeness: if the rendering ever changes to use `dangerouslySetInnerHTML` (e.g. to support bold text in errors), this pattern would become dangerous.

**Recommendation:** Document that `e.payload.detail` must remain a text-node child; add a lint rule or comment forbidding `dangerouslySetInnerHTML` in error display components.

Confidence: high (confirmed safe in current code).

---

### F6 — `AuthBusBridge` navigates to `/login` without restoring `?next=` on global 401
**Severity:** low  
**File:line:** `frontend/src/App.tsx:54-58`

**Evidence:**
```ts
// App.tsx:54-58 — global 401 clears state and navigates to /login bare:
if (e.type === "unauthenticated") {
  clear();
  navigate(routes.login());  // no ?next= appended
}
```

**Why it matters:** When a TanStack query fires a 401 mid-session (e.g. token expired while user is on `/o/acme/dashboard`), the user is redirected to `/login` without a `?next=` parameter. After logging back in, `LoginPage.resolveDestination()` has no `explicitNext` and falls back to `pickLandingPathForUser`, which may send the user to a different page than where they were (e.g. root `/orgs` if memberships were cleared). This is a UX issue with a mild session-continuity security implication (a CSRF attack that forces a 401 could disrupt user flow).

**Recommendation:** In `AuthBusBridge`, capture `location.pathname + location.search` before clearing state and append as `?next=`:
```ts
navigate(`${routes.login()}?next=${encodeURIComponent(location.pathname + location.search)}`);
```

Confidence: high.

---

## Gaps (forward-looking, not current bugs)

| # | Area | Gap | Needed for | Effort |
|---|------|-----|-----------|--------|
| G1 | Authz | No frontend role/module guard on `/2fa/enroll` — an unauthenticated user can load the enrollment page (though the API will 401). | Security hardening | S |
| G2 | CSRF | `MutationCache.onError` hook is absent; future `useMutation` calls that encounter 401/403 outside TanStack queries will not fire the auth bus. | All Phase 1B mutation surfaces | S |
| G3 | Session | No test asserts that `AuthBusBridge` appends `?next=` on forced logout. | Regression prevention | S |
| G4 | QR URI | No test asserts `TwoFactorEnrollPage` rejects a non-`data:image/` QR URI from the backend. | Defense-in-depth | S |
| G5 | Pending creds | `pendingCredentials` in module scope survives hot-module-replacement in dev — stale credentials could persist between page-module reloads in development. Not a production risk. | Dev-mode safety | S |
| G6 | Rate limiting | No client-side rate-limit feedback on the login form (e.g. disabling after N failed attempts). Relies entirely on backend throttling. | Brute-force UX | M |
