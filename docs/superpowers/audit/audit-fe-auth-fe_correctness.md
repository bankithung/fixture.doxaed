# Audit: fe-auth — Frontend Correctness
**Date:** 2026-06-04  
**Scope:** `frontend/src/features/auth/` + `frontend/src/features/layout/ProtectedRoute.tsx` + `frontend/src/App.tsx` (auth wiring)  
**Lens:** Hook deps / stale closures, TanStack query keys / missing invalidation, races, broken route guards / redirects, form validation gaps, bad optimistic updates, unhandled rejections.

---

## Findings

### F1 — `resolveDestination` reads Zustand state via `useAuthStore.getState()` inside a render-time closure (stale closure / hook rule violation)
**Severity:** High  
**File:** `frontend/src/features/auth/LoginPage.tsx:70-75`

```tsx
const resolveDestination = (): string => {
  if (explicitNext) return explicitNext;
  const user = useAuthStore.getState().user;   // <-- direct getState() call
  if (user) return pickLandingPathForUser(user);
  return routes.root();
};
```

**Why it matters:** `resolveDestination` is defined as a plain function (not a hook), yet it calls `useAuthStore.getState()` at call-time instead of capturing the user from the React subscription already in scope (`const user = useAuthStore((s) => s.user)` is NOT subscribed to in `LoginPage`). This is not a lint violation per se (it's not called during render, only from event handlers), but there is a subtle race: `login()` is `await`-ed and the store is updated, then `resolveDestination()` is called. Because the component subscribes to `isLoading`, `requires2FA`, and `error` but NOT to `user`, a re-render triggered by the store update could theoretically unmount or remount the component before the navigate fires; more concretely, the function reads `getState()` directly rather than the reactive value. If the store dispatch and the function call are in different microtask slots (possible with React 18 batching), the user read from `getState()` should be fresh, but the approach is fragile and non-idiomatic. Additionally, `user` is not subscribed at the component level so there is no reactivity safety net.

**Recommendation:** Subscribe `user` at the component level (`const user = useAuthStore((s) => s.user);`) and close over it in `resolveDestination` directly, or pass `user` as an argument to the function. This also removes the implicit dependency on `getState()` which confuses static analysis and future readers.

---

### F2 — `pendingCredentials` module-scope variable survives Hot Module Replacement and is never cleared on tab navigation away from the TOTP form
**Severity:** High  
**File:** `frontend/src/features/auth/authStore.ts:35`

```ts
let pendingCredentials: { email: string; password: string } | null = null;
```

**Why it matters:** `pendingCredentials` is held at module scope. This is intentional for keeping credentials out of Zustand devtools, but it creates two correctness problems:

1. **HMR in dev:** Vite HMR re-evaluates the module, resetting `pendingCredentials = null`. If the user's 2FA flow is interrupted by a HMR reload (e.g. a code change during development), `completeTotp` will throw `"no_pending_credentials"` with the misleading error "Session expired. Sign in again." — confusing during development.
2. **Navigation-away race:** If the user initiates `login()` (which sets `requires2FA: true` and stashes `pendingCredentials`), then navigates away (e.g. hits the browser back button) without completing TOTP, `pendingCredentials` remains set. A subsequent login attempt by a different user on the same browser tab will re-use the old credentials for the TOTP re-call until `login()` overwrites them. The window is small but real if the first login's `requires2FA` branch does not immediately clear on a second `login()` call — checking line 64, `login()` does set `requires2FA: false` on entry but does NOT null `pendingCredentials` before the new API call returns. If the new login also triggers `requires_2fa: true`, the overwrite is fine; if it does NOT, line 84 (`pendingCredentials = null`) is reached. But if the new login throws, `pendingCredentials` retains the previous user's credentials.

**Recommendation:** In `login()`, add `pendingCredentials = null` at the very top of the function body (before the API call), so any prior stale credentials are discarded regardless of the new login's outcome.

---

### F3 — `bootstrap()` is called once at module evaluation in `main.tsx`; the `unauthenticated` bus handler in `AuthBusBridge` calls `clear()` but NOT `bootstrap()` — subsequent navigation to a protected route shows a permanent "Loading..." spinner
**Severity:** High  
**File:** `frontend/src/App.tsx:53-62` and `frontend/src/features/layout/ProtectedRoute.tsx:29-38`

```tsx
// App.tsx
if (e.type === "unauthenticated") {
  clear();
  navigate(routes.login());
}
```

```tsx
// ProtectedRoute.tsx
if (!bootstrapped) {
  return <div role="status" ...>{t("Loading...")}</div>;
}
```

**Why it matters:** After a global 401 fires (e.g. session expiry), `clear()` resets `bootstrapped` to `false` (line 154-156 of `authStore.ts`: `set({ user: null, requires2FA: false, error: null, isLoading: false })` — note `bootstrapped` is NOT reset). Actually on re-inspection `clear()` does not reset `bootstrapped`, so `ProtectedRoute` would still pass through — this specific concern is mitigated. However the `logout()` action also does NOT reset `bootstrapped`, which means after logout + login, `bootstrap()` is never called again, so `me/` is never re-fetched. The `user` is set by the `login()` action directly (line 83-90), not via a fresh `bootstrap()`, so there is no stale-data problem on login. The concern shifts: the `authBus` `unauthenticated` handler does not invalidate the TanStack Query cache. All queries that were cached while authenticated remain in the cache; if the user logs back in as a different account, stale queries from the previous session can appear momentarily before refetch.

**Recommendation:** In `AuthBusBridge`, after `clear()`, also call `queryClient.clear()` to purge the entire cache. Without this, a user who logs out and a different user logs in on the same tab will briefly see the previous user's org data.

---

### F4 — `logout()` does not purge the TanStack Query cache; stale org/member/audit data from the prior session is visible after re-login as a different user
**Severity:** High  
**File:** `frontend/src/features/auth/authStore.ts:139-152`

```ts
logout: async () => {
  try {
    await authApi.logout();
  } catch {
    // even on transport failure clear local state
  }
  pendingCredentials = null;
  set({ user: null, requires2FA: false, error: null, isLoading: false });
},
```

**Why it matters:** `logout()` clears Zustand auth state but does not touch the `queryClient`. The default `staleTime` is 30 seconds and `gcTime` is 5 minutes. If user A logs out and user B logs in within 30 seconds on the same tab, user B will momentarily see user A's cached org/member/permission data until those queries re-fetch. This is a multi-tenancy isolation failure at the UI layer (invariant #2).

**Recommendation:** Import and call `queryClient.clear()` inside `logout()` after the API call. This is the standard pattern for SPA session teardown with TanStack Query. Alternatively, call `queryClient.invalidateQueries()` but `clear()` is safer here.

---

### F5 — `PasswordResetCompletePage` uses a `setTimeout` for redirect that leaks if the component unmounts before the timeout fires
**Severity:** Medium  
**File:** `frontend/src/features/auth/PasswordResetCompletePage.tsx:41-43`

```ts
setTimeout(() => navigate(routes.login()), 1500);
```

**Why it matters:** If the user navigates away during the 1500 ms window (browser back button, link click), the `setTimeout` fires on an unmounted component, calling `navigate()` in a dead context. In React 18 with concurrent features this can produce a `Warning: Can't perform a React state update on an unmounted component` style race; more practically it causes an unexpected redirect. The timer ID is never stored or cleared.

**Recommendation:** Store the timer ID in a `useRef` and clear it in a `useEffect` cleanup:
```tsx
const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
// in onSubmit:
timerRef.current = setTimeout(() => navigate(routes.login()), 1500);
// useEffect cleanup:
useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
```

---

### F6 — `TwoFactorChallengePage` is a dead route — the TOTP flow is fully handled inside `LoginPage`; if a user lands on `/2fa/challenge` directly (e.g. bookmarked or browser-back after 2FA prompt), `completeTotp` will throw `"no_pending_credentials"` with no recovery path
**Severity:** Medium  
**File:** `frontend/src/features/auth/TwoFactorChallengePage.tsx:24-30`

```tsx
const onSubmit = async (e: React.FormEvent): Promise<void> => {
  e.preventDefault();
  try {
    await completeTotp(totp);
    navigate(routes.root());
  } catch {
    // store sets error
  }
};
```

**Why it matters:** `completeTotp()` requires `pendingCredentials` to be set (set only by `login()`). If the user arrives at `/2fa/challenge` without having just completed the first leg of login, the store throws `"no_pending_credentials"` and sets `error: "Session expired. Sign in again."`. The page shows the error but provides no navigation back to `/login` — the user is stuck. Additionally, `TwoFactorChallengePage` is registered as a PUBLIC route (no `ProtectedRoute` wrapper), meaning an unauthenticated user can navigate directly to it.

**Recommendation:** 
1. Add a fallback check: if `requires2FA` is false and `user` is null when the challenge page mounts, immediately redirect to `/login`.
2. Show a "Back to sign in" link when the error is `"Session expired"`.

---

### F7 — `PasswordReauthModal` has no form-level validation and an empty-password guard only on the submit button (`disabled={!password}`), not in the submit handler
**Severity:** Medium  
**File:** `frontend/src/features/auth/PasswordReauthModal.tsx:41-58`

```tsx
const onSubmit = async (e: React.FormEvent): Promise<void> => {
  e.preventDefault();
  setSubmitting(true);
  setError(null);
  try {
    await authApi.reauth(password);
    ...
```

**Why it matters:** The submit button is `disabled={!password}`, but there is no guard inside `onSubmit`. If the browser auto-fills the password field and then the user clears it after the button becomes enabled, or if the `disabled` attribute is bypassed (e.g. via accessibility tools or automated testing), an empty-password `POST /api/accounts/auth/reauth/` will be sent to the backend. This is a low-risk API call but adds unnecessary round-trips and backend load. More importantly, the `form` element wrapping is placed inside the `Dialog`, but the `Dialog` itself does not receive a `<DialogContent>` wrapper — the `form` is a direct child of `Dialog`, bypassing the modal's accessibility and keyboard-trap scaffolding. This can break focus management.

**Recommendation:** Add an early return in `onSubmit` if `!password.trim()`. Also wrap the form content in `<DialogContent>` per the shadcn/ui Dialog API contract.

---

### F8 — `VerifyEmailPage` and `TwoFactorEnrollPage` use the CSS class `text-grant` which does not exist in the Tailwind config / shadcn token set — the success text will render without color
**Severity:** Medium  
**Files:** `frontend/src/features/auth/VerifyEmailPage.tsx:60`, `frontend/src/features/auth/TwoFactorEnrollPage.tsx:84`

```tsx
// VerifyEmailPage.tsx:60
<p role="status" className="text-sm text-grant">
  {t("Email verified. You can now sign in.")}

// TwoFactorEnrollPage.tsx:84
<p role="status" className="text-sm text-grant">
  {t("2FA enabled. Save these recovery codes...")}
```

**Why it matters:** `text-grant` is not a standard Tailwind CSS utility and does not appear to be defined as a custom color token in the project (the project uses `text-emerald-*` and `text-muted-foreground` throughout). The success state text will fall back to inheriting color from the parent (likely the default foreground color), losing the intended green/success visual signal. This is a correctness issue at the UI layer.

**Recommendation:** Replace `text-grant` with `text-emerald-700` (matching the rest of the auth surface) or define a `grant` color token in `tailwind.config`. Also check `bg-grant-muted` in `MyProfilePage.tsx:207` for the same issue.

---

### F9 — `LoginPage.tsx` suppresses the `react-hooks/exhaustive-deps` warning on the mount-only `useEffect` with an ESLint disable comment, but the actual dependency (`credForm.reset`, `totpForm.reset`) should be in the dep array
**Severity:** Low  
**File:** `frontend/src/features/auth/LoginPage.tsx:62-67`

```tsx
useEffect(() => {
  credForm.reset({ email: "", password: "" });
  totpForm.reset({ totp: "" });
  // Run once on mount; resetting after every render would fight typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

**Why it matters:** `credForm.reset` and `totpForm.reset` are stable function references (react-hook-form guarantees stability), so the lint suppression is technically safe. However, the suppression silences the entire dep-array check, which means if future code adds a dependency inside this effect, the warning won't fire. The comment acknowledges the intent, which partially mitigates the risk, but it is better practice to be explicit.

**Recommendation:** Either include `[credForm.reset, totpForm.reset]` in the dep array (safe since they're stable), or use `useRef` to call reset once without an effect.

---

### F10 — `PasswordResetRequestPage` does not disable the submit button during the async `onSubmit`, creating a double-submit window
**Severity:** Low  
**File:** `frontend/src/features/auth/PasswordResetRequestPage.tsx:26-33`, `88`

```tsx
const onSubmit = async (values: FormValues): Promise<void> => {
  try {
    await authApi.passwordResetRequest(values.email);
  } catch {
    // Anti-enumeration: always show success state even on backend error.
  }
  setSubmitted(true);  // no submitting guard
};
// ...
<Button type="submit" size="lg">
  {t("Send reset link")}
</Button>
```

**Why it matters:** There is no `submitting` state. The user can click "Send reset link" multiple times before the API responds, sending multiple reset-request emails. The `PasswordResetCompletePage` has a `submitting` guard; the request page does not.

**Recommendation:** Add `const [submitting, setSubmitting] = useState(false)` and gate the button: `<Button disabled={submitting}>`.

---

### F11 — `AuthBusBridge` useEffect closes over `navigate` and `clear` — both are stable, but the deps array could be problematic if React ever changes navigate identity
**Severity:** Low  
**File:** `frontend/src/App.tsx:52-62`

```tsx
useEffect(
  () =>
    onAuthEvent((e) => {
      if (e.type === "unauthenticated") {
        clear();
        navigate(routes.login());
      }
    }),
  [navigate, clear],
);
```

**Why it matters:** `onAuthEvent` returns an unsubscribe function, and the `useEffect` returns it directly as the cleanup. This is correct. However if `navigate` or `clear` change identity (e.g. if Zustand ever produces a new `clear` function reference after a state update), the effect re-runs, re-subscribing and adding a second listener to the `Set` while the first listener remains until the previous cleanup runs. Because `useEffect` cleanup runs before re-run, this is handled correctly by React — the old listener is removed before the new one is added. This is actually fine as-is, but worth noting for clarity.

**Recommendation:** No change required; behavior is correct. Document the cleanup pattern for future maintainers.

---

### F12 — `SignupPage` password-confirm field is absent — users have no way to verify they typed the intended password
**Severity:** Low (validation gap / UX, not a crash)  
**File:** `frontend/src/features/auth/SignupPage.tsx:15-24`

```ts
const schema = z.object({
  full_name: z.string().optional(),
  email: z.string().email(...),
  password: z.string().min(12, ...),
  accept_terms: z.literal(true, ...),
});
```

**Why it matters:** There is no `confirm_password` field. A user who typos their password during signup will be locked out of their account until they use password reset. This is a common usability issue, but also a correctness gap because the backend does not echo the password back.

**Recommendation:** Add a `confirm_password` field with a `.refine()` check (or `.superRefine()`) matching `password`.

---

## Gaps (forward-looking, not yet implemented)

| # | Area | Missing | Blocking? | Effort |
|---|------|---------|-----------|--------|
| G1 | `authStore.logout` | Does not call `queryClient.clear()` — stale TanStack Query cache from prior session persists across re-login | Yes (multi-tenancy invariant #2) | S |
| G2 | `ProtectedRoute` | No check that `user.email_verified_at !== null`; an unverified user who receives a session cookie (possible via admin or direct API call) can access all protected routes | Yes | S |
| G3 | `LoginPage` / `ProtectedRoute` | Already-authenticated users navigating to `/login` are not redirected away — they see the login form while `user` is set | No | S |
| G4 | `TwoFactorChallengePage` | Route is public but only functions when `pendingCredentials` is set (module-scope); needs mount-time redirect guard to `/login` when preconditions aren't met | No | S |
| G5 | `PasswordResetCompletePage` | No confirm-password field; backend silently accepts any 12+ char string — no client-side confirmation that the intended password was entered | No | S |
| G6 | `authStore.completeTotp` | Error path does not clear `pendingCredentials`; after a failed TOTP attempt the stale credentials remain held indefinitely (until the next `login()`) | No | S |
| G7 | `authStore` / App-wide | No CSRF token refresh after login — Django rotates the CSRF token on session creation; if `getCsrfToken()` reads a pre-login cookie value for the first post-login mutation, it will get a CSRF failure | Yes | M |
| G8 | `TwoFactorEnrollPage` | No guard preventing already-enrolled users from accessing `/2fa/enroll` — they can re-enroll (create a second device), which may or may not be desired | No | S |
| G9 | `authStore` | `refreshMe()` swallows all errors including network failures silently; a stale user object remains in Zustand with no feedback | No | S |
| G10 | `AuthBusBridge` | Only handles `unauthenticated` bus events; `password_reauth_required` is handled by `PasswordReauthModal` separately — but mutations that catch errors directly (not via `queryCache.onError`) never emit to the bus, so `PasswordReauthModal` won't open for those cases | No | M |
