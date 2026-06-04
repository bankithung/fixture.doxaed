# Audit: fe-roles — Frontend Correctness
**Scope:** `frontend/src/features/roles/` (all files + tests)
**Lens:** hook deps/stale closures, TanStack query keys/invalidation, races, route guards/redirects, form validation gaps, bad optimistic updates, unhandled rejections.
**Date:** 2026-06-04

---

## Findings

### F-01 — No role-specific route guard on `/o/:orgSlug/scoring`, `/referee`, `/team` (HIGH)

**File:** `frontend/src/App.tsx:144-155` / `frontend/src/features/layout/ProtectedRoute.tsx`

**Evidence:**
```tsx
// App.tsx:144-155 — no role check, only generic auth gate
<Route path="/o/:orgSlug/scoring" element={<ScorerLandingPage />} />
<Route path="/o/:orgSlug/referee" element={<RefereeLandingPage />} />
<Route path="/o/:orgSlug/team"    element={<TeamManagerLandingPage />} />
```
`ProtectedRoute` only checks `bootstrapped`, `requires2FA`, `user !== null`, and zero-membership redirect. It does NOT verify that the visiting user holds the `match_scorer` / `referee` / `team_manager` role in the org indicated by `:orgSlug`.

**Why it matters:** Any authenticated user — including an `admin` of org A — can navigate directly to `/o/org-b/scoring` without being a member of org B, or any user without the scorer role can access the scoring URL of their own org. While the landing pages are currently Phase 1A placeholders with no sensitive data, the routes will carry real Phase 1B scorer/referee tooling. The guard gap will persist into Phase 1B unless fixed now.

**Recommendation:** Add a `RoleGuard` wrapper (or extend `ProtectedRoute`) that reads the `:orgSlug` param, finds the user's membership for that org, and confirms the required role. Redirect to `/o/:orgSlug/dashboard` (or `/orgs`) if the membership or role is absent.

**Confidence:** 0.98

---

### F-02 — `routes.tsx` in `features/roles/` is dead code — never imported (LOW/MEDIUM)

**File:** `frontend/src/features/roles/routes.tsx:1-25`

**Evidence:**
```tsx
export const roleRoutes: RouteObject[] = [
  { path: "/o/:orgSlug/scoring", element: <ScorerLandingPage /> },
  ...
];
```
Grep confirms zero imports of `@/features/roles/routes` anywhere in `frontend/src`. The routes are instead declared inline in `App.tsx:144-155`. The two definitions are in sync today, but the unused file is a maintenance trap: changes made here will silently not apply.

**Why it matters:** A future developer editing `routes.tsx` will expect those changes to take effect. The divergence will be invisible until a route goes missing in production.

**Recommendation:** Delete `frontend/src/features/roles/routes.tsx`. Keep the routes in `App.tsx` as the single source.

**Confidence:** 0.97

---

### F-03 — `resolveDestination()` in `LoginPage` calls `useAuthStore.getState()` inside a closure, not a hook — stale-store race (MEDIUM)

**File:** `frontend/src/features/auth/LoginPage.tsx:70-75`

**Evidence:**
```ts
const resolveDestination = (): string => {
  if (explicitNext) return explicitNext;
  const user = useAuthStore.getState().user;  // snapshot, not reactive
  if (user) return pickLandingPathForUser(user);
  return routes.root();
};
```
`resolveDestination` is called inside `onCredSubmit` / `onTotpSubmit` immediately after `await login(values)` resolves. Because Zustand state updates are synchronous within the same micro-task flush, this usually works. However, if the login response does NOT return a `user` object (i.e., `res.user` is absent and the store then calls `await authApi.me()`), there is a window where the store write has not yet committed when `resolveDestination()` is called. In that scenario `getState().user` returns `null` and the user is sent to `/` (root) instead of their correct landing page.

**Why it matters:** The login endpoint is spec'd to sometimes return `{ requires_2fa: false }` without embedding the user object (`res.user` is optional — see `auth.ts:27`). In that path the store awaits a second `authApi.me()` call; `navigate(resolveDestination())` is invoked on the line immediately before the store promise resolves, so `user` is `null` and navigation goes to `/`.

**Recommendation:** Return the user object from `login()` in the store (already stored in `res.user`) and pass it directly to `pickLandingPathForUser` at the call site, removing the snapshot read:
```ts
const res = await login(values);
if (!res.requires_2fa) {
  const user = useAuthStore.getState().user;
  navigate(user ? pickLandingPathForUser(user) : routes.root());
}
```
Or better, have `login()` return the resolved `User` so the caller never needs `getState()`.

**Confidence:** 0.80 (depends on whether backend always embeds `user` in the response or not)

---

### F-04 — `saveName` mutation in `MyProfilePage` bypasses TanStack Query cache — no `queryKey` invalidation (MEDIUM)

**File:** `frontend/src/features/roles/MyProfilePage.tsx:60-79`

**Evidence:**
```ts
const saveName = useMutation({
  mutationFn: (newName: string) => authApi.patchMe({ name: newName }),
  onSuccess: async () => {
    await refreshMe();          // imperative store refresh
    setEditing(false);
    toast.push({ kind: "success", title: t("Profile updated") });
  },
  ...
});
```
The `PATCH /api/accounts/me/` response is never used to update any TanStack Query cache entry; instead `refreshMe()` is called, which makes a second `GET /api/accounts/me/` round-trip and writes directly into Zustand. If any other component in the tree has queried `/api/accounts/me/` via TanStack Query (e.g., a future `useQuery(["me"])` hook), it will remain stale and show the old name until it auto-refetches.

**Why it matters:** The pattern works today because `user` state is managed exclusively through Zustand and no TanStack Query key wraps `/api/accounts/me/`. But it sets a fragile precedent — the mutation has no `queryClient.invalidateQueries` call, so any future `useQuery` subscriber of the `me` endpoint will diverge.

**Recommendation:** Either (a) use the PATCH response body to update the store directly (`set({ user: res })`) and skip the second round-trip; or (b) add `queryClient.invalidateQueries({ queryKey: ["me"] })` in `onSuccess` alongside `refreshMe()` to future-proof the cache. Option (a) also saves a network round-trip.

**Confidence:** 0.90

---

### F-05 — Empty-string name allowed by save guard but rejected by nothing (LOW)

**File:** `frontend/src/features/roles/MyProfilePage.tsx:169-171`

**Evidence:**
```tsx
onClick={() => saveName.mutate(name.trim())}
disabled={
  saveName.isPending || name.trim() === user.name
}
```
The Save button is disabled only when the trimmed value equals `user.name`. If `user.name` is an empty string `""`, the button is enabled whenever the input changes. If the user types spaces and clicks Save, `name.trim()` is `""` and the PATCH fires with `{ name: "" }`. The backend serializer (`MeSerializer`) may or may not accept an empty `name` — if it does, subsequent initials computation (`initials`) degrades to `"?"` and the avatar becomes meaningless. No client-side minimum-length validation exists.

**Why it matters:** An empty name is a confusing but silent corruption of the user's display name. If later screens render the name without a fallback, they will show blank text.

**Recommendation:** Add `|| name.trim().length === 0` to the disabled condition and show a helper text "Name cannot be blank" when the field is empty in edit mode. Alternatively add a Zod schema to enforce `min(1)`.

**Confidence:** 0.92

---

### F-06 — `bg-grant-muted` Tailwind class on the 2FA "Enabled" badge is semantically wrong and risks incorrect colour in dark mode (LOW)

**File:** `frontend/src/features/roles/MyProfilePage.tsx:206`

**Evidence:**
```tsx
<span
  data-testid="2fa-status"
  className="rounded-full bg-grant-muted px-3 py-1 text-xs font-medium"
>
  {t("Enabled")}
</span>
```
`bg-grant-muted` (`hsl(142 50% 92%)`) is the domain colour for "permission granted" in the module matrix (see `GrantCell.tsx`). Using it on the 2FA badge is semantically appropriate (green = good) but it reuses an internal design-system token that has no dark-mode counterpart — in dark mode the badge will display a washed-out light-green on a dark background with no foreground colour token, making it potentially unreadable.

**Why it matters:** WCAG 2.1 AA compliance is a stated invariant. The badge has no explicit text-colour class paired with the background.

**Recommendation:** Either pair it with `text-grant` to ensure sufficient contrast (`text-grant` = `hsl(142 71% 45%)` — however this is too dark on the muted background, so use `text-grant-DEFAULT` / a legible foreground), OR use a purposeful Tailwind class like `bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200` that is designed for badge display.

**Confidence:** 0.85

---

### F-07 — `last_active_org_slug` mismatch silently falls back to `memberships[0]` without warning (LOW)

**File:** `frontend/src/features/roles/redirectByRole.ts:32-36`

**Evidence:**
```ts
const preferredSlug = user.last_active_org_slug;
const m =
  (preferredSlug
    ? memberships.find((mm) => mm.org_slug === preferredSlug)
    : null) ?? memberships[0];
```
If `last_active_org_slug` is set but the corresponding membership has been revoked (user removed from that org since the slug was last written), `find()` returns `undefined` and the code silently falls back to `memberships[0]`. The user is then redirected to a different org than they expect without any notification.

**Why it matters:** After a membership revocation the user will silently land in the wrong org. This is not a crash but is a confusing UX and may expose the wrong org's dashboard.

**Recommendation:** When the preferred slug doesn't match any membership, call `authApi.patchMe({ last_active_org_id: memberships[0]?.org_id ?? null })` asynchronously to repair the stale pointer, and/or show a toast "Your last active organization is no longer accessible."

**Confidence:** 0.80

---

### F-08 — `routes.tsx` in `features/roles/` imports JSX without a React import in a `.tsx` file — potential tooling edge (INFO)

**File:** `frontend/src/features/roles/routes.tsx:20`

**Evidence:**
```tsx
{ path: "/o/:orgSlug/scoring", element: <ScorerLandingPage /> },
```
The file uses JSX but has no `import * as React from "react"` or `import React from "react"`. With Vite's default `@vitejs/plugin-react` (automatic JSX transform), this is fine. However the file is already dead code (F-02), so this is only noted for completeness.

**Confidence:** 0.60 (non-issue with automatic runtime; dead code anyway)

---

## Gaps (forward-looking)

### G-01 — Role-guard for org-scoped role pages missing (blocking for Phase 1B)
**Current state:** `ProtectedRoute` only checks authentication; no membership/role check per org.
**Missing:** A `RoleGuard` or parameterised `ProtectedRoute` that verifies the visiting user's role in `:orgSlug`.
**Needed for:** Phase 1B scorer console, referee console, team manager console — these carry real sensitive write actions.
**Effort:** M
**Blocking:** Yes (ship Phase 1B without this = any logged-in user can access any org's scoring UI).

### G-02 — No cross-org access test for role landing pages
**Current state:** Tests in `__tests__/` confirm rendering and routing but do not assert that a user belonging to org A cannot visit `/o/org-b/scoring`.
**Missing:** A Playwright or vitest integration test that verifies a cross-org URL is redirected/rejected.
**Needed for:** Architectural invariant #2 (no cross-org leak via any endpoint).
**Effort:** S
**Blocking:** No (Phase 1A pages are read-only stubs), but required before Phase 1B.

### G-03 — `refreshMe()` makes a redundant network round-trip on profile save
**Current state:** `saveName.onSuccess` discards the PATCH response and immediately fetches `GET /me/` again.
**Missing:** Use of the PATCH response body to update store state directly.
**Needed for:** Performance / correctness under slow networks where the second GET could race with another write.
**Effort:** S
**Blocking:** No.

### G-04 — No validation schema / form library on the name edit field
**Current state:** Name is edited via raw `useState` with only an equality guard on the Save button.
**Missing:** react-hook-form + Zod for the name field (min 1 char, max N chars to match backend).
**Needed for:** Consistency with the rest of the codebase (all other forms use RHF+Zod) and to surface backend validation messages inline.
**Effort:** S
**Blocking:** No.

### G-05 — `last_active_org_slug` stale-pointer not repaired after membership revocation
**Current state:** Silent fallback to `memberships[0]`; stale pointer persists on the backend.
**Missing:** A PATCH to clear `last_active_org_id` whenever the preferred org is not found in memberships.
**Needed for:** Correct redirect behaviour after membership changes.
**Effort:** S
**Blocking:** No, but affects UX quality.
