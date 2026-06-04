# Audit: fe-landingerrors — Frontend State & Data Flow
**Lens:** TanStack cache correctness + invalidation; Zustand store correctness; multi-org context switch must refetch + evict org-scoped data (no cross-org UI bleed).
**Date:** 2026-06-04
**Files reviewed:** frontend/src/features/**, frontend/src/api/**, frontend/src/App.tsx, frontend/src/main.tsx

---

## CRITICAL Findings

### F1 — Logout does not flush TanStack query cache (cross-org / cross-user data bleed)
**Severity:** critical
**File:** `frontend/src/features/auth/authStore.ts:139-152`
**Evidence:**
```ts
logout: async () => {
  try {
    await authApi.logout();
  } catch {}
  pendingCredentials = null;
  set({ user: null, requires2FA: false, error: null, isLoading: false });
},
```
`queryClient.clear()` or `queryClient.removeQueries()` is never called on logout. All cached data — including `["org", orgSlug, "members"]`, `["org", orgSlug, "detail"]`, `["permissions", "matrix", orgSlug]`, `["audit", slug, ...]` — persists in the TanStack cache. A second user logging in on the same browser session (shared computer, admin handoff) will see the first user's org member list, permission matrix, and audit log entries before their own data loads. The gcTime of 5 minutes (queryClient.ts:27) makes this window worse.

**Recommendation:** Call `queryClient.clear()` inside `authStore.logout()` after clearing auth state. Similarly call it in `authStore.clear()` for the global 401 path. Both callers (`AppShell.handleSignOut` and `AuthBusBridge`) rely on those store methods.

---

### F2 — Org switch does NOT invalidate or evict cached org-scoped queries
**Severity:** critical
**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:38-42`
**Evidence:**
```ts
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```
Switching org navigates and fires a best-effort PATCH but never touches the query cache. Because query keys include `orgSlug` (e.g. `["org", orgSlug, "members"]`), the new org's data is fetched fresh — that part is correct. However:
1. The **old org's queries remain in cache with gcTime=5min**. If the user navigates back to the old org URL (browser back, bookmarks), they see stale data until revalidation.
2. More critically, `OrgSwitcherStore.currentSlug` (Zustand) is updated asynchronously via the `AppShell` `useEffect` (AppShell.tsx:43-45), not synchronously in `onPickOrg`. There is a render window where `currentSlug` in the store still holds the old org slug while the URL has already changed, and any component that reads `useOrgSwitcher().currentSlug` directly (not `useParams`) may render stale org identity.

**Recommendation:**
- In `onPickOrg`, call `queryClient.invalidateQueries({ queryKey: ["org", current.org_slug] })` before navigating to eagerly mark old-org data as stale.
- Alternatively call `setSlugFromUrl(m.org_slug)` synchronously in `onPickOrg` so the Zustand slug is updated before the navigation effect fires.

---

## HIGH Findings

### F3 — `OrgSettingsPage` writes back with `qc.setQueryData` but does not invalidate membership data in authStore
**Severity:** high
**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:189-195`
**Evidence:**
```ts
onSuccess: (next) => {
  toast.push({ kind: "success", title: t("Organization settings saved") });
  qc.setQueryData(["org", orgSlug, "detail"], next);
},
```
When the org name or timezone changes, the TanStack cache is updated inline. However `user.memberships[i].org_name` in the authStore Zustand state is NOT refreshed. This means `OrgSwitcher` (which renders `m.org_name` from `user.memberships`), `OrgChooserPage` (same), and `OrgDashboardPage` (displays `membership?.org_name`) all continue showing the old org name until the user reloads or a new `authApi.me()` round-trip occurs.

**Recommendation:** After a successful org PATCH, call `useAuthStore.getState().refreshMe()` to sync the membership list in the auth store, or at minimum invalidate and refetch the `/me/` data so the membership `org_name` stays coherent with the setting update.

---

### F4 — `OwnershipTransferModal` invalidates `["org", orgSlug]` (prefix) but `authStore` user object still has old ownership data
**Severity:** high
**File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:63-70`
**Evidence:**
```ts
onSuccess: () => {
  toast.push({ kind: "success", title: t("Ownership transferred") });
  qc.invalidateQueries({ queryKey: ["org", orgSlug] });
  onOpenChange(false);
},
```
The TanStack cache is broad-invalidated (all keys under `["org", orgSlug]`), which correctly triggers refetches for members/settings/branding/detail. However `user.memberships[i].is_org_owner` in the Zustand authStore is not refreshed. The transferring user will still see the owner-tier UI permissions (canManage, canEdit checks derived from `membership?.is_org_owner`) until the page refreshes or `refreshMe()` is called.

**Recommendation:** Call `useAuthStore.getState().refreshMe()` after a successful ownership transfer (or navigate away, which triggers a full re-bootstrap).

---

### F5 — `InviteAcceptPage` refreshes auth store but does not invalidate org-scoped TanStack queries
**Severity:** high
**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:46-51`
**Evidence:**
```ts
const res = await orgsApi.acceptInvitation(token);
setOrgSlug(res.org_slug);
await refreshMe();  // updates authStore user with new membership
setState("ok");
```
`refreshMe()` correctly updates the authStore with the new membership. But any already-cached `["org", res.org_slug, "members"]` query from a previous visit (same browser session, cache still warm) is NOT invalidated. A user who was already cached as a non-member and then accepts an invite could briefly see stale member-list data (or a "no permission" card from the old effective_modules set) until the 30s staleTime expires.

**Recommendation:** After `refreshMe()` resolves, call `qc.invalidateQueries({ queryKey: ["org", res.org_slug] })` to force a fresh fetch of all data the new membership may unlock.

---

### F6 — `authStore.bootstrap()` 403 responses cause error state rather than treating them as unauthenticated
**Severity:** high
**File:** `frontend/src/features/auth/authStore.ts:44-61`
**Evidence:**
```ts
bootstrap: async () => {
  set({ isLoading: true, error: null });
  try {
    const me = await authApi.me();
    set({ user: me, isLoading: false, bootstrapped: true });
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
},
```
The known issue (listed in the task description as "(b)") is that `/api/accounts/me/` returns 403 when logged out. The bootstrap only handles 401 silently; a 403 falls through to the error branch and sets `error: "Forbidden"` (or similar). `ProtectedRoute` then redirects to `/login?next=...` because `user` is null, but the `error` field is left set. `LoginPage` renders `{error ? <div role="alert">{error}</div> : null}` (line 107-113) — but it reads from `useAuthStore((s) => s.error)`. Since the store error is NOT cleared on navigation to `/login`, the "Forbidden" error banner appears on the login page for any cold-load by an unauthenticated user.

**Recommendation:** In the `catch` branch of `bootstrap`, explicitly check for 403 and treat it the same as 401 (clear user, no error set). `ApiError.isUnauthenticated` already covers this case for some 403 payloads (api.ts:34-45) — use that getter instead of a raw status check: `if (e instanceof ApiError && (e.status === 401 || e.isUnauthenticated))`.

---

## MEDIUM Findings

### F7 — `OrgAuditLogPage` pagination cursor is included in query key, creating orphan cache entries
**Severity:** medium
**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:70-77`
**Evidence:**
```ts
const [cursor, setCursor] = React.useState<string | null>(null);
const query = useQuery({
  queryKey: ["audit", slug, cursor],
  queryFn: () => auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
  enabled: Boolean(slug && hasModule),
});
```
Each paginated page creates a separate cache entry `["audit", slug, "cursor-abc123"]`. With gcTime=5min, all visited pages accumulate in cache. When the user switches org and returns, all old cursor-keyed audit entries for the old org sit in the cache for 5 minutes. This is a memory concern at scale, and more importantly, it means `queryClient.invalidateQueries({ queryKey: ["audit", slug] })` would correctly invalidate them (the slug prefix matches), but no code currently calls that invalidation. The "Refresh" button only calls `query.refetch()` which only refetches the current cursor page.

**Recommendation:** On org switch, invalidate `["audit"]` or scope invalidation by slug. Also consider using `keepPreviousData` or switching to `placeholderData` to avoid flashing empty states during cursor transitions.

---

### F8 — `OrgSwitcherStore` `activeRole` is not reset when switching orgs
**Severity:** medium
**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:44-46` and `OrgSwitcherStore.ts:21`
**Evidence:**
```ts
// OrgSwitcher.tsx
const onPickRole = (r: Role): void => {
  setActiveRole(r);
};
// OrgSwitcher.tsx onPickOrg — no call to setActiveRole(null)
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```
When the user switches org, `activeRole` in the Zustand store is not reset. If OrgA set activeRole to "referee" and the user switches to OrgB (where they are an "admin" with no "referee" role), the stored `activeRole = "referee"` persists. Any component that reads `useOrgSwitcher().activeRole` for role-based display logic will display "referee" for the new org context until the user manually switches roles.

**Recommendation:** In `onPickOrg`, call `setActiveRole(null)` to clear the role before navigating.

---

### F9 — `OrgBrandingPage` and `OrgSettingsPage` share query key `["org", orgSlug, "detail"]` — a setQueryData in one may silently hydrate the other
**Severity:** medium
**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:194` and `frontend/src/features/orgs/OrgBrandingPage.tsx:115`
**Evidence:**
```ts
// OrgSettingsPage.tsx:157
queryKey: ["org", orgSlug, "detail"],
// OrgBrandingPage.tsx:115
queryKey: ["org", orgSlug, "detail"],
// OrgSettingsPage.tsx:194 (onSuccess)
qc.setQueryData(["org", orgSlug, "detail"], next);
```
Both pages fetch the same endpoint `/api/orgs/${orgSlug}/` under the same query key. This is intentional cache sharing. However, the `OrgSettingsPage.onSuccess` handler calls `qc.setQueryData` with the full PATCH response — this will hydrate the branding page's query too, replacing any cached detail with the PATCH response without a fresh GET. If the PATCH response shape ever diverges from the GET response shape (e.g., partial responses), the branding page will render stale/partial data. Additionally, `OrgBrandingPage` uses a `useQuery` with `enabled: Boolean(orgSlug) && canEdit` — when both pages mount in different tabs (same SPA session), the first to resolve sets the cache for both. Not a bug today but a fragile contract.

**Recommendation:** Document this intentional sharing with a comment in both query definitions. For the `setQueryData` call in `OrgSettingsPage`, verify the PATCH response type exactly matches the GET response shape, or use `qc.invalidateQueries` instead of `setQueryData` to force a clean refetch.

---

### F10 — `queryClient` `refetchOnWindowFocus: false` means org-scoped data never auto-refreshes after background navigation
**Severity:** medium
**File:** `frontend/src/api/queryClient.ts:29`
**Evidence:**
```ts
defaultOptions: {
  queries: {
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  },
```
`refetchOnWindowFocus: false` disables the standard TanStack mechanism that re-fetches stale queries when the browser tab regains focus. Combined with `staleTime: 30_000`, data fetched for an org can be up to 30 seconds stale on return from a background tab. For a scorer or referee workflow in Phase 1B (live match data), this will need to be revisited. For Phase 1A it primarily affects member directory and permissions pages — low severity for now — but setting this globally means org admins won't see membership changes made by another admin tab without a manual refresh.

**Recommendation:** Consider setting `refetchOnWindowFocus: true` for org-scoped queries (via per-query override), or document the staleness contract explicitly. At minimum, the decision should be revisited before live-scoring features ship.

---

## LOW Findings

### F11 — `authStore.bootstrap()` status check hardcodes `=== 401` instead of using `isUnauthenticated` getter
**Severity:** low
**File:** `frontend/src/features/auth/authStore.ts:50-52`
**Evidence:**
```ts
if (e instanceof ApiError && e.status === 401) {
  set({ user: null, isLoading: false, bootstrapped: true });
  return;
}
```
The `ApiError.isUnauthenticated` getter (api.ts:33-45) already encodes the 401 + certain 403 logic. The bootstrap path uses a raw status check. This is inconsistent and means that a 403 with `detail: "not authenticated"` from `/me/` will not be silently swallowed. This directly causes the premature error banner on the login page (see F6).

**Recommendation:** Replace with `if (e instanceof ApiError && e.isUnauthenticated)`.

---

### F12 — `ModuleMatrixPage` unsaved `edits` state persists across org navigation (Zustand-less local state, no cleanup)
**Severity:** low
**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:85`
**Evidence:**
```ts
const [edits, setEdits] = useState<PendingMap>({});
```
The unsaved edits map is held in local React state. When a user has unsaved edits and switches org via the OrgSwitcher (navigating to a different `:orgSlug`), the component unmounts and the edits are lost silently — no unsaved-changes warning is shown. This is the correct behavior for local state (no persistence), but the component also doesn't call `onResetAll` on unmount, meaning if the component were kept alive (e.g. in a future tab/panel architecture), edits from OrgA would persist visually into OrgB's matrix.

**Recommendation:** If the component is ever kept mounted across org navigations in future (e.g. nested layout), add a `useEffect` that calls `setEdits({})` when `orgSlug` changes. Add a `useBlocker` or `window.onbeforeunload` warning for unsaved edits on navigation.

---

## Gaps (Forward-Looking)

| # | Gap | Effort | Needed for |
|---|-----|--------|-----------|
| G1 | No `queryClient.clear()` on logout/401-eviction — must be added before any shared-device or multi-user scenario is viable | S | Security; cross-org/cross-user data isolation |
| G2 | `authStore.refreshMe()` is fire-and-forget; callers (InviteAcceptPage) await it but it silently swallows errors; no signal back to pages if refresh fails | S | Reliability |
| G3 | No test covering the "org switch → old org data eviction" path. The `orgSwitcher.test.tsx` only asserts navigation + PATCH, not cache state | M | Multi-org regression coverage |
| G4 | No test covering "logout → re-login as different user sees fresh data" (cache bleed scenario) | M | Security / multi-user regression |
| G5 | `OrgAuditLogPage` cursor-based pagination has no built-in prefetching (`queryClient.prefetchQuery` on next cursor) — each page click causes a loading flash | M | Phase 1B UX |
| G6 | The `["org", orgSlug, "detail"]` shared query key between `OrgSettingsPage` and `OrgBrandingPage` is undocumented; a future phase adding `OrgTournamentsPage` could accidentally share stale data | S | Maintainability |
| G7 | `refetchOnWindowFocus: false` global default needs revisiting for Phase 1B live-match surfaces | M | Phase 1B scorer/referee flow |
| G8 | No `useBlocker` or `beforeunload` for unsaved `ModuleMatrixPage` edits | S | UX / data loss prevention |
