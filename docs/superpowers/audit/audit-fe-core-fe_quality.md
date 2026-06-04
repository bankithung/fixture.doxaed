# Frontend UI/UX Quality Audit — `fe-core` lens

**Date:** 2026-06-04  
**Scope:** `frontend/src/**` — visual/UX quality vs professional SaaS bar + vitest coverage for guards/permission gating/error states  
**Status:** Phase 1A implemented; Phase 1B not built.

---

## Executive Summary

The frontend is a solid, accessible Phase 1A scaffold — correct ARIA, good
shadcn/ui token usage, consistent `t()` wrapping, comprehensive test coverage
for most pages. For the planned SaaS quality overhaul (framer-motion, dark-mode
toggle, more polished colour hierarchy, coherent brand token usage) several
concrete weak spots exist. Eight findings below, ordered by severity.

---

## Findings

### F-01 — No dark-mode toggle; `.dark` class is never applied

**Severity:** high  
**File:** `frontend/src/index.css:45-65`, `frontend/tailwind.config.js:3`

**Evidence:**  
`tailwind.config.js` declares `darkMode: ["class"]` — meaning dark mode
activates only when a `.dark` class is present on `<html>`. The `.dark` block
in `index.css` is fully defined (lines 45-65). But nowhere in the codebase is
`.dark` set, a `ThemeProvider` mounted, or a toggle rendered. The dark-mode CSS
is dead code for all users.

**Why it matters:**  
The owner explicitly wants dark mode. Half the tokens are already specified
(`--background`, `--card`, etc. all have dark variants). The wiring is just
missing — no `ThemeProvider`, no toggle button in `AppShell`, no `localStorage`
persistence.

**Recommendation:**  
Add a minimal `ThemeProvider` (Zustand or `localStorage` + React context) that
toggles `document.documentElement.classList.toggle("dark")`. Surface a
sun/moon `Button` in the AppShell header. This is a one-file change of ~40 lines.

---

### F-02 — `framer-motion` is not installed; zero motion anywhere

**Severity:** high  
**File:** `frontend/package.json`

**Evidence:**  
`package.json` lists no `framer-motion` dependency. No `motion.div`,
`AnimatePresence`, or any animation import exists across `frontend/src`. All
transitions are bare CSS (`transition-colors`, `transition-shadow`).

**Why it matters:**  
The owner explicitly requested framer-motion as part of the pro SaaS overhaul.
Entry animations on the auth card, route transitions, toast slide-ins, and
dashboard card reveals are all missing. The current feel is functional but
static.

**Recommendation:**  
Install `framer-motion`. Add `AnimatePresence` + `motion.div` around: (1)
auth cards, (2) dashboard card grid (staggered entrance), (3) mobile nav drawer
open/close, (4) toast items (slide-from-bottom). Align with the `reduced-motion`
media query for a11y.

---

### F-03 — Hardcoded `text-emerald-*`/`bg-emerald-*` bypasses the brand token system in 12 files

**Severity:** medium  
**Files (34 occurrences across 12 files):**  
`AuthLayout.tsx`, `LandingPage.tsx`, `AppShell.tsx`, `LoginPage.tsx`,
`SignupPage.tsx`, `OrgBrandingPage.tsx`, `ErrorPage.tsx`,
`NotFoundPage.tsx`, `ComingSoonPage.tsx`, `PasswordResetRequestPage.tsx`,
`PasswordResetCompletePage.tsx`, `AboutPage.tsx`

**Evidence (representative):**  
`LandingPage.tsx:104` — `className="bg-emerald-700 hover:bg-emerald-800"`  
`AuthLayout.tsx:28` — `className="bg-gradient-to-br from-emerald-700 via-teal-700 to-slate-900"`  
`LoginPage.tsx:169` — `className="text-xs text-emerald-700 hover:underline"`

Brand tokens are defined in `tailwind.config.js` (`brand.DEFAULT = hsl(160 84% 30%)`) and
in `index.css` (`--brand: 160 84% 30%`), but the pages use raw Tailwind
emerald classes instead. If the brand colour ever changes (e.g., to a sports
orange), 34 sites must be updated manually.

**Why it matters:**  
Blocks efficient brand re-theming. Also means any dark-mode override must be
duplicated for `text-emerald-700` rather than just flipping `--brand`.

**Recommendation:**  
Replace `text-emerald-700` → `text-brand`, `bg-emerald-700` → `bg-brand`,
`hover:bg-emerald-800` → `hover:bg-brand/90` across all 12 files. The Tailwind
`brand` palette is already configured; only the classes at call sites are wrong.

---

### F-04 — `ProtectedRoute` loading state is plain text "Loading..." — no spinner or skeleton

**Severity:** medium  
**File:** `frontend/src/features/layout/ProtectedRoute.tsx:30-38`

**Evidence:**
```tsx
return (
  <div
    role="status"
    aria-live="polite"
    className="flex min-h-screen items-center justify-center text-sm text-muted-foreground"
  >
    {t("Loading...")}
  </div>
);
```

**Why it matters:**  
On every cold load and every hard refresh, authenticated users stare at plain
text for the duration of the `/me/` bootstrap fetch. A professional SaaS shows
a spinner, skeleton, or at least an animated logo mark.

**Recommendation:**  
Replace with an animated spinner (`<Loader2 className="animate-spin" />` from
lucide) or the emerald "F" logo mark with a pulse animation. Takes ~10 lines.

---

### F-05 — Toast dismiss button uses raw `"x"` text, not a Lucide icon; success toast CSS class is non-existent

**Severity:** medium  
**File:** `frontend/src/components/ui/toast.tsx:79,91`

**Evidence (line 79):**  
```tsx
tm.kind === "success" && "border-grant bg-grant-muted",
```
`border-grant` and `bg-grant-muted` are valid Tailwind custom tokens (defined in
`tailwind.config.js`). However, `text-grant` used in `GrantCell.tsx:58` is
also fine (same palette). — **This is actually a non-issue for those lines.**

**Evidence (line 91):**  
```tsx
<button type="button" aria-label="Dismiss notification" onClick={() => dismiss(tm.id)}
  className="rounded p-1 text-xs hover:bg-muted">
  x
</button>
```
The dismiss button renders the raw character `"x"` instead of a `<X />` Lucide
icon. Visually inconsistent with the `<X />` icon used in the mobile nav
drawer (`AppShell.tsx:245`). The button is also `text-xs` which at 10px does
not meet WCAG AA minimum tap-target size (44×44px for mobile).

**Why it matters:**  
Visual inconsistency and potential a11y failure for touch users.

**Recommendation:**  
Replace `x` with `<X aria-hidden="true" className="h-4 w-4" />` from lucide.
Increase the button's hit area: `className="flex h-8 w-8 items-center justify-center rounded"`.

---

### F-06 — `window.confirm()` used for destructive "remove member" action

**Severity:** medium  
**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:319-325`

**Evidence:**
```tsx
if (
  typeof window !== "undefined" &&
  !window.confirm(t(`Remove ${displayName} from this organization?`))
) {
  return;
}
```

**Why it matters:**  
`window.confirm()` is a blocking native browser dialog — unstyled, cannot be
themed, cannot be tested in vitest (jsdom returns `true` by default), and fails
in headless environments. A professional SaaS shows an in-app confirmation
dialog. The existing `Dialog` component is available.

**Recommendation:**  
Replace with a state-driven `<Dialog>` or `<AlertDialog>` that lists the member
name and a red "Confirm remove" button. This also enables proper vitest testing
of the confirmation step.

---

### F-07 — `CardTitle` renders as `<h3>` regardless of context — heading hierarchy breaks on some pages

**Severity:** low  
**File:** `frontend/src/components/ui/card.tsx:32-43`

**Evidence:**
```tsx
export const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn("text-2xl font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
```
On `OrgDashboardPage`, the page `<h1>` is "Acme FC". The next headings are
`<CardTitle>` elements which render as `<h3>` — skipping `<h2>`. Screen readers
announce a heading-level skip, which technically violates WCAG success criterion
1.3.1.

**Why it matters:**  
Heading hierarchy is an a11y requirement (WCAG 2.1 AA mandated by invariant #13).
The standard shadcn/ui `CardTitle` accepts an `asChild` prop or a `level` prop
to fix this.

**Recommendation:**  
Add an optional `as` prop to `CardTitle` (`"h2" | "h3" | "h4"`, defaulting to
`"h3"`). Call sites where a `CardTitle` is the first heading below an `<h1>`
should use `as="h2"`.

---

### F-08 — OrgChooserPage has no test; zero vitest for several key surfaces

**Severity:** low  
**Files without test coverage (no `__tests__` file exists):**

| Surface | File | Risk |
|---|---|---|
| `OrgChooserPage` | `features/layout/OrgChooserPage.tsx` | Renders directly from `ProtectedRoute`; no test for 0-membership empty state or card links |
| `OrgAuditLogPage` | `features/orgs/OrgAuditLogPage.tsx` | Permission gate, pagination, retry — none tested |
| `TwoFactorChallengePage` | `features/auth/TwoFactorChallengePage.tsx` | Auth flow tested only indirectly via `LoginPage` store mock |
| `TwoFactorEnrollPage` | `features/auth/TwoFactorEnrollPage.tsx` | QR display, confirm flow, recovery codes — not tested |
| `VerifyEmailPage` | `features/auth/VerifyEmailPage.tsx` | Token OK/error/idle states — not tested |
| `PasswordResetRequestPage` | `features/auth/PasswordResetRequestPage.tsx` | Not tested |
| `PasswordResetCompletePage` | `features/auth/PasswordResetCompletePage.tsx` | Not tested |
| `InviteAcceptPage` | `features/orgs/InviteAcceptPage.tsx` | Accept + error states not tested |
| `OwnershipTransferModal` | `features/orgs/OwnershipTransferModal.tsx` | Conflict-of-interest banner, submit path — not tested |
| `InvitationsListPanel` | `features/orgs/InvitationsListPanel.tsx` | Revoke, copy-link — not tested |
| `ConflictOfInterestBanner` | `features/permissions/ConflictOfInterestBanner.tsx` | No test |
| `ProtectedRoute` | `features/layout/ProtectedRoute.tsx` | Loading state, 2FA redirect, 0-memberships redirect — not tested |

**Evidence:**  
Running `Glob frontend/src/**/__tests__/*.test.*` yields 27 test files, none
matching the above surfaces.

**Why it matters:**  
`ProtectedRoute` and `OrgChooserPage` are on every authenticated path. Bugs in
them (e.g., the known issue where `/api/accounts/me/` returns 403 not 401)
would cause a premature redirect loop that no unit test currently catches.
`OrgAuditLogPage` has module-gating logic duplicated from scratch (not reusing
the same guard idiom as `MemberDirectoryPage`) and is unverified.

**Recommendation:**  
Add tests for: `ProtectedRoute` (bootstrapped=false → spinner; no user →
redirect to login with `?next`; 0 memberships → redirect to `/orgs`);
`OrgChooserPage` (0 memberships empty state; card links); `OrgAuditLogPage`
(permission gate + pagination). The remaining pages are lower priority but
each has at least one non-trivial state (token error, recovery-code display)
worth a smoke test.

---

## Gaps (Forward-Looking)

| Item | Missing | Needed for | Effort | Blocking |
|---|---|---|---|---|
| Dark-mode toggle + persistence | `ThemeProvider`, localStorage, toggle button in AppShell | Phase 1B SaaS overhaul | S | No |
| framer-motion animations | Install dep, animate auth card, nav drawer, dashboard grid, toasts | Phase 1B SaaS overhaul | M | No |
| Brand token consolidation | Replace 34 `text-emerald-*`/`bg-emerald-*` with `text-brand`/`bg-brand` | Design system coherence | M | No |
| Alert/confirm dialog component | In-app destructive-action confirmation (`AlertDialog`); retire `window.confirm` | UX parity + testability | S | No |
| `CardTitle` heading level prop | `as="h2"|"h3"` prop; fix call sites where heading hierarchy skips | WCAG 2.1 AA invariant #13 | S | No |
| Toast spinner replacement | Replace `x` dismiss with Lucide `<X />` + fix touch target | WCAG tap target | XS | No |
| ProtectedRoute + OrgChooserPage tests | vitest coverage for auth guard edge cases | Known bug #(b) regression | S | No |
| OrgAuditLogPage tests | Module gate, pagination, error state | Regression safety | M | No |
| Spinner on ProtectedRoute loading | Replace plain "Loading..." text with animated indicator | SaaS polish | XS | No |
| Ownership transfer / conflict-of-interest tests | vitest for `OwnershipTransferModal` + `ConflictOfInterestBanner` | Correctness assurance | S | No |
