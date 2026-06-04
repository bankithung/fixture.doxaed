# Audit: frontend/src/features/roles — UI/UX Quality & Test Coverage

**Date:** 2026-06-04
**Scope:** `frontend/src/features/roles/**` (routes, role landing pages, profile, notification prefs, redirect logic) + directly coupled shared components (`PreviewTile`, `RoleBadge`, `Avatar`, `AppShell`) that affect the roles UX bar.
**Lenses:** (1) Visual/UX quality vs. a professional SaaS bar with `shadcn/ui + lucide + framer-motion + cohesive colors/dark mode`; (2) Missing vitest coverage for guards, permission gating, and error states.

---

## Findings

---

### F-01 — `framer-motion` is not installed; zero motion anywhere in the roles feature

**Severity:** high
**File:** `frontend/package.json:19-29` / all files in `frontend/src/features/roles/`

**Evidence (`package.json`):**
```json
"dependencies": {
  "@hookform/resolvers": "^5.2.2",
  "@tanstack/react-query": "^5.100.8",
  ...
  // framer-motion is absent
}
```

**Why it matters:** The owner explicitly asked for `framer-motion` as part of the pro SaaS UI/UX overhaul. Currently the role landing pages, profile sections, and preview tiles have zero entrance/transition animations. The page feels flat and static compared to peers (Linear, Vercel dashboard, etc.). Cards just pop into existence on mount; the preview tile grid has no stagger; the edit-profile inline form appears/disappears without a transition.

**Recommendation:** Add `framer-motion` to `dependencies`. Apply `motion.div` with a staggered `initial/animate` to the `RoleLandingShell` tile grid and to the `MyProfilePage` card stack. The profile inline-edit form (Save/Cancel buttons) is the highest-value spot for a height-animate exit/enter.

---

### F-02 — No dark-mode variant classes anywhere in the roles feature (or any feature file)

**Severity:** high
**File:** all files in `frontend/src/features/roles/`, `frontend/src/components/ui/RoleBadge.tsx`, `frontend/src/components/ui/PreviewTile.tsx`

**Evidence:** A repo-wide grep for `dark:` in `frontend/src` returned **zero results**. The CSS custom-property `.dark` block exists in `index.css` (lines 45-65) and `tailwind.config.js` has `darkMode: ["class"]` (line 3), meaning Tailwind is ready — but no component switches colours for dark mode via utility classes.

Specific problematic patterns in `RoleBadge.tsx` (lines 33-57): hard-coded Tailwind colour-scale classes like `bg-amber-50 text-amber-900`, `bg-indigo-100 text-indigo-900`, etc. These are light-mode-only values. In dark mode they will render as blindingly light chips on a near-black background. Similarly, `MyProfilePage.tsx` line 206 uses `bg-grant-muted` (maps to `hsl(142 50% 92%)` — essentially white), which turns unreadable in dark mode. The `PreviewTile.tsx` badge at line 51 uses `bg-secondary text-secondary-foreground` (CSS vars, so theme-aware), which is correct — but the container `bg-muted/30` border-dashed pattern reads poorly in dark too.

**Recommendation:**
- For `RoleBadge`: replace raw Tailwind `bg-amber-50 text-amber-900` etc. with pairs like `bg-amber-100/80 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200`. All seven palette entries need dark counterparts.
- For the `MyProfilePage` 2FA "Enabled" chip (line 206): replace `bg-grant-muted` with a CSS-var-based token or add a `dark:` variant (e.g., `dark:bg-grant/20 dark:text-grant`).
- Add a theme toggle (Sun/Moon icon) to `AppShell` that sets/removes the `.dark` class on `<html>`. Until the toggle exists, none of the dark tokens are reachable.

---

### F-03 — `MyProfilePage` avatar uses a hard-coded `bg-secondary` style, inconsistent with the `Avatar` component used elsewhere

**Severity:** medium
**File:** `frontend/src/features/roles/MyProfilePage.tsx:104-108`

**Evidence:**
```tsx
<div
  aria-hidden="true"
  className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-lg font-semibold text-secondary-foreground"
  data-testid="profile-avatar"
>
  {initials}
```

**Why it matters:** The `Avatar` component at `frontend/src/components/ui/Avatar.tsx` already derives a deterministic hue from the user's email and handles initials correctly (including the DEFECT-K disambiguation fix). The profile page re-implements initials derivation inline (a simplified version at lines 52-58) and uses a flat `bg-secondary` circle — losing both the colour differentiation and the consistent size system (`sm/md/lg`). This visual inconsistency is noticeable to professional eyes: the top of the profile page has a grey disc while everywhere else (nav header, member directory) the same person gets a coloured avatar.

**Recommendation:** Replace the hand-rolled `div` + local `initials` derivation with `<Avatar email={user.email} name={user.name} size="lg" />`. Delete the local `initials` `useMemo`.

---

### F-04 — `RoleLandingShell` "What you can do today" uses a bare `<ul>` with plain link text, not a card list pattern

**Severity:** medium
**File:** `frontend/src/features/roles/RoleLandingShell.tsx:95-142`

**Evidence:**
```tsx
<ul className="flex flex-col gap-2 text-sm">
  <li>
    <Link to={routes.myProfile()} className="text-primary underline-offset-4 hover:underline">
      {t("View profile")}
    </Link>
    <span className="ml-2 text-xs text-muted-foreground">
      {t("Edit name, change password, manage 2FA")}
    </span>
  </li>
```

**Why it matters:** The three action items are presented as a line of underlined text with a trailing muted descriptor — essentially a markdown-style list. Professional SaaS role landing pages (e.g., Vercel's project dashboard) use structured action rows with an icon on the left, bold label, and description below, making each item scannable. The current pattern also mixes a `<button>` (feedback) visually into the same `<ul>` as `<Link>` elements; their affordances look identical, which breaks the convention that buttons perform actions and links navigate.

**Recommendation:** Convert each item to a consistent row component: `lucide` icon + bold label + description + optional chevron. Consider a `<nav>` or using the shadcn `<Button variant="ghost">` with `asChild` for the link rows so everything is visually aligned.

---

### F-05 — Preview tiles use a dashed border with `bg-muted/30` — conveys "broken" rather than "preview"

**Severity:** medium
**File:** `frontend/src/components/ui/PreviewTile.tsx:44-48`

**Evidence:**
```tsx
className={cn(
  "relative flex flex-col gap-2 rounded-lg border border-dashed bg-muted/30 p-4",
  "text-card-foreground",
  className,
)}
```

**Why it matters:** A dashed border is a drag-and-drop drop-target affordance in most design systems. Using it for "coming soon" tiles gives the impression of an empty state or broken UI rather than a deliberate preview card. Professional SaaS "upcoming feature" tiles typically use a solid border with reduced opacity, a diagonal stripe overlay, or a `blur-sm` content layer combined with an `absolute` "coming soon" ribbon. The current "Phase 1B" badge in the top-right corner is small (`text-[10px]`) and competes visually with the icon.

**Recommendation:** Change `border-dashed` to `border` with `opacity-70` on the whole tile, and increase the badge prominence (use `shadcn/ui` Badge primitive or a `rounded-md` with a stronger colour).

---

### F-06 — `MyProfilePage` has no role/permission-gating check; any authenticated user who knows the URL can render it without constraint

**Severity:** medium (UX + security hygiene)
**File:** `frontend/src/features/roles/MyProfilePage.tsx`, `frontend/src/features/roles/routes.tsx:23`

**Evidence:** Route `{ path: "/me", element: <MyProfilePage /> }` is declared inside the role routes that are spread into `<AppShell>` which sits behind `<ProtectedRoute>`. `ProtectedRoute` only checks `user !== null` — it has no role check. The route is correctly protected from unauthenticated access but there is no restriction on which role can access it. This is intentional for `/me` (it should be universally accessible). The issue is there are no tests verifying that non-authenticated users are bounced (the `ProtectedRoute` layer is not unit-tested in conjunction with these routes), and the landing pages for `scorer/referee/team-manager` are equally accessible to an `admin` who types the URL directly — there is no role-enforcement guard.

**Recommendation:** Add a test in `__tests__/` that wraps the role landing pages with `ProtectedRoute` and asserts that a non-authenticated user is redirected to `/login`, and that a wrong-role user sees the page anyway (as intended — document the design decision explicitly). This is not a bug but a gap in documented test coverage.

---

### F-07 — `NotificationPrefsPage` has zero test coverage

**Severity:** medium
**File:** `frontend/src/features/roles/NotificationPrefsPage.tsx` — no `__tests__/NotificationPrefsPage.test.tsx` exists

**Evidence:** `Glob frontend/src/features/roles/__tests__/NotificationPrefsPage*` returned no files. The page renders a non-trivial layout (section, card, heading, link back to profile) and is linked from the user menu in `AppShell` and from `RoleLandingShell`.

**Why it matters:** No test means a future refactor of route names or `t()` wrapping could silently break the "Back to profile" link or the heading text.

**Recommendation:** Add `NotificationPrefsPage.test.tsx`: render with `MemoryRouter`, assert the `<h1>` content, assert the "Back to profile" link points to `/me`, and assert the "Coming in Phase 1B" card is present.

---

### F-08 — `MyProfilePage.test.tsx` does not test any interactive states (edit flow, save success, save error, sign-out)

**Severity:** medium
**File:** `frontend/src/features/roles/__tests__/MyProfilePage.test.tsx`

**Evidence:** The test file (lines 1-139) contains only 8 `it` blocks, none of which use `userEvent` or mock `authApi`. The following interactive paths are entirely untested:
- Clicking "Edit profile" → form switches to edit mode → `Input` becomes enabled
- Clicking "Save" → `authApi.patchMe` called → `refreshMe` called → edit mode exits
- `authApi.patchMe` throws → error toast rendered
- Clicking "Cancel" → name reverts to original, edit mode exits
- Clicking "Sign out everywhere" → `logout()` called → navigate to `/login`

**Recommendation:** Add a `userEvent`-driven suite (5–6 tests) covering the above. Mock `authApi.patchMe` with `vi.spyOn`. The error-state test is particularly important for user trust.

---

### F-09 — `redirectByRole.test.ts` lacks the slug-encoding edge-case assertion for all non-scorer roles

**Severity:** low
**File:** `frontend/src/features/roles/__tests__/redirectByRole.test.ts:170-176`

**Evidence:**
```ts
it("encodes org slug in produced paths", () => {
  expect(
    pickLandingPathForUser(
      userWithRoles(["match_scorer"], { slug: "acme & sons" }),
    ),
  ).toBe(`/o/${encodeURIComponent("acme & sons")}/scoring`);
});
```

The slug-encoding test only covers `match_scorer`. The dashboard, referee, and team-manager branches of `pickLandingPathForUser` also call `routes.orgDashboard/orgReferee/orgTeam` — if those helpers ever forgot to encode, this test would not catch it.

**Recommendation:** Add encoding tests for `admin` (→ dashboard), `referee` (→ `/referee`), and `team_manager` (→ `/team`) with a slug containing a special character.

---

### F-10 — `ScorerLandingPage` / `RefereeLandingPage` / `TeamManagerLandingPage` do not test "today" action links or feedback link for `RefereeLandingPage` and `TeamManagerLandingPage`

**Severity:** low
**File:** `frontend/src/features/roles/__tests__/RefereeLandingPage.test.tsx`, `frontend/src/features/roles/__tests__/TeamManagerLandingPage.test.tsx`

**Evidence:** `ScorerLandingPage.test.tsx` (lines 34-48) tests the "View profile", "Update notification preferences", and "Send feedback" links. `RefereeLandingPage.test.tsx` and `TeamManagerLandingPage.test.tsx` do not check those links at all — they only check tile rendering.

**Recommendation:** Port the link-assertion block from `ScorerLandingPage.test.tsx` to the other two test files.

---

### F-11 — `RoleLandingShell` has no direct unit tests for the `onSendFeedback` branch

**Severity:** low
**File:** `frontend/src/features/roles/RoleLandingShell.tsx:119-135` — no `__tests__/RoleLandingShell.test.tsx`

**Evidence:** The shell has a conditional: if `onSendFeedback` is provided, render a `<button>`; otherwise render a `<Link>`. Only the `<Link>` path is exercised indirectly via the three page tests. The `<button>` path (used when a parent passes a callback) is never tested.

**Recommendation:** Add a `RoleLandingShell.test.tsx` that (a) tests with `onSendFeedback` provided — asserts a `<button>` renders and `onClick` is called; (b) tests without — asserts a `<Link>` renders.

---

### F-12 — `ScorerLandingPage.tsx` uses `React.ReactElement` return type without importing React

**Severity:** low (latent — harmless in React 19 JSX transform but fragile for strict-mode tooling)
**File:** `frontend/src/features/roles/ScorerLandingPage.tsx:12`

**Evidence:**
```ts
// imports at top: only lucide icons, RoleLandingShell, t
export function ScorerLandingPage(): React.ReactElement {
```

`React` is referenced in the return type annotation but not imported. In React 19 with the automatic JSX transform this compiles, but `tsc --noEmit` will fail if `tsconfig.json` has `"jsx": "react"` instead of `"react-jsx"`. The same pattern applies to `RefereeLandingPage.tsx` and `TeamManagerLandingPage.tsx`.

**Recommendation:** Either add `import type { ReactElement } from "react"` and use `ReactElement` as the return type, or add a top-level `import * as React from "react"` to make the `React.ReactElement` reference explicit.

---

### F-13 — No `ProtectedRoute` integration tests for the role-specific landing paths

**Severity:** low
**File:** (missing) — no test file exercises `ProtectedRoute` + role landing route together

**Evidence:** `ProtectedRoute` is tested implicitly only through `AppShell.test.tsx` (which does not mount `ProtectedRoute`). The actual "unauthenticated user hits `/o/acme/scoring`" redirect path is untested end-to-end in unit tests.

**Recommendation:** Add one parametrized test in a new `ProtectedRoute.test.tsx` (or extend AppShell tests) that mounts `<ProtectedRoute><ScorerLandingPage /></ProtectedRoute>` with `user = null` and asserts a redirect to `/login?next=...`.

---

## Gaps (forward-looking, not yet bugs)

| # | Item | Missing | Needed for | Effort | Blocking? |
|---|------|---------|------------|--------|-----------|
| G-01 | Dark mode toggle | No component sets/removes `.dark` class on `<html>`; CSS vars are ready but unreachable | Pro SaaS dark mode overhaul | M | No |
| G-02 | `framer-motion` entrance animations | Package not installed; no animated mounts/exits anywhere | Motion-design overhaul | M | No |
| G-03 | `RoleBadge` dark-mode variants | All 7 palette entries use light-only Tailwind colour scales | Readable badges in dark mode | S | No |
| G-04 | `NotificationPrefsPage` tests | No test file exists | CI coverage gate | S | No |
| G-05 | `MyProfilePage` interaction tests | No `userEvent` / mutation-error tests | Regression safety for profile mutations | M | No |
| G-06 | `RoleLandingShell` onSendFeedback branch test | Only Link path exercised | Full shell coverage | S | No |
| G-07 | Slug-encoding tests for all redirect branches | Only scorer branch tested | Catch encoding regressions in route helpers | S | No |
| G-08 | `ProtectedRoute` + role page integration test | No test mounting ProtectedRoute with role pages | Confidence in auth guard | S | No |
| G-09 | Preview tile visual upgrade | Dashed border / tiny badge — subpro appearance | Pro SaaS tile design | S | No |
| G-10 | `MyProfilePage` use `Avatar` component | Inline initials re-implementation diverges from shared component | Visual consistency | S | No |
