# Audit: fe-layout — UI/UX Quality vs Pro SaaS Bar + Test Coverage Gaps

**Scope:** `frontend/src/features/layout/` (AppShell, ProtectedRoute, OrgDashboardPage, OrgChooserPage, OrgComingSoonPage, computeNavItems) and directly supporting primitives (`components/ui/DashboardCard`, `components/ui/dialog`, `index.css`).

**Lens:** Visual/UX quality vs a professional SaaS bar (shadcn/ui, lucide, framer-motion, cohesive colors/dark mode); plus missing vitest coverage for guards, permission gating, and error states.

---

## Findings

### F-1 — HIGH — No animation library installed; mobile drawer and user menu have zero motion polish

**File:** `frontend/package.json` (no `framer-motion` dependency)
**Evidence:**
```json
"dependencies": {
  "@hookform/resolvers": "^5.2.2",
  "@tanstack/react-query": "^5.100.8",
  // ... no framer-motion
```

AppShell mounts/unmounts the mobile drawer and user menu via a ternary with no transition:
```tsx
// AppShell.tsx:223-285
{drawerOpen ? (
  <div id="mobile-nav-drawer" ... className="fixed inset-0 z-40 md:hidden">
    ...
  </div>
) : null}
```
And the user menu:
```tsx
// AppShell.tsx:174
{menuOpen ? (
  <div role="menu" ... className="absolute right-0 z-30 mt-2 w-56 ...">
```

**Why it matters:** Instant mount/unmount on menus and drawers reads as a broken or cheap UI. Every pro SaaS (Linear, Vercel, Notion) animates these with 150–200 ms ease-out slide/fade. The owner explicitly cited framer-motion as a target library.

**Recommendation:** Install `framer-motion`. Wrap the mobile drawer in `<AnimatePresence>` with `motion.div` slide-in-left. Wrap the user-menu dropdown in a 100 ms opacity + translateY entrance. Use `layout` prop on nav items if they reorder.

---

### F-2 — HIGH — Dialog primitive is a homegrown scaffold, not Radix/shadcn; lacks focus trap, `aria-describedby`, and scroll-lock

**File:** `frontend/src/components/ui/dialog.tsx:7-9`
**Evidence:**
```tsx
/**
 * Tiny accessible modal-dialog primitive. We avoid pulling Radix into this
 * scaffold to keep the package surface minimal. Replace with @radix-ui/dialog
 * when shadcn primitives are formally adopted.
 */
```

The component has no focus trap (tabbing out of the dialog escapes to the page), no `aria-describedby` linkage from the dialog element to the description paragraph, and no body scroll-lock. The close button renders the text literal `x` instead of a proper icon:
```tsx
// dialog.tsx:111
>
  x
</button>
```

**Why it matters:** A feedback modal on the dashboard is the first interactive complex element users encounter. A broken focus trap is a WCAG 2.1 AA failure (4.1.3 / 2.1.2). The `x` text is visually inconsistent with the lucide icons used everywhere else.

**Recommendation:** Replace with `@radix-ui/react-dialog` (which shadcn wraps). Add `@radix-ui/react-dialog` and the shadcn dialog scaffold. Wire `<DialogTitle>` to `aria-labelledby` and `<DialogDescription>` to `aria-describedby` on the root. Replace the `x` close button with `<X className="h-4 w-4" />` from lucide.

---

### F-3 — HIGH — Dark-mode color tokens defined but AppShell header and nav have hardcoded `bg-card` that collapses in dark mode without a dark card value distinct from the background

**File:** `frontend/src/index.css:44-65`
**Evidence:**
```css
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --card: 222.2 84% 4.9%;   /* identical to --background */
```

`AppShell.tsx:123`:
```tsx
className="flex h-14 items-center gap-3 border-b bg-card px-3 sm:px-4"
```

In dark mode the header (`bg-card`) has exactly the same value as `bg-background`, so the `border-b` is the only visual separator. On a dark theme the header visually merges with the page body — no depth, no chrome distinction.

**Why it matters:** Pro SaaS apps (Linear, Vercel) use a slightly elevated card surface in dark mode (e.g. `hsl(222 47% 7%)` vs `hsl(222 47% 5%)`) to give the header a subtle lift. Without it the layout reads flat.

**Recommendation:** Set `--card` in `.dark` to a value 2–4% lighter than `--background` (e.g. `217.2 32.6% 10%` vs `222.2 84% 4.9%`). Consider adding a `--surface-elevated` token for the header specifically, matching the pattern used in the tailwind config `brand.*` tokens.

---

### F-4 — MEDIUM — AppShell brand wordmark is plain text; no logo/icon; inconsistent with the LandingPage brand treatment

**File:** `frontend/src/features/layout/AppShell.tsx:136-142`
**Evidence:**
```tsx
<Link
  to={routes.landing()}
  className="font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
>
  {t("Fixture")}
</Link>
```

vs. `LandingPage.tsx:49-56`:
```tsx
<span
  aria-hidden="true"
  className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-700 text-white font-bold"
>
  F
</span>
<span>{t("Fixture Platform")}</span>
```

The landing page has an icon badge ("F" on emerald). The authenticated AppShell has just plain text "Fixture". The two pages present different brand identities.

**Why it matters:** Brand consistency is a table-stakes SaaS quality signal. Every page transition that crosses the boundary (landing → login → dashboard) resets the wordmark feel.

**Recommendation:** Replicate the icon badge from LandingPage into the AppShell wordmark. Extract a shared `<BrandMark />` component (icon + text) consumed by both AppShell and LandingPage.

---

### F-5 — MEDIUM — OrgChooserPage membership pill shows raw `effective_modules.length` as a string interpolated into `t()`, making it untranslatable

**File:** `frontend/src/features/layout/OrgChooserPage.tsx:35-37`
**Evidence:**
```tsx
<CardContent className="text-xs text-muted-foreground">
  {t(`${m.effective_modules.length} modules accessible`)}
</CardContent>
```

The template literal bakes the count into the key string, so every org count produces a unique translation key (e.g. `"3 modules accessible"`, `"12 modules accessible"`). The `t()` function will never find these in a translation file because the key is dynamic. This violates invariant #13 (i18n from day 1).

**Why it matters:** When localisation lands, every `t(\`${n} ...\`)` pattern will silently pass through untranslated. The pattern also defeats any ICU plural rules (`{count, plural, one {# module} other {# modules}}`).

**Recommendation:** Split into `t("{count} modules accessible", { count: m.effective_modules.length })` with a static key, or use a dedicated helper. At minimum move the count outside `t()`: `` `${m.effective_modules.length} ${t("modules accessible")}` ``.

---

### F-6 — MEDIUM — OrgChooserPage: zero-membership empty state renders as a plain `<p>` paragraph with no call to action

**File:** `frontend/src/features/layout/OrgChooserPage.tsx:41-47`
**Evidence:**
```tsx
{user.memberships.length === 0 ? (
  <p className="text-sm">
    {t(
      "You don't belong to any organizations yet. Sign up creates a personal one automatically; otherwise wait for an invitation.",
    )}
  </p>
) : null}
```

There is no action button (create org, or re-send invite reminder). The wording says "sign up creates a personal one automatically" but if a user reaches this page they are already signed in — the message is contradictory. Also the paragraph sits below the `grid gap-3` which is empty, leaving blank whitespace above the text.

**Why it matters:** A new user who has been invited but whose org auto-provision failed, or who arrived via a direct deep-link, sees a confusing unstyled message with no next step. This is a dead-end UX.

**Recommendation:** Replace the `<p>` with an empty-state card (icon + heading + body + optional CTA). Correct the copy to say "Your invitation is pending" or "Contact your admin." Add a "Back to login" link for users who are stuck.

---

### F-7 — MEDIUM — OrgDashboardPage role pill renders raw comma-joined role strings; no RoleBadge component and no colour coding

**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:117-131`
**Evidence:**
```tsx
<span
  className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground"
  data-testid="role-pill"
>
  {t("You are:")} {roles.join(", ")}
</span>
```

There is an existing `<RoleBadge>` component in `components/ui/RoleBadge.tsx`, but the dashboard bypasses it and renders a single monolithic pill with comma-separated roles and the prefix "You are:". If a user has multiple roles the result is `"You are: admin, co_organizer"` which is unwieldy.

**Why it matters:** Multiple roles in one pill is hard to scan. RoleBadge already handles per-role colour coding. "You are:" is verbose and reads like a form label rather than a status badge.

**Recommendation:** Replace the single span with `{roles.map(r => <RoleBadge key={r} role={r} />)}` inline. Remove the "You are:" prefix. Arrange badges in a `flex flex-wrap gap-1` row.

---

### F-8 — MEDIUM — ProtectedRoute loading state is a plain text string with no visual spinner or skeleton

**File:** `frontend/src/features/layout/ProtectedRoute.tsx:29-38`
**Evidence:**
```tsx
if (!bootstrapped) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center text-sm text-muted-foreground"
    >
      {t("Loading...")}
    </div>
  );
}
```

On a cold load (first visit, cookie warm), the user sees the entire screen replaced with the text "Loading..." for the duration of the `/api/accounts/me/` round trip.

**Why it matters:** Pro SaaS apps use a subtle spinner or a skeleton shell (header chrome + grey card skeletons) to signal activity without a jarring blank screen. Plain "Loading..." text was the 2015 standard.

**Recommendation:** Replace with a centered `<Loader2 className="h-8 w-8 animate-spin text-primary" />` from lucide-react, or a full AppShell skeleton (grey header bar + card placeholders) to reduce layout shift.

---

### F-9 — MEDIUM — OrgComingSoonPage is a bare Card with only back-link; no illustration, phase label, or expected timeline

**File:** `frontend/src/features/layout/OrgComingSoonPage.tsx:16-39`
**Evidence:**
```tsx
export function OrgComingSoonPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  return (
    <div className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Coming soon")}</CardTitle>
          <CardDescription>
            {t(
              "This area is part of Phase 1B. The chassis is in place, but the feature has not shipped yet.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <Link to={routes.orgDashboard(orgSlug)} className="text-primary underline">
            {t("Back to dashboard")}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
```

The page is blank except for one card. It appears when navigating to Tournaments. There is no icon, no timeline hint, no visual branding differentiation from an error page.

**Why it matters:** This is frequently encountered by users exploring the dashboard. A plain "coming soon" card reads like a 404. A high-quality teaser page (illustrated, phase-labelled, with a subscribe/notify CTA) increases retention and expectation alignment.

**Recommendation:** Add a `Trophy` icon with an emerald brand treatment, a phase label ("Phase 1B — target: Q3 2026"), and optionally a "Notify me when it ships" button wired to the feedback modal.

---

### F-10 — LOW — OrgDashboardPage Phase 1B teaser strip uses `border-dashed bg-muted/40` with no icon or visual accent; reads as a debug note

**File:** `frontend/src/features/layout/OrgDashboardPage.tsx:168-178`
**Evidence:**
```tsx
<aside
  aria-label={t("Phase 1B preview")}
  className="rounded-lg border border-dashed bg-muted/40 p-4 text-sm"
  data-testid="phase1b-teaser"
>
  <p className="font-medium">{t("Coming in Phase 1B")}</p>
  <p className="mt-1 text-muted-foreground">
    {PHASE_1B_TEASERS.map((s) => t(s)).join(", ")}
    {"."}
  </p>
</aside>
```

The dashed border signals "placeholder/debug" not "upcoming feature". The content is a comma-separated sentence dump.

**Why it matters:** First impressions of the dashboard set user expectations. A teaser strip should feel intentional, not like scaffolding left in.

**Recommendation:** Replace with a styled callout (solid subtle border, a `Sparkles` or `Rocket` icon, feature chips laid out as `flex flex-wrap gap-2` badges rather than comma-prose). Apply the brand emerald accent colour for the callout border.

---

### F-11 — LOW — AppShell nav badge uses hardcoded `emerald-100/emerald-800` hex classes instead of the brand token

**File:** `frontend/src/features/layout/AppShell.tsx:111-114`
**Evidence:**
```tsx
<span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
  {item.badge}
</span>
```

The tailwind config defines `brand.muted` and `brand.DEFAULT` tokens, but the nav badge uses raw `emerald-100` / `emerald-800`.

**Why it matters:** When the brand palette changes (e.g. switching from emerald to a different primary), this badge will not update with the rest. It creates a maintenance inconsistency.

**Recommendation:** Replace `bg-emerald-100 text-emerald-800` with `bg-brand-muted text-brand` (using the configured custom tokens).

---

### F-12 — LOW — AppShell mobile drawer uses a plain `<div role="dialog">` instead of a native `<dialog>` element or Radix Sheet; focus restoration on close is not handled

**File:** `frontend/src/features/layout/AppShell.tsx:224-285`
**Evidence:**
```tsx
<div
  id="mobile-nav-drawer"
  role="dialog"
  aria-modal="true"
  aria-label={t("Navigation menu")}
  className="fixed inset-0 z-40 md:hidden"
>
```

When the drawer closes there is no focus-restoration to the hamburger button. Users relying on keyboard navigation lose their position.

**Why it matters:** WCAG 2.1 Success Criterion 2.1.1 (Keyboard) and 2.4.3 (Focus Order) require that closing a modal returns focus to the element that opened it.

**Recommendation:** Track the trigger element ref and call `.focus()` in the `setDrawerOpen(false)` handler, or migrate to Radix `Sheet` which handles this automatically.

---

## Gaps (missing test coverage)

| # | Item | Missing | Needed for | Effort | Blocking |
|---|------|---------|-----------|--------|---------|
| G-1 | `ProtectedRoute` | Zero vitest coverage. No test file exists. Redirect rules (not-bootstrapped → spinner, requires2FA → `/2fa/challenge`, no-user → `/login?next=...`, zero-memberships → `/orgs`) are untested. | Guard correctness; regression safety for auth flows | M | Yes — boot and 2FA redirect paths are core security guards |
| G-2 | `OrgChooserPage` | No test file. Empty-membership empty-state, multi-org list rendering, and link hrefs are untested. | Page-level regressions | S | No |
| G-3 | `OrgComingSoonPage` | No test file. Slug extraction and back-link href are untested. | Page-level regressions | S | No |
| G-4 | `AppShell` — Escape key dismisses user menu | Test suite covers open/close via click but has no keyboard test for the Escape dismissal (the `onKey` handler in the `useEffect`). | A11y keyboard regression | S | No |
| G-5 | `AppShell` — mobile drawer Escape key | No test that pressing Escape while the mobile drawer is open closes it. | A11y keyboard regression | S | No |
| G-6 | `AppShell` — click-outside dismisses user menu | Not covered. The `onDocClick` handler in the effect is untested. | UX regression | S | No |
| G-7 | `AppShell` — superuser with zero memberships | `ProtectedRoute` skips the `/orgs` redirect for `is_superuser=true`, but `AppShell` has no test for a superuser with no memberships seeing the correct nav (empty, not an error). | Permission gate regression | S | No |
| G-8 | `OrgDashboardPage` — feedback submit error path | `submitFeedback` has a `catch` block that toasts an error, but no test exercises the `feedbackApi.submit` rejection branch. | Error-state coverage | S | No |
| G-9 | `OrgDashboardPage` — `?feedback=1` query param auto-opens modal | The `useEffect` that reads `searchParams.get("feedback") === "1"` is not tested. | Feature regression | S | No |
| G-10 | `OrgDashboardPage` — `deleted_at` field on user | The `makeUser` helper in the OrgDashboardPage test omits the `deleted_at` field check and there is no test asserting a soft-deleted user is handled gracefully. | Edge-case correctness | S | No |
| G-11 | `computeNavItems` — `is_org_owner=true` without `"owner"` in roles | The test at line 56 covers the case where `roles.includes("owner")` makes someone an owner, but no test covers the `is_org_owner: true, roles: ["admin"]` path as distinct from owner-by-role. | RBAC correctness | S | No |
| G-12 | `DashboardCard` — disabled state renders `div` not link/button | No test that a `disabled=true` card is non-interactive and carries `aria-disabled="true"`. | A11y regression | S | No |
