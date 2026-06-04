# Audit: fe-core — TanStack Cache Correctness + Invalidation / Zustand Store Correctness / Multi-Org Context Switch

**Area:** `frontend/src`  
**Lens:** TanStack Query cache correctness and invalidation; Zustand store correctness; multi-org context switch must refetch and evict org-scoped data (no cross-org UI bleed).  
**Date:** 2026-06-04

---

## Summary

The overall cache architecture is sound: all org-scoped queries key on `orgSlug`, so a slug change produces distinct cache keys and React Query naturally fetches fresh data for the new org without any invalidation call. However, four genuine defects were found:

1. **Critical: TanStack cache is never cleared on logout or 401.** Cached data from one session survives into the next (cross-user bleed).
2. **High: `OrgSwitcherStore.activeRole` is never reset on org switch** — a role chosen in Org A bleeds into Org B for multi-role users.
3. **High: `OrgAuditLogPage` cursor state not reset on org switch** — switching org while on the audit log page shows the old org's cursor-paginated data momentarily.
4. **Medium: `OrgSettingsPage.update` uses `qc.setQueryData` after a PATCH** but does not also invalidate the `["org", orgSlug]` prefix, so if `OwnershipTransferModal` is used while the settings page is open the two caches diverge.
5. **Medium: `ModuleMatrixPage` pending edits (`edits` state) are not reset when `orgSlug` changes** — stale unsaved edits from Org A can be submitted against Org B if the user navigates quickly.

No cross-org data bleed was found at the query-key level (all keys include `orgSlug`).

---

## Findings

### F1 — Critical: TanStack query cache not cleared on logout or global 401

**File:** `frontend/src/features/auth/authStore.ts:139–152` / `frontend/src/App.tsx:49–63`

**Evidence:**
```ts
// authStore.ts:139
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
```ts
// App.tsx:54
onAuthEvent((e) => {
  if (e.type === "unauthenticated") {
    clear();
    navigate(routes.login());
  }
}),
```

Neither `logout()` nor the `AuthBusBridge` 401 handler calls `queryClient.clear()`. After logout, the TanStack Query cache still holds all previously fetched org data (`["org", slug, "members"]`, `["org", slug, "detail"]`, `["permissions", "matrix", slug]`, `["audit", slug, cursor]`). If the same browser tab is reused for a second user's login (or if a different user logs in on a shared device), they momentarily see the prior user's member list, permission matrix, and settings — cached data served before the new user's queries resolve.

This is the same class of defect that caused data leaks in multi-tenancy apps.

**Severity:** Critical  
**Recommendation:** In both `logout()` and the `AuthBusBridge` unauthenticated handler, call `queryClient.clear()` immediately before navigating. `queryClient` is a module-level singleton so it can be imported directly:
```ts
import { queryClient } from "@/api/queryClient";
// inside logout:
queryClient.clear();
// inside AuthBusBridge handler:
queryClient.clear();
```

---

### F2 — High: `activeRole` in OrgSwitcherStore not reset on org switch

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:38–43` / `frontend/src/features/orgs/OrgSwitcherStore.ts:18–23`

**Evidence:**
```ts
// OrgSwitcher.tsx:38
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```
When picking a new org, `setActiveRole` is never called to clear `activeRole`. The store has:
```ts
// OrgSwitcherStore.ts:20
activeRole: null,
```
But if User A is in Org A as `admin` and manually sets their active role to `admin` via the radiogroup, then switches to Org B (where they hold `match_scorer` and `referee`), the `activeRole` is still `"admin"` — which is not a valid role in Org B. The role radiogroup defaults correctly via `(activeRole ?? currentRoles[0])` if `activeRole` happens to not match any role in the new membership's `currentRoles`, but there is no explicit reset, and `activeRole` remains as stale state.

For users where the stale `activeRole` string happens to match a role name in the new org (e.g. both orgs have an `admin` role), the role is silently carried over without reflecting their actual role in the destination org.

**Severity:** High  
**Recommendation:** Reset `activeRole` to `null` in `onPickOrg`:
```ts
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  setActiveRole(null);  // clear stale role context
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```

---

### F3 — High: Audit log cursor state not reset on org switch

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:68–77`

**Evidence:**
```ts
// OrgAuditLogPage.tsx:68
const [cursor, setCursor] = React.useState<string | null>(null);

const query = useQuery<...>({
  queryKey: ["audit", slug, cursor],
  queryFn: () => auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
  enabled: Boolean(slug && hasModule),
});
```

The `cursor` state is component-local React state. If the user navigates from Org A's audit log (with a cursor set to page 3) to Org B's audit log by using the org switcher without unmounting the component (same route pattern `/o/:orgSlug/audit`), the `cursor` value persists from Org A. The query key changes (`slug` changes) so a new fetch IS triggered — but the fetch uses the stale Org A cursor value, sending `?cursor=<org-A-cursor>` to Org B's endpoint. The backend will return an error or an empty response since Org A's cursor is meaningless to Org B, leaving the user stranded on an error screen.

React's route system unmounts and remounts the component if React Router recreates the element, but because the route path pattern `/o/:orgSlug/audit` is identical and React Router reuses the same component instance when only `orgSlug` changes, the local state is NOT reset automatically.

**Severity:** High  
**Recommendation:** Add a `useEffect` that resets `cursor` to `null` when `slug` changes:
```ts
useEffect(() => {
  setCursor(null);
}, [slug]);
```

---

### F4 — Medium: `OrgSettingsPage` uses `setQueryData` but not `invalidateQueries` on success — diverges from `OwnershipTransferModal`

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:189–195`

**Evidence:**
```ts
// OrgSettingsPage.tsx:189
onSuccess: (next) => {
  toast.push({ kind: "success", title: t("Organization settings saved") });
  qc.setQueryData(["org", orgSlug, "detail"], next);
},
```

`OrgSettingsPage` updates the `["org", orgSlug, "detail"]` cache entry directly via `setQueryData`. Meanwhile `OwnershipTransferModal` uses the broader invalidation:
```ts
// OwnershipTransferModal.tsx:68
qc.invalidateQueries({ queryKey: ["org", orgSlug] });
```

The `setQueryData` call in settings is missing a paired `invalidateQueries` (or at least an `invalidateQueries` call for the `["org", orgSlug, "detail"]` key). The practical issue: after a settings PATCH, the `setQueryData` write updates the org detail cache with the new server response, which is correct at that moment. However, `OrgBrandingPage` has its own `useQuery` for `["org", orgSlug, "detail"]` (same key), and that query will pick up the new cached value without an explicit invalidation — that part is fine. But if `OrgSettingsPage` was modified in the future, the `setQueryData` pattern without invalidation leaves the cache in a manually managed state that is easy to get wrong.

More concretely: if an admin saves org settings and concurrently another admin triggers an ownership transfer (which does `invalidateQueries({ queryKey: ["org", orgSlug] })`), the settings page cache entry (`["org", orgSlug, "detail"]`) is refetched, overwriting the optimistic `setQueryData` value with the authoritative server state. This is actually _correct behavior_ but is not documented or tested, making it fragile.

**Severity:** Medium  
**Recommendation:** Replace the `setQueryData` call with an `invalidateQueries` call for consistency, or at minimum document the intentional split between the two invalidation strategies:
```ts
onSuccess: () => {
  toast.push({ kind: "success", title: t("Organization settings saved") });
  // Invalidate to refetch authoritative state rather than managing manually.
  qc.invalidateQueries({ queryKey: ["org", orgSlug, "detail"] });
},
```

---

### F5 — Medium: `ModuleMatrixPage` pending edits not cleared on orgSlug change

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:85` / line 154

**Evidence:**
```ts
// ModuleMatrixPage.tsx:85
const [edits, setEdits] = useState<PendingMap>({});
```
The `edits` PendingMap is keyed by `user_id`. If a user navigates from Org A's `/permissions` to Org B's `/permissions` (same route pattern, same component instance reused by React Router), the `edits` state carries over. Because user IDs are UUIDs and are shared across orgs (same `Person` identity), a user who exists in both Org A and Org B would find their Org A pending permission edits still in the matrix for Org B (the cells render the org-B server data for `stored` but layer `rowEdits[m.key]` from Org A on top via `eff: GrantState = rowEdits[m.key] ?? stored`). Pressing "Save row" would then submit the Org A cell values to Org B's grants endpoint.

This is a genuine cross-org mutation risk where a permission edit intended for Org A could silently be applied to Org B.

**Severity:** Medium  
**Recommendation:** Add a `useEffect` that resets `edits` when `orgSlug` changes:
```ts
useEffect(() => {
  setEdits({});
}, [orgSlug]);
```

---

### F6 — Low: `InviteAcceptPage` calls `refreshMe()` but does not invalidate TanStack org-scoped queries after join

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:41–49`

**Evidence:**
```ts
// InviteAcceptPage.tsx:41
const onAccept = async (): Promise<void> => {
  setState("loading");
  setError(null);
  try {
    const res = await orgsApi.acceptInvitation(token);
    setOrgSlug(res.org_slug);
    // Backend cycles the session — refresh local user state.
    await refreshMe();
    setState("ok");
  } catch (e) { ... }
};
```

After accepting an invitation, `refreshMe()` re-fetches `/api/accounts/me/` and updates the Zustand store with the new membership. However, any already-cached TanStack queries for the newly joined org (if the user had previously browsed to that org's public surface or visited the org URL while unauthenticated) are not invalidated. In practice, for a fresh session this matters less. But if the user already had org data in the cache (e.g. they were previously a member who left and re-joined), the stale data persists for up to `staleTime` (30 seconds). The `refreshMe()` call updates the Zustand user store but the query cache is independent.

**Severity:** Low  
**Recommendation:** After `refreshMe()`, invalidate org queries for the newly accepted org:
```ts
await refreshMe();
qc.invalidateQueries({ queryKey: ["org", res.org_slug] });
```

---

### F7 — Low: `30_000 ms staleTime` with `refetchOnWindowFocus: false` means members/permissions seen immediately after a bulk change are up to 30 s stale

**File:** `frontend/src/api/queryClient.ts:26–29`

**Evidence:**
```ts
// queryClient.ts:26
queries: {
  staleTime: 30_000,
  gcTime: 5 * 60_000,
  retry: 1,
  refetchOnWindowFocus: false,
},
```

All queries — including `["org", slug, "members"]` and `["permissions", "matrix", slug]` — use a 30-second stale window with no window-focus refetch. For a multi-admin scenario (Org A admin A adds member via the backend or another browser tab), Admin B on the members page will see the old list for up to 30 seconds. Given this is a live sports platform context, this is tolerable for Phase 1A but will need revisiting when Phase 1B live features ship. Mutations do correctly call `invalidateQueries` to force a refresh after the current user's own mutations.

**Severity:** Low  
**Recommendation:** Document the 30 s staleTime as an intentional performance trade-off. Consider dropping it to 0 or re-enabling `refetchOnWindowFocus: true` for org-scoped data pages once Phase 1B ships collaborative editing.

---

### F8 — Info: `OrgSwitcherStore` comment says "nothing else should write" but `logout`/`clear` don't reset `currentSlug`

**File:** `frontend/src/features/orgs/OrgSwitcherStore.ts:9` / `frontend/src/features/auth/authStore.ts:154–156`

**Evidence:**
```ts
// OrgSwitcherStore.ts:9
// `setSlugFromUrl` is called from a router-aware effect inside <AppShell>;
// nothing else should write here.
```
```ts
// authStore.ts:154
clear: () => {
  pendingCredentials = null;
  set({ user: null, requires2FA: false, error: null, isLoading: false });
},
```

After logout, `OrgSwitcherStore.currentSlug` and `activeRole` remain set to the last org. On the login page, `AppShell` is not rendered so these values are harmless. Once a new user logs in and `AppShell` mounts, the `useEffect` in AppShell sets `currentSlug` from the new URL's `orgSlug` parameter — so for normal flows this is fine. However if a new user logs in without an `orgSlug` in the URL (e.g. they're redirected to `/orgs`), the stale slug from the previous user remains in `currentSlug` until the next route with a slug is visited.

**Severity:** Info  
**Recommendation:** Add `currentSlug: null, activeRole: null` to the `authStore.clear()` call, or add a `reset` action to `OrgSwitcherStore` and call it from `authStore.logout()`.

---

## Gaps (forward-looking, not currently broken)

| # | Area | Missing | Needed for | Effort | Blocking? |
|---|------|---------|-----------|--------|-----------|
| G1 | Phase 1B live features | No WebSocket/SSE cache invalidation hook — when live match events fire, member list / permissions won't auto-refresh | Invariant #11 (SSE one-way) and #4 (DB-first event log) | M | No |
| G2 | OrgSwitcherStore | No `persist` or `sessionStorage` backing — if the tab crashes and reloads, `currentSlug` / `activeRole` are lost and the user starts from whatever URL the browser restores | UX continuity on crash-reload | S | No |
| G3 | Pagination | `OrgAuditLogPage` cursor pagination is purely client-local; there is no `infiniteQuery` or bookmark-able cursor URL parameter — deep-linking to page 5 is impossible | Audit log usability | M | No |
| G4 | TanStack Devtools | No `@tanstack/react-query-devtools` conditional import present; visibility into cache state during development requires manual inspection | Developer experience | S | No |
| G5 | Multi-tab | No broadcast channel / `BroadcastChannel` or `visibilitychange`+`refetchOnWindowFocus` strategy for multi-tab org-switch sync | Two tabs showing different orgs out of sync | M | No |
| G6 | `ModuleMatrixPage` edits state | There is no "unsaved changes" navigation guard (`useBlocker` / `beforeunload`) — navigating away silently discards pending edits | UX — permission edit loss | S | No |
