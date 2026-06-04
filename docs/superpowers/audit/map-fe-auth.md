# Frontend Auth Area Map — `frontend/src/features/auth` + `frontend/src/api/auth.ts`

Generated: 2026-06-04  
Auditor: Claude Code (map pass, read-every-file)

---

## 1. Purpose

The auth area owns every unauthenticated user-facing flow:

- **Session bootstrap** — hydrates the Zustand auth store before first render.
- **Login** — credential form + inline TOTP 2FA challenge gate.
- **Signup** — registration form → email-verification hold state.
- **Email verification** — one-shot token redemption page.
- **Password reset** — request + complete pages.
- **2FA enroll** — QR setup + code confirm + recovery codes display.
- **2FA challenge (standalone page)** — alternative TOTP entry page (partially redundant with inline gate in `LoginPage`).
- **Password re-auth modal** — global dialog for `password_reauth_required` 403s.
- **Auth layout** — branded two-column shell shared across all auth pages.

---

## 2. File Inventory

| File | Role |
|---|---|
| `frontend/src/api/auth.ts` | All auth HTTP calls; TypeScript payload/response interfaces |
| `frontend/src/features/auth/authStore.ts` | Zustand store — session state + login/logout/2FA/bootstrap actions |
| `frontend/src/features/auth/AuthLayout.tsx` | Branded two-column shell (emerald gradient + form column) |
| `frontend/src/features/auth/LoginPage.tsx` | Credential form + inline TOTP gate; `?next=` aware |
| `frontend/src/features/auth/SignupPage.tsx` | Registration form; password strength meter; terms checkbox |
| `frontend/src/features/auth/VerifyEmailPage.tsx` | Token verification on mount; idle/loading/ok/error states |
| `frontend/src/features/auth/PasswordResetRequestPage.tsx` | Email form; anti-enumeration always-success state |
| `frontend/src/features/auth/PasswordResetCompletePage.tsx` | Token + new-password form; auto-redirect after success |
| `frontend/src/features/auth/TwoFactorEnrollPage.tsx` | QR display + TOTP confirm + recovery codes |
| `frontend/src/features/auth/TwoFactorChallengePage.tsx` | Standalone TOTP entry page (separate from inline gate) |
| `frontend/src/features/auth/PasswordReauthModal.tsx` | Global dialog; subscribes to `password_reauth_required` auth-bus event |
| `frontend/src/features/auth/__tests__/authStore.test.ts` | 5 unit tests for store: login, 2FA leg, logout, fallback /me/ |
| `frontend/src/features/auth/__tests__/LoginPage.test.tsx` | 5 integration tests: labels, navigate, ?next, 2FA form, error banner, off-site next |
| `frontend/src/features/auth/__tests__/SignupPage.test.tsx` | 5 tests: render, terms gate, success card, strength meter, bad email |

---

## 3. Key Types & Interfaces

Defined in `frontend/src/api/auth.ts`:

- `LoginPayload` — `{email, password, totp_code?}`
- `LoginResponse` — `{requires_2fa?, user?}`
- `SignupPayload` — `{email, password, name}`
- `PatchMePayload` — `Partial<Pick<User, "name" | "last_active_org_id">>`
- `TwoFAEnrollResponse` — `{otpauth_uri, qr_data_uri, device_id}`
- `GetMeResponse` — alias for `User` (from `frontend/src/types/user.ts`)

`User` is defined in `frontend/src/types/user.ts` as a hand-written interface (not purely generated) because it adds the optional client-only `OrgMembership.active_role` field. It mirrors `MeSerializer` exactly otherwise.

---

## 4. Endpoints Consumed

| Method | Path | Used by |
|---|---|---|
| `GET` | `/api/accounts/me/` | `authApi.me` — bootstrap + post-login fallback + refreshMe |
| `POST` | `/api/accounts/auth/login/` | `authApi.login` — credentials + TOTP second-leg |
| `POST` | `/api/accounts/auth/logout/` | `authApi.logout` |
| `POST` | `/api/accounts/auth/signup/` | `authApi.signup` |
| `POST` | `/api/accounts/auth/verify-email/` | `authApi.verifyEmail` |
| `POST` | `/api/accounts/auth/password-reset-request/` | `authApi.passwordResetRequest` |
| `POST` | `/api/accounts/auth/password-reset-complete/` | `authApi.passwordResetComplete` |
| `POST` | `/api/accounts/auth/2fa/enroll/` | `authApi.totpEnrollBegin` |
| `POST` | `/api/accounts/auth/2fa/confirm/` | `authApi.totpEnrollConfirm` |
| `POST` | `/api/accounts/auth/reauth/` | `authApi.reauth` |
| `PATCH` | `/api/accounts/me/` | `authApi.patchMe` |

---

## 5. Route Table (auth surfaces in `App.tsx`)

| Route | Component | Protected? |
|---|---|---|
| `/login` | `LoginPage` | No |
| `/signup` | `SignupPage` | No |
| `/verify-email` | `VerifyEmailPage` | No |
| `/password-reset` | `PasswordResetRequestPage` | No |
| `/password-reset/complete` | `PasswordResetCompletePage` | No |
| `/2fa/enroll` | `TwoFactorEnrollPage` | No (see Finding #6) |
| `/2fa/challenge` | `TwoFactorChallengePage` | No |
| *(global)* | `PasswordReauthModal` | Mounted in `App` root, outside routes |

---

## 6. Findings

### F-01 — HIGH: bootstrap treats 403 as an error, not as "logged out"

**File:** `frontend/src/features/auth/authStore.ts:49–59`

```ts
} catch (e) {
  if (e instanceof ApiError && e.status === 401) {
    set({ user: null, isLoading: false, bootstrapped: true });
    return;
  }
  set({
    user: null,
    isLoading: false,
    bootstrapped: true,
    error: e instanceof Error ? e.message : "Bootstrap failed",
  });
}
```

**Problem:** DRF's `SessionAuthentication` combined with `IsAuthenticated` returns **403** (not 401) for unauthenticated anonymous requests because Django does not set a `WWW-Authenticate` header for session auth, so DRF's permission layer fires `PermissionDenied` (→ 403) rather than `NotAuthenticated` (→ 401). This is the known issue documented in the task brief: `/api/accounts/me/` returns 403 when logged out. The bootstrap only short-circuits on `status === 401`; a 403 from `/me/` falls into the `else` branch and sets `error: "Forbidden"` (or similar DRF detail string). That error string then persists in the store while `bootstrapped` is set to `true`, causing any error-rendering component that subscribes to `authStore.error` (including the error banner in `LoginPage`) to show an error on page load before the user has done anything.

**Why it matters:** This is the "premature error banner on /login" bug listed in the known issues. A logged-out user who navigates to `/login` will see an error flash if any component subscribes to `error` before it is cleared.

**Recommendation:** In `bootstrap()`, treat `status === 403` the same as 401 — i.e., silently set `user: null` without setting `error`. Alternatively (and more robustly), the backend `me_view` should return 401 for anonymous requests; add `SessionAuthentication` + a custom `authentication_classes = []` (or use `@permission_classes([AllowAny])` with manual check) so unauthenticated GET to `/me/` returns 401 with a `WWW-Authenticate` header. The easiest frontend-only fix is:

```ts
if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
  set({ user: null, isLoading: false, bootstrapped: true });
  return;
}
```

---

### F-02 — HIGH: `isUnauthenticated` heuristic on `ApiError` is fragile and may intercept legitimate 403s

**File:** `frontend/src/types/api.ts:31–45`

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

**Problem:** This getter is used by `queryClient.ts` to decide whether to emit `{ type: "unauthenticated" }` and redirect to `/login`. The string-match on DRF's default "Authentication credentials were not provided." is fragile — it depends on DRF's English string not changing and on no other 403 detail message accidentally containing "authentication credentials". More critically: the bootstrap 403 from `/me/` will NOT match here (detail is typically "You do not have permission to perform this action.") so it will not fire the redirect. This means the known-issues 403 bug manifests as an error string in the store without a redirect. However, a future query that fires and returns 403-with-wrong-detail will also be silent, leaving the user in a half-authenticated zombie state.

**Recommendation:** Have the backend emit a stable `code` field (e.g. `{"code": "not_authenticated", "detail": "..."}`) in all unauthenticated 403s and key the check on `e.payload.code === "not_authenticated"` rather than string-matching on `detail`.

---

### F-03 — MEDIUM: `TwoFactorChallengePage` is a dead/orphaned route

**Files:** `frontend/src/features/auth/TwoFactorChallengePage.tsx`, `frontend/src/App.tsx:107`, `frontend/src/features/layout/ProtectedRoute.tsx:41–43`

`LoginPage` handles the full 2FA inline flow: when `requires_2fa` is true, it renders the TOTP form directly in place of the credential form (lines 116–141 of `LoginPage.tsx`). The `authStore.completeTotp()` action re-calls `/login/` with the stashed credentials. The user never leaves `/login`.

`TwoFactorChallengePage` (`/2fa/challenge`) is a separate page that also calls `authStore.completeTotp()`, but it is only reachable via two paths:
1. `ProtectedRoute` redirects to `/2fa/challenge` when `requires2FA && !user` (line 41–43 of `ProtectedRoute.tsx`). This can only fire if a user navigates directly to a protected route while mid-2FA state, which is an edge case that works correctly but is undiscoverable.
2. `routes.twoFactorChallenge()` is never linked from `LoginPage` or `TwoFactorEnrollPage`.

The result: `TwoFactorChallengePage` duplicates the same code path as the inline TOTP form in `LoginPage` but provides a slightly worse UX (no integration with `?next=` forwarding — it always navigates to `routes.root()`, line 28 of `TwoFactorChallengePage.tsx`). The redirect from `ProtectedRoute` also bypasses `?next=` preservation.

**Recommendation:** Either (a) delete `TwoFactorChallengePage` and make `ProtectedRoute` redirect to `/login` (with `?next=`) when `requires2FA` is set, letting `LoginPage` handle the TOTP gate; or (b) remove the inline TOTP gate from `LoginPage` and make it always redirect to `/2fa/challenge` with `?next=` forwarded. Option (a) reduces surface and test burden.

---

### F-04 — MEDIUM: `PasswordResetCompletePage` enforces min-12 on new password but has no strength indicator

**File:** `frontend/src/features/auth/PasswordResetCompletePage.tsx:15–19`

```ts
const schema = z.object({
  password: z.string().min(12, t("Password must be at least 12 characters")),
});
```

`SignupPage` has a live strength meter (lines 38–47, 193–208) with a `role="progressbar"` to indicate password quality. `PasswordResetCompletePage` enforces the same 12-character minimum but shows no meter. The user experience is inconsistent — a user resetting their password has less guidance than a new user creating one.

**Recommendation:** Extract the `passwordStrength()` function and the strength bar UI from `SignupPage` into a shared component or hook (e.g. `frontend/src/features/auth/PasswordStrengthBar.tsx`) and reuse it in `PasswordResetCompletePage`.

---

### F-05 — MEDIUM: `TwoFactorEnrollPage` and `VerifyEmailPage` use `text-grant` — a domain-specific Tailwind color for the permission matrix

**Files:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:84`, `frontend/src/features/auth/VerifyEmailPage.tsx:60`

```tsx
<p role="status" className="text-sm text-grant">
  {t("2FA enabled. Save these recovery codes...")}
</p>
```

```tsx
<p role="status" className="text-sm text-grant">
  {t("Email verified. You can now sign in.")}
</p>
```

The `grant` color (`hsl(142 71% 45%)`) is defined in `tailwind.config.js:47–49` alongside `deny` and `warn` as semantic colors for the module-override permission matrix UI. Using it in auth success messages couples an auth UI concern to a permissions-domain color name. It works visually (it is a green), but the semantic meaning bleeds across domains. More practically, if the `grant` color is ever adjusted for the permission matrix, the auth success messages will change color silently.

**Recommendation:** Use `text-emerald-600` or `text-emerald-700` (already used throughout `AuthLayout` for brand accents) for auth success states, or introduce a dedicated `text-success` semantic token in the Tailwind config that both the permission matrix and auth pages share. Do not alias the permission-domain `grant` color into unrelated contexts.

---

### F-06 — MEDIUM: `/2fa/enroll` route is not behind `ProtectedRoute` — unauthenticated users get a backend 401

**File:** `frontend/src/App.tsx:106`

```tsx
<Route path="/2fa/enroll" element={<TwoFactorEnrollPage />} />
```

`TwoFactorEnrollPage` fires `authApi.totpEnrollBegin()` (`POST /api/accounts/auth/2fa/enroll/`) on mount (line 32–48 of `TwoFactorEnrollPage.tsx`). The backend endpoint is `@permission_classes([IsAuthenticated])`. If an unauthenticated user navigates directly to `/2fa/enroll`, the POST will fail with a 403/401 and the component sets a generic error: "Could not start 2FA enrollment" — no redirect to login.

`/accept` (invite accept) has the same pattern — it is a public route but requires authentication and handles it explicitly in-component. The difference is that `InviteAcceptPage` has logic to handle the auth-required case. `TwoFactorEnrollPage` has no such logic.

**Recommendation:** Move `/2fa/enroll` behind `ProtectedRoute` by nesting it inside the protected `<Route element={<ProtectedRoute>...}>` group. It does not need the `AppShell` chrome, so it can be nested inside `ProtectedRoute` without `AppShell` — use a separate element wrapper. Alternatively, add an explicit auth check in `TwoFactorEnrollPage` that redirects to `/login?next=/2fa/enroll` when the API returns 401/403.

---

### F-07 — MEDIUM: `pendingCredentials` module-level variable survives hot-module reloads in development

**File:** `frontend/src/features/auth/authStore.ts:35`

```ts
let pendingCredentials: { email: string; password: string } | null = null;
```

This variable is declared in module scope outside the Zustand store. Vite HMR re-evaluates modules and re-initializes the store via `create()`, but module-level variables are reset to `null` during HMR. If a developer is mid-2FA challenge (credentials stashed, `requires2FA === true` in the store) and saves a file triggering HMR, the store state `requires2FA` persists (Zustand's in-memory state survives HMR via the singleton pattern), but `pendingCredentials` is reset to `null`. The next `completeTotp()` call will hit `if (!pendingCredentials)` and throw `"no_pending_credentials"`, confusing the developer.

**Why it matters:** Development-only friction, not a production bug. The pattern (credentials in module scope to avoid devtools exposure) is the right security call; HMR behavior is the tradeoff. Documented in the comment but no recovery path exists.

**Recommendation:** On HMR invalidation, also reset `requires2FA` in the store. Add a Vite `import.meta.hot.accept()` handler in the module that calls `useAuthStore.getState().clear()` if `pendingCredentials` is about to be lost. Or simply document the recovery step: "if TOTP challenge screen is stuck after HMR, refresh the page."

---

### F-08 — LOW: `accept_terms` default value uses an unsafe type cast to satisfy TypeScript

**File:** `frontend/src/features/auth/SignupPage.tsx:60`

```ts
accept_terms: undefined as unknown as true,
```

The `accept_terms` field is typed as `z.literal(true)` so zod rejects anything other than `true`. react-hook-form's `defaultValues` requires the initial value to be type-compatible with the field type (`true`), but the initial state must be `undefined` (unchecked checkbox). The double cast `undefined as unknown as true` suppresses the TypeScript error but introduces a lie in the type system.

**Recommendation:** Type the `defaultValues` argument as `Partial<FormValues>` or use `useForm<FormValues, unknown, DefaultValues<FormValues>>` to allow `undefined` as a valid initial value for required fields. Alternatively, give `accept_terms` an initial value of `false` and change the zod refinement to `z.boolean().refine(v => v === true, ...)`.

---

### F-09 — LOW: `LoginPage.resolveDestination` calls `useAuthStore.getState()` directly inside a non-hook function

**File:** `frontend/src/features/auth/LoginPage.tsx:70–75`

```ts
const resolveDestination = (): string => {
  if (explicitNext) return explicitNext;
  const user = useAuthStore.getState().user;
  if (user) return pickLandingPathForUser(user);
  return routes.root();
};
```

`resolveDestination` is a plain function defined inside a component. Calling `useAuthStore.getState()` outside of a React render context is the correct pattern for reading Zustand state imperatively (not in a hook), so this is not a rules-of-hooks violation. However, because the resolved `user` is read at call time (after the store has set `user`), it is correct — but subtly coupled to the timing of Zustand's synchronous state update inside the `onCredSubmit` handler. If the `set()` call in the store were deferred (e.g. inside an async boundary), `resolveDestination` would read stale state.

Currently this is fine because `authStore.login()` calls `set()` synchronously before returning, but the pattern is fragile. The `user` is also available as a subscribed state value at the top of the component (`const user = useAuthStore(s => s.user)` is not declared, but `requires2FA` etc. are). Passing `res.user` directly to `pickLandingPathForUser` from the resolved login response would be cleaner and eliminate the dependency on store timing.

**Recommendation:**

```ts
const onCredSubmit = async (values: CredValues): Promise<void> => {
  try {
    const res = await login(values);
    if (!res.requires_2fa) {
      const dest = explicitNext ?? (res.user ? pickLandingPathForUser(res.user) : routes.root());
      navigate(dest);
    }
  } catch { /* surfaced via store error */ }
};
```

---

### F-10 — LOW: `PasswordReauthModal` does not re-dispatch the blocked action after successful re-auth

**File:** `frontend/src/features/auth/PasswordReauthModal.tsx:46–49`

```ts
await authApi.reauth(password);
setOpen(false);
setPassword("");
```

The modal confirms the password and closes. It does not retry the original action that triggered the `password_reauth_required` 403. The caller (whatever mutation triggered the 403) has already failed; the user must manually retry the action. This is a UX gap — the user confirmed their identity but still must click whatever button triggered the re-auth a second time.

v1Users.md Appendix B.18 does not require automatic retry, but the current behavior is not communicated to the user (no "please try again" message after the modal closes).

**Recommendation:** Either (a) emit a follow-up `{ type: "reauth_complete" }` event on the auth bus after successful re-auth so the originating feature can re-run its mutation, or (b) after `setOpen(false)`, show a brief toast: "Identity confirmed — please try again." This is the minimum viable improvement.

---

### F-11 — LOW: `VerifyEmailPage` `state === "ok"` success paragraph uses an undefined class `text-grant`

**File:** `frontend/src/features/auth/VerifyEmailPage.tsx:60`

```tsx
<p role="status" className="text-sm text-grant">
```

`grant` without a modifier (just `text-grant`) maps to `hsl(var(--grant, 142 71% 45%))` via the Tailwind config `grant.DEFAULT`. This is the same issue as F-05 — wrong semantic domain — but additionally carries the risk that if Tailwind's JIT purges `text-grant` (which doesn't appear in any other auth-path component), it could be dropped from the generated CSS bundle in production. In practice, `GrantCell.tsx` uses `text-grant` so the class will be present in the bundle, but the coupling is not obvious. See also F-05.

---

### F-12 — INFO: `t()` is a pass-through stub — strings are not extractable by standard i18n tooling

**File:** `frontend/src/lib/t.ts:7`

```ts
export const t = (s: string): string => s;
```

The invariant (CLAUDE.md #13) requires all user-visible strings to be wrapped in `t()` so that when i18next/Lingui ships, only this file changes. The auth area correctly wraps all visible strings. However, the string literal arguments are inline, not keyed, which means they are not extractable by standard i18n CLI tools (`lingui extract`, `i18next-parser`) without code changes — those tools expect `t('key')` or tagged template `t\`key\`` patterns, not `t("full English sentence")`. This is a deferred concern but worth noting: when i18n migration happens, the string catalog must be built manually or the `t()` signature must change.

**Recommendation:** No action needed in Phase 1A. Record this in the PRD open questions (§13) as a migration note for the i18n phase.

---

### F-13 — INFO: No test coverage for `VerifyEmailPage`, `PasswordResetRequestPage`, `PasswordResetCompletePage`, `TwoFactorEnrollPage`, `PasswordReauthModal`

Only `LoginPage` and `SignupPage` have `__tests__` files. Five auth pages have zero test coverage. `authStore.ts` has unit tests for the store actions but not for the component integrations of those pages.

**Recommendation:** Add `__tests__/VerifyEmailPage.test.tsx` covering: (a) no-token idle state, (b) token → success, (c) token → error. Add `__tests__/PasswordResetCompletePage.test.tsx` covering: (a) no-token guard, (b) submit → success + redirect, (c) bad token error. Prioritize these before Phase 1B ships.

---

## 7. Gaps / Missing Features

| Gap | Severity | Notes |
|---|---|---|
| No "resend verification email" button on `VerifyEmailPage` | medium | The idle state tells users to check their inbox but provides no way to resend from the UI. Backend endpoint not yet exposed (not in `authApi`). |
| No "disable 2FA" flow on the frontend | low | `twofa_disable_view` exists in the backend (`POST /api/accounts/auth/2fa/disable/`), is listed in `api.generated.ts`, but is not in `authApi` and has no UI. Documented as Phase 1B scope. |
| No "regenerate recovery codes" flow | low | `twofa_recovery_regenerate_view` exists in backend, not in `authApi`, no UI. |
| `accept_terms` links to `routes.about()` ("/about") — not a real T&C page | info | `AboutPage` is a landing page placeholder. No real terms of service page exists. Placeholder is acceptable for Phase 1A but must be resolved before public launch. |
| CSRF token not available before first page load (cold start) | info | `getCsrfToken()` reads from the `csrftoken` cookie. On cold start (no prior Django session), the cookie may not exist until Django's `SessionMiddleware` runs. The login POST is among the first requests — if CSRF is absent, DRF will 403. Django normally sets the cookie on the first GET. The Vite proxy should ensure the Django home page is fetched first, but there is no explicit guarantee in the current setup. |
| No "remember me" / session duration control | info | All sessions use Django's default session expiry (`SESSION_COOKIE_AGE`). Not a Phase 1A requirement but worth noting in §13. |
