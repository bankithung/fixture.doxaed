# A11y & i18n Audit — `frontend/src/features/auth`

**Audit date:** 2026-06-04
**Auditor:** Claude Code (automated)
**Scope:** `frontend/src/features/auth/**` (LoginPage, SignupPage, AuthLayout, PasswordResetRequestPage, PasswordResetCompletePage, TwoFactorChallengePage, TwoFactorEnrollPage, PasswordReauthModal, VerifyEmailPage) plus shared primitives referenced by those pages (`components/ui/dialog.tsx`, `components/ui/card.tsx`, `components/ui/input.tsx`, `components/ui/button.tsx`, `components/ui/label.tsx`, `lib/t.ts`).
**Lenses:** unwrapped user-visible strings; missing aria/labels/for; keyboard nav + focus management; dialog focus traps; alt text; WCAG 2.1 AA contrast.

---

## Findings

### F-01 — HIGH | Dialog has no focus trap (keyboard escapes modal)

**File:** `frontend/src/components/ui/dialog.tsx` (entire file, ~50 lines)

**Evidence:**
```tsx
// dialog.tsx:26-31
React.useEffect(() => {
  if (!open) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onOpenChange(false);
  };
  window.addEventListener("keydown", onKey);
```

The custom `Dialog` handles Escape correctly but implements **no focus trap**. When `PasswordReauthModal` opens, `Tab` cycles freely through background document content behind the overlay. The ARIA Authoring Practices Guide (APG) Modal Dialog Pattern mandates that Tab and Shift+Tab cycle only within the dialog until it is dismissed.

**Why it matters:** WCAG 2.1 SC 2.1.2 (No Keyboard Trap) applies bidirectionally — users must not be unable to escape AND keyboard focus must be contained within a dialog. Keyboard-only users navigating behind the overlay can trigger destructive background actions.

**Recommendation:** Add a focus-trap utility (e.g., `focus-trap-react`, or a manual `querySelectorAll('[tabindex], a, button, input, select, textarea')` guard inside the keydown handler). On open, focus the first focusable child (or the dialog container). On close, restore focus to the trigger element. If adopting Radix UI's `@radix-ui/react-dialog` is planned, this is handled automatically.

---

### F-02 — HIGH | Dialog does not move focus on open / restore on close

**File:** `frontend/src/components/ui/dialog.tsx:33-49`

**Evidence:**
```tsx
if (!open) return null;
return (
  <div role="dialog" aria-modal="true" aria-label={ariaLabel} ...>
    <div className="w-full max-w-md rounded-lg ...">
      {children}
    </div>
  </div>
);
```

When the dialog renders there is no programmatic focus move to the dialog or its first interactive child. `PasswordReauthModal` partially compensates with `autoFocus` on the password input (`PasswordReauthModal.tsx:83`), but `autoFocus` is fragile across transitions and does not handle focus restoration on close.

**Why it matters:** WCAG 2.1 SC 2.4.3 (Focus Order) — focus must be managed so that the sequence is meaningful. Screen readers depend on focus being inside the dialog to announce the dialog role/label.

**Recommendation:** In the Dialog `useEffect` that fires when `open` becomes `true`, call `.focus()` on the dialog container (or the first focusable child). Store and restore the previously focused element (`document.activeElement`) when `open` becomes `false`.

---

### F-03 — HIGH | Dialog uses `aria-label` instead of `aria-labelledby` pointing to `<DialogTitle>`

**File:** `frontend/src/components/ui/dialog.tsx:37-38`, `frontend/src/features/auth/PasswordReauthModal.tsx:61-65`

**Evidence:**
```tsx
// dialog.tsx:37-38
<div role="dialog" aria-modal="true" aria-label={ariaLabel} ...>
// PasswordReauthModal.tsx:64
ariaLabel={t("Confirm your password")}
```
The dialog container uses `aria-label` (a static string prop) while also rendering `<DialogTitle>` (an `<h2>`) with the same text. When both exist, AT may announce the label twice. More importantly, `aria-label` is a hardcoded string; `aria-labelledby` pointing to the rendered `<h2>` id is the ARIA-recommended pattern and survives copy changes automatically.

**Why it matters:** WCAG 2.1 SC 4.1.2 (Name, Role, Value) — dialogs should be labelled by their visible heading.

**Recommendation:** Give `<DialogTitle>` a stable `id` (e.g., `id="dialog-title"`) and replace `aria-label` with `aria-labelledby="dialog-title"` on the dialog container. Remove the `ariaLabel` prop from the Dialog API entirely.

---

### F-04 — HIGH | `<aside>` brand panel is `aria-hidden` but contains a keyboard-reachable `<Link>`

**File:** `frontend/src/features/auth/AuthLayout.tsx:28-66`

**Evidence:**
```tsx
// AuthLayout.tsx:28-29
<aside
  className="hidden lg:flex ..."
  aria-hidden="true"
>
  ...
  <Link to="/" className="inline-flex ... focus-visible:ring-2 ...">
    {/* logo link is keyboard reachable */}
    <span>{t("Fixture Platform")}</span>
  </Link>
```

The `<aside>` is correctly decorative on small screens (hidden via `hidden lg:flex`) but on large screens it is visible, `aria-hidden="true"`, and yet contains an interactive `<Link>`. Keyboard focus will reach the link (Tab from outside), but the element is invisible to screen readers — it has no accessible name, role, or announcement.

**Why it matters:** WCAG 2.1 SC 1.3.1 (Info and Relationships) and SC 4.1.2 — interactive controls must not be hidden from the accessibility tree. A sighted keyboard user will see the brand panel; a keyboard+SR user gets a "phantom" focusable element.

**Recommendation:** Either (a) remove `aria-hidden="true"` from the `<aside>` and keep the link accessible, or (b) add `tabIndex={-1}` to the link so it is not keyboard-reachable while remaining visually present for pointer users.

---

### F-05 — MEDIUM | Validation error `<p role="alert">` elements have no `id`; inputs lack `aria-describedby` linking to them

**File:** `frontend/src/features/auth/LoginPage.tsx:157-161`, `LoginPage.tsx:180-184`, `SignupPage.tsx:177-180`, `SignupPage.tsx:209-212`, `SignupPage.tsx:238-242`, `PasswordResetRequestPage.tsx:82-86`, `PasswordResetCompletePage.tsx:121-125`

**Evidence (representative):**
```tsx
// LoginPage.tsx:150-160
<Input
  id="email"
  ...
  aria-invalid={!!credForm.formState.errors.email}
  {...credForm.register("email")}
/>
{credForm.formState.errors.email ? (
  <p role="alert" className="text-xs text-destructive">
    {credForm.formState.errors.email.message}
  </p>
) : null}
```

Every field marks itself `aria-invalid` when there is an error, which is correct. However none of the error `<p role="alert">` elements carry an `id`, and no input carries `aria-describedby` pointing to its error. The `role="alert"` approach means AT announces the text on insertion via a live-region — which works for first-time errors — but after that the error is only accessible by navigating to it. Users who revisit the field in a subsequent interaction will not hear the error unless they physically move to the paragraph.

**Why it matters:** WCAG 2.1 SC 1.3.1 and SC 3.3.1 (Error Identification) — errors must be programmatically associated with their control.

**Recommendation:** Add matching `id` props to each error paragraph (e.g., `id="email-error"`) and add `aria-describedby="email-error"` to the corresponding input. React Hook Form's `register` returns the field name; a small helper `fieldId(name, 'error')` can generate consistent IDs.

---

### F-06 — MEDIUM | TwoFactorChallengePage: TOTP input missing `aria-invalid` and inline validation

**File:** `frontend/src/features/auth/TwoFactorChallengePage.tsx:47-55`

**Evidence:**
```tsx
// TwoFactorChallengePage.tsx:47-55
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

No `aria-invalid`, no validation message, no field-level error shown. If the user enters a 6-digit code that the server rejects, only the global `{error}` below the input shows. Compare with LoginPage's identical TOTP widget (LoginPage.tsx:124-136) which correctly sets `aria-invalid`.

**Why it matters:** WCAG 2.1 SC 3.3.1 (Error Identification) — when a user submits an erroneous input, the error must be described in text.

**Recommendation:** Add `aria-invalid={!!error}` and `aria-describedby="totp-error"` to the input. Add `id="totp-error"` to the error paragraph at line 58. Optionally mirror LoginPage's zod-validated pattern.

---

### F-07 — MEDIUM | TwoFactorEnrollPage: TOTP input missing `aria-invalid`

**File:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:118-126`

**Evidence:**
```tsx
// TwoFactorEnrollPage.tsx:118-126
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

Same deficiency as F-06: no `aria-invalid`, no `aria-describedby` linking to the error at line 129.

**Recommendation:** Same fix as F-06 — add `aria-invalid={!!error}` and `aria-describedby="totp-enroll-error"` to the input, and `id="totp-enroll-error"` to the `<p role="alert">`.

---

### F-08 — MEDIUM | Card-based auth pages have no `<h1>` — page title is an `<h3>`

**File:** `frontend/src/features/auth/TwoFactorChallengePage.tsx:37-39`, `TwoFactorEnrollPage.tsx:73-79`, `VerifyEmailPage.tsx:42-44`

**Evidence:**
```tsx
// card.tsx:35 — CardTitle renders as h3
<h3 ref={ref} className="text-2xl font-semibold ..." {...props} />

// TwoFactorChallengePage.tsx:37-39
<CardTitle>{t("Two-factor verification")}</CardTitle>
```

Pages using the Card layout do not embed themselves in `AuthLayout` (which provides the `<h1>`). Their visible page title is rendered as `<h3>` by `CardTitle`, with no `<h1>` or `<h2>` present anywhere on the page. Screen readers and search engines expect exactly one `<h1>` per page.

**Why it matters:** WCAG 2.1 SC 2.4.6 (Headings and Labels) — headings convey structure. An `<h3>` as the first and only heading creates a broken heading outline.

**Recommendation:** Change `CardTitle` to render `<h2>` (or parameterize the level), and wrap the Card pages in `AuthLayout` or add a visually-hidden `<h1>` matching the card title. Alternatively, change `card.tsx:35` to `<h2>` since none of the current Card usages are inside a page that already has an `<h2>`.

---

### F-09 — MEDIUM | SignupPage: `accept_terms` checkbox error has no `aria-describedby` link

**File:** `frontend/src/features/auth/SignupPage.tsx:219-242`

**Evidence:**
```tsx
// SignupPage.tsx:219-242
<label className="flex items-start gap-2 text-sm text-foreground">
  <input
    type="checkbox"
    ...
    aria-invalid={!!form.formState.errors.accept_terms}
    {...form.register("accept_terms")}
  />
  ...
</label>
{form.formState.errors.accept_terms ? (
  <p role="alert" className="text-xs text-destructive">
    {form.formState.errors.accept_terms.message}
  </p>
) : null}
```

The checkbox is wrapped in a `<label>` (correct), sets `aria-invalid`, but the error `<p>` has no `id` and the checkbox has no `aria-describedby`. Additionally, the `<label>` is a plain `<label>` (not the shadcn `<Label>`) which is fine semantically, but the error is outside the label's implicit scope.

**Recommendation:** Add `id="terms-error"` to the error `<p>` and `aria-describedby="terms-error"` to the checkbox `<input>`.

---

### F-10 — MEDIUM | PasswordResetCompletePage: auto-redirect after success without screen-reader announcement

**File:** `frontend/src/features/auth/PasswordResetCompletePage.tsx:41-43`

**Evidence:**
```tsx
// PasswordResetCompletePage.tsx:41-43
setTimeout(() => navigate(routes.login()), 1500);
```

After a successful password reset, the page shows a success card (`role="status"`) and then auto-navigates after 1.5 seconds. Screen-reader users may not have finished reading the status message before the page disappears, and the navigation itself has no announcement (e.g., "Redirecting to sign in in 3 seconds").

**Why it matters:** WCAG 2.1 SC 2.2.1 (Timing Adjustable) — if a time limit is enforced, users must be warned and given control. A 1.5s silent redirect is very short.

**Recommendation:** Either (a) remove the auto-redirect and rely on the explicit "Continue to sign in" link pattern used by VerifyEmailPage, or (b) increase the delay substantially (≥5 s) and add a live-region announcement such as "Password updated. Redirecting to sign in in 5 seconds." with a cancel option.

---

### F-11 — LOW | AuthLayout: no skip-to-main link for keyboard users

**File:** `frontend/src/features/auth/AuthLayout.tsx:26-88`

**Evidence:**
```tsx
// AuthLayout.tsx:26
<div className="min-h-screen grid lg:grid-cols-2 bg-background">
  <aside aria-hidden="true">...</aside>
  <main className="flex items-center justify-center ...">
```

There is no "Skip to main content" link before the layout. On large screens the `<aside>` is `aria-hidden` so there are no focusable elements there to skip. However on mobile the mobile wordmark div (lines 69-77) is a non-link `<div>` — not an issue. Still, best practice requires a skip link at the top of every page that has navigational content before the main landmark.

**Why it matters:** WCAG 2.1 SC 2.4.1 (Bypass Blocks).

**Recommendation:** Add a visually-hidden skip link as the very first element of the layout: `<a href="#main-content" className="sr-only focus:not-sr-only ...">Skip to content</a>` and add `id="main-content"` to the `<main>`.

---

### F-12 — LOW | SignupPage: password strength progressbar announced before user types

**File:** `frontend/src/features/auth/SignupPage.tsx:196-207`

**Evidence:**
```tsx
// SignupPage.tsx:196-207
<div
  role="progressbar"
  aria-valuemin={0}
  aria-valuemax={3}
  aria-valuenow={strength}    // strength=0 when field empty
  aria-label={t("Password strength")}
  ...
/>
<span className="text-xs text-muted-foreground">
  {strengthLabel}             // "Too short" when empty
</span>
```

When the page loads the empty password field results in `strength=0`, so the progressbar announces "Password strength: 0 of 3" and the label reads "Too short". This may confuse users who haven't yet interacted with the field.

**Recommendation:** Add `aria-hidden="true"` to the progressbar container (the `<div id="password-hint">`) until the user has typed at least one character, or change the label to a neutral "Enter a password" at strength 0.

---

### F-13 — LOW | `text-grant` on small status text — potential contrast issue

**File:** `frontend/src/features/auth/TwoFactorEnrollPage.tsx:84`, `VerifyEmailPage.tsx:60`

**Evidence:**
```tsx
// TwoFactorEnrollPage.tsx:84
<p role="status" className="text-sm text-grant">
// VerifyEmailPage.tsx:60
<p role="status" className="text-sm text-grant">
```

`text-grant` resolves to `hsl(142 71% 45%)` — a mid-green (tailwind.config.js:48). At 14px (`text-sm`) this is "normal" text requiring a 4.5:1 contrast ratio against the card background (white or near-white in light mode). A green at L=45% against white has an approximate contrast of ~3.1:1, which is below WCAG AA for body text.

**Why it matters:** WCAG 2.1 SC 1.4.3 (Contrast — Minimum). Small green-on-white text commonly fails AA.

**Recommendation:** Verify with a contrast checker tool. If it fails, use `text-emerald-800` (darker) or the brand `text-emerald-700` which the rest of the auth surface already uses, or create a `text-grant-dark` alias at a higher contrast value in tailwind.config.js.

---

### F-14 — LOW | `AuthLayout` `<h2>` inside `aria-hidden` aside creates misleading heading order if `aria-hidden` is ever removed

**File:** `frontend/src/features/auth/AuthLayout.tsx:54`

**Evidence:**
```tsx
// AuthLayout.tsx:54
<h2 className="text-3xl font-semibold leading-tight">
  {t("Sports fixtures, made in Nagaland.")}
</h2>
```

Currently hidden from AT by the parent `aria-hidden="true"`. If the aside's `aria-hidden` is ever removed (see F-04), this `<h2>` appears before the form's `<h1>` in DOM order, creating an inverted heading hierarchy.

**Recommendation:** Change to `<p>` (or `<div>`) as it is purely decorative brand copy; it does not function as a document section heading.

---

### F-15 — INFO | `t()` i18n wrapper is consistently applied across all auth strings

All user-visible strings in the audit scope are correctly wrapped in `t()` from `@/lib/t`. No bare string literals found in JSX text nodes or ARIA attributes. The `t()` stub (`lib/t.ts:7`) is ready for replacement by `i18next`/`Lingui` without call-site changes.

---

## Gaps (forward-looking — not current defects)

| # | Area | Current state | Missing | Effort | Needed for |
|---|------|---------------|---------|--------|------------|
| G-01 | Dialog primitive | Custom hand-rolled Dialog | Radix UI `@radix-ui/react-dialog` (or equivalent) with built-in focus trap, `aria-labelledby`, scroll-lock, and portal | M | Resolves F-01, F-02, F-03 in one swap |
| G-02 | Live region strategy | `role="alert"` on field errors (live-region) + `aria-invalid` on inputs | `aria-describedby` wiring so errors are persistently associated, not just announced on change | S | F-05, F-06, F-07, F-09 |
| G-03 | Heading structure | `CardTitle` hardcoded as `<h3>` | Polymorphic `as` prop on CardTitle or a page-level `<h1>` wrapper; or change default to `<h1>` | S | F-08 |
| G-04 | Contrast tokens | `grant` color at L=45% used for status text | Audit all semantic colors at their actual Tailwind L values against bg-card/bg-white; add `-dark` variants where needed | S | F-13 |
| G-05 | Skip navigation | No skip-to-main link | One `<a href="#main-content">` inside AuthLayout and an `id` on `<main>` | XS | F-11 / WCAG 2.4.1 |
| G-06 | Auto-redirect | Silent 1.5 s navigate on password reset | Replace with a live-region countdown or remove auto-redirect | XS | F-10 / WCAG 2.2.1 |
| G-07 | i18n runtime | `t()` is a no-op passthrough | When adding i18next/Lingui: extract all `t()` calls to locale files, add locale detection (user TZ → language preference), add RTL CSS flag for future language support | XL | Invariant #13 (ships v1 English only) |
| G-08 | Dark mode contrast audit | Not performed | Test all auth pages in dark mode (`darkMode: ["class"]` is configured) — specifically `text-emerald-700` on dark backgrounds and `bg-destructive/10` tints | M | WCAG 1.4.3 dark mode |
