# VERIFY A (adversarial) — logout() does not purge TanStack Query cache

**Finding:** logout() does not purge TanStack Query cache; stale org/member/permission data from prior session is visible on re-login
**Severity claimed:** high
**File:** frontend/src/features/auth/authStore.ts:139
**Verdict:** REAL — confirmed. Severity adjusted to **medium**.
**Confidence:** 0.88

## What the real code shows

### 1. `logout()` clears zustand only, never the query cache

`frontend/src/features/auth/authStore.ts:139-152`:

```ts
logout: async () => {
  try {
    await authApi.logout();
  } catch {
    // even on transport failure clear local state
  }
  pendingCredentials = null;
  set({
    user: null,
    requires2FA: false,
    error: null,
    isLoading: false,
  });
},
```

It resets zustand auth state and the module-scoped `pendingCredentials`. There is no
`queryClient.clear()`, `removeQueries()`, or `resetQueries()` call. The same is true of
`clear()` at lines 154-157.

### 2. Org / member / permission data IS held in the TanStack Query cache

These are real cached server-state queries keyed by org slug:
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:295` — `["org", orgSlug, "members"]`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:59` / `InviteCreateModal.tsx:106` — `["org", orgSlug, "invitations"]`
- `frontend/src/features/orgs/OwnershipTransferModal.tsx:68` — `["org", orgSlug]`
- `frontend/src/features/permissions/ModuleMatrixPage.tsx:106` — module/permission query

`queryClient` is a singleton created at module load (`frontend/src/api/queryClient.ts:23`)
with `gcTime: 5 * 60_000` (line 27), so cached pages survive in memory for up to 5 minutes
after their observers unmount. The cache is never reset on logout.

### 3. No other logout path purges the cache either

- `frontend/src/features/layout/AppShell.tsx:86-90` (`handleSignOut`) → `await logout(); navigate(login)`. No cache touch.
- `frontend/src/features/roles/MyProfilePage.tsx:81-88` (`onSignOutEverywhere`) → `await logout()` then navigate. No cache touch.
- `frontend/src/App.tsx:54-58` (`AuthBusBridge`, global 401 handler) → `clear(); navigate(login)`. No cache touch.

So on every logout path, and on a forced 401 clear, prior-session org/member/permission
query data remains resident in the singleton `queryClient` cache.

## Is the stated impact real?

Partially. The data does remain in the JS-heap query cache after logout. Whether a *different*
user re-logging in on the same tab actually *sees* it depends on cache-key collision:

- Most leaky queries are keyed by `orgSlug` (e.g. `["org", orgSlug, "members"]`). A new user who
  navigates to the *same* org slug while the entry is still within `gcTime` (5 min) and
  `staleTime` (30s, line 26) would get the stale cached payload rendered first (cached page shows
  pre-fetch), before a refetch — a brief stale-data flash, and a refetch would 403/scope-filter
  for an unauthorized org anyway (backend enforces org isolation, invariant #2). So cross-user
  data exposure via these org-scoped keys is real but bounded and largely self-correcting.
- The higher-signal vector is the same user logging out and a second user logging in on a shared
  device within the gcTime window and landing on the same org — they could momentarily see the
  first user's member/invitation lists before the backend-scoped refetch lands.

This is a genuine defect (missing `queryClient.clear()` on logout is a well-known TanStack
hygiene gap), but it is **not** an unconditional "stale data visible on re-login" — it requires a
shared tab, the same org slug, and the short gcTime/staleTime window, and backend org isolation
limits the blast radius. That makes **high** an overstatement.

## Severity assessment

- The "high" claim implies reliable cross-session data leakage. The actual exposure is
  time-boxed (30s stale / 5min gc), key-scoped (mostly per-org-slug), and backstopped by
  server-side org isolation on refetch. No auth tokens leak (session is cookie-based, invariant
  #15; logout invalidates the server session via `authApi.logout`).
- It is still a real correctness/privacy hygiene bug (a fresh login should start from a clean
  cache; brief stale renders on a shared device are a legitimate concern). That warrants
  **medium**, not high or info.

## Recommendation

Add `queryClient.clear()` (or `removeQueries`) on logout. Cleanest is in the `AuthBusBridge`
unauthenticated handler and in `logout()`/`clear()` via the existing decoupling bus
(`frontend/src/api/queryClient.ts`), to avoid an import cycle between authStore and queryClient.
