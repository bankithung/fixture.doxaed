# A11y & i18n Audit: `frontend/src/features/layout`

**Date:** 2026-06-04
**Scope:** `frontend/src/features/layout/` (AppShell, OrgChooserPage, OrgDashboardPage, OrgComingSoonPage, ProtectedRoute, computeNavItems) plus directly-consumed UI primitives: `components/ui/dialog.tsx`, `components/ui/DashboardCard.tsx`, `features/orgs/OrgSwitcher.tsx`, `features/orgs/dashboardCards.ts`.
**Lens:** unwrapped (non-`t()`) user-visible strings; missing aria/labels/for; keyboard nav + focus management; dialog focus traps; alt text; WCAG 2.1 AA contrast issues.

---

## Findings

### F1 — HIGH: Mobile nav drawer has no focus trap (keyboard users can tab behind overlay)

**File:** `frontend/src/features/layout/AppShell.tsx:222-285`

When `drawerOpen` is true a `<div role="dialog" aria-modal="true">` is mounted. `aria-modal="true"` tells AT to treat the overlay as modal, but AT support for `aria-modal` on non-`<dialog>` elements is inconsistent (especially VoiceOver/Safari). More critically, no JavaScript focus trap is applied: the first focusable element in the drawer does not receive focus on open, and Tab will silently traverse behind the dark overlay to header elements.

**Quoted evidence:**
```tsx
// AppShell.tsx:222-235
{drawerOpen ? (
  <div
    id="mobile-nav-drawer"
    role="dialog"
    aria-modal="true"
    aria-label={t("Navigation menu")}
    className="fixed inset-0 z-40 md:hidden"
  >
    <div
      aria-hidden="true"
      className="absolute inset-0 bg-foreground/40"
      onClick={() => setDrawerOpen(false)}
    />
```

No `useEffect` moves focus to the close button or first nav link on mount. No focus-trap library or manual tabindex sentinel logic.

**Why it matters:** WCAG 2.1 SC 2.1.2 (No Keyboard Trap) and SC 1.3.6 (Identify Purpose) — screen-reader users and keyboard-only users cannot reliably operate the drawer; focus escapes to obscured background content.

**Recommendation:**
1. Switch to a native `<dialog>` element (browser-native focus trap + Escape handling).
2. Or install `focus-trap-react` / `@radix-ui/react-dialog` and wrap the drawer panel.
3. On mount, `useEffect(() => { closeButtonRef.current?.focus(); }, [drawerOpen])`.

---

### F2 — HIGH: Dialog primitive has no `aria-labelledby` linking title to dialog role

**File:** `frontend/src/components/ui/dialog.tsx:34-49`

The `<div role="dialog">` uses `aria-label` but the `DialogTitle` (`<h2>`) inside is not connected via `aria-labelledby`. ARIA authoring practice prefers `aria-labelledby` (pointing to the visible heading) over a duplicate `aria-label`, because `aria-label` is not translated by some AT when the page language changes, and it creates a redundant narration when the title is also spoken as a heading.

Additionally, no `aria-describedby` connects `DialogDescription` to the dialog.

**Quoted evidence:**
```tsx
// dialog.tsx:35-48
<div
  role="dialog"
  aria-modal="true"
  aria-label={ariaLabel}          // ← only aria-label, no aria-labelledby
  className="..."
  onClick={(e) => { ... }}
>
  <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
    {children}
    // DialogTitle renders as <h2> but has no id referenced here
  </div>
</div>
```

**Why it matters:** WCAG 2.1 SC 4.1.2 (Name, Role, Value). AT may announce the dialog without announcing its title; on locale switch, `aria-label` (static string) may not be re-translated, while `aria-labelledby` always reads the live DOM text.

**Recommendation:**
- Add `id` props to `DialogTitle` and optionally `DialogDescription`, then pass `aria-labelledby` / `aria-describedby` to `Dialog`. Alternatively, adopt `@radix-ui/react-dialog` which handles this automatically.

---

### F3 — HIGH: Dialog has no focus trap or initial-focus management

**File:** `frontend/src/components/ui/dialog.tsx:24-49`

Escape key is handled (line 27) but no focus is moved into the dialog on open, and Tab is not trapped inside the dialog panel. Background content remains Tab-accessible while the modal is mounted.

**Quoted evidence:**
```tsx
// dialog.tsx:24-31
React.useEffect(() => {
  if (!open) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onOpenChange(false);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [open, onOpenChange]);
```

Only Escape is handled; focus is never moved.

**Why it matters:** WCAG 2.1 SC 2.1.2 (No Keyboard Trap — dialog should trap focus _inside_). The feedback modal in `OrgDashboardPage` opens without moving focus to the textarea or a dialog action button, so keyboard-only users must Tab from wherever their focus was before.

**Recommendation:** Same as F1 — use `<dialog>` native element or `@radix-ui/react-dialog`. If keeping the custom primitive, add `autoFocus` on the first interactive child or call `firstFocusableRef.current?.focus()` in a `useEffect`.

---

### F4 — HIGH: `DialogCloseButton` renders literal `x` text as visible label

**File:** `frontend/src/components/ui/dialog.tsx:99-113`

The close button has `aria-label="Close dialog"` (acceptable for AT), but its visible content is the raw character `x`, not an icon or visually meaningful label. This fails WCAG 2.5.3 (Label in Name) if a user tries to activate it by speech ("click x" is not a recognized voice command alias for "close dialog") and violates general usability.

**Quoted evidence:**
```tsx
// dialog.tsx:104-113
<button
  type="button"
  onClick={onClick}
  aria-label={t("Close dialog")}
  className="absolute right-4 top-4 rounded-sm opacity-70 ..."
>
  x
</button>
```

**Why it matters:** WCAG 2.1 SC 2.5.3 — accessible name ("Close dialog") does not contain the visible label ("x"), which is a mismatch for speech-input users who activate controls by their visual label. Also the `x` text has no `aria-hidden` annotation.

**Recommendation:** Replace the `x` text with a `<X aria-hidden="true" className="h-4 w-4" />` lucide icon (already imported elsewhere in the shell). Update `aria-label` to be wrapped in `t()` — it already is, so that part is fine.

---

### F5 — MEDIUM: No skip-to-main-content link in AppShell

**File:** `frontend/src/features/layout/AppShell.tsx:119-291`

The `<main>` element at line 287 has no `id` attribute and there is no skip-navigation link before the header. Every keyboard and screen-reader user must Tab through the entire header (hamburger / wordmark / nav items / org switcher / user menu) before reaching page content.

**Quoted evidence:**
```tsx
// AppShell.tsx:287-290
<main className="flex-1">
  <Outlet />
</main>
```

No `<a href="#main-content" className="sr-only focus:not-sr-only ...">Skip to main content</a>` is present anywhere in the rendered tree.

**Why it matters:** WCAG 2.1 SC 2.4.1 (Bypass Blocks) — requires a mechanism to skip repeated navigation blocks. This is a common WCAG 2.1 AA fail.

**Recommendation:**
```tsx
// First child inside the outer <div className="flex min-h-screen flex-col">:
<a
  href="#main-content"
  className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:px-4 focus:py-2 focus:bg-background focus:text-foreground"
>
  {t("Skip to main content")}
</a>
// Then:
<main id="main-content" className="flex-1">
```

---

### F6 — MEDIUM: Mobile drawer nav links have no focus-visible ring

**File:** `frontend/src/features/layout/AppShell.tsx:262-272`

The `<Link>` elements for "My profile" and "Notifications" in the bottom section of the mobile drawer use `rounded-md px-3 py-1.5 text-sm hover:bg-accent` but do not include `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`. The `renderNavLink` function does add focus rings for the nav items, but the personal links at the bottom of the drawer do not.

**Quoted evidence:**
```tsx
// AppShell.tsx:262-272
<Link
  to={routes.myProfile()}
  className="rounded-md px-3 py-1.5 text-sm hover:bg-accent"
>
  {t("My profile")}
</Link>
<Link
  to={routes.myNotifications()}
  className="rounded-md px-3 py-1.5 text-sm hover:bg-accent"
>
  {t("Notifications")}
</Link>
```

Compare with `renderNavLink` at line 101 which includes `focus-visible:ring-2 focus-visible:ring-ring`.

**Why it matters:** WCAG 2.1 SC 2.4.7 (Focus Visible) — keyboard-only users cannot see which link currently has focus in the bottom section of the mobile drawer.

**Recommendation:** Add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring` to both `<Link>` classNames in the drawer footer section (lines 264 and 269).

---

### F7 — MEDIUM: User-menu (`role="menu"`) lacks arrow-key keyboard navigation

**File:** `frontend/src/features/layout/AppShell.tsx:174-218`

The container has `role="menu"` and children have `role="menuitem"`. The ARIA menu pattern (APG) requires that users can navigate between items using ArrowDown / ArrowUp keys, with Tab closing the menu (not moving between items). Currently, Tab traverses items as if they were regular focusable elements, and arrow keys do nothing.

**Quoted evidence:**
```tsx
// AppShell.tsx:175-215
<div
  role="menu"
  aria-label={t("User menu")}
  className="..."
>
  // items: <Link role="menuitem">, <Link role="menuitem">, <button role="menuitem">
  // No onKeyDown handlers for ArrowDown/ArrowUp/Home/End
```

**Why it matters:** WCAG 2.1 SC 4.1.2 (Name, Role, Value) — using `role="menu"` creates an expectation for AT users that arrow-key navigation is supported. Screen readers enter "menu mode" and announce "use arrow keys to navigate", then arrow keys do nothing.

**Recommendation:**
- Either implement the keyboard pattern (ArrowDown/ArrowUp cycle through items, Tab closes menu), or
- Change the container to a simple `<div>` (no menu role) and the items to `<a>`/`<button>` styled as a list — simpler and equally accessible without the broken ARIA contract.

---

### F8 — MEDIUM: `t()` called with runtime-interpolated string — breaks i18n extraction

**File:** `frontend/src/features/layout/OrgChooserPage.tsx:36`

The call `t(\`${m.effective_modules.length} modules accessible\`)` passes a fully-interpolated string (e.g., "3 modules accessible") to `t()`. When an i18n extraction tool (e.g., `i18next-parser`, Lingui's `extract`) scans the source, it cannot statically find this message; it sees a template literal, not a string literal. Each unique count generates a unique message key, preventing proper plural-form handling.

**Quoted evidence:**
```tsx
// OrgChooserPage.tsx:36
<CardContent className="text-xs text-muted-foreground">
  {t(`${m.effective_modules.length} modules accessible`)}
</CardContent>
```

**Why it matters:** Invariant #13 mandates i18n from day 1 with `t()` as the sole call-site so the i18n system can be swapped in later. This usage breaks that contract: the extractor will either skip the key or generate an un-translatable entry. Plural handling ("1 module" vs "2 modules") is also not addressed.

**Recommendation:**
```tsx
// Use a translatable template with the count extracted:
{m.effective_modules.length === 1
  ? t("1 module accessible")
  : t("{{count}} modules accessible", { count: m.effective_modules.length })}
// Or use a future-compatible interpolation pattern:
{t("modules_accessible", { count: m.effective_modules.length })}
```

---

### F9 — MEDIUM: OrgSwitcher role radio-buttons lack focus-visible ring

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:82-93`

The role-switcher buttons inside `role="radiogroup"` have no focus-visible ring. They rely on the browser's default dotted outline, which is removed by the `outline-none` Tailwind reset in many configurations.

**Quoted evidence:**
```tsx
// OrgSwitcher.tsx:82-93
<button
  key={r}
  type="button"
  role="radio"
  aria-checked={(activeRole ?? currentRoles[0]) === r}
  onClick={() => onPickRole(r)}
  className={cn(
    "rounded px-2 py-1",
    (activeRole ?? currentRoles[0]) === r
      ? "bg-background font-medium shadow-sm"
      : "text-muted-foreground hover:text-foreground",
  )}
>
```

No `focus-visible:ring-2 focus-visible:ring-ring` class is present.

**Why it matters:** WCAG 2.1 SC 2.4.7 (Focus Visible) — keyboard users cannot see which radio button has focus.

**Recommendation:** Add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring` to the className. Also add `aria-roledescription="radio button"` or handle ArrowLeft/ArrowRight for proper radiogroup keyboard navigation per APG.

---

### F10 — MEDIUM: `OrgComingSoonPage` back-link has no focus-visible ring

**File:** `frontend/src/features/layout/OrgComingSoonPage.tsx:30-35`

The only interactive element on this page (`<Link>`) has `className="text-primary underline"` but no `focus-visible:ring-*`. Keyboard users cannot see focus on this element.

**Quoted evidence:**
```tsx
// OrgComingSoonPage.tsx:30-35
<Link
  to={routes.orgDashboard(orgSlug)}
  className="text-primary underline"
>
  {t("Back to dashboard")}
</Link>
```

**Why it matters:** WCAG 2.1 SC 2.4.7 (Focus Visible).

**Recommendation:** Add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm` to the className.

---

### F11 — LOW: NavLink badge text not visually separated for screen readers

**File:** `frontend/src/features/layout/AppShell.tsx:110-114`

Badge text (e.g., "Phase 1B") inside a `<NavLink>` has no `aria-label` or visually-hidden separator. Screen readers announce "Scoring Phase 1B" which is technically parsable but could be clearer.

**Quoted evidence:**
```tsx
// AppShell.tsx:110-114
{item.badge ? (
  <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
    {item.badge}
  </span>
) : null}
```

**Why it matters:** Informational — the badge announces inline without punctuation or pause, which may confuse AT users into thinking "Phase 1B" is part of the link name. Low severity because the content is still understandable.

**Recommendation:** Add `aria-label={t("badge: {{badge}}", { badge: item.badge })}` or wrap in `<span aria-hidden="true">` and add a visually-hidden `, {item.badge}` with a comma so a screen reader pauses:
```tsx
<span aria-hidden="true">{item.badge}</span>
<span className="sr-only">, {item.badge}</span>
```

---

### F12 — LOW: `OrgChooserPage` org cards are `<Link>` wrapping `<Card>` — no accessible description of destination

**File:** `frontend/src/features/layout/OrgChooserPage.tsx:27-40`

Each org card is a `<Link>` whose accessible name is derived from its full text content: "Org Name\nrole1, role2 · /o/slug\n3 modules accessible". The slug fragment `/o/{slug}` is read aloud as URL text which is not meaningful.

**Quoted evidence:**
```tsx
// OrgChooserPage.tsx:27-40
<Link key={m.org_id} to={routes.orgDashboard(m.org_slug)}>
  <Card className="transition-colors hover:bg-accent">
    <CardHeader>
      <CardTitle className="text-lg">{m.org_name}</CardTitle>
      <CardDescription>
        {m.roles.join(", ")} · /o/{m.org_slug}
      </CardDescription>
    </CardHeader>
    <CardContent className="text-xs text-muted-foreground">
      {t(`${m.effective_modules.length} modules accessible`)}
    </CardContent>
  </Card>
</Link>
```

**Why it matters:** WCAG 2.1 SC 2.4.6 (Headings and Labels) — the slug `/o/acme` in the CardDescription becomes part of the link's accessible name and is read as "/o/acme" by AT. Not a hard fail but unnecessarily noisy.

**Recommendation:** Add `aria-label={t("Go to {{orgName}}", { orgName: m.org_name })}` on the `<Link>`, and wrap the slug display in `<span aria-hidden="true">/o/{m.org_slug}</span>`.

---

### F13 — INFO: `ProtectedRoute` loading state uses `role="status"` + `aria-live="polite"` correctly

**File:** `frontend/src/features/layout/ProtectedRoute.tsx:29-38`

This is a positive finding. The loading placeholder correctly uses `role="status" aria-live="polite"` and the content is wrapped in `t()`.

**Quoted evidence:**
```tsx
// ProtectedRoute.tsx:29-38
<div
  role="status"
  aria-live="polite"
  className="..."
>
  {t("Loading...")}
</div>
```

No action required — this is compliant.

---

## Gaps (forward-looking, not current failures)

| # | Area | Missing | Needed for | Effort |
|---|------|---------|------------|--------|
| G1 | AppShell / Dialog | Global focus-trap utility (used by both drawer and feedback dialog) | F1 + F3 fixes | M |
| G2 | AppShell | Skip-navigation link | WCAG 2.4.1 AA | S |
| G3 | i18n | Plural-form API in `t()` | F8 fix, future i18n swap | M |
| G4 | Dialog primitive | Adopt `@radix-ui/react-dialog` (focus trap, labelledby, portal) | F2 + F3 combined fix | M |
| G5 | Color tokens | Audit `bg-emerald-100 text-emerald-800` badge (F11) for 4.5:1 contrast ratio against `bg-card` background | WCAG 1.4.3 AA | S |
| G6 | OrgSwitcher radiogroup | Arrow-key keyboard navigation (APG radio group pattern) | WCAG 2.1 SC 4.1.2 | M |
| G7 | AppShell nav | Current-page `aria-current="page"` is handled by `NavLink` (React Router), but `end` prop affects matching — audit that it correctly marks the active item and does not mark parent routes | WCAG 2.4.8 | S |
| G8 | OrgChooserPage | Route-level `<title>` / `document.title` update | WCAG 2.4.2 (Page Titled) — not currently set on any layout page | L |
