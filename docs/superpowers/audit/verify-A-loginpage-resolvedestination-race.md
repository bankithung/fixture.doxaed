# Adversarial Verify A — LoginPage resolveDestination stale-closure / race

**Finding under test (severity=high, area=auth):**
`frontend/src/features/auth/LoginPage.tsx:70` — "resolveDestination creates a
stale closure and has a race between store state flip and navigate()."

**Verdict: NOT REAL (false positive).** is_real=false. Confidence: high (0.9).

## Evidence read

### LoginPage.tsx (lines 69-96)
```ts
const resolveDestination = (): string => {
  if (explicitNext) return explicitNext;
  const user = useAuthStore.getState().user;   // line 72 — IMPERATIVE fresh read
  if (user) return pickLandingPathForUser(user);
  return routes.root();
};

const onCredSubmit = async (values) => {
  const res = await login(values);             // line 79 — awaited
  if (!res.requires_2fa) {
    navigate(resolveDestination());            // line 81 — runs AFTER await
  }
};

const onTotpSubmit = async (values) => {
  await completeTotp(values.totp);             // line 91 — awaited
  navigate(resolveDestination());              // line 92 — runs AFTER await
};
```

### authStore.ts (login, lines 63-104; completeTotp, lines 106-137)
- `login` calls `set({ user, isLoading:false, requires2FA:false, bootstrapped:true })`
  (lines 85-90) BEFORE `return { requires_2fa: false }` (line 91).
- `completeTotp` calls `set({ user, ... })` (lines 121-126) BEFORE the promise
  resolves (no further await after the set on the success path).
- Zustand `set()` is synchronous.

### redirectByRole.ts (pickLandingPathForUser, lines 27-56)
Pure function; takes `user` as an argument; no closure capture, no async.

## Why both claims fail

1. **Stale closure — refuted.** The user identity is read via
   `useAuthStore.getState().user` (line 72), a fresh imperative read at call
   time, NOT a render-snapshot. This is the canonical Zustand pattern for
   avoiding stale closures. The only closure-captured value is `explicitNext`
   (line 43), derived from the URL `next` query param via `useSearchParams`,
   which is stable for the page's lifetime (the URL does not change while the
   user types credentials). No staleness path exists.

2. **Race between state flip and navigate() — refuted.** Zustand `set()` is
   synchronous and completes inside `login` / `completeTotp` BEFORE those async
   actions' promises resolve. The component `await`s the action (lines 79, 91)
   before calling `navigate(resolveDestination())` (lines 81, 92). The `await`
   imposes strict happens-before ordering: store-state-flip → navigate. By the
   time `resolveDestination` runs, `getState().user` is guaranteed populated
   (or is intentionally null on a path that does not navigate, e.g. the
   requires_2fa branch which is gated by `!res.requires_2fa` at line 80).

## Residual / minor notes (not the reported defect)
- On the credential path, `resolveDestination` could equivalently use
  `res.user`, but reading `getState().user` is correct and not buggy.
- No correctness defect; nothing to fix. The cited high-severity bug does not
  exist in the real code.
