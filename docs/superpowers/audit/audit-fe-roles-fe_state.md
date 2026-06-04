# Audit: fe-roles — TanStack Cache Correctness + Invalidation, Zustand Store Correctness, Multi-Org Context Switch

**Area:** `frontend/src/features/roles`  
**Lens:** TanStack Query cache correctness + invalidation; Zustand store correctness; multi-org context switch must refetch + evict org-scoped data (no cross-org UI bleed).  
**Date:** 2026-06-04

---

## Findings

### F-1 — HIGH: OrgSwitcher navigates but does NOT invalidate org-scoped TanStack queries

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:38-41`

```ts
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```

When the user switches org via the org-select dropdown, only a navigation (`navigate(...)`) and a best-effort PATCH to persist `last_active_org_id` are fired. There is no `queryClient.invalidateQueries()` or `queryClient.removeQueries()` call.

**Why it matters (cross-org UI bleed):**  
Every org-scoped query key is structured as `["org", orgSlug, ...]` (e.g. `["org", "acme", "members"]`, `["org", "acme", "invitations"]`, `["org", "acme", "detail"]`) and `["permissions", "matrix", orgSlug]`. With `staleTime: 30_000` (30 s) set as the global default in `queryClient.ts:27`, if the user switches from org A to org B within 30 seconds, every page that re-uses a query key from A still renders stale A data until the cache entry expires. The `MemberDirectoryPage`, `OrgSettingsPage`, `ModuleMatrixPage`, `InvitationsListPanel`, and `OrgDashboardPage` all key by `orgSlug` and would immediately re-render with cached data from the previous org if the user switched orgs rapidly.

In practice, React Router unmounts the old route and mounts a new one, so TanStack Query issues a new fetch on mount for the new slug. However, any query that is already rendered and shared across routes (not the case today, but the absence of explicit cache eviction is an architectural risk that grows as Phase 1B adds more pages) would show stale cross-org data.

**Recommendation:** After `navigate(...)`, call `queryClient.removeQueries({ queryKey: ["org", current.org_slug] })` (or `invalidateQueries`) to eagerly evict cached data for the departing org so any lingering or concurrent renders cannot serve stale org-A content to the org-B context. Add the same eviction for `["permissions", "matrix", current.org_slug]`. Add a test in `orgSwitcher.test.tsx` asserting the cache is cleared on switch.

---

### F-2 — HIGH: `activeRole` in `OrgSwitcherStore` is NOT reset on org switch

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:38-41` and `frontend/src/features/orgs/OrgSwitcherStore.ts:18-23`

```ts
// OrgSwitcherStore.ts
export const useOrgSwitcher = create<OrgSwitcherState>((set) => ({
  currentSlug: null,
  activeRole: null,
  setSlugFromUrl: (slug) => set({ currentSlug: slug }),
  setActiveRole: (role) => set({ activeRole: role }),
}));
```

`onPickOrg` in `OrgSwitcher` calls `navigate(...)` and `persistLastActive.mutate(...)` but never calls `setActiveRole(null)`. Meanwhile the `OrgSwitcherStore.setSlugFromUrl` is only called from an effect inside `AppShell` keyed to `orgSlug` param changes.

If a user is in org A, selects role "match_scorer" (which persists in `activeRole`), then switches to org B, the stale `activeRole` from org A remains. The role radio-group UI in `OrgSwitcher` does display the new org's roles (`currentRoles` is derived from the current membership), but `activeRole` from the previous org is still in store state and is used as the default for `aria-checked` and the active-role highlight:

```ts
// OrgSwitcher.tsx:81
aria-checked={(activeRole ?? currentRoles[0]) === r}
```

If the old `activeRole` string happens to exist as a role in the new org, the wrong role will appear selected. If not, `currentRoles[0]` is used via fallback, but the stale `activeRole` remains in store—a latent state leak.

**Recommendation:** In `onPickOrg`, call `setActiveRole(null)` before or after `navigate(...)` to clear the role view for the incoming org.

---

### F-3 — MEDIUM: `MyProfilePage` mutations use `refreshMe()` instead of TanStack Query invalidation — inconsistent cache ownership

**File:** `frontend/src/features/roles/MyProfilePage.tsx:60-66`

```ts
const saveName = useMutation({
  mutationFn: (newName: string) => authApi.patchMe({ name: newName }),
  onSuccess: async () => {
    await refreshMe();   // <-- calls authApi.me() and sets Zustand state
    setEditing(false);
    toast.push({ kind: "success", title: t("Profile updated") });
  },
```

`refreshMe()` is defined in `authStore.ts:159-165` as a direct `authApi.me()` call that updates Zustand state, bypassing TanStack Query entirely. The `/api/accounts/me/` endpoint is **not** managed via `useQuery` anywhere — it is fetched imperatively in `authStore.bootstrap()` and in `authStore.refreshMe()`. This is a deliberate design (user identity lives in Zustand, not TanStack), but it creates a correctness gap:

The `OrgDashboardPage` (line 32), `MemberDirectoryPage` (line 262), `computeNavItems` (line 56), and `OrgSettingsPage` (line 134) all derive their `membership` object by calling `user?.memberships.find(...)` from the Zustand store. After `saveName` succeeds, `refreshMe()` fires and updates the entire `User` object including `memberships`. This is correct for the name change, but it means any in-flight or concurrent reads of `membership.effective_modules` are temporarily stale during the async `refreshMe()` round-trip. This is a narrow race window and low-risk for a name-only PATCH, but it is worth noting as the pattern generalises to Phase 1B mutations that change role or module grants.

More importantly: if the name PATCH fails at the network level but `refreshMe()` somehow still succeeds (or vice versa), the UI can show inconsistent state (toast says "Profile updated" but name reverts). The `onError` path in `saveName` does NOT call `refreshMe()`, which is correct — but the asymmetry means the Zustand store lags the server on partial failures until the next full bootstrap.

**Recommendation:** This design is acceptable for Phase 1A name-only edits. Document that any Phase 1B mutation that changes `effective_modules` or `roles` (e.g. role assignment, grant changes) MUST call `refreshMe()` after success, not just `qc.invalidateQueries(...)`, because `MemberDirectoryPage`, `OrgDashboardPage`, and `computeNavItems` all read modules from Zustand rather than from TanStack Query.

---

### F-4 — MEDIUM: `ModuleMatrixPage` invalidates `["permissions", "matrix", orgSlug]` on save-row success, but the auth store (`effective_modules`) is NOT refreshed — stale RBAC in nav + gating components

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:99-108`

```ts
onSuccess: (_data, vars) => {
  setEdits((cur) => { ... });
  toast.push({ kind: "success", title: t("Permissions saved") });
  qc.invalidateQueries({
    queryKey: ["permissions", "matrix", orgSlug],
  });
},
```

When an admin saves a per-user module override, `qc.invalidateQueries(...)` re-fetches the permissions matrix. However, `effective_modules` is embedded inside `User.memberships[]` in the Zustand auth store, and **no `refreshMe()` call** is made after a grant change.

This means:
- `computeNavItems` (derives nav tabs from `membership.effective_modules`) still shows the old module set.
- `MemberDirectoryPage`, `OrgSettingsPage`, `OrgDashboardPage` still gate access based on stale `effective_modules`.
- The user whose grants were just changed will not see the updated nav until they reload or perform another bootstrap cycle.

**Recommendation:** After a successful `setGrants` mutation, call `useAuthStore.getState().refreshMe()` in addition to `qc.invalidateQueries(...)`. Alternatively, the `/api/permissions/orgs/{slug}/me/modules/` endpoint (`permissionsApi.myModules`) should be queried reactively by `computeNavItems` and the gating components instead of reading from the embedded Zustand snapshot — but that is a larger architectural change.

---

### F-5 — MEDIUM: `OrgSwitcherStore.activeRole` Zustand state persists across page navigations within the same org when the URL route no longer includes a role-specific path

**File:** `frontend/src/features/orgs/OrgSwitcherStore.ts:14-22` and `frontend/src/features/layout/AppShell.tsx:34-45`

```ts
// AppShell.tsx — only syncs orgSlug from URL, never activeRole
useEffect(() => {
  setSlugFromUrl(orgSlug ?? null);
}, [orgSlug, setSlugFromUrl]);
```

`activeRole` is set when a multi-role user clicks a role radio button in `OrgSwitcher`, and it is never cleared by any navigation effect. It persists until the user clicks a different role or switches org. For Phase 1A this is low risk (the role radio-group merely highlights the active role view, no routing side-effects). But Phase 1B will use `activeRole` to gate console surfaces (scorer vs referee). The missing cleanup is a design debt that will cause bugs when Phase 1B routes are added if not addressed.

**Recommendation:** Add a `useEffect` in `AppShell` (or `OrgSwitcher`) that resets `activeRole` when `orgSlug` changes. This should be paired with F-2's fix.

---

### F-6 — MEDIUM: Query key for `["org", orgSlug, "invitations"]` is fetched in `InvitationsListPanel` only when `canManage=true`, but the key is invalidated by `InviteCreateModal` unconditionally

**File:** `frontend/src/features/orgs/InviteCreateModal.tsx:104-107`

```ts
onSuccess: (inv) => {
  toast.push({ kind: "success", title: t("Invitation sent") });
  qc.invalidateQueries({ queryKey: ["org", orgSlug, "invitations"] });
  setSent(inv);
},
```

**File:** `frontend/src/features/orgs/InvitationsListPanel.tsx:49-53`

```ts
const query = useQuery({
  queryKey: ["org", orgSlug, "invitations"],
  queryFn: () => orgsApi.invitations(orgSlug),
  enabled: Boolean(orgSlug) && canManage,
});
```

This is not a correctness bug — invalidating a query that is disabled is a no-op in TanStack Query. However, the `["org", orgSlug, "members"]` invalidation in `MemberDirectoryPage.removeMember` also only triggers re-fetch of the members list, not invitations. If an invitation is accepted (making the invitee a member), neither `invitations` nor `members` queries are automatically refreshed on the other page — there is no cross-list invalidation. This is an existing gap, not a regression introduced in this feature, but it is visible as stale UX.

**Recommendation:** After `removeMember` succeeds, also invalidate `["org", orgSlug, "invitations"]` (in case the removed member had a pending re-invitation). Similarly document that `InviteAcceptPage` must invalidate both keys on success in Phase 1B.

---

### F-7 — LOW: Global `staleTime: 30_000` in `queryClient.ts` is too long for security-sensitive permission data

**File:** `frontend/src/api/queryClient.ts:25-31`

```ts
defaultOptions: {
  queries: {
    staleTime: 30_000,    // 30 seconds for ALL queries
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  },
```

With `refetchOnWindowFocus: false` and `staleTime: 30_000`, the `["permissions", "matrix", orgSlug]` query serves cached grant data for up to 30 seconds after a grant change. Combined with the missing `refreshMe()` after grant saves (F-4), a user who has just been denied a module could still see it in the nav and attempt to access it for up to 30 seconds. The backend enforces real access control, so this is a UI-only race — no security breach — but it is a UX inconsistency.

**Recommendation:** Override `staleTime` for the permissions matrix query to `0` (always re-validate on focus/mount) or at least `5_000`. Alternatively, enable `refetchOnWindowFocus: true` specifically for permissions-related queries by passing `staleTime: 0` in the `useQuery` options at the call site in `ModuleMatrixPage`.

---

### F-8 — LOW: `redirectByRole.ts` `pickLandingPathForUser` reads `last_active_org_slug` from Zustand store snapshot — stale after PATCH /me/ if `refreshMe()` has not yet resolved

**File:** `frontend/src/features/roles/redirectByRole.ts:33-36`

```ts
const preferredSlug = user.last_active_org_slug;
const m =
  (preferredSlug
    ? memberships.find((mm) => mm.org_slug === preferredSlug)
    : null) ?? memberships[0];
```

`pickLandingPathForUser` is called during login with whatever `User` object is in `authStore`. The `OrgSwitcher`'s `persistLastActive` mutation PATCHes `/api/accounts/me/` with `last_active_org_id`, but it does NOT call `refreshMe()` afterward (it uses a fire-and-forget `useMutation` with no `onSuccess`). So if the user switches org → closes the tab → re-opens → bootstrap fires, the `last_active_org_slug` in the bootstrap response will be correct (server-authoritative). But if the PATCH is still in-flight when bootstrap completes, there is a race. This is the same best-effort comment in the source (`// Failures are non-blocking — server-side persistence is best-effort`), so this is a known, accepted trade-off. The risk is low; flagged for completeness.

**Recommendation:** Add a `onSuccess` handler to `persistLastActive` that calls `useAuthStore.getState().refreshMe()` to keep the local Zustand state in sync with the persisted server value. This ensures `pickLandingPathForUser` uses the most recent `last_active_org_slug` on subsequent calls (e.g. if the user opens a new tab while still in the same session).

---

### F-9 — INFO: No org-switch tests assert TanStack Query cache state

**File:** `frontend/src/features/orgs/__tests__/orgSwitcher.test.tsx`

The existing `OrgSwitcher` test verifies that `patchMe` is called and that navigation occurs. It does not assert that any org-scoped cache entries are evicted or invalidated on switch. Because there is no current eviction (F-1), the test cannot catch that regression.

**Recommendation:** Add a test that pre-populates a query (e.g. `["org", "acme", "members"]`) into the `QueryClient` before switching org and asserts that the query is removed/invalidated afterward. This will fail until F-1 is fixed, making it a useful regression guard.

---

### F-10 — INFO: `roleRoutes` array in `routes.tsx` is imported in App.tsx individually (routes spread manually), making the `roleRoutes` export unused

**File:** `frontend/src/features/roles/routes.tsx:19-25` and `frontend/src/App.tsx:40-44, 124-154`

```ts
// routes.tsx defines this array...
export const roleRoutes: RouteObject[] = [
  { path: "/o/:orgSlug/scoring", element: <ScorerLandingPage /> },
  ...
];

// But App.tsx imports and registers the pages individually — roleRoutes is never used:
import { ScorerLandingPage } from "@/features/roles/ScorerLandingPage";
...
<Route path="/o/:orgSlug/scoring" element={<ScorerLandingPage />} />
```

The `roleRoutes` array is defined but the routes in `App.tsx` are registered manually rather than via `{...roleRoutes}`. This means the comment in `routes.tsx` (`"Spread into the protected <AppShell> route block in App.tsx"`) is inaccurate and any future route added to `roleRoutes` alone would not be registered.

**Recommendation:** Either (a) remove `roleRoutes` and keep App.tsx as the single source, or (b) spread `roleRoutes` in `App.tsx` and delete the individual `<Route>` entries. The current dual-definition is a latent source of drift.

---

## Gaps (forward-looking, not current bugs)

### G-1 — Phase 1B cache eviction plan is unspecified

When Phase 1B adds `Tournament`, `Match`, and `MatchEvent` endpoints, every tournament-scoped query must be evicted on org switch. The current architecture has no org-switch hook; F-1 must be resolved before Phase 1B lands to avoid cross-org tournament data bleed.

**Effort:** S  
**Blocking:** Yes — must precede Phase 1B endpoint implementation.

---

### G-2 — `effective_modules` is embedded in Zustand, not reactively fetched

All module-gating logic (`canViewDirectory`, `canEdit`, `computeNavItems`, `computeDashboardCards`) reads `effective_modules` from the Zustand user snapshot. If grants change server-side (by an admin in another session), the UI does not update until the next bootstrap. Phase 1B real-time surfaces (live scoring, referee console) will need a reactive module check or at minimum a `refreshMe()` on WebSocket connect.

**Effort:** M  
**Blocking:** No for Phase 1A; Yes for Phase 1B live surfaces.

---

### G-3 — `team_manager` nav item uses role-string gating instead of a module

`computeNavItems.ts:137-145` gates the "Team" nav item on `roles.includes("team_manager")` because no `tournament.team_manager_workspace` module exists in the v1Users Appendix A.2 catalog. When Phase 1B introduces the team workspace module, this check must be migrated to `hasModule(...)` or the nav item will be visible to users whose `team_manager` role was revoked but who hold a grant.

**Effort:** S  
**Blocking:** No for Phase 1A.

---

### G-4 — No test covers cross-org UI bleed scenario

There is no test that verifies user A in org X cannot see cached org Y data after switching. This test is critical for the multi-tenancy isolation invariant (architectural invariant #2).

**Effort:** S  
**Blocking:** Yes — required by invariant #2 before production.
