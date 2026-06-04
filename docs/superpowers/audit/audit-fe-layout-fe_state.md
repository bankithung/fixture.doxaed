# Audit: fe-layout — TanStack Cache Correctness + Zustand Store + Multi-Org Context Switch

**Lens:** TanStack Query cache correctness and invalidation; Zustand store correctness; multi-org context switch must refetch and evict org-scoped data (no cross-org UI bleed).
**Date:** 2026-06-04
**Files examined:** AppShell.tsx, OrgSwitcherStore.ts, OrgSwitcher.tsx, authStore.ts, queryClient.ts, OrgDashboardPage.tsx, OrgChooserPage.tsx, computeNavItems.ts, ProtectedRoute.tsx, MemberDirectoryPage.tsx, InvitationsListPanel.tsx, InviteCreateModal.tsx, OrgSettingsPage.tsx, OrgBrandingPage.tsx, OrgAuditLogPage.tsx, ModuleMatrixPage.tsx, OwnershipTransferModal.tsx, App.tsx, main.tsx, api/orgs.ts, api/auth.ts, api/permissions.ts, api/client.ts, types/user.ts

---

## Findings

---

### F-1 [HIGH] No TanStack cache eviction on org switch — stale org-scoped data bleeds across org boundaries

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx` lines 38–42
**Evidence:**
```ts
const onPickOrg = (m: OrgMembership): void => {
    if (m.org_slug === current.org_slug) return;
    navigate(routes.orgDashboard(m.org_slug));
    persistLastActive.mutate(m.org_id);
};
```

**Why it matters:** On org switch, the component navigates and fires a PATCH to persist the selection, but performs **no cache invalidation or eviction** of org-scoped queries. All TanStack Query cache entries keyed on the old org slug (`["org", oldSlug, "members"]`, `["org", oldSlug, "invitations"]`, `["org", oldSlug, "detail"]`, `["permissions", "matrix", oldSlug]`, `["audit", oldSlug, ...]`) remain in the cache with their stale 30-second TTL (configured in `queryClient.ts` line 27: `staleTime: 30_000`). If user A is in Org1 (admin), sees a member list, then switches to Org2 (non-admin), the old Org1 data will be served from cache for up to 30 seconds if routes share similar paths or components remount. More critically, if the new org slug's routes happen to trigger queries before stale data is GC'd, a race between a fast re-mount and the stale cache window can surface Org1 data under Org2 context.

While React Router's `useParams` ensures query keys use the **new** slug, and pages are designed to use the URL slug as the primary key discriminator, the 30-second staleness window means that a user who quickly switches back to Org1 will be served stale data that might no longer reflect Org2 mutations the user just made. This is the cross-org bleed vector: `gcTime: 5 * 60_000` (5 minutes) means evicted-but-cached data can be served again on remount within that window.

**Recommendation:** In `onPickOrg`, call `queryClient.invalidateQueries({ queryKey: ['org', current.org_slug] })` (and `['permissions', 'matrix', current.org_slug]`, `['audit', current.org_slug]`) before navigating, so the old org's data is marked stale. Alternatively, call `queryClient.removeQueries({ queryKey: ['org', current.org_slug] })` for an immediate eviction. The `queryClient` is accessible via `useQueryClient()` which should be added to `OrgSwitcher.tsx`.

---

### F-2 [HIGH] `logout` clears authStore but does NOT clear the TanStack cache — prior-user org data survives logout

**File:** `frontend/src/features/auth/authStore.ts` lines 139–152
**Evidence:**
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

**Why it matters:** The logout handler sets `user: null` and clears Zustand state but never calls `queryClient.clear()`. All cached queries — members, invitations, audit log, permissions matrix, org detail — survive in the TanStack cache under their previous keys with their full gcTime of 5 minutes. If a second user logs in on the same browser tab within 5 minutes, TanStack Query will serve stale data from the first user's session until the cache GC runs. This is a direct cross-user data leak in a multi-tenant context.

The `AuthBusBridge` in `App.tsx` (lines 56–62) calls `clear()` (not `logout()`) on a 401 bus event, but `clear()` also lacks a `queryClient.clear()` call (authStore.ts lines 154–157).

**Recommendation:** In `authStore.logout()` AND `authStore.clear()`, import and call `queryClient.clear()` from `@/api/queryClient` to evict all cached server state. Since `queryClient` is a module-level singleton, the import creates no circular dependency.

---

### F-3 [MEDIUM] `OrgSwitcherStore.activeRole` is not reset on org switch — stale role view from old org bleeds into new org

**File:** `frontend/src/features/orgs/OrgSwitcherStore.ts` lines 18–23
**Evidence:**
```ts
export const useOrgSwitcher = create<OrgSwitcherState>((set) => ({
  currentSlug: null,
  activeRole: null,
  setSlugFromUrl: (slug) => set({ currentSlug: slug }),
  setActiveRole: (role) => set({ activeRole: role }),
}));
```

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx` lines 38–41
```ts
const onPickOrg = (m: OrgMembership): void => {
    if (m.org_slug === current.org_slug) return;
    navigate(routes.orgDashboard(m.org_slug));
    persistLastActive.mutate(m.org_id);
};
```

**Why it matters:** When a user picks a different org in the dropdown, `activeRole` is never reset. If the user had selected role "referee" in Org1 (which has both match_scorer and referee roles), then switches to Org2 (which has only "admin"), the `activeRole` is still "referee". The role picker in `OrgSwitcher.tsx` (lines 70–93) renders only when `currentRoles.length > 1` and uses `activeRole ?? currentRoles[0]`, so in practice the UI shows the correct role for Org2 (via the null-coalescing fallback). However, any code reading `activeRole` directly from the store without the `?? currentRoles[0]` guard would receive a stale role from a different org. This creates a subtle bug surface.

**Recommendation:** In `setSlugFromUrl` or in `onPickOrg`, call `setActiveRole(null)` to reset the role picker on org change. Alternatively, combine both fields into a single `setOrg(slug, role)` action that atomically resets both.

---

### F-4 [MEDIUM] `OrgSettingsPage` uses `setQueryData` for optimistic update but `OrgBrandingPage` uses the same query key `["org", orgSlug, "detail"]` without awareness — cache cross-contamination

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx` lines 189–196
**Evidence:**
```ts
onSuccess: (next) => {
    toast.push({ kind: "success", title: t("Organization settings saved") });
    qc.setQueryData(["org", orgSlug, "detail"], next);
},
```

**File:** `frontend/src/features/orgs/OrgBrandingPage.tsx` lines 114–118
```ts
const orgQuery = useQuery({
    queryKey: ["org", orgSlug, "detail"],
    queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
    enabled: Boolean(orgSlug) && canEdit,
});
```

**Why it matters:** Both `OrgSettingsPage` and `OrgBrandingPage` use the identical query key `["org", orgSlug, "detail"]`. The settings page writes into the cache with `setQueryData` after a successful PATCH. This write will also be read by `OrgBrandingPage` the next time it mounts or goes from `enabled: false` to `enabled: true`. This is accidental shared cache and is only benign currently because both pages read the same endpoint and the branding page is read-only. When Phase 1B adds real branding fields and a separate `PATCH /api/orgs/{id}/branding/` endpoint, a stale `setQueryData` write from settings could overwrite a fresh branding fetch. Additionally, `OrgSettingsPage` should have used `qc.invalidateQueries` (to refetch authoritatively) rather than `setQueryData` (optimistic write) for a PATCH that modifies persistent org state.

**Recommendation:** Separate the query keys: use `["org", orgSlug, "detail", "settings"]` for `OrgSettingsPage` and `["org", orgSlug, "detail", "branding"]` for `OrgBrandingPage`. In `OrgSettingsPage.onSuccess`, replace `setQueryData` with `invalidateQueries` to maintain server-as-truth semantics consistent with the rest of the codebase.

---

### F-5 [MEDIUM] `AuthBusBridge` (App.tsx) only handles `unauthenticated` bus events — `password_reauth_required` does not clear the cache

**File:** `frontend/src/App.tsx` lines 50–62
**Evidence:**
```ts
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

**File:** `frontend/src/api/queryClient.ts` lines 36–43
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

**Why it matters:** The `password_reauth_required` event is emitted but never consumed in `AuthBusBridge`. The comment in `queryClient.ts` says "auth feature subscribes to these and reacts," but the `AuthBusBridge` only handles `unauthenticated`. The `PasswordReauthModal` component is rendered in `App.tsx` (line 88) but it is not connected to the auth event bus — it is unclear how it receives the reauth signal. If the reauth modal relies on a separate mechanism, the cache is also not cleared on session expiry that triggers a reauth challenge, which could leave org-scoped queries visible to a re-authed but potentially different-privilege session.

**Recommendation:** In `AuthBusBridge`, add handling for `password_reauth_required` to open the reauth modal (if not already done), and audit the `PasswordReauthModal` to verify it properly subscribes to the bus. Confirm the reauth flow does not require a cache clear.

---

### F-6 [MEDIUM] `OrgAuditLogPage` pagination: cursor state is local component state, not part of the query key correctly — cursor-based TanStack pagination has no "previous page" data in cache

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx` lines 68–77
**Evidence:**
```ts
const [cursor, setCursor] = React.useState<string | null>(null);

const query = useQuery<...>({
    queryKey: ["audit", slug, cursor],
    queryFn: () => auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
    enabled: Boolean(slug && hasModule),
});
```

**Why it matters:** Each distinct cursor value creates a separate TanStack Query cache entry (good). However, when the user navigates back to a "Previous" page, they receive a new query key with the previous cursor, and TanStack will show a loading state even though the user was just on that page, because there's no `keepPreviousData`/`placeholderData` configuration. This is a UX issue rather than a correctness bug, but because the data is refetched per navigation without `placeholderData`, the table blanks out between pagination changes. More critically, if the user switches org (F-1) and the audit cache for the old org is not evicted, an audit log cursor from Org1 could theoretically be passed to the Org2 endpoint if local `cursor` state is not reset on org switch (it IS reset because the component unmounts on route change, but this depends on route key being distinct per slug).

**Recommendation:** Add `placeholderData: keepPreviousData` (TanStack Query v5 API) to the audit query to prevent blank-out on pagination. Confirm via route-level test that the cursor state properly resets when the `:orgSlug` URL param changes.

---

### F-7 [LOW] `OrgDashboardPage` reads RBAC/module data exclusively from `authStore.user.memberships` — no TanStack query; stale `/me/` data governs dashboard card visibility until explicit `refreshMe`

**File:** `frontend/src/features/layout/OrgDashboardPage.tsx` lines 28–33
**Evidence:**
```ts
const user = useAuthStore((s) => s.user);
const membership =
    user?.memberships.find((m) => m.org_slug === orgSlug) ?? null;
```

**Why it matters:** The dashboard cards, nav items, and permission gates all derive from `authStore.user.memberships`, which is populated once at bootstrap (or on explicit `refreshMe` in `InviteAcceptPage`). If an admin grants a new module to the current user in another browser session (via the `ModuleMatrixPage`), the current session's dashboard cards do not update until the user refreshes the page or an explicit `refreshMe()` is called. There is no TanStack query backing the current user's effective modules — it is purely cached in Zustand without a TTL. This is a design choice documented implicitly in the code, but it means:
1. Modules removed from a user (security downgrade) do not take effect in the UI until reload.
2. New modules granted to a user do not become visible until reload.

This is consistent with the session-auth model, but it is a UX gap: the app has no periodic refresh of `/me/`, no cache-invalidation hook from the permissions matrix save to `refreshMe()`.

**Recommendation:** After `ModuleMatrixPage.saveRow.onSuccess`, call `refreshMe()` from `useAuthStore` to refresh the current user's effective modules if the saved row belongs to the current user. Additionally, consider adding a `staleTime`-aware `useQuery` for `/me/` to keep Zustand synchronized rather than relying solely on bootstrap.

---

### F-8 [LOW] `OrgSwitcher.persistLastActive` mutation has no `onError` handler — silent failures in PATCH `/me/`

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx` lines 26–28
**Evidence:**
```ts
const persistLastActive = useMutation({
    mutationFn: (orgId: string) =>
      authApi.patchMe({ last_active_org_id: orgId }),
});
```

**Why it matters:** The `persistLastActive` mutation fires on org switch to persist the user's last-active org for the next session. There is no `onError` handler. If the PATCH fails (network error, 4xx), the failure is silently swallowed and the user's next session will incorrectly default to a different org than expected. The comment in `OrgSwitcher.tsx` line 18 says "Failures are non-blocking — server-side persistence is best-effort," which is intentional. However, with no error logging or user notification, debugging broken "last active org" behavior will be difficult.

**Recommendation:** Add at minimum an `onError` console.warn or error logger call so failures can be traced in diagnostics, consistent with how the app handles other non-blocking failures.

---

### F-9 [LOW] `queryClient.ts` sets `refetchOnWindowFocus: false` globally — org-scoped queries never refetch when user returns to a stale tab after extended absence

**File:** `frontend/src/api/queryClient.ts` lines 29
**Evidence:**
```ts
refetchOnWindowFocus: false,
```

**Why it matters:** With `refetchOnWindowFocus: false` and `staleTime: 30_000`, if a user leaves the org dashboard for 10+ minutes and returns, TanStack will serve 10-minute-old member data, permissions matrix, audit events, and org details without refetching. In a live sports context (Phase 1B) where members join/leave orgs in real time, this will lead to incorrect permission display (a user appears as member when they've been removed). For Phase 1A this is lower severity, but it is a known invariant violation: invariant #4 states "DB-first event log" as the system of record, but the UI is serving stale cache.

**Recommendation:** Restore `refetchOnWindowFocus: true` for org-scoped queries, or selectively enable it per query (e.g., `membersQuery` in `MemberDirectoryPage` can opt-in individually with `refetchOnWindowFocus: true`). Alternatively, reduce `staleTime` from 30 seconds to a value appropriate for the data's change rate.

---

### F-10 [INFO] `OrgSwitcherStore` comment says "nothing else should write here" but `AppShell` also relies on `setSlugFromUrl` — this write pattern is correct and intentional

**File:** `frontend/src/features/orgs/OrgSwitcherStore.ts` lines 8–9
**Evidence:**
```ts
// `setSlugFromUrl` is called from a router-aware effect inside <AppShell>;
// nothing else should write here.
```

The single `useEffect` at `AppShell.tsx` line 43 is the only writer — this is well-designed and clean. No finding, just confirming the invariant holds.

---

### F-11 [INFO] `OrgSwitcher` test (`orgSwitcher.test.tsx`) does not assert that org-scoped cache is invalidated on switch

**File:** `frontend/src/features/orgs/__tests__/orgSwitcher.test.tsx` lines 87–101
**Evidence:**
```ts
it("PATCHes /me/ with last_active_org_id and navigates on switch", async () => {
    // ...
    expect(patchSpy).toHaveBeenCalledWith({ last_active_org_id: "o2" });
    expect(screen.getByTestId("loc").textContent).toBe("/o/globex/dashboard");
});
```

No assertion tests that queries for Org1 are invalidated. This test gap is related to F-1 above: the test passing gives false confidence that the cache is clean on switch.

---

## Gaps (Forward-Looking)

| # | Item | Missing | Needed For | Effort | Blocking |
|---|------|---------|------------|--------|---------|
| G-1 | `OrgSwitcher.onPickOrg` → cache eviction | Call `qc.invalidateQueries(['org', currentSlug])` + `['permissions', 'matrix', currentSlug]` + `['audit', currentSlug]` on org switch | Prevent cross-org data bleed when switching orgs | S | No (safety fix) |
| G-2 | `authStore.logout` + `authStore.clear` → `queryClient.clear()` | Import and call `queryClient.clear()` in both actions | Prevent cross-user cache leak on logout/session expiry | S | No (security hygiene) |
| G-3 | Test: `orgSwitcher.test.tsx` | Add assertion that org-scoped cache keys are invalidated after org switch | Prevents regression of G-1 fix | S | No |
| G-4 | `ModuleMatrixPage.saveRow.onSuccess` → `refreshMe()` for current user | Call `useAuthStore.getState().refreshMe()` if `vars.userId === currentUser.id` | Show updated nav/dashboard cards to a user whose modules were just changed | M | No |
| G-5 | `AuthBusBridge` — wire `password_reauth_required` to `PasswordReauthModal` | Confirm the reauth modal receives the bus event; document the mechanism | Security: reauth challenge must visibly gate UI | M | No |
| G-6 | Audit pagination `keepPreviousData` | Add `placeholderData: keepPreviousData` to `OrgAuditLogPage.query` | Smooth UX during cursor-based pagination | S | No |
| G-7 | Per-user `/me/` query (TanStack) to keep Zustand in sync | Replace or supplement bootstrap-only hydration with a `useQuery` for `/me/` with appropriate staleTime | Keeps RBAC display current without full page reload | M | No |
| G-8 | Separate query keys for OrgSettingsPage and OrgBrandingPage | Use `["org", orgSlug, "detail", "settings"]` and `["org", orgSlug, "detail", "branding"]` | Prevents future Phase 1B cache contamination | S | No |
| G-9 | No org-context isolation tests | Write a test: user sees Org1 members, switches to Org2, asserts Org1 data is not present | Invariant #2 (no cross-org leak) is tested at backend only; frontend isolation is untested | M | No |
