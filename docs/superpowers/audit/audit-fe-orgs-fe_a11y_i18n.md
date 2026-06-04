# Audit: fe-orgs — A11y & i18n
**Scope:** `frontend/src/features/orgs/` (all .tsx files)
**Lenses:** unwrapped user-visible strings; missing aria/labels/for; keyboard nav + focus management; dialog focus traps; alt text; WCAG 2.1 AA contrast.
**Date:** 2026-06-04

---

## Findings

### F-01 — CRITICAL: Dialog has no focus trap (keyboard users can Tab outside modal)
**File:** `frontend/src/components/ui/dialog.tsx` lines 18–48 (used by `InviteCreateModal`, `OwnershipTransferModal`)
**Evidence:**
```tsx
export function Dialog({ open, onOpenChange, ariaLabel, children }: DialogProps) {
  // Escape key only — no focus-trap logic at all
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    ...
  }, [open, onOpenChange]);
```
**Why it matters:** WCAG 2.1 SC 2.1.2 (No Keyboard Trap) + ARIA APG modal pattern require that Tab/Shift+Tab cycle only within an open dialog. Without a focus trap, keyboard users Tab out of the modal into the inert background, losing context. Additionally, `aria-modal="true"` is set but there is no `inert` attribute on the background or focus cycling — screen readers may still traverse background content.
**Recommendation:** Implement a proper focus trap: on open, collect all tabbable descendants, intercept Tab/Shift+Tab to cycle only within them, and restore focus to the trigger element on close. Use `@radix-ui/react-dialog` (already planned per CLAUDE.md) or `focus-trap-react`. Also add `aria-labelledby` pointing to the `DialogTitle` id rather than the string-only `aria-label` (allows the title to be visible AND referenced). Priority: ship before any modal goes to users.

---

### F-02 — CRITICAL: Dialog missing initial focus management and return-focus on close
**File:** `frontend/src/components/ui/dialog.tsx` (no `autoFocus` / `useEffect` that calls `.focus()`)  
**File (callers):** `InviteCreateModal.tsx:151` — `autoFocus` on the email input works inside that specific modal, but `OwnershipTransferModal.tsx` has no `autoFocus` on any field.
**Evidence (OwnershipTransferModal):**
```tsx
<Input id="transfer-target" value={toUserId} onChange={...} placeholder="01HF..." />
```
No `autoFocus`, no `useEffect` restoring focus. The Dialog itself never calls `.focus()` on open.
**Why it matters:** WCAG 2.1 SC 2.4.3 (Focus Order) + ARIA APG: when a dialog opens, focus must move into it; when it closes, focus must return to the element that opened it.
**Recommendation:** In `Dialog`, accept an optional `initialFocusRef` prop; on open call `initialFocusRef.current?.focus()`. On close, capture and restore the previously-focused element. Add `autoFocus` to the first actionable input in `OwnershipTransferModal` as an interim fix.

---

### F-03 — HIGH: Interpolated template literals inside `t()` are not i18n-extractable
**Files (all occurrences):**
- `InvitationsListPanel.tsx:141` — `{t(\`expires ${expiresLabel}\`)}`
- `InvitationsListPanel.tsx:152` — `aria-label={t(\`Copy invitation link for ${invitation.email}\`)}`
- `InvitationsListPanel.tsx:174` — `aria-label={t(\`Revoke invitation for ${invitation.email}\`)}`
- `MemberDirectoryPage.tsx:152` — `aria-label={t(\`Actions for ${displayName}\`)}`
- `MemberDirectoryPage.tsx:321` — `t(\`Remove ${displayName} from this organization?\`)`
- `MemberDirectoryPage.tsx:336` — `t(\`${total} ${total === 1 ? "member" : "members"}\`)`
- `MemberDirectoryPage.tsx:405` — `t(\`No members match "${search}".\`)`
- `InviteCreateModal.tsx:271` — `t(\`Expires ${expiryLabel}.\`)`
- `InviteCreateModal.tsx:328` — `aria-label={t(\`Copy ${label}\`)}`
**Evidence (representative):**
```tsx
{t(`expires ${expiresLabel}`)}
// InvitationsListPanel.tsx:141
```
**Why it matters:** Invariant #13 ("every user-visible string wrapped in `t()`") is met syntactically, but the current implementation of `t()` is `(s: string) => s` — it works for static strings. When i18next/Lingui is adopted, template literal calls with interpolations are NOT statically extractable by the tooling. Plural forms (`member`/`members`) require ICU plural syntax, not ternaries.
**Recommendation:** Replace all interpolated `t()` calls with parameterised variants using a named-key + interpolation object (e.g., `t("expires_at", { date: expiresLabel })`) or adopt Lingui's `msg` + `t` macro pattern. For plurals, use `t("members_count", { count: total })`. Update `lib/t.ts` to accept an interpolation object now so callers can migrate incrementally.

---

### F-04 — HIGH: `window.confirm()` used for destructive action — inaccessible to keyboard/screen reader users
**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:319–326`
**Evidence:**
```tsx
if (
  typeof window !== "undefined" &&
  !window.confirm(t(`Remove ${displayName} from this organization?`))
) {
  return;
}
removeMember.mutate(m);
```
**Why it matters:** `window.confirm()` is a browser-native modal that:
- Is unstyled and cannot pass WCAG AA contrast checks.
- Blocks JS and does not integrate with ARIA live regions.
- Is disallowed in some browser contexts (iframes, sandboxed content).
- Some screen readers do not announce browser dialogs reliably.
WCAG 2.1 SC 3.3.4 (Error Prevention) requires a confirm mechanism for irreversible actions, but it must be accessible.
**Recommendation:** Replace with the project's own `Dialog` (once focus-trapped) containing a clearly labelled "Remove member" confirm button, or use a toast-level undo pattern. Short-term: extract into a `ConfirmDialog` component.

---

### F-05 — HIGH: OrgAuditLogPage table has no accessible name
**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:150`
**Evidence:**
```tsx
<table className="min-w-full text-sm">
  <thead ...>
    <tr>
      <th ...>{t("When")}</th>
```
No `aria-label`, no `aria-labelledby`, no `<caption>`. Compare: `MemberDirectoryPage.tsx:411` correctly sets `aria-label={t("Members table")}`.
**Why it matters:** WCAG 2.1 SC 1.3.1 (Info and Relationships) + ARIA spec require tables to have an accessible name. Without it, screen readers announce "table" with no context, especially when the page contains only one table.
**Recommendation:** Add `aria-label={t("Audit log events")}` or a `<caption className="sr-only">{t("Audit log events")}</caption>` to the `<table>` element.

---

### F-06 — HIGH: OrgAuditLogPage loading skeleton has no accessible status announcement
**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:121–130`
**Evidence:**
```tsx
{query.isLoading ? (
  <div className="space-y-2">
    {Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="h-12 animate-pulse rounded-md bg-muted/40" aria-hidden="true" />
    ))}
  </div>
```
The skeleton divs are `aria-hidden`, but there is no `role="status"` or `aria-live` region announcing that content is loading. Compare with `MemberDirectoryPage.tsx:185` which has `<div role="status" aria-live="polite"><span className="sr-only">{t("Loading members...")}</span>`.
**Why it matters:** WCAG 2.1 SC 4.1.3 (Status Messages) requires loading states to be announced to screen reader users.
**Recommendation:** Wrap the skeleton in `<div role="status" aria-live="polite"><span className="sr-only">{t("Loading audit log...")}</span> ...skeletons... </div>` matching the pattern used in other pages.

---

### F-07 — HIGH: InviteAcceptPage typo — `text-grant` is not a Tailwind class (contrast unknown)
**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:83`
**Evidence:**
```tsx
<p role="status" className="text-sm text-grant">
  {t("You're now a member.")}
</p>
```
`text-grant` is not a valid Tailwind CSS utility class. This is almost certainly a typo for `text-green-600` or the design-token `text-success`. Without the intended colour applying, the text renders in the browser's default foreground colour, but the intent (success green) is lost.
**Why it matters:** If the intended colour is a light green it may fail WCAG AA contrast (4.5:1 for normal text). The class silently has no effect; no visual styling is applied.
**Recommendation:** Replace `text-grant` with the correct Tailwind colour class (e.g., `text-green-700` which is dark enough on white, or the project's semantic `text-success` if defined). Lint with `eslint-plugin-tailwindcss` to catch unknown class names.

---

### F-08 — MEDIUM: Role name raw values displayed without human-readable labels in OrgSwitcher
**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:90`
**Evidence:**
```tsx
{currentRoles.map((r) => (
  <button ... role="radio" aria-checked={...}>
    {r}  {/* Raw string like "co_organizer", "game_coordinator" */}
  </button>
))}
```
The button visible text is the raw API role key (e.g., `co_organizer`, `game_coordinator`). This is announced by screen readers verbatim. Compare: `InviteCreateModal.tsx:36–43` defines a `ROLE_LABELS` map with human-readable names for exactly these keys.
**Why it matters:** WCAG 2.1 SC 2.4.6 (Headings and Labels): labels must be descriptive. Screen readers will announce "co_organizer" as a label, which is not natural language. Sighted users also see the underscore-separated API slug.
**Recommendation:** Import or share the `ROLE_LABELS` map from `InviteCreateModal` (or a shared constants file) and render `ROLE_LABELS[r] ?? r` as the button text, wrapped in `t()`.

---

### F-09 — MEDIUM: Inline menu (`role="menu"`) in MemberRow has no `aria-label` and no `id` linking trigger to menu
**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:158–176`
**Evidence:**
```tsx
<Button
  aria-haspopup="menu"
  aria-expanded={menuOpen}
  aria-label={t(`Actions for ${displayName}`)}
  onClick={() => setMenuOpen((o) => !o)}
>
  <MoreVertical ... />
</Button>
{menuOpen ? (
  <div role="menu" className="...">
    <button role="menuitem" ...>
```
The trigger has `aria-haspopup="menu"` and `aria-label`, but the `role="menu"` container has no `aria-label` and the trigger does not link to the menu via `aria-controls`.
Additionally, when the menu opens there is no focus shift into the menu — keyboard users cannot reach menu items via Tab (menu items require Arrow key navigation per ARIA APG Menu Button pattern).
**Why it matters:** WCAG 2.1 SC 4.1.2 (Name, Role, Value); ARIA APG Menu Button pattern. Keyboard-only users cannot operate this menu.
**Recommendation:**
1. Add `aria-label={t(`Actions for ${displayName}`)}` to the `role="menu"` div.
2. Add `aria-controls` on the trigger referencing the menu's `id`.
3. On menu open, move focus to the first `role="menuitem"`.
4. Implement Arrow Down/Up to move between items, Home/End for first/last, Escape to close and return focus to trigger.

---

### F-10 — MEDIUM: Form error `<p role="alert">` elements not associated with their inputs via `aria-describedby`
**Files:**
- `InviteCreateModal.tsx:155–163` — email input error
- `InviteCreateModal.tsx:184–193` — roles fieldset error
- `OrgSettingsPage.tsx:268–276` — org name error
- `OrgSettingsPage.tsx:318–326` — time zone error
- `OwnershipTransferModal.tsx:136–139` — transfer error
**Evidence (representative from InviteCreateModal.tsx):**
```tsx
<Input id="invite-email" aria-invalid={Boolean(form.formState.errors.email)} {...} />
{form.formState.errors.email ? (
  <p role="alert" data-testid="email-error" className="text-xs text-destructive">
    {form.formState.errors.email.message}
  </p>
) : null}
```
`aria-invalid` is set on the input, but the error paragraph has no `id` and the input has no `aria-describedby`/`aria-errormessage` pointing to it. Screen readers may not associate the error message with the field.
**Why it matters:** WCAG 2.1 SC 1.3.1 + 3.3.1 (Error Identification). The ARIA spec recommends `aria-describedby` pointing to the error message id so that reading the input also reads its error context.
**Recommendation:** Add stable ids to error paragraphs (e.g., `id="invite-email-error"`) and `aria-describedby="invite-email-error"` on the corresponding inputs. This is especially important for the fieldset/roles error which has no associated `aria-describedby` on the `<fieldset>` at all.

---

### F-11 — MEDIUM: `<fieldset disabled>` in OrgBrandingPage — disabled state not announced clearly
**File:** `frontend/src/features/orgs/OrgBrandingPage.tsx:207–241`
**Evidence:**
```tsx
<fieldset className="flex flex-col gap-4" disabled aria-describedby="branding-phase-note" ...>
  <div ...>
    <Label htmlFor="brand-color">{t("Primary color")}</Label>
    <Input id="brand-color" type="text" value="#10b981" readOnly ... />
```
`<fieldset disabled>` correctly prevents interaction and `aria-describedby` points to the note. However, the `<Label>` elements inside a `disabled` fieldset are not automatically communicated as inactive by all screen readers. Also `readOnly` + `disabled` combination may be announced differently across AT — some say "dimmed," others say nothing.
**Why it matters:** WCAG 2.1 SC 4.1.2: users must know fields are unavailable. The note text (`aria-describedby`) is at fieldset level but individual input announce order may not surface it.
**Recommendation:** Add a visually-hidden prefix like `<span className="sr-only">{t("Coming in Phase 1B — ")}</span>` before each disabled field label, or add `aria-disabled="true"` with `aria-describedby` on each input pointing to the phase note.

---

### F-12 — MEDIUM: Pagination buttons in OrgAuditLogPage have no descriptive labels
**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:186–204`
**Evidence:**
```tsx
<Button type="button" variant="outline" size="sm" disabled={!prevCursor} onClick={() => setCursor(prevCursor ?? null)}>
  {t("Previous")}
</Button>
<Button type="button" variant="outline" size="sm" disabled={!nextCursor} onClick={() => setCursor(nextCursor ?? null)}>
  {t("Next")}
</Button>
```
Plain "Previous" / "Next" text with no additional context. Multiple paginated tables on a page (if ever) would have duplicate landmark labels.
**Why it matters:** WCAG 2.1 SC 2.4.6 (Headings and Labels). While acceptable for a single-table view, adding `aria-label` (e.g., `t("Previous page of audit events")`) future-proofs the page and improves screen reader clarity.
**Recommendation:** Add `aria-label={t("Previous page of audit events")}` / `aria-label={t("Next page of audit events")}` to the pagination buttons.

---

### F-13 — LOW: `EventTypeBadge` uses `title` attribute (tooltip) — not keyboard accessible
**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:50–59`
**Evidence:**
```tsx
<span className="..." title={event_type}>
  <span className="text-muted-foreground">{namespace}</span>
  <span>·</span>
  <span>{event_type.slice(namespace.length + 1)}</span>
</span>
```
The full `event_type` string is only surfaced via `title`, which is not accessible via keyboard (only shown on hover) and not reliably announced by screen readers.
**Why it matters:** WCAG 2.1 SC 1.3.1 — if the full event type string is informative, it must be accessible without a mouse.
**Recommendation:** Remove `title` and instead render the full event type in a `<span className="sr-only">` sibling, or display the full string inline with a tooltip that is properly implemented (e.g., Radix Tooltip, which is keyboard-accessible).

---

### F-14 — LOW: `InvitationsListPanel` pending count uses `t()` with interpolation — not plural-safe
**File:** `frontend/src/features/orgs/InvitationsListPanel.tsx:77–79`
**Evidence:**
```tsx
<CardDescription>
  {t(
    `${pending.length} ${pending.length === 1 ? "invitation" : "invitations"} awaiting acceptance.`,
  )}
</CardDescription>
```
Same interpolation/plural pattern as F-03, flagged again because this is directly user-visible prose.
**Recommendation:** See F-03. Use `t("pending_invitations", { count: pending.length })` with a plural-aware message catalog entry.

---

### F-15 — LOW: `OrgSwitcher` role radiogroup — role buttons are `<button role="radio">` inside a plain `<div role="radiogroup">`, but individual items have no `id` linking them
**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:70–93`
**Evidence:**
```tsx
<div role="radiogroup" aria-label={t("Active role view")} ...>
  {currentRoles.map((r) => (
    <button type="button" role="radio" aria-checked={...} onClick={...}>
      {r}
    </button>
  ))}
</div>
```
The pattern is mostly correct (radiogroup + radio + aria-checked). The gap: ARIA APG recommends that a `radiogroup` uses `aria-labelledby` if the label is visible, or Arrow key navigation (not Tab) between radio items. The current implementation relies on Tab between buttons, which conflicts with the radio ARIA pattern (radios should only receive focus as a group, with arrows to move within).
**Why it matters:** WCAG 2.1 SC 2.1.1 (Keyboard). Users familiar with radio button keyboard conventions (arrow keys) will find Tab-navigation unexpected.
**Recommendation:** Implement roving tabindex: set `tabIndex={0}` on the active radio, `tabIndex={-1}` on others, and handle ArrowLeft/ArrowRight to cycle. This matches the ARIA APG Radio Group pattern.

---

## Gaps (forward-looking, not current bugs)

| # | Area | Gap | Needed for | Effort |
|---|------|-----|------------|--------|
| G-01 | Dialog primitive | No Radix UI Dialog integration — custom `dialog.tsx` lacks focus trap, return-focus, and scroll-lock | WCAG 2.1 AA compliance for all modals | M |
| G-02 | i18n infrastructure | `lib/t.ts` is a passthrough — no extraction tooling (i18next-parser / Lingui extractor) configured; interpolated strings will break extraction | Phase 1B / i18n production readiness | M |
| G-03 | Contrast validation | No automated colour-contrast CI check (e.g., `axe-core` in Playwright or `jest-axe`) — `text-grant` typo (F-07) would have been caught | WCAG AA ongoing | S |
| G-04 | `window.confirm` replacement | No shared `ConfirmDialog` component exists — each destructive action invents its own pattern | Consistency + accessibility | S |
| G-05 | Live region for mutations | Toast pushes after member remove / invite revoke are the success signal, but no `aria-live` region confirms the table update to screen reader users (table re-renders silently) | SC 4.1.3 Status Messages | S |
| G-06 | Keyboard-accessible tooltips | `EventTypeBadge` and similar `title`-only patterns exist throughout; no accessible Tooltip primitive is available yet | SC 1.3.1 | M |
| G-07 | Skip-navigation link | No skip-nav is present in the app shell for the Members / Audit pages which have long tables | SC 2.4.1 Bypass Blocks | S |
