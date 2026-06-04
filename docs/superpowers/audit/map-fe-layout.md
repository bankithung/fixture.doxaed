# Structural Map: fe-layout (`frontend/src/features/layout`)

Generated: 2026-06-04  
Status: Phase 1A complete, Phase 1B not built.

---

## Overview

The `layout` feature folder is the authenticated shell of the SPA. It owns the
entry-gate (`ProtectedRoute`), the persistent chrome (`AppShell`), and the
first two pages a user lands on after login (`OrgChooserPage`,
`OrgDashboardPage`). A sixth file (`OrgComingSoonPage`) exists but is dead
code — it is never mounted.

---

## Files

| File | Purpose |
|------|---------|
| `ProtectedRoute.tsx` | Auth gate; blocks, redirects, or renders `children` |
| `AppShell.tsx` | Authenticated chrome: header, primary nav, mobile drawer, user menu |
| `computeNavItems.ts` | Pure function — role+module-aware ordered nav items |
| `OrgChooserPage.tsx` | `/orgs` — lists memberships; entry point for zero-org state |
| `OrgDashboardPage.tsx` | `/o/:orgSlug/dashboard` — role/module-gated card grid + feedback modal |
| `OrgComingSoonPage.tsx` | Phase 1B placeholder — **never imported or routed** (dead code) |
| `__tests__/AppShell.test.tsx` | 7 tests; covers nav items, user menu, sign-out, DEFECT-F fallback, mobile drawer |
| `__tests__/computeNavItems.test.ts` | 17 tests; comprehensive role+module matrix coverage |
| `__tests__/OrgDashboardPage.test.tsx` | 7 tests; cards grid, feedback modal, fallback slug, Phase 1B teaser |

---

## Supporting Types and Stores

| File | Role in layout |
|------|---------------|
| `frontend/src/types/user.ts` | `User`, `OrgMembership`, `Role`, `ModuleDef` — structural source of truth for layout logic |
| `frontend/src/features/auth/authStore.ts` | Zustand store: `user`, `bootstrapped`, `requires2FA`; `bootstrap()`, `logout()`, `clear()`, `refreshMe()` |
| `frontend/src/features/orgs/OrgSwitcherStore.ts` | `currentSlug` mirror of URL; written by `AppShell` effect only; read by `OrgSwitcher` |
| `frontend/src/features/orgs/dashboardCards.ts` | `computeDashboardCards()` + `MODULES` constants + `PHASE_1B_TEASERS` |
| `frontend/src/lib/routes.ts` | Typed URL builders (all `encodeURIComponent`-safe) |
| `frontend/src/components/ui/DashboardCard.tsx` | Renders as `<Link>`, `<button>`, or `<div>` depending on props |

---

## Endpoints / API Surface

The layout layer itself makes **no direct API calls**. All I/O is delegated:

| Call | Where it happens |
|------|-----------------|
| `GET /api/accounts/me/` | `authStore.bootstrap()` (called in `main.tsx`) and `authStore.refreshMe()` |
| `POST /api/accounts/auth/logout/` | `authStore.logout()` (triggered by "Sign out" in `AppShell`) |
| `POST /api/sadmin/feedback/` | `feedbackApi.submit()` (called from `OrgDashboardPage.submitFeedback`) |

---

## Key Models / Types in Scope

- `User` — `id`, `email`, `name`, `is_superuser`, `memberships[]`, `last_active_org_slug`, `deleted_at`
- `OrgMembership` — `org_id`, `org_slug`, `org_name`, `roles[]`, `is_org_owner`, `effective_modules[]`
- `Role` — enum sourced from `Schemas["RoleEnum"]` (generated from drf-spectacular)
- `NavItem` — `key`, `label`, `href`, `icon: LucideIcon`, `badge?`
- `DashboardCardConfig` — `key`, `icon`, `title`, `description`, `href?`, `action?`, `badge?`
- `AuthState` — `user`, `bootstrapped`, `requires2FA`, `isLoading`, `error`

---

## Findings

### F-01 — Dead code: `OrgComingSoonPage.tsx` is never imported or routed
**Severity:** medium  
**File:** `frontend/src/features/layout/OrgComingSoonPage.tsx:16`  
```ts
export function OrgComingSoonPage(): React.ReactElement {
```
`OrgComingSoonPage` is defined but appears zero times in any import or route table (`grep` across all `frontend/src` confirms only its own definition matches). The router (`App.tsx`) uses `ComingSoonPage` from `@/features/errors/ComingSoonPage` for the tournaments teaser, and real pages (`OrgAuditLogPage`, `OrgSettingsPage`, `OrgBrandingPage`) replaced the per-org coming-soon pattern. The file is stale.  
**Recommendation:** Delete `frontend/src/features/layout/OrgComingSoonPage.tsx`.

---

### F-02 — `OrgComingSoonPage` has no test coverage (moot, but confirms deadness)
**Severity:** low  
**File:** `frontend/src/features/layout/OrgComingSoonPage.tsx`  
No test file under `__tests__/` exercises `OrgComingSoonPage`. Combined with F-01 this is a strong signal the component was superseded without a cleanup pass.  
**Recommendation:** Delete the file (resolves F-01 and F-02 together).

---

### F-03 — Spec gap: `team_manager` nav item has no module gate
**Severity:** medium  
**File:** `frontend/src/features/layout/computeNavItems.ts:133-145`  
```ts
// Team workspace: no Appendix A.2 module exists (`tournament.team_manager_workspace`
// is unspecified). Spec gap — see report. Fall back to role-only gating until
// the module catalog is extended. Use a People icon (Users2) to differentiate
// from the Tournaments Trophy icon (DEFECT-N).
if (roles.includes("team_manager")) {
  items.push({
    key: "team",
    ...
    badge: t("Phase 1B"),
  });
}
```
The invariant (§12) requires the two-layer RBAC model: module visibility + verb permission. The `team_manager` workspace nav item cannot be module-gated because Appendix A.2 of `v1Users.md` does not define a `tournament.team_manager_workspace` module. This means a `MembershipModuleGrant` deny cannot suppress the nav item for a `team_manager` user. The comment in the code self-documents the gap.  
**Recommendation:** Add `tournament.team_manager_workspace` to the v1Users.md Appendix A.2 module catalog and to the backend `modules.json` fixture. Then convert the role-string guard to `hasModule(MODULE_TEAM_WORKSPACE)`.

---

### F-04 — `OrgDashboardPage` shows "Loading your modules..." when cards list is empty, but zero-module users are a legitimate state
**Severity:** medium  
**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:145-148`  
```tsx
{cards.length === 0 ? (
  <p className="col-span-full text-sm text-muted-foreground">
    {t("Loading your modules...")}
  </p>
) : (
```
`computeDashboardCards` always returns at least the "My profile" card (hardcoded, no module gate). So `cards.length === 0` only fires when `user` is null — but `user` is guaranteed non-null at this point because `ProtectedRoute` blocks unauthenticated renders. The copy "Loading your modules..." is therefore unreachable in normal operation, which is misleading and could mask future logic errors.  
**Recommendation:** Either remove the zero-card guard (since it is unreachable) or assert `user !== null` earlier and replace the message with a real empty state. A unit test asserting the fallback shows something meaningful would catch regressions.

---

### F-05 — `OrgChooserPage` shows no CTA to create an organization when membership list is empty
**Severity:** medium  
**File:** `frontend/src/features/layout/OrgChooserPage.tsx:41-48`  
```tsx
{user.memberships.length === 0 ? (
  <p className="text-sm">
    {t(
      "You don't belong to any organizations yet. Sign up creates a personal one automatically; otherwise wait for an invitation.",
    )}
  </p>
) : null}
```
The locked product decision states "creating a tournament auto-provisions the creator personal workspace". However if a user reaches `/orgs` with zero memberships (e.g., because the auto-provisioning on signup failed, or they were removed from all orgs), the page only shows explanatory text — there is no button to create an org or retry. The text mentions "Sign up creates a personal one automatically" which may already have happened for this user (so the instruction is wrong for them).  
**Recommendation:** Add a "Create an organization" CTA (link or button) that navigates to an org-creation flow. At minimum, replace the copy with a more accurate message and a contact/retry path.

---

### F-06 — `ProtectedRoute` redirects zero-membership non-superuser to `/orgs` but `OrgChooserPage` has no way out for them
**Severity:** medium  
**File:** `frontend/src/features/layout/ProtectedRoute.tsx:50-57`  
```ts
if (
  memberships.length === 0 &&
  !user.is_superuser &&
  location.pathname !== routes.orgChooser()
) {
  return <Navigate to={routes.orgChooser()} replace />;
}
```
The guard correctly avoids a loop by checking `location.pathname !== routes.orgChooser()`. However, the `OrgChooserPage` at `/orgs` only lists existing memberships — if the user has zero memberships they are permanently stuck on `/orgs` with only a static message (F-05). The `AppShell` nav will be empty (no slug → empty `computeNavItems`). The user cannot reach `/me`, `/me/notifications`, or any org-scoped surface without either receiving an invite or the backend creating a membership behind the scenes.  
**Recommendation:** Exempt `/me` and `/me/notifications` from the zero-membership redirect so users can at least edit their profile while waiting for an invite. Update `ProtectedRoute` to check `location.pathname.startsWith("/me")` in addition to the `/orgs` exception.

---

### F-07 — `AppShell` mobile drawer `<nav>` click handler closes drawer but swallows Escape key
**Severity:** low  
**File:** `frontend/src/features/layout/AppShell.tsx:251-259`  
```tsx
<nav
  aria-label={t("Primary")}
  className="flex flex-col gap-1"
  onClick={() => setDrawerOpen(false)}
>
```
The drawer overlay handles click-outside to close. The `<nav>` inside the drawer closes on any click (good for nav links). However, there is no `keydown` Escape handler for the drawer (contrast: the user menu at line 65-73 has one). This is a minor a11y gap — the spec mandates WCAG 2.1 AA; the `role="dialog"` element should close on Escape per ARIA Authoring Practices.  
**Recommendation:** Add a `useEffect` that listens for `keydown` Escape when `drawerOpen === true` and calls `setDrawerOpen(false)`, mirroring the pattern already used for the user menu.

---

### F-08 — `AppShell` mobile drawer uses custom `role="dialog"` instead of native `<dialog>`; focus trap is absent
**Severity:** medium  
**File:** `frontend/src/features/layout/AppShell.tsx:225-284`  
```tsx
<div
  id="mobile-nav-drawer"
  role="dialog"
  aria-modal="true"
  aria-label={t("Navigation menu")}
  className="fixed inset-0 z-40 md:hidden"
>
```
A `role="dialog"` with `aria-modal="true"` requires a focus trap — keyboard users (Tab / Shift-Tab) must not be able to navigate outside the dialog. The current implementation has no focus-trap logic (no `inert` on siblings, no trap library). This is a WCAG 2.1 AA violation (Success Criterion 2.4.3 Focus Order).  
**Recommendation:** Either (a) use a shadcn/ui `<Dialog>` (which uses Radix UI Portal + focus trap internally) for the mobile nav, or (b) add `@radix-ui/react-focus-trap` / `focus-trap-react` and wrap the drawer panel.

---

### F-09 — `computeNavItems` duplicates module-code constants from `dashboardCards.ts`
**Severity:** low  
**File:** `frontend/src/features/layout/computeNavItems.ts:21-24`  
```ts
const MODULE_ORG_MEMBER_DIRECTORY = "org.member_directory";
const MODULE_ORG_AUDIT_LOG = "org.audit_log";
const MODULE_MATCH_SCORING_CONSOLE = "match.scoring_console";
const MODULE_MATCH_REFEREE_CONSOLE = "match.referee_console";
```
The same keys exist as `MODULES.ORG_MEMBER_DIRECTORY`, `MODULES.ORG_AUDIT_LOG` etc. in `dashboardCards.ts`. The file comment acknowledges this: "Duplicated here… the source-of-truth list is in features/orgs/dashboardCards.ts and the two should stay in sync." If a module key is renamed in the fixture or backend, both files must be updated or they silently diverge.  
**Recommendation:** Export `MODULES` from `dashboardCards.ts` and import it in `computeNavItems.ts`. This removes the duplication risk without breaking the pure-function isolation goal.

---

### F-10 — `ProtectedRoute` 2FA redirect only fires when `requires2FA && !user`; a mid-session 2FA demand has no path
**Severity:** low / info  
**File:** `frontend/src/features/layout/ProtectedRoute.tsx:41-43`  
```ts
if (requires2FA && !user) {
  return <Navigate to={routes.twoFactorChallenge()} replace />;
}
```
The `requires2FA` flag is set only during the login flow (`authStore.login`). There is no mechanism for a mid-session server-side 2FA re-challenge. This is acceptable for Phase 1A but worth noting: if the backend ever emits a `403 totp_required` on a protected endpoint, the `AuthBusBridge` in `App.tsx` only handles `unauthenticated` (401). The 403 would surface as a generic API error without redirecting to the challenge page.  
**Recommendation:** Document the limitation in the auth store. In Phase 1B, extend `onAuthEvent` to handle a `totp_required` event and update `ProtectedRoute` accordingly.

---

### F-11 — `OrgDashboardPage` feedback `event_id` falls back silently to `undefined`
**Severity:** low  
**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:85-88`  
```ts
event_id:
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : undefined,
```
All browsers supported by the React 18 + Vite target support `crypto.randomUUID()` (Chromium 92+, Firefox 95+, Safari 15.4+). The guard is overly defensive and masks the case where `undefined` is sent — the backend's idempotency constraint (invariant §3) requires a non-null `event_id`. If the guard fires (e.g. in a test environment without `crypto`), duplicate feedback submissions will not be de-duped.  
**Recommendation:** Remove the defensive guard and call `crypto.randomUUID()` directly. Polyfill in the Vite test setup if needed.

---

### F-12 — Dashboard card `<aside>` Phase 1B teaser is always visible regardless of role
**Severity:** low / info  
**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:168-178`  
```tsx
<aside
  aria-label={t("Phase 1B preview")}
  ...
  data-testid="phase1b-teaser"
>
  <p className="font-medium">{t("Coming in Phase 1B")}</p>
```
The teaser strip listing "Tournament editor, Bracket generator, Live scoring, Referee console, Match disputes" is unconditionally rendered for every role — including viewer-only users who may never have access to those features. This is probably intentional (awareness/marketing), but it is worth making explicit in the design decision log.  
**Recommendation:** No code change required now, but add a `data-decision="phase1b-teaser-always-visible"` comment or PRD §14 entry so the choice is documented for Phase 1B cleanup.

---

### F-13 — `computeNavItems` `end` prop on `<NavLink>` set unconditionally; dashboard link will not match sub-routes
**Severity:** low / info  
**File:** `frontend/src/features/layout/AppShell.tsx:97-98`  
```tsx
<NavLink
  key={item.key}
  to={item.href}
  end
```
`end` means the link is only "active" when the pathname matches exactly. For the Dashboard link pointing to `/o/acme/dashboard` this is correct. But if Phase 1B adds nested routes under `/o/:orgSlug/dashboard/...`, the Dashboard nav item will lose its active highlight when a sub-route is shown. Low risk now; flag for Phase 1B.

---

## Gaps Section

| # | Gap | Area | Priority |
|---|-----|------|----------|
| G-01 | No "Create organization" flow exists in `OrgChooserPage` or anywhere in Phase 1A. The locked decision says signup auto-provisions a workspace, but there is no recovery path if that fails or a user is removed from all orgs. | Layout / Orgs | High |
| G-02 | `tournament.team_manager_workspace` module is absent from v1Users.md Appendix A.2. Until it is added, the Team nav item cannot be module-gated (no MembershipModuleGrant deny is possible). | RBAC spec | Medium |
| G-03 | Mobile drawer has no focus trap. WCAG 2.1 AA violation. | a11y | Medium |
| G-04 | `OrgComingSoonPage` is dead code in `frontend/src/features/layout/`; should be deleted. | Cleanup | Low |
| G-05 | Module-code constants duplicated between `computeNavItems.ts` and `dashboardCards.ts`; sync drift risk. | Maintainability | Low |
| G-06 | Zero-membership users can only reach `/orgs` and `/me`-family routes; the redirect in `ProtectedRoute` blocks all others but does not exempt `/me`. | UX / routing | Medium |
| G-07 | No dark-mode tokens applied; AppShell uses `bg-card`, `text-muted-foreground`, etc. (shadcn tokens) which are dark-mode capable once a dark theme CSS variable set is wired at the root. No root theme toggling exists yet. | Pro SaaS UX overhaul | Low (future) |
| G-08 | `OrgDashboardPage` has no "empty org" state for a user with a valid membership but zero effective modules (every module deny-overridden). `computeDashboardCards` still returns the Profile card, so the UX degrades gracefully — but the visible "Loading your modules…" label is misleading. | UX | Low |
