# Audit: fe-auth — API Contract

**Area:** `frontend/src/features/auth` + `frontend/src/api/auth.ts`
**Lens:** API calls hit real routes; request/response shapes match serializers and types; non-2xx handling; loading/empty/error states.
**Date:** 2026-06-04
**Auditor:** Claude Code (automated)

---

## Findings

### F-01 — CRITICAL: Login response shape mismatch — backend never returns `user`; frontend depends on it

**Severity:** critical
**File:** `frontend/src/api/auth.ts:24-28` and `backend/apps/accounts/views.py:253`

**Frontend declares:**
```ts
export interface LoginResponse {
  requires_2fa?: boolean;
  user?: User;
}
```

**Backend returns only:**
```python
return Response({"status": "ok"})           # line 253 — no `user` key at all
return Response({"requires_2fa": True})     # line 228-229 — only for 2FA gate
```

The backend `POST /api/accounts/auth/login/` never emits a `user` payload — not on a regular success, not on a 2FA completion. The frontend `authStore.ts:83` has a fallback:
```ts
const user = res.user ?? (await authApi.me());
```
This fallback works but means every login takes **two round-trips** rather than one. The `LoginResponse.user` field is permanently dead — it is never populated. If the fallback `me()` call fails (e.g. network blip right after login), the user sees a silent bootstrap failure (store sets `error` to the message string, but `LoginPage` does not re-render the error state because the error is set after `navigate()` has already been called).

**Why it matters:** Silent extra round-trip + potential race condition where `navigate()` fires before `me()` resolves and the store has no user.

**Recommendation:** Either (a) add `user` to the login response (return `MeSerializer(user).data` from the login view), or (b) remove `user?` from `LoginResponse` and make the dual-call explicit + guarded. If (b), wrap the `me()` call in a try/catch that prevents navigation on failure.

---

### F-02 — HIGH: Signup response shape mismatch — frontend expects `{ user: User }`, backend returns `{ status: "pending_verification" }`

**Severity:** high
**File:** `frontend/src/api/auth.ts:55-57` and `backend/apps/accounts/views.py:119-148`

**Frontend declares:**
```ts
signup: (payload: SignupPayload) =>
  api.post<{ user: User }>("/api/accounts/auth/signup/", payload),
```

**Backend returns:**
```python
return Response({"status": "pending_verification"}, status=status.HTTP_201_CREATED)
```

The backend never returns a `user` object from signup — signup is a two-step flow (create → email verify → login). The frontend call returns `{ status: "pending_verification" }` but the TypeScript type promises `{ user: User }`. The `SignupPage.tsx` component does not read the return value (`await authApi.signup(...)` with no destructuring, line 71-75), so it does not crash — but the type lie can mislead future callers.

**Why it matters:** TypeScript consumers of `authApi.signup()` that attempt to access `.user` will silently receive `undefined` at runtime. The test (`SignupPage.test.tsx:56`) passes `{ user: {} as never }` as the mock value, compounding the fiction.

**Recommendation:** Change the return type to `api.post<{ status: string }>` to match actual backend output. Update the test mock accordingly.

---

### F-03 — HIGH: `verifyEmail` response type mismatch — backend returns `{ status: "verified" }`, frontend expects `{ ok: true }`

**Severity:** high
**File:** `frontend/src/api/auth.ts:58` and `backend/apps/accounts/views.py:186`

**Frontend:**
```ts
verifyEmail: (token: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/verify-email/", { token }),
```

**Backend returns:**
```python
return Response({"status": "verified"})   # line 186
```

The `VerifyEmailPage.tsx` does not read the return value (line 22: `await authApi.verifyEmail(token)` — result discarded), so it does not crash. But the declared type `{ ok: true }` is factually wrong. Any caller that checks `res.ok` gets `undefined` (falsy) instead of `true`.

**Recommendation:** Change return type to `api.post<{ status: string }>`. No component change needed if the return value continues to be discarded.

---

### F-04 — HIGH: `passwordResetRequest`, `passwordResetComplete`, and `reauth` return type mismatch — backend returns `{ status: "ok" }`, not `{ ok: true }`

**Severity:** high
**File:** `frontend/src/api/auth.ts:59-88` and `backend/apps/accounts/views.py:285,304,323`

**Frontend declares:**
```ts
passwordResetRequest: (email: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/password-reset-request/", { email }),
passwordResetComplete: (token: string, new_password: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/password-reset-complete/", { ... }),
reauth: (password: string) =>
  api.post<{ ok: true }>("/api/accounts/auth/reauth/", { password }),
```

**Backend returns in all three cases:**
```python
return Response({"status": "ok"})   # lines 285, 304, 323
```

All three consumers (`PasswordResetRequestPage`, `PasswordResetCompletePage`, `PasswordReauthModal`) discard the return value so there is no runtime crash. But the declared TypeScript contract is wrong — `{ ok: true }` vs actual `{ status: "ok" }`.

**Recommendation:** Change all three to `api.post<{ status: string }>`. This is a straightforward type-correction with no behavioral change.

---

### F-05 — HIGH: `bootstrap()` in authStore catches 401, but `GET /api/accounts/me/` returns 403 when unauthenticated — causes error banner on /login

**Severity:** high
**File:** `frontend/src/features/auth/authStore.ts:50-53` and `backend/fixture/settings/base.py:153-158`

**Evidence:**
```ts
// authStore.ts line 50-53
if (e instanceof ApiError && e.status === 401) {
  set({ user: null, isLoading: false, bootstrapped: true });
  return;
}
```

DRF's `SessionAuthentication` + `IsAuthenticated` returns **HTTP 403** (not 401) to unauthenticated anonymous requests because Django's session auth is not a bearer-token scheme — it does not set `WWW-Authenticate`, so DRF's `is_authenticated` shortcircuit path returns 403 Forbidden. The bootstrap code only silences 401; a 403 falls through to the generic error path:
```ts
set({
  user: null, isLoading: false, bootstrapped: true,
  error: e instanceof Error ? e.message : "Bootstrap failed",
});
```
This sets `error` to "HTTP 403" (or the `detail` value from DRF's response). The `LoginPage` renders that error in an `role="alert"` banner immediately on page load, before the user has done anything — a known issue explicitly called out in the task brief.

**Recommendation:** Change the bootstrap catch to also clear state (not set error) on 403:
```ts
if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
  set({ user: null, isLoading: false, bootstrapped: true });
  return;
}
```
Alternatively, add `UNAUTHENTICATED_USER = None` and a custom auth class that returns 401. The frontend fix is lower risk.

---

### F-06 — MEDIUM: `isUnauthenticated` in `ApiError` treats certain 403s as unauthenticated, but bootstrap does not use this helper

**Severity:** medium
**File:** `frontend/src/types/api.ts:33-44` and `frontend/src/features/auth/authStore.ts:50`

**Evidence:**
```ts
// api.ts line 33-44
get isUnauthenticated(): boolean {
  if (this.status === 401) return true;
  if (this.status === 403) {
    const detail = typeof this.payload.detail === "string"
      ? this.payload.detail.toLowerCase() : "";
    return detail.includes("authentication credentials") || detail.includes("not authenticated");
  }
  return false;
}
```

The `ApiError.isUnauthenticated` property already covers the 403 case (checking the DRF detail string). But `authStore.bootstrap()` at line 50 does its own `e.status === 401` check instead of calling `e.isUnauthenticated`. This is an inconsistency — one part of the codebase knows about the 403 ambiguity, the other does not.

**Recommendation:** Replace `e.status === 401` in `authStore.bootstrap()` with `e instanceof ApiError && e.isUnauthenticated` to stay consistent with the existing abstraction. This also fixes F-05 if the DRF 403 detail string matches.

---

### F-07 — MEDIUM: `logout` endpoint requires `IsAuthenticated` — frontend swallows the 403 silently but doesn't recover state

**Severity:** medium
**File:** `backend/apps/accounts/views.py:258` and `frontend/src/features/auth/authStore.ts:139-152`

**Evidence:**
```python
# views.py line 258
@permission_classes([IsAuthenticated])
def logout_view(request: Request) -> Response:
```
```ts
// authStore.ts line 139-147
logout: async () => {
  try {
    await authApi.logout();
  } catch {
    // even on transport failure clear local state
  }
  ...
```

If the user's session has already expired (common on back button after a long idle), the logout call returns 403. The frontend catches and swallows this, which is the correct recovery behavior (local state is still cleared). However, if someone attempts double-logout (calls logout twice), the second call fails silently with no indication. This is low-risk but worth noting. The more significant concern: any `authBus.emit` for the unauthenticated event is NOT fired here, meaning the queryClient's cache is not invalidated on logout. `queryClient.clear()` should be called after logout.

**Recommendation:** Call `queryClient.clear()` after `authApi.logout()` (regardless of success) to evict cached query data. This prevents the next user on the same browser from seeing stale data.

---

### F-08 — MEDIUM: `TwoFactorChallengePage` is an orphan — it re-implements the 2FA flow already embedded in `LoginPage`

**Severity:** medium
**File:** `frontend/src/features/auth/TwoFactorChallengePage.tsx:1-70`

`TwoFactorChallengePage` is a standalone card-based 2FA entry page (separate from `LoginPage`). `LoginPage` already handles the `requires_2fa` state inline by conditionally rendering a TOTP form. `TwoFactorChallengePage` is apparently not routed to from `LoginPage` — after setting `requires2FA: true`, the `LoginPage` renders inline, not via a route redirect. This page appears to never be navigated to in the normal flow.

If `TwoFactorChallengePage` is accessible via a direct URL (e.g. `/2fa/challenge`), a user could reach it without prior login state, causing `completeTotp` to throw `"no_pending_credentials"` — the error is shown, which is acceptable, but the UX is a dead end with no back-to-login link.

**Recommendation:** Either (a) remove `TwoFactorChallengePage` as dead code if `LoginPage` handles the inline TOTP flow, or (b) document its route and add a fallback "Return to sign in" link when `pendingCredentials` is null.

---

### F-09 — LOW: `VerifyEmailPage` uses `className="text-grant"` (typo for `text-green-*` or `text-emerald-*`)

**Severity:** low
**File:** `frontend/src/features/auth/VerifyEmailPage.tsx:60`

```tsx
<p role="status" className="text-sm text-grant">
  {t("Email verified. You can now sign in.")}
</p>
```

`text-grant` is not a Tailwind class — it's likely a typo for `text-emerald-600` or similar. The success text will render in the browser default color (black) instead of green, making it visually indistinguishable from body text. The same class appears in `TwoFactorEnrollPage.tsx:84`.

**Recommendation:** Replace `text-grant` with `text-emerald-600` (or whichever green token is used elsewhere in the auth flow).

---

### F-10 — LOW: `TwoFactorEnrollPage` uses `text-grant` too

**Severity:** low
**File:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:84`

```tsx
<p role="status" className="text-sm text-grant">
  {t("2FA enabled. Save these recovery codes somewhere safe...")}
```

Same typo as F-09.

---

### F-11 — LOW: `PasswordResetRequestPage` has no loading/disabled state on the submit button

**Severity:** low
**File:** `frontend/src/features/auth/PasswordResetRequestPage.tsx:88`

```tsx
<Button type="submit" size="lg">
  {t("Send reset link")}
</Button>
```

No `disabled={submitting}` and no local `submitting` state. If the user double-clicks or the network is slow, multiple identical POST requests go to `password-reset-request`. The backend is idempotent (fires best-effort email), so there's no data corruption risk, but it's a UX gap inconsistent with all other forms in this feature (SignupPage, PasswordResetCompletePage, etc. all properly disable during submit).

**Recommendation:** Add `const [submitting, setSubmitting] = useState(false)` and `disabled={submitting}` to the button, with `setSubmitting(true/false)` around the `await`.

---

### F-12 — INFO: `signup` payload does not include `event_id` — idempotent retry is not exposed to the SPA

**Severity:** info
**File:** `frontend/src/api/auth.ts:31-36` and `backend/apps/accounts/serializers.py:31`

The backend `SignupSerializer` accepts an optional `event_id` (UUID) for idempotent replay (architectural invariant 3). The `SignupPayload` interface and `authApi.signup` do not expose this field — the SPA cannot participate in idempotent retry for signup. This is not a bug (it degrades gracefully), but it is an unimplemented capability.

**Recommendation:** Add `event_id?: string` to `SignupPayload` and pass it through in `authApi.signup`. The caller (SignupPage) can generate a UUID on form mount and include it on submit.

---

### F-13 — INFO: `CSRF skip` is not set on login — POST /api/accounts/auth/login/ requires CSRF token even though it is AllowAny

**Severity:** info
**File:** `frontend/src/api/client.ts:59-61` and `frontend/src/api/auth.ts:52-53`

`authApi.login` calls `api.post(...)` with no `skipCsrf` option. DRF `SessionAuthentication` enforces CSRF on all unsafe methods — the `@permission_classes([AllowAny])` only waives authentication, not CSRF. The client always attaches CSRF from the cookie (`getCsrfToken()`), which is correct behavior. This is working as intended, but could confuse developers wondering why login needs CSRF. A code comment would help.

---

## Summary of Response Shape Mismatches

| Endpoint | Backend returns | Frontend expects |
|----------|----------------|-----------------|
| `POST /api/accounts/auth/login/` (success) | `{"status": "ok"}` | `LoginResponse { user?: User }` |
| `POST /api/accounts/auth/signup/` | `{"status": "pending_verification"}` | `{ user: User }` |
| `POST /api/accounts/auth/verify-email/` | `{"status": "verified"}` | `{ ok: true }` |
| `POST /api/accounts/auth/password-reset-request/` | `{"status": "ok"}` | `{ ok: true }` |
| `POST /api/accounts/auth/password-reset-complete/` | `{"status": "ok"}` | `{ ok: true }` |
| `POST /api/accounts/auth/reauth/` | `{"status": "ok"}` | `{ ok: true }` |

The pattern is consistent: backend uses `{"status": "<verb>"}` throughout; frontend type declarations say `{ ok: true }`. In no case does a component actually read the success value, so there is no runtime crash — but the types are systematically wrong and will mislead future callers.

---

## Gaps (forward-looking)

| # | Area | Missing | Needed for | Effort | Blocking |
|---|------|---------|-----------|--------|---------|
| G-01 | authStore | `queryClient.clear()` not called on logout — cached query data persists across user sessions | Multi-user browser security | S | No |
| G-02 | SignupPage | `event_id` not generated or passed — signup idempotent retry not available | Architectural invariant 3 | S | No |
| G-03 | auth API types | All success response types (`{ ok: true }`) should match actual backend `{ status: string }` | Type safety for future callers | S | No |
| G-04 | LoginResponse | `user` field should either be populated by backend (add `MeSerializer` to login response) or removed from the type | Single-RTT login / type hygiene | M | No |
| G-05 | TwoFactorChallengePage | Orphan page with no route guard; should either be removed or given a back-link and proper route | UX dead end | S | No |
| G-06 | bootstrap 403 handling | `authStore.bootstrap` does not use `ApiError.isUnauthenticated` helper — inconsistent handling of session-expired 403 | Prevents spurious error banner on /login | S | Yes (known issue) |
| G-07 | PasswordResetRequestPage | Missing `submitting` state — double-submit possible | UX consistency | S | No |
