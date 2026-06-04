# Audit: fe-auth — TanStack Cache, Zustand Store, Multi-Org Context Switch

**Area:** `frontend/src/features/auth` + related consumers  
**Lens:** TanStack cache correctness & invalidation; Zustand store correctness; multi-org context-switch must refetch + evict org-scoped data (no cross-org UI bleed)  
**Date:** 2026-06-04  
**Status:** Phase 1A complete; Phase 1B not built.

---

## Findings

---

### F-01 [HIGH] Logout does not clear the TanStack query cache — org-scoped data persists for up to 5 minutes

**File:** `frontend/src/features/auth/authStore.ts:139-152`  
**Evidence:**
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

**Why it matters:** The `queryClient` has `gcTime: 5 * 60_000` (5 min). After logout, queries like `["org", orgSlug, "members"]`, `["permissions", "matrix", orgSlug]`, `["audit", slug, cursor]`, `["org", orgSlug, "detail"]` sit live in cache. If a second user logs in on the same browser tab (shared kiosk / shared device scenario), those TanStack queries are still cached under the previous user's slug keys. The second user will momentarily see the first user's org data until `gcTime` expires or they navigate to a page that fetches fresh data — a cross-user data bleed.

**Recommendation:** Add `queryClient.clear()` (or at minimum `queryClient.removeQueries()`) in the `logout` action, after clearing Zustand state. Import `queryClient` from `@/api/queryClient` inside the store, or expose a `clearCache` callback that `App.tsx`'s `AuthBusBridge` calls after it receives the `unauthenticated` event.

---

### F-02 [HIGH] Global 401 handler (`AuthBusBridge`) does not clear the query cache either

**File:** `frontend/src/App.tsx:49-63`  
**Evidence:**
```ts
function AuthBusBridge(): null {
  const navigate = useNavigate();
  const clear = useAuthStore((s) => s.clear);
  useEffect(
    () =>
      onAuthEvent((e) => {
        if (e.type === "unauthenticated") {
          clear();          // clears Zustand, not query cache
          navigate(routes.login());
        }
      }),
    [navigate, clear],
  );
  return null;
}
```

**Why it matters:** When a session expires mid-use (server returns 401 on any query), the `QueryCache.onError` fires `emit({ type: "unauthenticated" })`, which calls `authStore.clear()` and navigates to `/login`. The Zustand `user` becomes null, but all previously fetched org-scoped TanStack queries remain in the cache. A re-login as a different user on the same tab immediately renders stale data from the evicted session's cache until `gcTime` passes.

**Recommendation:** In `AuthBusBridge`, call `queryClient.clear()` (already imported in `App.tsx` at line 9) before `clear()` and `navigate()`.

---

### F-03 [HIGH] Org-switch (OrgSwitcher) does not evict or refetch the previous org's TanStack queries

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:38-42`  
**Evidence:**
```ts
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```

**Why it matters:** When switching from org A (`acme`) to org B (`globex`), the code navigates to `/o/globex/dashboard` and PATCHes `/me/` — but it does NOT invalidate or remove the previous org's cached queries. The queries for `["org", "acme", "members"]`, `["org", "acme", "invitations"]`, `["permissions", "matrix", "acme"]`, `["audit", "acme", ...]` etc. stay in cache with their full `gcTime = 5 min` TTL. Because `staleTime = 30s` and `refetchOnWindowFocus = false`, if the user returns to an Acme page within 30 seconds of switching away (e.g. browser back button), they see Acme's own data — which is correct. However, the stale Acme data is accessible to any component that calls `queryClient.getQueryData(["org", "acme", "members"])` directly (e.g. an optimistic update path or a future feature). More critically, in a future Phase 1B tournament/match context, org-scoped queries may contain data from a tournament of org A that should be invisible in org B's context.

The spec (Invariant #2) demands NO cross-org leak via any endpoint. While the current TanStack queries are keyed by `orgSlug` so query B never literally reads query A's data, the 5-minute in-memory retention is a latent risk surface — especially as Phase 1B adds more sensitive org-scoped query keys.

**Recommendation:** In `onPickOrg`, after `navigate()`, call `queryClient.removeQueries({ queryKey: ["org", previousSlug] })` to evict the departing org's cache entries. Alternatively use `queryClient.invalidateQueries({ queryKey: ["org", previousSlug] })` to mark them stale (softer, will refetch on next mount). The former is stricter and recommended for the security invariant.

---

### F-04 [MEDIUM] `authStore.logout` does not reset `bootstrapped` flag — stale bootstrap state on re-login

**File:** `frontend/src/features/auth/authStore.ts:139-152`  
**Evidence:**
```ts
set({ user: null, requires2FA: false, error: null, isLoading: false });
// `bootstrapped` is NOT reset
```

**Why it matters:** After logout, `bootstrapped` remains `true`. If the app SPA-navigates back to a protected route before a full page reload (single-tab scenario), `ProtectedRoute` reads `bootstrapped === true && user === null` and immediately redirects to `/login` — which is the correct behavior. However, `bootstrap()` will not be called again on re-login via the store's `login()` action unless the user does a hard refresh, so `bootstrapped` has no effect during the re-login flow. This is benign today but creates confusion: `bootstrapped` now means "we tried at least once ever in this tab's lifetime" rather than "the current session's /me/ hydration succeeded," which will break assumptions in future code that guards on `bootstrapped` before rendering sensitive components.

**Recommendation:** Reset `bootstrapped: false` in the `logout` and `clear` actions, then call `bootstrap()` again when the user logs in successfully (at the end of the `login` action). Alternatively, deprecate the separate `bootstrapped` flag and replace it with a derived state from `user !== null`.

---

### F-05 [MEDIUM] `InviteAcceptPage.onAccept` calls `refreshMe()` but does NOT invalidate any TanStack queries that depend on the updated membership list

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:41-58`  
**Evidence:**
```ts
const res = await orgsApi.acceptInvitation(token);
setOrgSlug(res.org_slug);
// Backend cycles the session — refresh local user state.
await refreshMe();
setState("ok");
```

**Why it matters:** `refreshMe()` calls `authApi.me()` and sets `user` in Zustand. But the user's new membership is now in Zustand (`user.memberships`), while any cached `["org", orgSlug, "members"]` or `["org", orgSlug, "invitations"]` queries for the ORG they just joined may still show the old state (pending invitation, member not yet present). This is visible if the admin who sent the invite is on the members page in the same browser; after invitation acceptance the invitation list is not automatically refreshed for them.

More importantly, the new user navigating to `/o/{newSlug}/dashboard` immediately after acceptance relies on freshly-fetched data from the Zustand `user` (correct), but if they then navigate to `/o/{newSlug}/members`, TanStack may serve a cached response from a previous visit that predates their membership.

**Recommendation:** After `refreshMe()`, call `queryClient.invalidateQueries({ queryKey: ["org", res.org_slug] })` to flush all cached org-scoped data for the newly joined org.

---

### F-06 [MEDIUM] `OrgSettingsPage` mutation uses `qc.setQueryData` to update cache on success but skips `user` store update — org name in `OrgSwitcher` stays stale

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:189-195`  
**Evidence:**
```ts
onSuccess: (next) => {
  toast.push({ kind: "success", title: t("Organization settings saved") });
  qc.setQueryData(["org", orgSlug, "detail"], next);
  // No: authStore.refreshMe() or qc.invalidateQueries for user membership
},
```

**Why it matters:** When an admin updates the org's `name`, the `["org", orgSlug, "detail"]` TanStack cache is immediately updated with the new name. But `user.memberships[i].org_name` in the Zustand store still holds the old name. The `OrgSwitcher` dropdown renders `{m.org_name}`, which now shows the stale name until the user refreshes the page or re-bootstraps. This is a Zustand/TanStack split-brain: one source says "NewOrgName", the other says "OldOrgName."

**Recommendation:** After `qc.setQueryData`, call `authStore.refreshMe()` (or call `qc.invalidateQueries` on the `/me/` data if `/me/` is ever promoted to a TanStack query). Alternatively, accept the stale OrgSwitcher label as a cosmetic lag and document it explicitly.

---

### F-07 [MEDIUM] `LoginPage.resolveDestination` calls `useAuthStore.getState()` inside the render body (not a hook)

**File:** `frontend/src/features/auth/LoginPage.tsx:70-75`  
**Evidence:**
```ts
const resolveDestination = (): string => {
  if (explicitNext) return explicitNext;
  const user = useAuthStore.getState().user;   // imperative read from inside a closure
  if (user) return pickLandingPathForUser(user);
  return routes.root();
};
```

**Why it matters:** `useAuthStore.getState()` is a Zustand imperative read — it bypasses React's subscription mechanism. Inside an async submit handler (`onCredSubmit`) this is fine because it's called after `login()` has already set `user` in the store. However, the function is defined inside the component render scope and is also called by `onTotpSubmit` (line 91). The current code is functionally correct because `login()`/`completeTotp()` awaits the API before returning, and `set({ user })` is called synchronously before the resolve call. But the pattern is subtle and fragile: if the store update becomes async-batched in a future React version (React 19 transitions or concurrent features), `getState()` could return the pre-login snapshot. 

**Recommendation:** Instead of `getState().user`, read `user` from the outer component scope via the hook subscription (line 37: `const user = useAuthStore((s) => s.user)`). Replace the `const user = useAuthStore.getState().user` line inside `resolveDestination` with the already-subscribed `user` from the outer closure.

---

### F-08 [LOW] `authStore.bootstrap` error path sets `error` for non-401 failures but `error` is never cleared on a subsequent successful login

**File:** `frontend/src/features/auth/authStore.ts:44-60`  
**Evidence:**
```ts
} catch (e) {
  if (e instanceof ApiError && e.status === 401) {
    set({ user: null, isLoading: false, bootstrapped: true });
    return;
  }
  set({
    user: null, isLoading: false, bootstrapped: true,
    error: e instanceof Error ? e.message : "Bootstrap failed",
  });
}
```

And in `login`:
```ts
set({ isLoading: true, error: null, requires2FA: false });
```

**Why it matters:** The `login` action correctly clears `error` at the start (line 64). So a bootstrap error followed by a successful login does clear the error — this is benign today. However, if `bootstrap` fails with a non-401 error (e.g. 503), the `error` field is set but `LoginPage` renders the error alert (lines 107-114). The user may be confused seeing a "Bootstrap failed" error when the page loads, not knowing to dismiss it before entering credentials.

**Recommendation:** Clear `error` in `bootstrap` when starting the request (already done on line 45 with `error: null`), which is correct. However, also consider a separate `bootstrapError` state distinct from the login/TOTP `error` state so the two error flows don't share the same field.

---

### F-09 [LOW] `OrgSwitcherStore.activeRole` is not reset when org slug changes — stale role view across org switch

**File:** `frontend/src/features/orgs/OrgSwitcherStore.ts:18-23` and `frontend/src/features/orgs/OrgSwitcher.tsx:44-46`  
**Evidence:**
```ts
// OrgSwitcherStore:
setSlugFromUrl: (slug) => set({ currentSlug: slug }),
// Note: activeRole is NOT reset when slug changes

// OrgSwitcher.tsx onPickOrg:
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
  // No: setActiveRole(null) reset
};
```

**Why it matters:** If a user switches from org A (where they have roles `["admin", "match_scorer"]` and `activeRole = "match_scorer"`) to org B (where they only have role `["admin"]`), `activeRole` in the store is still `"match_scorer"`. The `OrgSwitcher` renders `(activeRole ?? currentRoles[0]) === r` (line 81), which correctly falls back to `currentRoles[0]` for the UI highlight because `"match_scorer"` is not in org B's roles. But `activeRole` in the store remains `"match_scorer"` — any component that reads `activeRole` for access control logic rather than display would see the stale value.

**Recommendation:** In `setSlugFromUrl` (or in `onPickOrg`), reset `activeRole: null` whenever the slug changes: `setSlugFromUrl: (slug) => set({ currentSlug: slug, activeRole: null })`.

---

### F-10 [INFO] `PasswordReauthModal` does not call `queryClient.invalidateQueries` or retry the failed mutation after reauth succeeds

**File:** `frontend/src/features/auth/PasswordReauthModal.tsx:41-56`  
**Evidence:**
```ts
const onSubmit = async (e: React.FormEvent): Promise<void> => {
  ...
  await authApi.reauth(password);
  setOpen(false);
  setPassword("");
  // No retry of the original failed mutation
};
```

**Why it matters:** The modal opens because a sensitive mutation returned 403 with `password_reauth_required`. After the user confirms their password, the modal closes but the original mutation is NOT retried. The user must manually re-click whatever triggered the 403. This is a UX gap, not a correctness or security bug, but it means the reauth flow is incomplete compared to the spec intent (B.18: "fresh password confirmation for the verb").

**Recommendation:** Track the pending mutation's retry callback in the `authBus` event payload. When the reauth succeeds, invoke the retry. This requires the mutation to subscribe to the auth bus and store a retry function before emitting the event.

---

## Gaps (forward-looking)

| # | Area | Missing | Needed for | Effort | Blocking |
|---|------|---------|------------|--------|----------|
| G-01 | Logout / 401 handler | `queryClient.clear()` call | Multi-user tab safety; Invariant #2 | S | No (Phase 1A complete but correctness gap) |
| G-02 | OrgSwitcher | `removeQueries(["org", prevSlug])` on org switch | Invariant #2; Phase 1B org-scoped tournament/match data | S | No |
| G-03 | InviteAcceptPage | `invalidateQueries(["org", newSlug])` after membership join | Data freshness for newly joined user | S | No |
| G-04 | OrgSettingsPage onSuccess | `authStore.refreshMe()` after name update | OrgSwitcher label stays in sync | S | No |
| G-05 | OrgSwitcherStore | Reset `activeRole` on slug change | Prevents stale role view in multi-role users crossing orgs | XS | No |
| G-06 | Phase 1B tournament/match | No query keys defined yet for tournament-scoped data | When Phase 1B lands, the query key namespace needs a documented convention (`["tournament", tournamentId, ...]`, `["match", matchId, ...]`) to make invalidation on org-switch deterministic | M | Phase 1B blocked until convention chosen |
| G-07 | authStore.logout | `bootstrapped` flag not reset | Future code assuming bootstrapped=true means current session is live | S | No |
| G-08 | Test coverage | No test asserts that logout/401 clears TanStack cache | CI would not catch cross-user cache bleed | M | No |
| G-09 | PasswordReauthModal | No retry of original failed mutation after reauth | Full B.18 implementation | L | No |
