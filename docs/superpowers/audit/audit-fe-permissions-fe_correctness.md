# Audit: fe-permissions — Frontend Correctness

**Scope:** `frontend/src/features/permissions/` + wiring in `App.tsx`, `api/permissions.ts`, `types/user.ts`
**Lens:** Hook deps / stale closures, TanStack Query key correctness / missing invalidation, races, broken route guards / redirects, form validation gaps, bad optimistic updates, unhandled rejections.
**Date:** 2026-06-04
**Auditor:** Claude Code (automated analysis)

---

## Findings

---

### F1 — HIGH: Single `useMutation` instance shared across all rows enables a concurrency race

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:87`

**Evidence:**
```ts
const saveRow = useMutation({ ... });
// later in JSX:
disabled={
  saveRow.isPending &&
  saveRow.variables?.userId === row.user_id
}
```

**Why it matters:**
`useMutation` returns a single result object. If the user clicks Save on row A then immediately clicks Save on row B (before A's request resolves), TanStack Query fires both mutations but `saveRow.isPending` / `saveRow.variables` reflects the **most recently submitted mutation only**. The moment B is submitted, row A's spinner disappears and its cells become re-editable even though the A request is still in-flight. If A succeeds after B, its `onSuccess` clears A's edits from state and invalidates the query, but because A's `edits` were snapshotted at `onSaveRow` time (line 148–151), the PUT body sent for A was correct. The real danger is that row A's disabled/spinner state vanishes mid-flight, allowing the operator to start editing A again while A's PUT has not completed. On success both A and B invalidate the same query key, triggering two sequential refetches; on error for A, no toast fires with row context (the generic error handler at line 110 has no `vars` access to name the failing row).

**Recommendation:**
Use `useMutation` with `mutateAsync` per row and track per-row pending state in a local `Set<string>` ref, or switch to `useIsMutating` scoped by a `mutationKey` that includes `userId`. Simplest fix: add a `pendingRows: Set<string>` ref updated synchronously in `onSaveRow` / `onSettled`.

---

### F2 — HIGH: `orgSlug` stale closure in `mutationFn` and `onSuccess` — PUT goes to the wrong org if user navigates mid-flight

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:95,107`

**Evidence:**
```ts
// mutationFn closes over orgSlug from useParams at render time:
permissionsApi.setGrants(orgSlug, userId, { cells, event_id: newEventId() })

// onSuccess invalidates using the same closed-over value:
qc.invalidateQueries({ queryKey: ["permissions", "matrix", orgSlug] });
```

**Why it matters:**
In React Router v7, when navigating from `/o/acme/permissions` to `/o/other/permissions`, React **reuses** the mounted `ModuleMatrixPage` component (no unmount/remount because the route path is the same pattern). `useParams` re-reads the new slug, so new renders see the new org. However, any in-flight mutation already submitted (before the navigation) has already captured the old `orgSlug` in the closure at the time `useMutation` was defined. The `onSuccess` callback that fires after navigation will call `qc.invalidateQueries` with the old slug, leaving the new org's cache stale. Worse, the `mutationFn` could in theory be re-run by a retry with the new `orgSlug` because TanStack calls the `mutationFn` from the latest closure after a component re-render.

**Note:** The save button does NOT carry `orgSlug` in the mutation variables, so the `onSuccess` invalidation key does not match the currently-viewed org if the user navigated between submitting and settlement.

**Recommendation:**
Pass `orgSlug` as part of the mutation variables (`{ userId, cells, orgSlug }`) and read `vars.orgSlug` in `onSuccess` instead of the closed-over value. This is the canonical TanStack Query pattern for closures over volatile route params.

---

### F3 — MEDIUM: `edits` state not reset when `orgSlug` changes — unsaved edits from Org A bleed into Org B

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:85`, `frontend/src/App.tsx:139-142`

**Evidence:**
```ts
// App.tsx — no key prop, component is reused across org navigations:
<Route
  path="/o/:orgSlug/permissions"
  element={<ModuleMatrixPage />}
/>

// ModuleMatrixPage.tsx — edits are plain useState, never cleared on orgSlug change:
const [edits, setEdits] = useState<PendingMap>({});
```

**Why it matters:**
React Router reuses the same `ModuleMatrixPage` instance across param changes to the same route pattern. The `matrixQ` cache switches because the query key includes `orgSlug`, so the displayed data flips to the new org. But `edits` (`PendingMap` keyed by `user_id`) is not reset. If user IDs happen to collide between orgs (possible given UUID v7 PKs are globally unique, so collision is impossible — BUT if the same user is a member of both orgs, that user's `user_id` will exist in both `members` arrays). Edits made for User X in Org A will be pre-applied to User X's cells in Org B's matrix display. The operator then sees a dirty row for User X in Org B with data they intended for Org A — a cross-org data exposure in the UI state.

**Recommendation:**
Either (a) add `key={orgSlug}` to the Route element in App.tsx to force unmount/remount on slug change, or (b) add a `useEffect` that calls `setEdits({})` when `orgSlug` changes, or (c) also reset `edits` inside the query's `onSuccess` handler.

---

### F4 — MEDIUM: `aria-checked` on a 3-state control — semantics misrepresent the "deny" state

**File:** `frontend/src/features/permissions/GrantCell.tsx:85`

**Evidence:**
```tsx
<button
  role="switch"
  aria-checked={state === "grant"}
  ...
>
```

**Why it matters:**
`role="switch"` with a boolean `aria-checked` is correct for a 2-state toggle but incorrect for a 3-state (`default`/`grant`/`deny`) control. Both `default` and `deny` emit `aria-checked="false"`, so an AT (screen reader) cannot distinguish between "not overridden" and "explicitly denied". The ARIA spec allows `aria-checked="mixed"` for an indeterminate/3rd state; here `"default"` maps well to `"mixed"` (role defers). The `deny` state should be `aria-checked="false"` but needs to be announced as "denied" rather than simply "unchecked". The current spec comment says WCAG 2.1 AA is required on all non-scorer UIs (invariant #13); this falls short.

**Recommendation:**
Change to `aria-checked={state === "grant" ? true : state === "default" ? "mixed" : false}`. Update the test at `GrantCell.test.tsx:63` which currently asserts `aria-checked="false"` for the `deny` state (which is still correct as a boolean) but would need update for the `default` → `"mixed"` change. Alternatively switch from `role="switch"` to `role="button"` and rely entirely on the composed `aria-label` for state announcement; this avoids the semantic mismatch.

---

### F5 — MEDIUM: No client-side route guard for the `/o/:orgSlug/permissions` route — 403 deferred to server round-trip

**File:** `frontend/src/App.tsx:139-142`, `frontend/src/features/layout/computeNavItems.ts:66-67`

**Evidence:**
```ts
// App.tsx — bare route, no module/role check:
<Route
  path="/o/:orgSlug/permissions"
  element={<ModuleMatrixPage />}
/>

// computeNavItems.ts — nav item IS gated:
const canManagePermissions = roles.includes("admin") || isOrgOwner;
if (canManagePermissions) { items.push({ key: "permissions", ... }); }
```

**Why it matters:**
The nav hides the Permissions link from non-admins / non-owners, but the route itself is open. A non-admin user who manually types `/o/acme/permissions` will cause `ModuleMatrixPage` to mount and fire the matrix query. The backend will respond with 403 and the graceful 403 card will render — so there is no data leak. But two problems exist:
1. A flash/loading state occurs (network round-trip) before the 403 card appears. The `ProtectedRoute` only checks auth, not role.
2. `isOrgOwner` in `computeNavItems` is computed with `roles.includes("owner")` as a fallback, but `is_org_owner` is the canonical flag (Appendix B). The nav check (`canManagePermissions`) and the backend gate may diverge if a co_organizer is made owner via ownership transfer — the nav won't show Permissions until the user reloads and gets fresh `me/` data.

**Recommendation:**
Add a lightweight `ModuleRouteGuard` wrapper (reads `effective_modules` / `is_org_owner` from auth store) that redirects to the dashboard immediately rather than waiting for the API round-trip. This is consistent with how `OrgAuditLogPage` does it client-side: `if (!hasModule) { return <AccessRequired /> }`.

---

### F6 — LOW: `onSaveRow` reads stale `edits` from closure — potential for merged cells to include already-cleared edits on rapid double-click

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:147-151`

**Evidence:**
```ts
const onSaveRow = (row: ModuleMatrixRow): void => {
  const rowEdits = edits[row.user_id];   // reads closure value of edits
  if (!rowEdits) return;
  const cells: Record<string, GrantState> = { ...row.cells, ...rowEdits };
  saveRow.mutate({ userId: row.user_id, cells });
};
```

**Why it matters:**
`onSaveRow` closes over `edits` from the last render. If the user clicks Save for two different rows in rapid succession within the same React event batch (unlikely but possible), both calls read the same snapshot of `edits`. Since the mutation disables the Save button only while `saveRow.isPending && saveRow.variables?.userId === row.user_id`, this scenario is unlikely in practice but remains a correctness risk when combined with F1's racing mutations.

**Recommendation:**
This is a minor issue that is largely mitigated by the disabled-button guard. Fix naturally when F1 is addressed (per-row pending state will prevent double-submit on the same row).

---

### F7 — LOW: Unhandled rejection in `saveRow.mutate` call path — no `.catch()` and `mutate` doesn't throw

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:151`

**Evidence:**
```ts
saveRow.mutate({ userId: row.user_id, cells });
// (no .catch; mutate() swallows throws — this is correct TanStack v5 behaviour)
```

**Why it matters:**
`useMutation.mutate()` (as opposed to `mutateAsync()`) internally swallows rejections to prevent unhandled promise rejections — TanStack Query v5 routes errors to `onError` instead. This is correct usage. However, the `onError` callback at line 110 does **not** receive `vars`, so the toast for a failed save does not identify which row failed (e.g. "Save failed for alice@example.com"). In a large matrix with many rows in-flight (per F1), the operator cannot tell which row to retry.

**Recommendation:**
Change the `onError` signature to `(e, vars) => { ... }` and include `vars.userId` or look up the email in the toast description.

---

### F8 — LOW: `newEventId()` fallback uses `Math.random()` — not cryptographically unique

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:24-28`

**Evidence:**
```ts
function newEventId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ev_${Math.random().toString(36).slice(2)}`;
}
```

**Why it matters:**
The fallback is reached only in environments where `crypto.randomUUID` is unavailable (e.g. non-secure HTTP contexts). In production, the app runs behind HTTPS (Caddy TLS, per invariant #15), so `crypto.randomUUID` is always available. The fallback is dead code in prod but is technically reachable in test/CI environments running on `http://`. The spec mandates idempotent writes via a client-generated event_id with a unique DB constraint (invariant #3); a non-unique `Math.random()` ID could cause duplicate-key collisions or false idempotency matches. However, since `crypto.randomUUID` is available in all modern browsers and in Vite's test env via `@vitest/browser`, risk is low.

**Recommendation:**
Remove the `Math.random()` fallback branch; throw an error or just call `crypto.randomUUID()` directly. If test environments lack it, polyfill via `@vitest/globals` or `crypto` from `node:crypto`.

---

### F9 — INFO: No invalidation of the `["me"]` query after a successful `setGrants` call

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:99-108`

**Evidence:**
```ts
onSuccess: (_data, vars) => {
  setEdits(...)
  toast.push(...)
  qc.invalidateQueries({ queryKey: ["permissions", "matrix", orgSlug] });
  // missing: qc.invalidateQueries({ queryKey: ["me"] })
}
```

**Why it matters:**
The `User.memberships[].effective_modules` array in the `me/` response is computed by the backend from the grant overrides. After saving a grant change, the operator's own effective modules (shown in the nav items via `computeNavItems`) would be stale if the operator changed their own row. The matrix cache is correctly invalidated, but the `me/` cache (used for nav/module-gating throughout the app) is not. This only matters when the admin modifies their own row. The `staleTime` is 30s, so the nav would update within 30s regardless — but the feedback gap is confusing.

**Recommendation:**
After `setGrants` succeeds, also call `qc.invalidateQueries({ queryKey: ["me"] })` to keep nav items and module gates consistent.

---

## Gaps (forward-looking)

| # | Gap | Needed for | Effort | Blocking? |
|---|-----|-----------|--------|-----------|
| G1 | No `TournamentMembership`-scoped module matrix — current `ModuleMatrixPage` is org-scoped only. Phase 1B will need a per-tournament view with `tournament.scoring_console` overrides. | Phase 1B scorer/referee flows | L | No |
| G2 | No `reason` field UI in the matrix — the API accepts an optional `reason` but the SPA never sends it. Backend audit log will have null reason for every matrix save. | Audit traceability | M | No |
| G3 | No optimistic UI for data from server — after `invalidateQueries` the table goes through a loading flicker. Should use `setQueryData` to write the confirmed cells immediately and let the background revalidation settle silently. | Polish / UX | S | No |
| G4 | `ConflictOfInterestBanner` is defined but **never used** anywhere in the permissions feature — no consumer exists yet. It will be needed when an admin edits their own row (conflict of interest). | Conflict-of-interest audit requirement (v1Users.md Appendix B.22) | M | No |
| G5 | No pagination on the matrix endpoint — if an org has hundreds of members the single aggregate response could be large. No `cursor` / `page` param seen in `api.generated.ts`. | Scale | L | No |
| G6 | Test suite lacks a test for the concurrent-save race (F1) and for cross-org edit bleed (F3). | Test coverage | S | No |
