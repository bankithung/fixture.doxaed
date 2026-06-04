# A11y & i18n Audit — frontend/src/features (fe-landingerrors lens)

**Date:** 2026-06-04
**Scope:** `frontend/src/features/**` (all TSX files) + directly imported UI primitives.
**Lenses:** unwrapped user-visible strings; missing aria/labels/for; keyboard nav + focus management; dialog focus traps; alt text; obvious WCAG 2.1 AA contrast issues.

---

## Critical findings

### F-01 — Dialog has no focus trap (critical)

**File:** `frontend/src/components/ui/dialog.tsx:24–48`

The custom `Dialog` primitive handles Escape and backdrop-click, but it never traps keyboard focus inside the dialog panel. When the dialog is open, Tab will cycle focus into background page content. This violates WCAG 2.1 SC 2.1.2 (No Keyboard Trap — inverse: the dialog *must* trap focus so users cannot accidentally interact with background content).

Affects every dialog in the app:
- `PasswordReauthModal` (`frontend/src/features/auth/PasswordReauthModal.tsx:60–105`)
- `InviteCreateModal` (`frontend/src/features/orgs/InviteCreateModal.tsx:129–238`)
- `OwnershipTransferModal` (`frontend/src/features/orgs/OwnershipTransferModal.tsx:85–159`)
- `OrgDashboardPage` feedback dialog (`frontend/src/features/layout/OrgDashboardPage.tsx:180–224`)

**Evidence (dialog.tsx):**
```tsx
export function Dialog({ open, onOpenChange, ariaLabel, children }: DialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    // No focus-trap logic anywhere
  }, [open, onOpenChange]);
```

**Recommendation:** After open=true, collect all focusable elements inside the dialog container (via ref), keep Tab/Shift+Tab within that set, and restore focus to the trigger element on close. Use a proven utility (e.g. `focus-trap-react` or `@radix-ui/dialog`) rather than hand-rolling.

---

### F-02 — Mobile nav drawer: no focus trap, focus not moved on open (high)

**File:** `frontend/src/features/layout/AppShell.tsx:222–284`

The mobile nav drawer uses `role="dialog" aria-modal="true"` but never moves focus into the drawer when it opens, and has no focus trap. Screen reader and keyboard users who activate the hamburger button will have focus left on the now-covered background content.

**Evidence:**
```tsx
{drawerOpen ? (
  <div
    id="mobile-nav-drawer"
    role="dialog"
    aria-modal="true"
    aria-label={t("Navigation menu")}
    // no useEffect to move focus; no focus-trap
  >
```

**Recommendation:** On open, move focus to the first focusable element inside the drawer (the Close button). Install a focus trap so Tab stays inside the drawer. On close, return focus to the hamburger trigger (currently focus is lost).

---

### F-03 — `GrantCell` misuses `role="switch"` for a 3-state control (high)

**File:** `frontend/src/features/permissions/GrantCell.tsx:84–86`

`role="switch"` semantics represent a binary on/off toggle (`aria-checked` is true or false). The GrantCell cycles through three states (default, grant, deny). Using `role="switch"` means AT users hear "switch, checked" or "switch, unchecked" but have no way to distinguish the "default" state from "grant". WCAG 2.1 SC 4.1.2 (Name, Role, Value) requires the role to accurately reflect the widget's semantics.

**Evidence:**
```tsx
<button
  role="switch"
  aria-checked={state === "grant"}  // "default" and "deny" both map to unchecked
  aria-label={ariaLabel}
```

**Recommendation:** Replace `role="switch"` with `role="button"` (since the full 3-state cycle cannot be expressed with a switch). Put the human-readable current state in `aria-label` (already done via `stateForAria`) or in a live region that announces the new value after each click. Alternatively, restructure as a `role="radiogroup"` with three radio inputs (Default / Grant / Deny).

---

## High severity findings

### F-04 — `text-grant` / `bg-grant-muted` / `bg-warn-muted` Tailwind classes reference undefined custom tokens (high)

**Files:**
- `frontend/src/features/auth/VerifyEmailPage.tsx:60` — `className="text-sm text-grant"`
- `frontend/src/features/auth/TwoFactorEnrollPage.tsx:84` — `className="text-sm text-grant"`
- `frontend/src/features/orgs/InviteAcceptPage.tsx:83` — `className="text-sm text-grant"`
- `frontend/src/features/permissions/ConflictOfInterestBanner.tsx:27–30` — `border-warn bg-warn-muted`
- `frontend/src/features/roles/MyProfilePage.tsx:207` — `className="rounded-full bg-grant-muted px-3 py-1 text-xs font-medium"`
- `frontend/src/features/permissions/GrantCell.tsx:58` — `bg-grant-muted text-grant border-grant/30`

These classes will fall back to Tailwind's "unknown class" behaviour (i.e., no style applied at all) unless `grant`, `warn`, and `warn-muted` are defined in `tailwind.config`. If the tokens are missing, success/warning text renders unstyled (often inheriting body foreground colour). The WCAG 2.1 AA contrast requirement cannot be verified, and the visual affordance (green = success, amber = warning) is entirely lost.

**Evidence:**
```tsx
// VerifyEmailPage.tsx:60
<p role="status" className="text-sm text-grant">
  {t("Email verified. You can now sign in.")}
</p>
```

**Recommendation:** Confirm these tokens exist in `tailwind.config.ts`/`tailwind.config.js`. If not, replace with confirmed Tailwind colours (`text-emerald-700`, `bg-amber-100`, etc.) that match the palette already used in other files. Measure contrast ratios: the palette in `Avatar.tsx` documents that its colours are "tuned for AA-on-white", but the grant/warn tokens have no such note.

---

### F-05 — `AuthLayout` brand panel link has no `aria-label` (high)

**File:** `frontend/src/features/auth/AuthLayout.tsx:40–52`

The logo link inside the brand panel is visually labelled "Fixture Platform" (text node) but the panel itself carries `aria-hidden="true"`, meaning the link is completely invisible to screen readers. This is correct intent, but it creates an inconsistency: the mobile logo block (lines 69–77) renders a `<div>` with the same wordmark but no interactive affordance, no `role`, and no label — it appears to be purely decorative. If the intent is purely decorative, `aria-hidden` on the brand panel is correct and the mobile block is fine. If the intent is navigation, the mobile block needs a Link.

**Evidence:**
```tsx
<aside
  className="hidden lg:flex …"
  aria-hidden="true"   // entire panel hidden from AT
>
  …
  <Link to="/" className="…">   // this link is unreachable by AT
    <span aria-hidden="true">F</span>
    <span>{t("Fixture Platform")}</span>
  </Link>
```

**Recommendation:** Confirm whether the brand panel Link is intentionally hidden (if the same nav is accessible elsewhere, `aria-hidden` is correct). If yes, document the intent with a code comment. The mobile logo block (lines 69–77) is already a non-interactive `<div>` — verify this is acceptable (since the main page heading is the `<h1>` directly below).

---

### F-06 — `AboutPage` home link has no `aria-label` distinguishing it from page heading (medium-high)

**File:** `frontend/src/features/landing/AboutPage.tsx:15–27`

The header logo link has no `aria-label`. Its visible text is just "Fixture Platform", the same as the page `<h1>` "About Fixture Platform". Screen reader users navigating via links list will see two entries that sound almost identical. The `LandingPage.tsx` correctly adds `aria-label={t("Fixture Platform — home")}` to its equivalent link; `AboutPage` does not.

**Evidence:**
```tsx
<Link
  to={routes.landing()}
  className="inline-flex items-center gap-2 …"
  // no aria-label — compare LandingPage.tsx:47 which has one
>
  <span aria-hidden="true" …>F</span>
  <span>{t("Fixture Platform")}</span>
</Link>
```

**Recommendation:** Add `aria-label={t("Fixture Platform — home")}` to match the pattern used in `LandingPage.tsx:47`.

---

### F-07 — `OrgChooserPage`: org card links lack descriptive `aria-label` (medium)

**File:** `frontend/src/features/layout/OrgChooserPage.tsx:27–39`

Each org card is wrapped in a `<Link>` but has no `aria-label`. The accessible name is computed from the card's inner text content: org name + roles + "N modules accessible". The roles string is a raw comma-joined array of API strings (e.g., `admin, co_organizer`) — these are not passed through `t()` and are not human-friendly for screen readers.

**Evidence:**
```tsx
<CardDescription>
  {m.roles.join(", ")} · /o/{m.org_slug}
</CardDescription>
<CardContent …>
  {t(`${m.effective_modules.length} modules accessible`)}
</CardContent>
```

The template literal inside `t()` on line 36 (`t(\`${m.effective_modules.length} modules accessible\`)`) is a dynamic string — `t()` receives a run-time value and cannot be statically extracted by i18n tools. The number and the noun "modules" need to be composed differently to support pluralisation (a `t()` call on the template receives a different string key every time).

**Recommendation:** Add `aria-label` to each card Link: e.g. `aria-label={t("Go to organization") + " " + m.org_name}`. Rewrite the module count string to use a static plural pattern: separate `t("module")` / `t("modules")` keys, or a future `t("{{count}} modules accessible", { count: n })` pattern.

---

### F-08 — `ConflictOfInterestBanner` checkbox: no explicit `id`/`htmlFor` pairing (medium)

**File:** `frontend/src/features/permissions/ConflictOfInterestBanner.tsx:42–51`

The acknowledgement checkbox is wrapped in a `<label>` element (the wrapping-label pattern), which is valid HTML. However, the `<input type="checkbox">` has no `id` and no `aria-describedby` pointing at the banner's warning message. Screen reader users will hear "checkbox, unchecked, I acknowledge this conflict …" without context about *which* action they are acknowledging.

**Evidence:**
```tsx
<label className="flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={acknowledged}
    onChange={(e) => onChangeAcknowledged(e.target.checked)}
    // no id, no aria-describedby
  />
  {t("I acknowledge this conflict …")}
</label>
```

**Recommendation:** Add `aria-describedby` pointing to the warning message paragraph so AT users hear the full context when the checkbox receives focus.

---

### F-09 — `MemberDirectoryPage`: `window.confirm()` is inaccessible (medium)

**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:319–325`

`window.confirm()` is a browser native dialog that:
- Cannot be styled or made compliant with WCAG contrast requirements.
- Is blocked entirely in some environments (embedded iframes, certain screen readers).
- Interrupts AT users unexpectedly with a modal they have no prior warning of.

**Evidence:**
```tsx
if (
  typeof window !== "undefined" &&
  !window.confirm(t(`Remove ${displayName} from this organization?`))
) {
  return;
}
```

**Recommendation:** Replace with a styled React confirmation dialog (reusing the existing `Dialog` primitive) that includes a cancel and confirm button. The string inside the `confirm()` call also uses a template literal inside `t()` — same static-extraction problem noted in F-07.

---

### F-10 — `OrgAuditLogPage`: loading skeleton has no `role="status"` or `aria-live` (medium)

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:120–130`

The loading skeleton uses `aria-hidden="true"` on the pulse divs but there is no surrounding `role="status"` or `aria-live` region to announce to screen readers that content is loading. Compare the correct pattern in `MemberDirectoryPage.tsx:185` (`<div role="status" aria-live="polite">`) and `OrgSettingsPage.tsx:118`.

**Evidence:**
```tsx
{query.isLoading ? (
  <div className="space-y-2">
    {Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="h-12 animate-pulse rounded-md bg-muted/40" aria-hidden="true" />
    ))}
  </div>
) : ...}
```

**Recommendation:** Wrap the skeleton block in `<div role="status" aria-live="polite"><span className="sr-only">{t("Loading audit log...")}</span>…</div>`.

---

### F-11 — `OrgAuditLogPage` and `ModuleMatrixPage`: data tables have no `<caption>` or `aria-label` (medium)

**Files:**
- `frontend/src/features/orgs/OrgAuditLogPage.tsx:150–179` — `<table className="min-w-full text-sm">` with no `aria-label` and no `<caption>`.
- `frontend/src/features/permissions/ModuleMatrixPage.tsx:297–406` — `<table … aria-label={t("Per-user module override matrix")}>` — this one is fine; cited for contrast.

The audit log table is missing the label; its `<thead>` has translated column headers but there is no accessible name on the table element itself.

**Evidence:**
```tsx
// OrgAuditLogPage.tsx:150
<table className="min-w-full text-sm">
  <thead className="bg-muted/40 …">
    <tr>
      <th …>{t("When")}</th>
```

**Recommendation:** Add `aria-label={t("Audit log events")}` to the audit log `<table>` element.

---

## Medium severity findings

### F-12 — `t()` called with dynamic template literals breaks future i18n extraction (medium)

**Files (all occurrences):**
- `frontend/src/features/errors/ComingSoonPage.tsx:53` — `t(\`${feature} — coming soon\`)`
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:152` — `t(\`Actions for ${displayName}\`)`
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:321` — `t(\`Remove ${displayName} from this organization?\`)`
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:336` — `t(\`${total} ${total === 1 ? "member" : "members"}\`)`
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:405` — `t(\`No members match "${search}".\`)`
- `frontend/src/features/layout/OrgChooserPage.tsx:36` — `t(\`${m.effective_modules.length} modules accessible\`)`
- `frontend/src/features/orgs/InviteCreateModal.tsx:271` — `t(\`Expires ${expiryLabel}.\`)`
- `frontend/src/features/orgs/InviteCreateModal.tsx:328` — `t(\`Copy ${label}\`)`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:141` — `t(\`expires ${expiresLabel}\`)`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:152` — `t(\`Copy invitation link for ${invitation.email}\`)`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:174` — `t(\`Revoke invitation for ${invitation.email}\`)`

`t()` is currently a pass-through (`s => s`). When a real i18n library (i18next, Lingui) is adopted, static extraction tools scan source for `t("literal string")` calls. Template literals with runtime variables produce different string keys on every call and cannot be extracted. Pluralisation logic embedded in the template (`total === 1 ? "member" : "members"`) cannot be expressed in ICU MessageFormat without restructuring.

**Recommendation:** Replace dynamic template literals with a two-argument API or split calls:
- Aria-labels with a proper noun: compose with string concatenation after `t()` — `t("Actions for") + " " + displayName`.
- Count/plural strings: `t("1 member")` / `t("{{count}} members")` or pass the count as a parameter.
- `ComingSoonPage` feature name: pass the translated feature name in, already translated by the caller, then compose with a static string: `` `${featureName} — ${t("coming soon")}` ``.

---

### F-13 — `OrgSwitcher`: role radio buttons render raw API role strings (medium)

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:77–92`

The role switcher radio buttons render the raw `Role` string (`admin`, `co_organizer`, `match_scorer`, etc.) without wrapping in `t()` or a human-friendly label mapping.

**Evidence:**
```tsx
{currentRoles.map((r) => (
  <button key={r} type="button" role="radio" aria-checked={…}>
    {r}   {/* raw API string, not translated */}
  </button>
))}
```

**Recommendation:** Map role keys to display labels via a `ROLE_LABELS` record (same pattern already defined in `InviteCreateModal.tsx:36–43`) and wrap in `t()`.

---

### F-14 — `PasswordResetCompletePage`: auto-redirect without warning is disorienting (medium)

**File:** `frontend/src/features/auth/PasswordResetCompletePage.tsx:40–44`

On successful password reset, a `setTimeout(..., 1500)` silently navigates to `/login`. Screen reader users who have focus on the "Set password" button will have the page unexpectedly changed within 1.5 seconds without announcement. This conflicts with WCAG 2.1 SC 3.2.1 (On Focus) in spirit; more precisely it risks failing SC 2.2.1 (Timing Adjustable) and SC 3.2.5 (Change on Request).

**Evidence:**
```tsx
setDone(true);
// Auto-redirect after a brief moment so the success card is visible.
setTimeout(() => navigate(routes.login()), 1500);
```

**Recommendation:** Remove the auto-redirect. Add a prominent "Sign in now" `<Link>` button to the success card so the user initiates navigation. If auto-redirect must stay, add `aria-live="assertive"` to the success message, and extend the delay to at least 5 seconds with a visible countdown.

---

### F-15 — `TwoFactorEnrollPage` recovery-codes list: no copy affordance labelled for AT (low-medium)

**File:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:89–93`

Recovery codes are listed in a `<ul>` inside a `<li>`. Each code `<li>` has no label and no copy affordance; users must select text manually. There is also no `aria-live` announcement that 2FA was enabled — the `role="status"` paragraph (line 84) uses the unresolved `text-grant` class (see F-04) and is rendered in the same render cycle as the component switch, so it may not be announced by live regions.

**Evidence:**
```tsx
<p role="status" className="text-sm text-grant">
  {t("2FA enabled. Save these recovery codes somewhere safe — each works once.")}
</p>
<ul className="grid grid-cols-2 gap-1 …">
  {recovery.map((code) => (
    <li key={code}>{code}</li>
  ))}
</ul>
```

**Recommendation:** Add `aria-live="assertive"` (not `role="status"` / `aria-live="polite"`) to announce the 2FA success immediately. Add a "Copy all codes" button or individual copy buttons (matching the `CopyField` pattern from `InviteCreateModal`).

---

## Low severity findings

### F-16 — `DialogCloseButton` renders "x" as text content without SR label (low)

**File:** `frontend/src/components/ui/dialog.tsx:99–114`

`DialogCloseButton` has `aria-label={t("Close dialog")}` which is correct, but its text content is the literal character `x` (lowercase). If CSS fails to load, sighted users see "x"; the `aria-label` override means AT users hear "Close dialog" correctly. However, the `x` character is not semantically meaningful and could confuse low-vision users relying on text zoom. Note: `DialogCloseButton` appears to be defined but never used in the current codebase (no import found) — verify before remediation.

**Evidence:**
```tsx
<button type="button" onClick={onClick} aria-label={t("Close dialog")} …>
  x
</button>
```

**Recommendation:** Replace `x` with a `<X />` Lucide icon (`aria-hidden="true"`) consistent with the AppShell close button pattern.

---

### F-17 — `LandingPage` hero section has no `<main>` landmark (low)

**File:** `frontend/src/features/landing/LandingPage.tsx:40–198`

The public landing page wraps everything in `<div className="flex min-h-screen …">`. There is no `<main>` landmark element. The `<header>`, `<section>`, and `<footer>` are used, but without `<main>` the primary content area is not marked as the main landmark. WCAG 2.1 SC 1.3.6 (Identify Purpose) and bypass-block techniques require a `<main>` landmark.

Compare: `NotFoundPage.tsx:21` and `ErrorPage.tsx:36` both correctly use `<main>`.

**Recommendation:** Wrap the hero + roadmap + footer sections in a `<main>` element (or make the first content `<section>` the `<main>` by changing the tag), and keep `<header>` and `<footer>` outside it.

---

### F-18 — `AboutPage`: no `<main>` landmark (low)

**File:** `frontend/src/features/landing/AboutPage.tsx:29`

`AboutPage` has `<main className="mx-auto w-full max-w-3xl px-6 py-16">` which is correct, but the outer wrapper `<div className="flex min-h-screen flex-col …">` has no landmark. This is fine as long as `<main>` is present, which it is. No action needed beyond noting it.

---

## Gaps (forward-looking)

| # | Area | What is missing | Needed for | Effort | Blocking? |
|---|------|-----------------|------------|--------|-----------|
| G-01 | Dialog primitive | Replace custom `Dialog` with `@radix-ui/dialog` (or `focus-trap-react`) to get a battle-tested focus trap, `inert` background, and WAI-ARIA Dialog pattern out of the box. | WCAG 2.1 SC 2.1.2 | M | Yes (all modals are broken for keyboard) |
| G-02 | i18n library | Adopt `i18next` + `react-i18next` (or Lingui). The current `t = s => s` shim means zero translations are possible and static extraction cannot run. All 11 dynamic-template `t()` calls (F-12) must be restructured at adoption time. | Invariant #13 | L | No (v1 ships English only) |
| G-03 | Skip-to-main link | No skip-navigation link exists in `AppShell` or any public page. Required for keyboard users to bypass the repeated header nav on every page change. | WCAG 2.1 SC 2.4.1 | S | No |
| G-04 | Colour contrast verification | Tailwind emerald-700 on white (`text-emerald-700`) passes AA at ~4.8:1. The `PALETTE` in `Avatar.tsx` claims AA tuning but has no test. `text-muted-foreground` (often `#6B7280` on `#FFFFFF`) is ~4.6:1 — marginal. Audit with automated tool (axe, Lighthouse) once app is running. | WCAG 2.1 SC 1.4.3 | S | No |
| G-05 | Live region for route changes | SPA route changes are invisible to screen readers. No `aria-live` announcement of page title change occurs. Add a visually-hidden live region that announces the new page `<title>` on navigation (react-router-dom v6 + a `useEffect` on location). | WCAG 2.1 SC 4.1.3 | S | No |
| G-06 | `<html lang>` attribute | Not audited in this pass (outside `frontend/src/features`). Verify `frontend/index.html` sets `lang="en"`. Required by WCAG 2.1 SC 3.1.1. | SC 3.1.1 | XS | No |
| G-07 | `GrantCell` role semantics | As noted in F-03, the 3-state toggle needs a new ARIA role strategy. The full design decision (radiogroup vs button + live region) should be decided before Phase 1B ships the permissions UI to a wider audience. | SC 4.1.2 | M | No |
| G-08 | Phase 1B scorer/referee UI | WebSocket-driven live scoring console will need: real-time score announcement via `aria-live="assertive"`; large tap targets for mobile scorers; high-contrast mode for outdoor use. Flag early in Phase 1B spec. | SC 1.4.11, 2.5.5 | L | No (Phase 1B) |
