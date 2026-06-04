# A11y & i18n Audit — `frontend/src/features/roles`

**Scope:** `frontend/src/features/roles/` (all `.tsx` / `.ts` files) + directly referenced UI primitives (`PreviewTile`, `toast`, `card`, `button`, `input`, `label`) through the lens of **WCAG 2.1 AA**, accessible markup, keyboard/focus management, and i18n (`t()`) coverage.

**Date:** 2026-06-04  
**Auditor:** Claude Code (automated static analysis)  
**Status:** Phase 1A implementation complete; no dynamic tests run.

---

## Findings

---

### F-01 · HIGH — Heading hierarchy skips h2 everywhere (h1 → h3 directly)

**Files:**
- `RoleLandingShell.tsx:55` (`<h1>{heroTitle}</h1>`) → `card.tsx:37` (`<h3>` via `CardTitle`) at lines 63, 87
- `MyProfilePage.tsx:111` (`<h1>`) → three `CardTitle` → `<h3>` at lines 133, 225, 265

**Evidence:**  
`RoleLandingShell.tsx:55`: `<h1 className="text-2xl font-semibold tracking-tight">{heroTitle}</h1>`  
`card.tsx:37`: `<h3 ref={ref} ...` (CardTitle renders as `<h3>`)

**Why it matters:**  
WCAG 1.3.1 Info and Relationships + technique H42. Screen readers use heading levels to build a document outline. Jumping from h1 to h3 breaks the outline and forces AT users to infer a missing level. WCAG requires headings to be used in logical order.

**Recommendation:**  
Either change `CardTitle` to render `<h2>` when it is a direct child of a page-level `<section>`, or pass an `as` prop (`<CardTitle as="h2">`), or wrap each card's structural heading in an explicit `<h2>`. Simplest fix: in `RoleLandingShell` and `MyProfilePage`, use `<h2>` for the card section titles instead of relying on `CardTitle`'s hardcoded `<h3>`.

---

### F-02 · HIGH — Focus not moved to name field when "Edit profile" is activated

**File:** `MyProfilePage.tsx:116–163`

**Evidence:**  
```tsx
// line 116-126 — button disappears when editing=true; no focus transfer
{!editing ? (
  <Button ... onClick={() => setEditing(true)}>
    {t("Edit profile")}
  </Button>
) : null}
// line 157-163 — input appears but receives no programmatic focus
<Input
  id="profile-name"
  value={name}
  onChange={(e) => setName(e.target.value)}
  disabled={!editing || saveName.isPending}
/>
```

**Why it matters:**  
WCAG 2.4.3 Focus Order and 3.2.2 On Input. When a button causes new interactive content to appear (the name input + Save/Cancel buttons), focus should move to that new content. Without this, keyboard and AT users who activate "Edit profile" will find their focus has landed nowhere (the button is gone but nothing gained focus), forcing them to re-navigate the entire form.

**Recommendation:**  
Add a `nameInputRef = useRef<HTMLInputElement>(null)` and in the `setEditing(true)` handler call `setTimeout(() => nameInputRef.current?.focus(), 0)`. Wire the ref to `<Input ref={nameInputRef} ...>`.

---

### F-03 · HIGH · `aria-disabled` on `role="group"` has no semantic effect

**File:** `PreviewTile.tsx:39–43`

**Evidence:**  
```tsx
<div
  role="group"
  aria-disabled="true"   // ← not valid on group role
  aria-label={title}
  ...
>
```

**Why it matters:**  
ARIA 1.2 spec defines `aria-disabled` as applicable to widget roles (button, link, input, combobox, etc.) and some composite roles, but NOT `group`. Assistive technologies silently ignore `aria-disabled` on a `group` role — the intended "this tile is not interactive" signal is never surfaced to AT users. They will encounter four `group` regions with no indication that they are placeholders.

**Recommendation:**  
Remove `aria-disabled="true"` from the `group` div (it has no effect). Instead, announce the tile's unavailable status through its visible content: the existing `t("Phase 1B")` badge is sufficient context. Optionally add `aria-roledescription="unavailable feature preview"` to the group div if you want AT to read more context.

---

### F-04 · MEDIUM — "Phase 1B" badge text is 10px — below readable size threshold

**File:** `PreviewTile.tsx:50–55`

**Evidence:**  
```tsx
<span
  className="... text-[10px] font-medium uppercase tracking-wide ..."
>
  {t(badgeText ?? "Phase 1B")}
</span>
```

**Why it matters:**  
WCAG 1.4.4 Resize Text requires text to be resizable to 200% without loss of content. At 10px (7.5pt), this text is at the extreme lower end. Although WCAG does not set a minimum px floor, SC 1.4.3 note 1 defines "large text" as 18pt / 14pt bold — 10px is far below. Users with even mild vision impairment will find this badge illegible. Additionally, this text color is `text-secondary-foreground` on `bg-secondary`; in dark mode those tokens may produce contrast near the limit.

**Recommendation:**  
Increase to `text-xs` (12px) minimum. The badge is purely informational and can afford the size increase without breaking the layout. Also add an explicit `text-secondary-foreground` class to the span so dark-mode contrast is guaranteed regardless of inheritance.

---

### F-05 · MEDIUM — Toast dismiss button shows literal "x" character

**File:** `toast.tsx:90–95`

**Evidence:**  
```tsx
<button
  type="button"
  aria-label="Dismiss notification"
  onClick={() => dismiss(tm.id)}
  className="rounded p-1 text-xs hover:bg-muted"
>
  x
</button>
```

**Why it matters:**  
WCAG 1.3.3 Sensory Characteristics: controls must not rely solely on a single sensory characteristic. The visible label "x" (lowercase letter x) is ambiguous — it is commonly used as a close icon but is not a universally recognised symbol (unlike ×, ✕, or a Lucide `X` icon). The `aria-label` fixes the accessible name for AT but sighted users, including those with cognitive disabilities, may not identify "x" as a close button.

**Recommendation:**  
Replace the "x" character with a Lucide `<X className="h-3 w-3" aria-hidden="true" />` icon and keep the `aria-label`. This is already available since lucide-react is in the project.

---

### F-06 · MEDIUM — 2FA status display is not semantically associated with its label

**File:** `MyProfilePage.tsx:192–218`

**Evidence:**  
```tsx
<div className="flex items-center justify-between gap-4">
  <div>
    <div className="text-sm font-medium">
      {t("Two-factor authentication")}     {/* ← visual label */}
    </div>
    <div className="text-xs text-muted-foreground">
      {user.has_2fa_enrolled
        ? t("2FA is enabled on this account.")
        : t("Add an authenticator app...")}
    </div>
  </div>
  {user.has_2fa_enrolled ? (
    <span data-testid="2fa-status" ...>{t("Enabled")}</span>   {/* ← status value */}
  ) : (
    <Link to={routes.twoFactorEnroll()} ...>{t("Enable 2FA")}</Link>
  )}
</div>
```

**Why it matters:**  
WCAG 1.3.1 Info and Relationships. The visual pairing of "Two-factor authentication" label with "Enabled" badge / "Enable 2FA" link is purely presentational. AT users receive no association; the badge announces as "Enabled" without context. The "Enable 2FA" link text ("Enable 2FA") is self-describing, but the "Enabled" chip has no role to identify it as a status indicator.

**Recommendation:**  
Wrap the 2FA row in a `<dl>` with `<dt>` for the label and `<dd>` for the value/action. Alternatively, add `role="status"` and `aria-label={t("Two-factor authentication: enabled")}` to the chip. For the link, `aria-describedby` pointing to the label `<div>` would connect it for AT.

---

### F-07 · MEDIUM — `aria-label` on "Send feedback" button redundantly duplicates visible text (minor) and the fallback `<Link>` has no aria-label at all

**File:** `RoleLandingShell.tsx:119–135`

**Evidence:**  
```tsx
// button path (line 120-126): aria-label duplicates visible text — acceptable but redundant
<button ... aria-label={t("Send feedback")}>{t("Send feedback")}</button>

// link fallback path (line 129-134): no aria-label — relies solely on "Send feedback" text
<Link to={`${routes.orgDashboard(orgSlug)}?feedback=1`} ...>
  {t("Send feedback")}
</Link>
```

**Why it matters:**  
The button case has `aria-label` equal to visible text — redundant but harmless. The `<Link>` fallback has no `aria-label`, which is fine if "Send feedback" is unambiguous in context, but the adjacent descriptive `<span>` ("Tell us what's working…") is not associated with the link (no `aria-describedby`). The `<span>` is announced separately from the link, so AT users may not connect them.

**Recommendation:**  
Remove the redundant `aria-label` from the `<button>` (visible text is sufficient). Add `aria-describedby` to both the `<button>` and the `<Link>`, referencing the `<span>` id that contains "Tell us what's working and what's not". This applies to all three list items in the "What you can do today" card.

---

### F-08 · MEDIUM — `muted-foreground` text at `text-xs` (12px) sits at the WCAG AA contrast boundary

**Files:** Multiple — `MyProfilePage.tsx`, `NotificationPrefsPage.tsx`, `RoleLandingShell.tsx`, `PreviewTile.tsx`

**Evidence (representative):**  
`MyProfilePage.tsx:148`: `<p className="text-xs text-muted-foreground">` — Email verified status  
`RoleLandingShell.tsx:103`: `<span className="ml-2 text-xs text-muted-foreground">` — Action hint

`--muted-foreground: 215.4 16.3% 46.9%` → approx `rgb(108, 119, 128)` on white (`rgb(255,255,255)`).  
Contrast ratio ≈ **4.54:1** (just above the 4.5:1 AA threshold for normal text).

**Why it matters:**  
WCAG 1.4.3 requires 4.5:1 for text below 18pt (24px) / 14pt bold (approximately 18.67px). At 12px the ratio at 4.54:1 technically passes, but it is razor-thin — CSS rendering differences, subpixel antialiasing, and dark-mode calculation could push specific instances below threshold. The dark-mode `--muted-foreground` value (`hsl(215 20.2% 65.1%)` ≈ `rgb(152, 161, 171)`) on dark background (`hsl(222.2 84% 4.9%)` ≈ `rgb(10, 14, 36)`) gives approx 8.5:1 — safe. Light mode is the risk.

**Recommendation:**  
Darken `--muted-foreground` in the light theme by 3–5% lightness (e.g. `215.4 16.3% 42%`) to build in a safety margin. Alternatively, change informational hint text from `text-xs` to `text-sm` (14px) where layout permits, which changes the WCAG threshold from 4.5:1 to 3:1 (large text rule does not apply at 14px, but every 1px helps).

---

### F-09 · LOW — `"Edit profile"` button has no visible label change when in saving state; Cancel has no explicit disabled announcement

**File:** `MyProfilePage.tsx:165–188`

**Evidence:**  
```tsx
<Button ... disabled={saveName.isPending || name.trim() === user.name}>
  {saveName.isPending ? t("Saving...") : t("Save")}
</Button>
<Button ... disabled={saveName.isPending}>
  {t("Cancel")}
</Button>
```

**Why it matters:**  
WCAG 4.1.3 Status Messages. The `Button` component applies `disabled:opacity-50` visually, but there is no `aria-live` region or status announcement when saving completes or fails. The toast notification handles errors and success, but it is positioned far from the form and may not be within the AT user's current reading context.

**Recommendation:**  
Add `aria-busy={saveName.isPending}` to the Save button (communicates ongoing operation to AT). The existing toast is the primary status mechanism and is marked `role="status"` / `role="alert"` — that is fine; this is an enhancement.

---

### F-10 · LOW — Missing `React` namespace import in 5 files that use `React.ReactElement` return type

**Files:** `MyProfilePage.tsx:37`, `NotificationPrefsPage.tsx:19`, `RefereeLandingPage.tsx:11`, `ScorerLandingPage.tsx:12`, `TeamManagerLandingPage.tsx:11`

**Evidence (representative):**  
`MyProfilePage.tsx:1`: `import { useEffect, useMemo, useState } from "react";` — no `* as React`  
`MyProfilePage.tsx:37`: `export function MyProfilePage(): React.ReactElement {` — uses React namespace

**Why it matters:**  
With `verbatimModuleSyntax: true` and `jsx: react-jsx`, JSX is fine without the namespace import, but using `React.ReactElement` as a type annotation requires the `React` namespace in scope. This is a TypeScript compile error under strict mode, not a runtime a11y issue, but it indicates the code may not be building cleanly, masking other type errors.

**Recommendation:**  
Either add `import * as React from "react"` to each of these 5 files, or change the return type annotation to `JSX.Element` (no namespace required) or `ReactElement` (import `{ type ReactElement } from "react"`). RoleLandingShell.tsx already does it correctly with `import * as React from "react"`.

---

### F-11 · INFO — No `<main>` landmark on role-landing pages

**Files:** `RoleLandingShell.tsx`, `MyProfilePage.tsx`, `NotificationPrefsPage.tsx`

**Evidence:**  
`RoleLandingShell.tsx:49`: `<section aria-label={ariaLabel} ...>` — outermost element is `<section>`  
`MyProfilePage.tsx:101`: `<div className="flex flex-col gap-4 p-6">` — outermost is `<div>`

**Why it matters:**  
WCAG 2.4.1 Bypass Blocks (technique ARIA11). Pages should have a `<main>` landmark so keyboard/AT users can skip directly to page content. Whether `<main>` is provided by the app shell or by each page component depends on the layout architecture. If the AppShell wraps all content in a `<main>`, this is a non-issue; if not, these pages lack the required landmark.

**Recommendation:**  
Check `AppShell` / layout wrapper in `App.tsx`. If there is no `<main>` wrapper, add one around the router outlet. The page components themselves should not be responsible for the `<main>` tag to avoid nested `<main>` elements.

---

## Gaps (Forward-looking, not currently implemented)

| # | Item | Missing | Needed for | Effort | Blocking |
|---|------|---------|-----------|--------|---------|
| G-01 | All role-landing pages | `skip to content` link before shell navigation | WCAG 2.4.1 Bypass Blocks | S | No |
| G-02 | `PreviewTile` | Visible focus ring when keyboard focus lands on the tile group (currently `pointer-events-none` behavior uninverted) | WCAG 2.4.7 Focus Visible | S | No |
| G-03 | `MyProfilePage` | `<dl>/<dt>/<dd>` semantic structure for label-value pairs (Email, 2FA status) | WCAG 1.3.1 | S | No |
| G-04 | `NotificationPrefsPage` | Real preference form (Phase 1B) — when built, every checkbox/toggle group will need proper `fieldset`/`legend` grouping and visible legends | WCAG 1.3.1 | M | No |
| G-05 | `RoleLandingShell` / role pages | Reduced-motion alternative: if framer-motion is added for tile animations, `prefers-reduced-motion` media query must disable them | WCAG 2.3.3 (AAA) / 2.3.1 | M | No |
| G-06 | All pages | End-to-end axe-core assertion in Playwright tests — currently no automated a11y smoke test exists in the roles feature tests | WCAG baseline regression | L | No |
| G-07 | `MyProfilePage` — Memberships | Long membership lists have no virtual-scroll; roles are joined with `", "` which is read as prose by AT — a `<ul>` of role chips per membership would be cleaner | WCAG 1.3.1 | S | No |
| G-08 | `t()` function | Currently a pass-through stub. When `i18next` or Lingui replaces it, interpolated strings (e.g. `${t("Switch to")} ${m.org_name}` at `MyProfilePage.tsx:252`) will need proper key+param i18n rather than string concatenation, which breaks in RTL languages | Invariant #13 | M | No |
