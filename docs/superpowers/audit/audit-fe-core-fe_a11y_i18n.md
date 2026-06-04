# A11y & i18n Audit — frontend/src (fe-core)

**Date:** 2026-06-04
**Scope:** `frontend/src/**/*.{tsx,ts}` — accessibility (WCAG 2.1 AA) and i18n (t() wrap coverage)
**Auditor:** Claude Code (automated static analysis; no live WCAG contrast scanner)

---

## Summary

The codebase shows strong intent: `t()` is consistently imported and applied; form fields have `<Label htmlFor>` + `aria-invalid`; icons are `aria-hidden`; loading skeletons carry `role="status"` with an `.sr-only` span. Several real defects were found across five categories:

1. **Dialog focus trap is absent** — the hand-rolled `<Dialog>` does not trap keyboard focus inside itself; Tab escapes to background content.
2. **`role="switch"` misused on a 3-state control** (`GrantCell`) — `aria-checked` only maps two states; the third (deny) is invisible to switch semantics.
3. **`window.confirm()` used for destructive confirmation** — not screen-reader-friendly; breaks keyboard flow; no custom dialog.
4. **Mobile nav drawer missing initial focus** — opening the drawer does not move focus inside it; keyboard users must Tab through the entire background DOM.
5. **Toast dismiss button icon is bare `x` character** — the `aria-label` is correct but the close icon is a raw text character, not an SVG.
6. **`aria-invalid` missing on TOTP inputs** in `TwoFactorEnrollPage` and `TwoFactorChallengePage`.
7. **Field errors are not linked to inputs with `aria-describedby`** on most forms (only the password-hint in `SignupPage` uses `aria-describedby`); error `<p role="alert">` elements exist but inputs do not explicitly reference them.
8. **`ConflictOfInterestBanner` checkbox has no visible label** — the checkbox and text are inside a plain `<label>` wrapper which is acceptable, but the checkbox lacks `id` + explicit `for` linkage, and the `role="alert"` + `aria-live="polite"` combination fires alert semantics twice.
9. **Pluralisation is not handled by `t()`** — raw template literals like `t(\`${total} ${total === 1 ? "member" : "members"}\`)` are not internationalisation-ready (gender/number rules differ per locale).
10. **`<html lang>` is set correctly** (`lang="en"` in `index.html`).

---

## Findings

### F-01 — Dialog has no focus trap (critical, keyboard-nav)

**File:** `frontend/src/components/ui/dialog.tsx:18-49`
**Evidence:**
```tsx
export function Dialog({ open, onOpenChange, ariaLabel, children }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    ...
  }, [open, onOpenChange]);
  ...
}
```
No `tabIndex`, no focus-management on open, no sentinel elements. Tab freely escapes to the background DOM.

**Why it matters:** WCAG 2.1 SC 2.1.2 (No Keyboard Trap) and the complementary modal dialog pattern both require focus to be trapped inside the dialog while open. Without this, keyboard-only users and screen-reader users can accidentally activate background controls.

**Recommendation:** Use `@radix-ui/react-dialog` (already planned — dialog.tsx line 8 says "Replace with @radix-ui/dialog when shadcn primitives are formally adopted") or implement a custom focus trap: on open, focus the first focusable child; on Tab, cycle within the dialog's focusable descendants.

**Affected dialogs:** `PasswordReauthModal`, `InviteCreateModal`, `OwnershipTransferModal`, `OrgDashboardPage` (feedback dialog).

---

### F-02 — Mobile nav drawer does not move focus on open (high, keyboard-nav)

**File:** `frontend/src/features/layout/AppShell.tsx:223-284`
**Evidence:**
```tsx
{drawerOpen ? (
  <div id="mobile-nav-drawer" role="dialog" aria-modal="true" aria-label={t("Navigation menu")} ...>
    <div aria-hidden="true" ... onClick={() => setDrawerOpen(false)} />
    <div className="absolute inset-y-0 left-0 ...">
      ...
    </div>
  </div>
) : null}
```
`role="dialog"` + `aria-modal="true"` are correct, but there is no `useEffect` or `autoFocus` that moves focus into the panel when `drawerOpen` becomes true.

**Why it matters:** WCAG 2.1 SC 2.4.3 (Focus Order). When a dialog opens, focus must move to the dialog or the first focusable element inside it. Without this, screen reader users remain in the background context.

**Recommendation:** Add a `useRef` on the close button (or the nav panel itself) and `ref.current?.focus()` inside a `useEffect([drawerOpen])` when `drawerOpen === true`. Also add focus-restoration on close (return focus to the hamburger button).

---

### F-03 — GrantCell uses `role="switch"` for a 3-state cycle (high, semantics)

**File:** `frontend/src/features/permissions/GrantCell.tsx:82-116`
**Evidence:**
```tsx
<button
  type="button"
  role="switch"
  aria-checked={state === "grant"}
  ...
>
```
`role="switch"` is a binary toggle (true/false). This cell has three states: `default`, `grant`, `deny`. Only "grant" maps to `aria-checked={true}`; "deny" and "default" both map to `aria-checked={false}`, making them semantically identical to screen readers.

**Why it matters:** WCAG 2.1 SC 1.3.1 (Info and Relationships). The "denied" state is announced identically to "default-not-granted", losing critical information.

**Recommendation:** Change to `role="button"` and include the full state in `aria-label` (which is already composed as `"${userLabel} — ${moduleLabel}: ${stateForAria}"`). Alternatively use `role="combobox"` / `role="option"` pattern or a custom `aria-pressed` with a multi-value `aria-label`. The composed `ariaLabel` is good — it just needs a semantically correct role.

---

### F-04 — `window.confirm()` for member removal (high, keyboard-nav, a11y)

**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:321`
**Evidence:**
```tsx
if (
  typeof window !== "undefined" &&
  !window.confirm(t(`Remove ${displayName} from this organization?`))
) {
  return;
}
```
`window.confirm()` is a blocking native browser dialog. It bypasses the app's own keyboard-focus management, cannot be styled, is not announced properly in all screen readers, and in some browsers and PWA contexts may be suppressed.

**Why it matters:** Destructive action confirmation must be an accessible dialog that can be tested and styled. This also means the string passed to `t()` is a dynamic template — untranslatable by any future i18n library.

**Recommendation:** Replace with a custom confirmation `<Dialog>` (once focus trap is implemented). Until then, at minimum add a `data-testid` and document the limitation.

---

### F-05 — Form error `<p role="alert">` elements not linked to inputs via `aria-describedby` (high, screen reader UX)

**Files:** Most form files; representative example:
`frontend/src/features/auth/LoginPage.tsx:157-161`
**Evidence:**
```tsx
<Input
  id="email"
  type="email"
  aria-invalid={!!credForm.formState.errors.email}
  {...credForm.register("email")}
/>
{credForm.formState.errors.email ? (
  <p role="alert" className="text-xs text-destructive">
    {credForm.formState.errors.email.message}
  </p>
) : null}
```
`aria-invalid` is set correctly, but the error paragraph has no `id` and the input has no `aria-describedby` pointing to it.

**Why it matters:** WCAG 2.1 SC 1.3.1. When `aria-invalid` is `true`, screen readers will announce the input as invalid but do not know *why* unless `aria-describedby` explicitly references the error text. Without the link, the user must navigate separately to the error paragraph.

**Scope of impact:** `LoginPage`, `SignupPage`, `PasswordResetRequestPage`, `PasswordResetCompletePage`, `InviteCreateModal`, `OrgSettingsPage`. Only `SignupPage` password field has `aria-describedby="password-hint"` (for the strength bar), but still not the error `<p>`.

**Recommendation:** Give each error paragraph a stable `id` (e.g. `email-error`) and add `aria-describedby="email-error"` to the input. When no error exists, either omit the `<p>` (current approach) or keep a hidden one — both are valid, but the `id` must exist before it is referenced.

---

### F-06 — `aria-invalid` missing on TOTP inputs in enroll and challenge pages (medium, form a11y)

**Files:**
- `frontend/src/features/auth/TwoFactorEnrollPage.tsx:118-126`
- `frontend/src/features/auth/TwoFactorChallengePage.tsx:47-55`

**Evidence (enroll):**
```tsx
<Input
  id="totp"
  inputMode="numeric"
  autoComplete="one-time-code"
  pattern="[0-9]*"
  maxLength={6}
  value={totp}
  onChange={(e) => setTotp(e.target.value)}
/>
```
No `aria-invalid` even though an error `<p role="alert">` can appear below.

**Why it matters:** Consistent with finding F-05: screen readers rely on `aria-invalid` to indicate an error state on the specific field.

**Recommendation:** Add `aria-invalid={!!error}` to both inputs.

---

### F-07 — Toast dismiss button uses raw `x` character instead of SVG icon (medium, a11y)

**File:** `frontend/src/components/ui/toast.tsx:90-94`
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
The dismiss button correctly has `aria-label="Dismiss notification"` so screen readers announce it properly. However, the visible content is a raw `x` character (not an `aria-hidden` SVG/icon), which makes the button look visually inconsistent compared to the rest of the UI (which uses lucide icons). Also, `aria-label` is not wrapped in `t()`.

**Why it matters:** Medium severity. The semantic is correct (aria-label overrides the text content for AT), but the `aria-label` string `"Dismiss notification"` is not passed through `t()`, violating invariant #13. Also, the `x` character has no `aria-hidden="true"` to prevent double-announcement in some ATs.

**Recommendation:**
1. Wrap the aria-label in `t()`: `aria-label={t("Dismiss notification")}`.
2. Replace `x` with a lucide `<X className="h-3.5 w-3.5" aria-hidden="true" />`.

---

### F-08 — `ConflictOfInterestBanner` combines `role="alert"` + `aria-live="polite"` (medium, AT over-announcement)

**File:** `frontend/src/features/permissions/ConflictOfInterestBanner.tsx:25-28`
**Evidence:**
```tsx
<div
  role="alert"
  aria-live="polite"
  ...
>
```
`role="alert"` implies `aria-live="assertive"`. Adding `aria-live="polite"` is redundant but also conflicting — some screen readers pick one or the other, leading to inconsistent behaviour.

**Why it matters:** WCAG technique ARIA19. The double declaration can cause the content to be announced twice or not at all, depending on browser+AT combination.

**Recommendation:** Remove `aria-live="polite"`. `role="alert"` already carries assertive live semantics. If polite is intentional, use `role="status"` instead.

---

### F-09 — `ConflictOfInterestBanner` checkbox label pattern (low, a11y)

**File:** `frontend/src/features/permissions/ConflictOfInterestBanner.tsx:42-51`
**Evidence:**
```tsx
<label className="flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={acknowledged}
    onChange={(e) => onChangeAcknowledged(e.target.checked)}
  />
  {t("I acknowledge this conflict...")}
</label>
```
The checkbox is wrapped inside a `<label>` which is valid HTML and acceptable for a11y. However, the checkbox has no explicit `id` and the `<label>` has no `htmlFor`. Implicit association (wrapping) is supported but can fail in certain AT+browser combos with complex layouts.

**Why it matters:** Low risk. The pattern works in modern browsers/ATs. Making it explicit (add `id="conflict-ack"` + `htmlFor="conflict-ack"`) is a robustness improvement.

**Recommendation:** Add `id="conflict-ack"` to the checkbox and `htmlFor="conflict-ack"` to the label for explicit association.

---

### F-10 — Plural strings hardcoded outside `t()` (medium, i18n)

**Files:** Multiple — representative examples:

`frontend/src/features/orgs/MemberDirectoryPage.tsx:333-336`:
```tsx
t(`${total} ${total === 1 ? "member" : "members"}`)
```

`frontend/src/features/orgs/InvitationsListPanel.tsx:77-79`:
```tsx
t(`${pending.length} ${pending.length === 1 ? "invitation" : "invitations"} awaiting acceptance.`)
```

`frontend/src/features/orgs/InviteCreateModal.tsx:258-259`:
```tsx
t(`An email has been sent to ${invitation.email}. Share the link below directly if needed.`)
```

**Why it matters:** Invariant #13 requires every user-visible string to be wrapped in `t()`. These uses pass dynamic runtime values into `t()`, making them untranslatable by i18next/Lingui (which require static string keys or ICU message format). Plural rules differ by locale — "1 member" vs "2 members" is only a simple English pattern.

**Recommendation:** Document a `tn(singular, plural, count)` helper or an ICU-format `t()` contract so these can be converted when i18next is adopted. For now add a `// TODO: i18n plural` comment at each site so they are traceable.

---

### F-11 — `OrgChooserPage` membership card has no accessible label for the card link (low, semantics)

**File:** `frontend/src/features/layout/OrgChooserPage.tsx:27-39`
**Evidence:**
```tsx
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
The `<Link>` has no `aria-label`. Screen readers will announce the full card contents as the link text (which is acceptable but verbose). More critically, `m.roles.join(", ") + " · /o/" + m.org_slug` renders a raw path in the description without `t()`.

**Why it matters:** The raw URL path `/o/${m.org_slug}` will be read aloud by screen readers. Also the `t()` call wraps a dynamic template (same as F-10).

**Recommendation:** Add `aria-label={t(`Go to ${m.org_name}`)}`to the Link and move the slug display to a visually-only element via `aria-hidden`.

---

### F-12 — `AuthLayout` brand panel `<aside>` is `aria-hidden="true"` but contains the site wordmark (info, semantics)

**File:** `frontend/src/features/auth/AuthLayout.tsx:28-66`
**Evidence:**
```tsx
<aside
  className="hidden lg:flex ..."
  aria-hidden="true"
>
  ...
  <Link to="/" ...>
    <span aria-hidden="true">F</span>
    <span>{t("Fixture Platform")}</span>
  </Link>
  ...
  <h2 className="text-3xl font-semibold ...">
    {t("Sports fixtures, made in Nagaland.")}
  </h2>
```
The entire aside is hidden from the accessibility tree (`aria-hidden="true"`). This is intentional (decorative brand panel), but it hides the `<Link to="/">` home link from AT. That is fine since the mobile version shows the wordmark without `aria-hidden`.

**Why it matters:** Informational only. The design deliberately hides the desktop branding panel for AT (since it's purely decorative/redundant with the `<main>` form heading). No action needed, but document the intent.

**Recommendation:** No code change required. Confirm intent is documented.

---

### F-13 — `GrantCell` `role="switch"` + missing `aria-checked` for 3rd state (see F-03 also) — `aria-label` uses template literal not `t()` for composition

**File:** `frontend/src/features/permissions/GrantCell.tsx:79`
**Evidence:**
```tsx
const ariaLabel = `${userLabel} — ${moduleLabel}: ${stateForAria}`;
```
The separator ` — ` and `:` are hardcoded ASCII outside `t()`. When a locale uses different punctuation conventions, these would be wrong.

**Why it matters:** Low / future-risk. Currently English only; the composed string is functionally correct.

**Recommendation:** Compose this string through `t()` once i18n is added, e.g. `t("{{user}} — {{module}}: {{state}}", { user: userLabel, module: moduleLabel, state: stateForAria })`.

---

### F-14 — `AuditLogPage` loading skeleton has no `sr-only` status text (low, screen reader UX)

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:120-128`
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
Skeleton divs are `aria-hidden` (good), but there is no wrapping element with `role="status"` or `aria-live` announcing "Loading…" to screen readers.

**Why it matters:** Without a live region, screen-reader users get no feedback that content is loading. Compare to `ModuleMatrixPage` and `MemberDirectoryPage` which correctly use `role="status" aria-live="polite"` with a `.sr-only` span.

**Recommendation:** Wrap the skeleton in `<div role="status" aria-live="polite"><span className="sr-only">{t("Loading audit log...")}</span>...</div>`.

---

## Gaps (forward-looking)

| Item | Missing | Needed For | Effort | Blocking |
|------|---------|------------|--------|----------|
| Focus trap in `<Dialog>` | A focus-trap implementation or migration to `@radix-ui/react-dialog` | WCAG 2.1 AA SC 2.1.2 | M | Yes |
| Focus restoration on modal close | After dialog closes, return focus to the trigger element | WCAG 2.1 AA SC 2.4.3 | S | Yes |
| Focus move on mobile drawer open | `useEffect` + `ref.current.focus()` when `drawerOpen` becomes true | WCAG 2.1 AA SC 2.4.3 | S | Yes |
| `GrantCell` role correction | Change `role="switch"` → `role="button"` and rely on composed `aria-label` | WCAG 2.1 AA SC 1.3.1 | S | Yes |
| Plural / interpolated strings i18n | `tn()` helper or ICU format wrapping for all `t(\`${count} …\`)` usages | Invariant #13 | M | No |
| `aria-describedby` on field errors | Add `id` to error `<p>` and link from `<Input aria-describedby>` across all forms | WCAG 2.1 AA SC 1.3.1 | S | Yes |
| WCAG contrast audit for custom colours | `grant`, `deny`, `warn`, emerald palette — need runtime contrast checker (e.g. axe-core in Playwright) | WCAG 2.1 AA SC 1.4.3 | S | No |
| Skip-to-content link | `<a href="#main" className="sr-only focus:not-sr-only">Skip to content</a>` in `AppShell` | WCAG 2.1 AA SC 2.4.1 | S | No |
| Dark mode a11y audit | Tailwind `dark:` variants exist in CSS; no dark-mode-specific contrast checks done | WCAG 2.1 AA SC 1.4.3 | M | No |
| `window.confirm()` replacement | Replace with accessible `<Dialog>` confirmation for member removal | WCAG 2.1 AA SC 2.1.1 | M | Yes |
| Toast `aria-label` through `t()` | `"Dismiss notification"` is unwrapped | Invariant #13 | S | No |
