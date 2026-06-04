# Structural Map: frontend/src/features/roles

**Audit date:** 2026-06-04
**Area:** `fe-roles` — role-specific landings, MyProfile, NotificationPrefs, redirectByRole, routes
**Status:** Phase 1A (placeholder/stub pages for Phase 1B consoles)
**Files read:** all 13 source + test files in `frontend/src/features/roles/`, plus
supporting files `frontend/src/features/layout/ProtectedRoute.tsx`,
`frontend/src/features/layout/computeNavItems.ts`,
`frontend/src/components/ui/PreviewTile.tsx`,
`frontend/src/lib/routes.ts`, `frontend/src/types/user.ts`,
`frontend/src/api/auth.ts`, `frontend/src/features/auth/authStore.ts`,
`frontend/src/App.tsx`.

---

## 1. Purpose

`features/roles` owns:

1. **`redirectByRole.ts`** — pure function `pickLandingPathForUser(user)` that maps a
   hydrated `User` object to a landing URL after login/root redirect.
2. **`RoleLandingShell.tsx`** — shared layout shell (hero copy + Phase 1B preview tiles
   + "what you can do today" footer).
3. **`ScorerLandingPage.tsx`** — Phase 1A placeholder for `/o/:orgSlug/scoring`.
4. **`RefereeLandingPage.tsx`** — Phase 1A placeholder for `/o/:orgSlug/referee`.
5. **`TeamManagerLandingPage.tsx`** — Phase 1A placeholder for `/o/:orgSlug/team`.
6. **`MyProfilePage.tsx`** — fully implemented profile page at `/me`
   (name edit via `PATCH /api/accounts/me/`, 2FA status, membership list, sign-out-everywhere).
7. **`NotificationPrefsPage.tsx`** — Phase 1A stub at `/me/notifications` (coming-soon card).
8. **`routes.tsx`** — `roleRoutes: RouteObject[]` array (currently not consumed).
9. **`__tests__/`** — 5 test files covering redirectByRole logic (15 cases),
   the three role landings (render + link assertions), and MyProfilePage (8 cases).

---

## 2. Key Files and Their Roles

| File | Path | Purpose |
|------|------|---------|
| `redirectByRole.ts` | `frontend/src/features/roles/redirectByRole.ts` | Post-login landing decision |
| `RoleLandingShell.tsx` | `frontend/src/features/roles/RoleLandingShell.tsx` | Shared placeholder layout |
| `ScorerLandingPage.tsx` | `frontend/src/features/roles/ScorerLandingPage.tsx` | Scorer placeholder |
| `RefereeLandingPage.tsx` | `frontend/src/features/roles/RefereeLandingPage.tsx` | Referee placeholder |
| `TeamManagerLandingPage.tsx` | `frontend/src/features/roles/TeamManagerLandingPage.tsx` | Team-manager placeholder |
| `MyProfilePage.tsx` | `frontend/src/features/roles/MyProfilePage.tsx` | Live profile page |
| `NotificationPrefsPage.tsx` | `frontend/src/features/roles/NotificationPrefsPage.tsx` | Notification prefs stub |
| `routes.tsx` | `frontend/src/features/roles/routes.tsx` | Route array (dead export) |
| `__tests__/redirectByRole.test.ts` | `frontend/src/features/roles/__tests__/redirectByRole.test.ts` | 15 unit cases |
| `__tests__/ScorerLandingPage.test.tsx` | `frontend/src/features/roles/__tests__/ScorerLandingPage.test.tsx` | 2 render+link cases |
| `__tests__/RefereeLandingPage.test.tsx` | `frontend/src/features/roles/__tests__/RefereeLandingPage.test.tsx` | 1 render case |
| `__tests__/TeamManagerLandingPage.test.tsx` | `frontend/src/features/roles/__tests__/TeamManagerLandingPage.test.tsx` | 1 render case |
| `__tests__/MyProfilePage.test.tsx` | `frontend/src/features/roles/__tests__/MyProfilePage.test.tsx` | 8 render + interaction cases |

---

## 3. Types / Models Consumed

- **`User`** (`frontend/src/types/user.ts:80`) — full authenticated user shape including
  `memberships: OrgMembership[]`, `last_active_org_slug`, `has_2fa_enrolled`, `email_verified_at`, `deleted_at`.
- **`OrgMembership`** (`frontend/src/types/user.ts:53`) — `org_id`, `org_slug`, `org_name`,
  `roles: Role[]`, `is_org_owner`, `effective_modules`, optional `active_role`.
- **`Role`** (`frontend/src/types/user.ts:24`) — `Schemas["RoleEnum"]` from generated OpenAPI types.
  NOTE: `redirectByRole.ts` widens roles to `string[]` (line 38: `const roles: string[] = (m.roles as string[] | undefined) ?? []`)
  because the backend v1Users.md catalog is wider than the generated `RoleEnum`.
- **`PreviewTileProps`** (`frontend/src/components/ui/PreviewTile.tsx:18`) — `{ icon, title, description, badgeText?, className? }`.
- **`NavItem`** (`frontend/src/features/layout/computeNavItems.ts:26`) — consumed indirectly
  by AppShell; the nav item for Team (`key: "team"`) uses role-string gating, not module gating.

---

## 4. Endpoints Called

| Page | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `MyProfilePage` | PATCH | `/api/accounts/me/` | Save profile name |
| `MyProfilePage` (via `authStore.logout`) | POST | `/api/accounts/auth/logout/` | Sign-out-everywhere |
| `MyProfilePage` (via `authStore.refreshMe`) | GET | `/api/accounts/me/` | Re-hydrate user after save |
| `NotificationPrefsPage` | — | none | Stub; no calls |
| Three role landing pages | — | none | Pure stubs; no calls |

---

## 5. Routes

### Registered in App.tsx (active)

| Path | Component | Guard |
|------|-----------|-------|
| `/me` | `MyProfilePage` | `ProtectedRoute` (auth only) |
| `/me/notifications` | `NotificationPrefsPage` | `ProtectedRoute` (auth only) |
| `/o/:orgSlug/scoring` | `ScorerLandingPage` | `ProtectedRoute` (auth only) |
| `/o/:orgSlug/referee` | `RefereeLandingPage` | `ProtectedRoute` (auth only) |
| `/o/:orgSlug/team` | `TeamManagerLandingPage` | `ProtectedRoute` (auth only) |

### `redirectByRole` logic (first-match-wins)

| Condition | Destination |
|-----------|-------------|
| No memberships | `/orgs` |
| `owner` / `admin` / `co_organizer` / `game_coordinator` | `/o/<slug>/dashboard` |
| `match_scorer` | `/o/<slug>/scoring` |
| `referee` | `/o/<slug>/referee` |
| `team_manager` | `/o/<slug>/team` |
| Anything else (`viewer`, empty) | `/o/<slug>/dashboard` |

Slug resolution: prefers `last_active_org_slug` membership if present; falls back to `memberships[0]`.

---

## 6. Findings

---

### F-01 — Dead export: `roleRoutes` array never imported

**Severity:** medium
**File:** `frontend/src/features/roles/routes.tsx:19`
```ts
export const roleRoutes: RouteObject[] = [
  { path: "/o/:orgSlug/scoring", element: <ScorerLandingPage /> },
  ...
```
`App.tsx` registers these five routes manually by importing page components directly
(lines 40-44, 146-154). The `roleRoutes` array is never imported anywhere in the codebase.
The comment in `routes.tsx` says "Spread into the protected `<AppShell>` route block in
`App.tsx` by the AppShell agent (B6)" — that integration never happened.

**Why it matters:** The file is misleading; anyone reading `routes.tsx` may assume it is
the canonical route registration. Routes are duplicated (App.tsx and routes.tsx define the
same paths). If `routes.tsx` is edited, it has no effect.

**Recommendation:** Either remove `routes.tsx` entirely and document the App.tsx registration,
or integrate `roleRoutes` into App.tsx (`...roleRoutes` spread inside the ProtectedRoute block)
and delete the manual per-page imports. The latter keeps role-page routes colocated with their
pages as intended.

---

### F-02 — No role-based route guard on role-specific landing pages

**Severity:** medium
**File:** `frontend/src/features/layout/ProtectedRoute.tsx:19–59`
**Also:** `frontend/src/App.tsx:144–154`

`ProtectedRoute` checks authentication and membership count, but does NOT check that the
logged-in user's role is `match_scorer` for `/scoring`, `referee` for `/referee`, or
`team_manager` for `/team`. Any authenticated user can navigate directly to any of the
three role pages regardless of their role.

**Why it matters:** An `admin` who opens `/o/acme/scoring` directly will see the Scorer
"Phase 1B preview" without being redirected, which is a minor UX oddity (low security risk
since these pages show no sensitive data and call no endpoints). In Phase 1B when these pages
have real functionality, an unguarded route would be a security issue.

**Recommendation:** Add a lightweight `RoleGuard` wrapper (or extend `ProtectedRoute`) that
checks membership roles for the org slug in the URL and redirects to `/o/:orgSlug/dashboard`
if the user lacks the expected role. Do this before Phase 1B lands real functionality.

---

### F-03 — `React.ReactElement` return type without importing React namespace

**Severity:** low (likely non-bug due to `jsx: "react-jsx"`)
**Files:**
- `frontend/src/features/roles/ScorerLandingPage.tsx:12`
- `frontend/src/features/roles/RefereeLandingPage.tsx:11`
- `frontend/src/features/roles/TeamManagerLandingPage.tsx:11`

```ts
// ScorerLandingPage.tsx line 12 — no `import React` at top of file
export function ScorerLandingPage(): React.ReactElement {
```

None of the three files import `React` yet use `React.ReactElement` as the return type.
With `"jsx": "react-jsx"` in `tsconfig.app.json` the JSX transform does not require an
explicit import, but the `React` namespace (for type references like `React.ReactElement`,
`React.ComponentType`) still requires the namespace to be in scope.

`RoleLandingShell.tsx` and `MyProfilePage.tsx` correctly include `import * as React from "react"`
(lines 1 and 1 respectively). The three leaf pages do not.

**Why it matters:** This will produce a TypeScript compile error ("'React' refers to a UMD
global") unless the project has a global type shim or `skipLibCheck` permits it. Currently
`skipLibCheck: true` is set but that applies to `.d.ts` files only; the error would still
surface in application source files if `strict: true` is combined with no ambient React namespace.

**Recommendation:** Add `import type { ReactElement } from "react";` to each of the three
files and update the return type to `ReactElement` (no namespace prefix), matching the style
used in most other components. Or add `import * as React from "react";` to bring the namespace
into scope explicitly.

---

### F-04 — `bg-grant-muted` Tailwind class on 2FA "Enabled" badge

**Severity:** low
**File:** `frontend/src/features/roles/MyProfilePage.tsx:206`
```tsx
className="rounded-full bg-grant-muted px-3 py-1 text-xs font-medium"
```

`grant` (green) is a domain-tinted colour in `tailwind.config.js:47–50` intended for the
module-override matrix (`GrantCell`). Using it on the 2FA "Enabled" badge creates a semantic
confusion — a green "grant" colour should mean "access granted to a module", not "2FA status".
The badge also lacks a foreground text colour class (`text-grant` or similar), so the text
colour inherits from context, which may be invisible in dark mode.

**Why it matters:** Visual inconsistency; potential dark-mode accessibility failure (WCAG 2.1
AA contrast); domain-colour leakage outside its intended surface.

**Recommendation:** Replace `bg-grant-muted` with `bg-green-100 text-green-800 dark:bg-green-900
dark:text-green-100` (or a semantic `bg-success-muted` token if one is added). Add an explicit
foreground colour class.

---

### F-05 — `team_manager` nav item uses role-string gating, not module gating

**Severity:** low (design gap, not a bug)
**File:** `frontend/src/features/layout/computeNavItems.ts:137`
```ts
// Team workspace: no Appendix A.2 module exists (`tournament.team_manager_workspace`
// is unspecified). Spec gap — see report. Fall back to role-only gating until
// the module catalog is extended.
if (roles.includes("team_manager")) {
```

Scoring and Referee nav items (lines 115–131) are correctly gated by `effective_modules`
(`match.scoring_console`, `match.referee_console`). The Team nav item falls back to a
role-string check because the Appendix A.2 module catalog has no matching module.

**Why it matters:** Breaks the two-layer RBAC invariant (Invariant #12). A per-user
`MembershipModuleGrant` cannot override team-manager nav visibility. An admin could not
deny a team-manager the nav item by removing a module grant (because there is no module to deny).

**Recommendation:** Add `tournament.team_manager_workspace` to the module catalog in
`apps/permissions/fixtures/modules.json`, seed it with appropriate role defaults, then
update `computeNavItems.ts` to gate on `hasModule("tournament.team_manager_workspace")`.
This is a Phase 1B concern but the gap should be filed now.

---

### F-06 — `NotificationPrefsPage` is a pure stub with no endpoint and no link to back-navigate cleanly via browser history

**Severity:** low (Phase 1A by design)
**File:** `frontend/src/features/roles/NotificationPrefsPage.tsx:1–59`

The page renders a single "Coming in Phase 1B" card and a "Back to profile" link. It does
not use `useNavigate(-1)` or the browser's back stack, so users who navigated from a page
other than `/me` will be sent to `/me` rather than their actual origin on click.

**Why it matters:** Minor UX regression in the Phase 1A period; acceptable but worth noting
so Phase 1B doesn't inherit the pattern.

**Recommendation:** Replace the hard-coded `routes.myProfile()` link with a back-navigation
button (`useNavigate(-1)` with a `routes.myProfile()` fallback).

---

### F-07 — `redirectByRole` widens `roles` to `string[]`, masking type drift

**Severity:** low / info
**File:** `frontend/src/features/roles/redirectByRole.ts:38`
```ts
const roles: string[] = (m.roles as string[] | undefined) ?? [];
```
The cast through `string[]` bypasses the `Role` union type from the generated OpenAPI schema.
The comment acknowledges this: "We compare role strings via `string` rather than the narrow
`Role` union because the v1Users.md role catalog is wider."

**Why it matters:** When the OpenAPI schema is regenerated and `RoleEnum` is updated to include
`co_organizer`, `game_coordinator`, `match_scorer`, `team_manager`, the widening cast will be
redundant but harmless. However, if a new role is added to the backend without updating
`redirectByRole.ts`, it silently falls to the dashboard fallback with no compile-time warning.

**Recommendation:** Once `RoleEnum` is confirmed to cover all v1Users.md roles, remove the
cast and use `roles: Role[]` directly. Add a `satisfies` or exhaustiveness check on the
role dispatch so new roles produce a TypeScript error.

---

### F-08 — `MyProfilePage` has no test for the `saveName` mutation (edit flow)

**Severity:** low
**File:** `frontend/src/features/roles/__tests__/MyProfilePage.test.tsx`

The 8 existing tests cover: header initials, section headings, membership list, 2FA chip,
Change password link, Sign-out-everywhere button, and the null-user placeholder. There is no
test that exercises the "Edit profile" → name input → Save mutation path, including optimistic
state and error toast.

**Why it matters:** The `saveName` mutation (via `authApi.patchMe`) and the subsequent
`refreshMe()` call are the only real side-effectful logic in this page; they are untested.

**Recommendation:** Add a test using `userEvent.click("Edit profile")`, `userEvent.type` into
the name field, `userEvent.click("Save")`, mock `authApi.patchMe` to resolve/reject, and
assert the toast message and `refreshMe` call.

---

### F-09 — `RefereeLandingPage` and `TeamManagerLandingPage` tests do not check "today" footer links

**Severity:** info
**Files:**
- `frontend/src/features/roles/__tests__/RefereeLandingPage.test.tsx`
- `frontend/src/features/roles/__tests__/TeamManagerLandingPage.test.tsx`

`ScorerLandingPage.test.tsx` (the first written) asserts both preview tiles AND today-footer
links. The referee and team-manager tests only assert preview tiles and hero copy; they do
not assert the `/me`, `/me/notifications`, and feedback links.

**Why it matters:** Low-risk gap; the shell is shared so a break would be caught by the
Scorer test. But symmetry is good for long-term maintainability.

**Recommendation:** Add link assertions to both tests, mirroring the pattern in
`ScorerLandingPage.test.tsx:34–47`.

---

### F-10 — `routes.profile()` vs `routes.myProfile()` naming duplication

**Severity:** info
**File:** `frontend/src/lib/routes.ts:41–44`
```ts
profile: () => "/me",
...
/** Aliases — match the role-landing spec naming (`myProfile`, `myNotifications`). */
myProfile: () => "/me",
myNotifications: () => "/me/notifications",
```

`routes.profile()` and `routes.myProfile()` are exact duplicates producing the same path.
Only `myProfile` is used within `features/roles/`. `profile` is unused in the features
directory (no grep hits within roles).

**Why it matters:** Dead alias creates confusion about the canonical name.

**Recommendation:** Remove `profile` (keep `myProfile`). Check for usages of `routes.profile`
across the full codebase before deleting.

---

## 7. Gaps

| Gap | Description | Where to address |
|-----|-------------|-----------------|
| G-1 | No `tournament.team_manager_workspace` module in Appendix A.2 catalog | `apps/permissions/fixtures/modules.json` + v1Users.md |
| G-2 | Role-level route guards absent from three role landing pages | Phase 1B pre-work in `ProtectedRoute` or a new `RoleGuard` |
| G-3 | `roleRoutes` export in `routes.tsx` is dead code — never spread into `App.tsx` | Either integrate or delete |
| G-4 | `NotificationPrefsPage` has no back-navigation via history | Phase 1B cleanup |
| G-5 | No mutation test for MyProfilePage name-edit flow | Add to `__tests__/MyProfilePage.test.tsx` |
| G-6 | Referee and TeamManager tests lack "today" footer link assertions | Add to respective test files |
| G-7 | `redirectByRole` role widening cast should be removed once RoleEnum is complete | Post Phase 1A cleanup |

---

## 8. Summary

The `fe-roles` feature is clean, minimal, and correctly scoped for Phase 1A:

- `pickLandingPathForUser` is well-tested (15 cases) and handles all documented roles plus
  `last_active_org_slug` preference and slug encoding.
- The three role landing pages are intentional stubs; they call no endpoints, render
  accurately-labelled "Coming in Phase 1B" tiles, and are accessible (ARIA labels, role
  attributes on tiles and groups).
- `MyProfilePage` is the only live feature in this folder; it correctly uses `authStore`,
  `authApi.patchMe`, and refreshMe, but its edit-flow is untested.
- The most actionable issues are: the dead `roleRoutes` export (F-01), the missing role
  guard (F-02), the missing React import in three leaf pages (F-03), the semantic colour
  misuse on the 2FA badge (F-04), and the module-catalog gap for team-manager (F-05).
