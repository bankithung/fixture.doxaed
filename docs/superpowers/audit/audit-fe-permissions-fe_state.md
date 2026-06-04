# Audit: fe-permissions — TanStack Cache Correctness, Zustand Store, Org-Switch Eviction

**Area:** `frontend/src/features/permissions/` + related store/cache infrastructure  
**Lens:** TanStack cache correctness + invalidation; Zustand store correctness; multi-org context switch must refetch + evict org-scoped data (no cross-org UI bleed)  
**Date:** 2026-06-04

---

## Findings

### F1 — HIGH: No cache eviction on org switch — stale auth-store `effective_modules` persists

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:38-42`  
**Evidence:**
```ts
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```
`authStore.user.memberships[*].effective_modules` is what controls nav visibility (`computeNavItems.ts:57`), module-gating in `MemberDirectoryPage.tsx:264`, `OrgSettingsPage.tsx:136`, `OrgBrandingPage.tsx:97`, and `OrgAuditLogPage.tsx:66`. These all read from the stale authStore snapshot — **no `refreshMe()` is called after org switch**. If an admin granted or revoked a module for the user between two org visits (or if the user was just added to org B with different modules), the stale membership data drives the UI. Nav items could appear/disappear incorrectly, and wrong module gates can be shown or hidden.

**Why it matters:** Cross-org UI bleed from stale `effective_modules`. A user switching from Org A (admin) to Org B (viewer) will see admin nav items briefly (or permanently if no background refetch occurs), because `authStore` is never re-hydrated from `/api/accounts/me/` on switch. This is the primary cross-org contamination vector for the permissions surface.

**Recommendation:** In `onPickOrg`, call `useAuthStore.getState().refreshMe()` (or dispatch via the Zustand action) after navigation. Alternatively, add an `invalidateQueries({ queryKey: ["me"] })` if `/me/` is also managed by TanStack, but currently it is not — it lives only in Zustand. The simplest fix is adding `useAuthStore.getState().refreshMe()` at the end of `onPickOrg`. Add a test asserting that `authStore.user` is re-hydrated after an org switch.

---

### F2 — HIGH: No TanStack cache eviction on logout — cross-user data leak risk

**File:** `frontend/src/App.tsx:54-59` + `frontend/src/features/auth/authStore.ts:139-152`  
**Evidence (App.tsx):**
```ts
onAuthEvent((e) => {
  if (e.type === "unauthenticated") {
    clear();
    navigate(routes.login());
  }
});
```
**Evidence (authStore logout):**
```ts
logout: async () => {
  try {
    await authApi.logout();
  } catch { }
  pendingCredentials = null;
  set({ user: null, requires2FA: false, error: null, isLoading: false });
},
```
Neither the `logout` action nor the `AuthBusBridge` calls `queryClient.clear()`, `queryClient.removeQueries()`, or any form of cache invalidation. The TanStack cache retains all org-scoped queries (matrix rows, member lists, audit log entries, org details) for `gcTime` = 5 minutes after the last observer unmounts. If User A logs out and User B logs in on the same tab within that 5-minute window, User B's initial renders can display User A's cached permission matrix rows, member lists, and org branding data before background refetch replaces them.

**Why it matters:** Sensitive data (member emails, permission override states, org names) cached for User A leaks visually to User B. This violates the multi-tenancy isolation requirement (Invariant #2) at the UI layer.

**Recommendation:** In `authStore.logout` (and in `AuthBusBridge` for the forced 401 path), call `queryClient.clear()` (or at minimum `queryClient.removeQueries()` for all org-scoped keys) before navigating to `/login`. Import `queryClient` from `@/api/queryClient`. Add a test that verifies the query cache is empty immediately after logout.

---

### F3 — MEDIUM: `orgSlug` closure in `saveRow.onSuccess` can invalidate wrong key on rapid navigation

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:69` + `106-108`  
**Evidence:**
```ts
const { orgSlug = "" } = useParams<{ orgSlug: string }>();
// ...
onSuccess: (_data, vars) => {
  // ...
  qc.invalidateQueries({
    queryKey: ["permissions", "matrix", orgSlug],
  });
},
```
`orgSlug` is captured from `useParams` at the time the component renders. It is closed over in the `useMutation` config object. If the user navigates to a different org while a `saveRow` PUT is in-flight (e.g., via the OrgSwitcher), `orgSlug` in the closure will have changed to the new URL's slug by the time `onSuccess` fires. The invalidation will then incorrectly evict the NEW org's matrix cache (which was just freshly fetched) rather than the OLD org's cache. The old org's cache will remain stale.

**Why it matters:** Post-save invalidation fires on the wrong org key — the user's just-saved grants for Org A are not confirmed by a server refetch, but Org B's freshly-loaded data is unnecessarily refetched. Low probability but correctness bug.

**Recommendation:** Capture the slug used for the mutation in `mutationFn`'s variable (e.g., pass it in the mutation variables alongside `userId`/`cells`) so `onSuccess` can reference the original slug from `vars` rather than the current render's `orgSlug`. Or use `mutationKey` to pin the slug.

---

### F4 — MEDIUM: `permissionsApi.myModules` is defined but never called — dead API surface

**File:** `frontend/src/api/permissions.ts:12-14`  
**Evidence:**
```ts
myModules: (slug: string) =>
  api.get<{ modules: string[] }>(`/api/permissions/orgs/${slug}/me/modules/`),
```
This endpoint is defined but has zero callers in the frontend codebase. `effective_modules` for the current user is consumed exclusively from `authStore.user.memberships[*].effective_modules`, which is populated via `/api/accounts/me/` at bootstrap. The dedicated per-org modules endpoint is never used, meaning any discrepancy between the `/me/` snapshot and the live `/me/modules/` response (e.g., an admin just changed grants) is invisible until the next full re-login or manual `refreshMe`.

**Why it matters:** Dead code creates maintenance burden and false confidence that live module state is being polled. If `effective_modules` becomes stale (see F1), there is no mechanism in the current code to refresh it without a full `refreshMe`. The dedicated endpoint exists to solve exactly this — but is unused.

**Recommendation:** Either (a) remove `myModules` and document that `effective_modules` is authoritative from the `/me/` bootstrap + explicit `refreshMe` on org switch, or (b) use `myModules` via a background-polling query (`refetchInterval`) to keep the visible module state fresh without a full `/me/` refetch. Option (a) is simpler for Phase 1A.

---

### F5 — LOW: `useMutation` `saveRow` is shared across all rows — concurrent saves on different rows show wrong "Saving…" state

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:87-121`  
**Evidence:**
```ts
const saveRow = useMutation({ ... });
// ...
disabled={
  saveRow.isPending &&
  saveRow.variables?.userId === row.user_id
}
```
A single `useMutation` instance is used for all rows. The code correctly compares `saveRow.variables?.userId === row.user_id` to disable only the active row's button. However, if User A clicks Save for Row 1, and User B (a second tab, or a different row in the same session) clicks Save for Row 2 before Row 1 completes, TanStack will queue or replace the in-flight mutation depending on configuration (default: replace). The second `mutate()` call replaces `saveRow.variables`, so Row 1's button becomes re-enabled even though an in-flight mutation still has Row 1's data in the network pipe. Row 1's `onSuccess` will still fire correctly (it's `vars` from the closure), but the UI feedback (disabled state, "Saving…" text) desynchronises.

**Why it matters:** In practice, only one person edits the matrix at a time (single admin per org in v1), so this is low-risk for Phase 1A. It becomes a real UX bug if Phase 1B adds co-organizers who could simultaneously edit.

**Recommendation:** Use one `useMutation` instance per row (render the mutation inside a row sub-component), or maintain a `Set<string>` of currently-saving user IDs in local state and consult that rather than `saveRow.variables`.

---

### F6 — LOW: `OwnershipTransferModal` invalidates `["org", orgSlug]` (prefix key) — may accidentally refetch too broadly

**File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:68`  
**Evidence:**
```ts
qc.invalidateQueries({ queryKey: ["org", orgSlug] });
```
This prefix-invalidation will match ALL queries whose key starts with `["org", orgSlug]`, including `["org", orgSlug, "members"]`, `["org", orgSlug, "invitations"]`, and `["org", orgSlug, "detail"]`. That is intentional for post-transfer consistency, but `["permissions", "matrix", orgSlug]` uses a DIFFERENT root key (`"permissions"`) and is NOT invalidated. After an ownership transfer, the new owner's role changes (is_org_owner flips), which affects `role_defaults` in the matrix view. The matrix page will show stale `role_defaults` until manual reload.

**Why it matters:** Stale `role_defaults` after ownership transfer means the matrix shows incorrect "default (role grants)" hints for the new owner's cells. This is cosmetic but misleading.

**Recommendation:** Add `qc.invalidateQueries({ queryKey: ["permissions", "matrix", orgSlug] })` alongside the existing invalidation in `OwnershipTransferModal.onSuccess`.

---

## Gaps (forward-looking, not defects in existing code)

### G1 — No test for org-switch cache/store invalidation

**Missing:** There is no test asserting that switching org evicts stale org-scoped TanStack queries or triggers `refreshMe` on the auth store. `orgSwitcher.test.tsx` only covers navigation and `patchMe`. When F1 is fixed, a test must be added to confirm the fix.

**Effort:** S  
**Blocking for multi-org correctness:** Yes

---

### G2 — No test for logout cache eviction

**Missing:** There is no test that logs in as User A, populates the TanStack cache, logs out, and asserts the cache is empty. Without this, the F2 fix could regress silently.

**Effort:** S  
**Blocking for multi-tenant isolation:** Yes

---

### G3 — `effective_modules` is not a TanStack query — no background staleness management

**Missing:** Because `effective_modules` lives in the Zustand `authStore` (derived from the last `/me/` bootstrap), it has no TanStack staleness/refetch lifecycle. There is no `staleTime`, no `refetchOnWindowFocus`, and no `gcTime` — the data persists until logout. For a multi-org scenario where an admin revokes a module grant for another user, the affected user's UI remains out-of-date until they reload. A periodic `refreshMe` (e.g., on window focus, or as a TanStack query wrapping `/me/`) would bring this inline with the rest of the cache strategy.

**Effort:** M  
**Needed for:** Live permission updates without page reload

---

### G4 — `permissionsApi.modules()` (catalog-only endpoint) has no query and no consumer

**Missing:** Similar to `myModules`, the standalone modules catalog endpoint (`GET /api/permissions/modules/`) is defined in `permissions.ts:10` but has no TanStack `useQuery` wrapper and no callers. The matrix endpoint already returns the full catalog alongside member rows, so this is currently redundant. Should be removed or wrapped if a standalone "view module catalog" surface is ever added.

**Effort:** S  
**Needed for:** Cleanup / preventing confusion

---

### G5 — No mechanism to propagate permission changes made by admin to other logged-in users

**Missing:** When an admin saves a new grant state for User B (via the matrix), User B's open browser session retains stale `effective_modules` in their authStore. There is no WebSocket/SSE signal, no polling, and no invalidation targeting User B's session. This is a known Phase 1A limitation (SSE channel for notifications is out of scope until Phase 1B `live/` app), but should be documented as a known gap.

**Effort:** L (requires SSE + server-side push)  
**Needed for:** Real-time permission propagation (Phase 1B)
