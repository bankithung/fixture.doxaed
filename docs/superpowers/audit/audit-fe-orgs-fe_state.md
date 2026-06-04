# Audit: fe-orgs — TanStack Cache Correctness, Zustand Store, Multi-Org Context Switch

**Scope:** `frontend/src/features/orgs/` (all files) + `frontend/src/features/layout/AppShell.tsx` +
`frontend/src/features/auth/authStore.ts` + `frontend/src/api/orgs.ts` + `frontend/src/api/queryClient.ts`
**Lens:** TanStack Query cache key correctness and invalidation; Zustand store correctness; multi-org context
switch must refetch + evict org-scoped data (no cross-org UI bleed).
**Date:** 2026-06-04

---

## Summary

The org-feature state layer is structurally sound for the single-org case but has four significant gaps
around multi-org switching:

1. Org switch navigates and fires `persistLastActive` but **never invalidates any TanStack Query cache**.
   If a user was on OrgA's member directory and switches to OrgB, old data is still in cache and will
   flash before the new query resolves (staleTime = 30 s, so it may never even refetch on same-session).

2. The `activeRole` Zustand field is **never reset on org switch**, so a multi-role user moving from OrgA
   (where they had role "referee") to OrgB (where they are "admin") will momentarily display the old role
   selection if the radiogroup renders before the route effect settles.

3. `OwnershipTransferModal` invalidates only `["org", orgSlug]` — which is the correct prefix, but
   because `OrgSettingsPage` uses key `["org", orgSlug, "detail"]` and membership data lives in the Zustand
   `user.memberships` (not the query cache), a successful ownership transfer does not force a re-fetch of
   `/api/accounts/me/`, so the Zustand store continues to show `is_org_owner: true` for the previous owner
   until they reload.

4. `InviteAcceptPage` calls `refreshMe()` after accept — correct — but does NOT invalidate any TanStack
   Query cache keys (e.g. `["org", *, "members"]`, `["org", *, "invitations"]`). If the page is rendered
   inside a shell that already has those queries warm, the member list will still show the old pre-accept
   state for up to `staleTime` (30 s).

No cross-org data bleed was found in the query keys themselves — all org-scoped keys include `orgSlug`
as a segment, which provides physical isolation. The bleed risk is UI-level: stale data from a previous
org displayed in a component before the new org's query resolves.

---

## Findings

### F-01 — HIGH: Org switch does not invalidate org-scoped TanStack Query cache

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:38-42`

**Evidence:**
```tsx
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```

There is no `queryClient.invalidateQueries(...)` or `queryClient.removeQueries(...)` call here.
Navigation changes `orgSlug` in URL params (causing route-keyed queries for the NEW org to fire),
but stale data for OLD org slugs remains in cache. With `staleTime: 30_000` (30 s — see
`frontend/src/api/queryClient.ts:26`) and `refetchOnWindowFocus: false` (line 29), those entries
will not be evicted promptly. If the user navigates back to the previous org within 30 s (e.g., via
browser back then forward), they will see the cached (now stale-for-a-different-actor) data without
a network refetch.

The more critical scenario: if the user switches org while a background refetch timer is active, the
old-org's stale query will silently re-populate its cache entry and — if another route renders the same
key — could display it.

**Why it matters:** Architectural invariant #2 ("no cross-org leak via any endpoint") applies to the
UI layer too. Displaying OrgA members briefly on an OrgB member-directory is an RBAC visibility
violation in spirit even if the backend would 403 the request for the new org.

**Recommendation:** In `onPickOrg`, add:
```tsx
import { useQueryClient } from "@tanstack/react-query";
// inside component:
const qc = useQueryClient();
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  qc.removeQueries({ queryKey: ["org", current.org_slug] });
  // OR: qc.invalidateQueries({ queryKey: ["org"] }) to force refetch for all orgs
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```
`removeQueries` is preferred over `invalidateQueries` for the previous org because the data belongs to a
different org and should not be re-fetched until explicitly needed. If there are other `["audit", slug]`
or future tournament query prefixes, those must also be removed. Consider a helper
`clearOrgCache(qc, slug)` that removes all prefixes scoped to a slug.

**Confidence:** 0.95

---

### F-02 — HIGH: `activeRole` in OrgSwitcherStore is never reset on org switch

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:38-42` + `OrgSwitcherStore.ts:18-23`

**Evidence (OrgSwitcher.tsx):**
```tsx
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```

**Evidence (OrgSwitcherStore.ts):**
```ts
setSlugFromUrl: (slug) => set({ currentSlug: slug }),
setActiveRole: (role) => set({ activeRole: role }),
```

There is no `setActiveRole(null)` call in `onPickOrg`. The `AppShell` effect (line 43-45 in
`AppShell.tsx`) calls `setSlugFromUrl(orgSlug ?? null)` on route change, but `activeRole` is not
touched. For a user with `memberships[0].roles = ["admin"]` in OrgA and `memberships[1].roles =
["match_scorer", "referee"]` in OrgB, switching orgs keeps `activeRole = "admin"` in the store. The
radiogroup in OrgSwitcher.tsx then renders with `(activeRole ?? currentRoles[0]) === r` (lines 81,
85), so "admin" would be highlighted even though OrgB has no such role.

**Why it matters:** The stored `activeRole` is used for role-filtered nav items, permission gates,
and any future role-aware UI. Displaying the wrong role in OrgB is functionally misleading.

**Recommendation:** In `onPickOrg`, call `setActiveRole(null)` before navigating:
```tsx
const onPickOrg = (m: OrgMembership): void => {
  if (m.org_slug === current.org_slug) return;
  setActiveRole(null);
  navigate(routes.orgDashboard(m.org_slug));
  persistLastActive.mutate(m.org_id);
};
```
Alternatively, reset `activeRole` inside `setSlugFromUrl` (but only if slug changes), keeping the
reset co-located with the slug transition.

**Confidence:** 0.95

---

### F-03 — MEDIUM: OwnershipTransfer success does not refresh authStore user (is_org_owner bleed)

**File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:63-70`

**Evidence:**
```tsx
onSuccess: () => {
  toast.push({ kind: "success", title: t("Ownership transferred") });
  qc.invalidateQueries({ queryKey: ["org", orgSlug] });
  onOpenChange(false);
},
```

`invalidateQueries({ queryKey: ["org", orgSlug] })` will mark `["org", orgSlug, "detail"]` and
`["org", orgSlug, "members"]` stale and trigger a background refetch. However, `is_org_owner` for
the current user lives in `useAuthStore(s => s.user).memberships`, which is NOT in the TanStack
cache. After a successful transfer, the authStore user's `is_org_owner` field remains `true` for the
outgoing owner, so any component that reads `membership.is_org_owner` (e.g., `OrgSettingsPage.tsx:149`,
`dashboardCards.ts:84`) will continue to show admin-level UI until the user refreshes the page or
another action triggers `refreshMe()`.

**Why it matters:** The outgoing owner retains apparent owner-level permissions in the UI after
transferring. This is only a cosmetic issue (the backend enforces), but it could confuse the user
and allow them to attempt actions that 403 without explanation.

**Recommendation:** Call `useAuthStore.getState().refreshMe()` (or `authStore.refreshMe()` via hook)
inside `onSuccess`:
```tsx
onSuccess: async () => {
  toast.push({ kind: "success", title: t("Ownership transferred") });
  qc.invalidateQueries({ queryKey: ["org", orgSlug] });
  await useAuthStore.getState().refreshMe();
  onOpenChange(false);
},
```

**Confidence:** 0.90

---

### F-04 — MEDIUM: InviteAcceptPage does not invalidate TanStack Query cache after accept

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:41-56`

**Evidence:**
```tsx
const onAccept = async (): Promise<void> => {
  ...
  const res = await orgsApi.acceptInvitation(token);
  setOrgSlug(res.org_slug);
  await refreshMe();
  setState("ok");
  ...
};
```

`refreshMe()` updates the Zustand authStore. But if the accepting user was already on the same
domain with warm TanStack queries for the target org (e.g., they opened the invite link in a tab
where that org was already loaded), the caches for `["org", res.org_slug, "members"]` and
`["org", res.org_slug, "invitations"]` will still contain pre-accept data.

More concretely: the accepting user just became a member, but an admin looking at that org's member
directory in another tab (or the same QueryClient instance via SSR/test) will see stale data.

**Why it matters:** The invitations list panel (`InvitationsListPanel.tsx`) relies on
`["org", orgSlug, "invitations"]` being invalidated to hide the accepted invitation. It won't be
removed from "pending" in the UI until `staleTime` expires (30 s).

**Recommendation:** After `refreshMe()`, call:
```tsx
const qc = useQueryClient();
qc.invalidateQueries({ queryKey: ["org", res.org_slug, "members"] });
qc.invalidateQueries({ queryKey: ["org", res.org_slug, "invitations"] });
```
This requires importing `useQueryClient` (it is not currently imported in `InviteAcceptPage.tsx`).

**Confidence:** 0.80 (lower because this page currently navigates away immediately; the scenario is
only observable if another component in the same tab holds those cache entries warm.)

---

### F-05 — MEDIUM: OrgBrandingPage shares the `["org", orgSlug, "detail"]` cache key with OrgSettingsPage but writes nothing back

**File:** `frontend/src/features/orgs/OrgBrandingPage.tsx:114-118` and `OrgSettingsPage.tsx:156-159`

**Evidence (OrgBrandingPage):**
```tsx
const orgQuery = useQuery({
  queryKey: ["org", orgSlug, "detail"],
  queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
  enabled: Boolean(orgSlug) && canEdit,
});
```

**Evidence (OrgSettingsPage mutation onSuccess):**
```tsx
onSuccess: (next) => {
  qc.setQueryData(["org", orgSlug, "detail"], next);
},
```

These two pages share the `["org", orgSlug, "detail"]` key. When the user saves org settings, the
Settings page calls `setQueryData` directly (no invalidation). This is correct. However, OrgBrandingPage
uses the SAME key with an independently fetched query. If both pages are mounted simultaneously (e.g.,
in a router animation or nested route), they will share the same cache entry but have separate
`queryFn` closures — which is the intended TanStack behavior. This is not a bug, but it IS a coupling
that must be documented: any future shape difference between what Settings expects and what Branding
expects from `/api/orgs/{slug}/` will silently break one of them if the other has already populated
the cache.

More concretely: `setQueryData` in `OrgSettingsPage.onSuccess` writes the PATCH response into the
cache. If `OrgDetail` in `OrgSettingsPage` and `OrgDetail` in `OrgBrandingPage` diverge (they are
separate interface declarations — lines 41-51 in each file), one will type-check but the other will
have a runtime shape mismatch.

**Why it matters:** Both `OrgSettingsPage` and `OrgBrandingPage` declare a LOCAL `OrgDetail` interface
independently (not from a shared type file), meaning they can drift apart undetected. The cache key
coupling means a PATCH to settings could silently put a wrong shape into a branding query.

**Recommendation:**
1. Extract `OrgDetail` into `frontend/src/api/orgs.ts` (or `types/`) and import it in both pages.
2. Keep `setQueryData` but assert the returned type matches the shared interface.

**Confidence:** 0.85

---

### F-06 — LOW: OrgAuditLogPage pagination cursor is included in the query key — every page-turn mounts a new cache entry; no cleanup

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:71-77`

**Evidence:**
```tsx
const query = useQuery<...>({
  queryKey: ["audit", slug, cursor],
  queryFn: () => auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
  enabled: Boolean(slug && hasModule),
});
```

Including `cursor` in the query key is a common pattern for cursor-based pagination and is technically
correct: each page is its own cache entry. However, there is no `keepPreviousData` (TanStack v5:
`placeholderData: keepPreviousData`) option set, so navigating pages causes a loading flash between
pages. More importantly, every page the user visits accumulates indefinitely in cache (gc 5 minutes).
For a long audit log session this is low-risk, but it does mean there is no logical scope that evicts
all audit pages when the user switches org — after the org-switch fix (F-01) lands, care must be
taken to also evict `["audit", oldSlug, *]` cursored pages, not just `["audit", oldSlug]`.

**Recommendation:**
1. Add `placeholderData: keepPreviousData` to eliminate the flash.
2. When implementing F-01's `clearOrgCache(qc, slug)`, use prefix removal:
   `qc.removeQueries({ queryKey: ["audit", slug] })` — TanStack's prefix matching removes all cursor
   variants.

**Confidence:** 0.90

---

### F-07 — LOW: OrgSwitcher test does NOT assert cache invalidation on switch

**File:** `frontend/src/features/orgs/__tests__/orgSwitcher.test.tsx:88-101`

**Evidence:**
```tsx
it("PATCHes /me/ with last_active_org_id and navigates on switch", async () => {
  ...
  expect(patchSpy).toHaveBeenCalledWith({ last_active_org_id: "o2" });
  expect(screen.getByTestId("loc").textContent).toBe("/o/globex/dashboard");
});
```

The test verifies PATCH + navigation but does not assert that the old org's query cache was cleared.
Even after F-01 is fixed, this gap means regression is invisible.

**Recommendation:** After fixing F-01, add a test that pre-populates the QueryClient with
`setQueryData(["org", "acme", "members"], [...])`, performs the switch, and asserts
`qc.getQueryData(["org", "acme", "members"])` is `undefined`.

**Confidence:** 0.95

---

### F-08 — INFO: `refetchOnWindowFocus: false` disables a natural org-switch staleness recovery mechanism

**File:** `frontend/src/api/queryClient.ts:29`

**Evidence:**
```ts
refetchOnWindowFocus: false,
```

This is a deliberate choice (no comment explaining it), but it means that if a user has two tabs open
with different orgs, switching focus between them does NOT trigger a refetch. Combined with the absence
of cache invalidation on org-switch (F-01), this extends the window of stale cross-org data display.

**Recommendation:** Document this decision with a comment. Once F-01 is fixed, the risk is reduced. If
multi-tab multi-org use is a real scenario, consider enabling `refetchOnWindowFocus` for org-scoped queries
selectively (per-query override: `refetchOnWindowFocus: true`).

**Confidence:** 0.80

---

## Gaps (Forward-Looking)

### G-01 — No `clearOrgCache` helper

**Current state:** Each invalidation is inlined at call site with a specific key. Three different
`invalidateQueries` patterns exist across the codebase for org data.
**Missing:** A shared utility `clearOrgCache(qc: QueryClient, slug: string)` that removes all
org-scoped query prefixes (`["org", slug]`, `["audit", slug]`, and future `["tournament", slug]`,
`["match", slug]`).
**Needed for:** F-01 fix + Phase 1B (tournament/match queries will multiply the invalidation surface).
**Effort:** S

### G-02 — No test for cross-org data bleed

**Current state:** Tests use a fresh `QueryClient` per test, so isolation is trivially guaranteed in
tests but the real risk is in production where the singleton `queryClient` is shared across nav.
**Missing:** An integration-style test that mounts OrgA's member directory, pre-populates the cache,
performs an org-switch, and asserts the OrgA data is no longer visible.
**Needed for:** confidence in the F-01 fix and all future org-scoped queries.
**Effort:** M

### G-03 — `activeRole` has no persistence or validation across reload

**Current state:** `OrgSwitcherStore` holds `activeRole` in memory only. On reload, it resets to
`null`, and the UI falls back to `currentRoles[0]`. This is fine, but there is no check that the
stored `activeRole` is still valid for the current org's membership (e.g., if the user was demoted
between sessions).
**Missing:** A guard in the component: if `activeRole !== null && !currentRoles.includes(activeRole)`,
reset to `null` automatically.
**Needed for:** correctness when users are removed from roles between sessions.
**Effort:** S

### G-04 — No org-switch hook / context for Phase 1B consumers

**Current state:** Phase 1B will add tournament, match, bracket, and scoring queries — all org-scoped.
Each new feature will need to participate in org-switch invalidation.
**Missing:** A documented "add your query prefix here" pattern (the `clearOrgCache` helper from G-01)
and a hook (e.g., `useOrgSwitch`) that wires the invalidation automatically.
**Needed for:** Phase 1B scalability.
**Effort:** M
