# Frontend Quality & UX Audit — Landing, Auth & Errors
**Area:** `frontend/src/features/` (landing, auth, errors, layout, roles)
**Lens:** Visual/UX quality vs professional SaaS bar + vitest coverage gaps
**Date:** 2026-06-04

---

## Executive Summary

The Phase 1A frontend is structurally solid — shadcn/ui primitives, lucide icons, and accessible focus rings are already wired in. Test coverage on happy paths is good. However, the overhaul to a *professional SaaS* bar reveals a cluster of medium-to-high issues: no framer-motion installed at all, hard-coded `emerald-*` color literals that bypass CSS custom properties (dark-mode will break), a `text-grant` typo that silently falls back to unstyled text, the well-known `/api/accounts/me/` 403-vs-401 bug that shows a premature error banner on `/login`, skeleton/loading states that are plain text rather than shimmer animations, and a set of missing test cases for error states, the `ProtectedRoute` guard, and `VerifyEmailPage`.

---

## Findings

### F-01 — framer-motion not installed; zero transition/animation exists anywhere
**Severity:** high
**File:** `frontend/package.json` lines 20-35
**Evidence:**
```json
"dependencies": {
  "@hookform/resolvers": "^5.2.2",
  "@tanstack/react-query": "^5.100.8",
  ...
  "lucide-react": "^1.14.0",
  "react": "^19.2.5",
  ...
}
```
`framer-motion` does not appear in `dependencies` or `devDependencies`. The PRD/CLAUDE.md owner explicitly wants framer-motion for the "pro SaaS UI/UX overhaul". No page transitions, no hero entrance animations, no dialog open/close springs are possible without installing it.
**Recommendation:** `npm install framer-motion`. Add `<AnimatePresence>` to the `AuthLayout` form swap (cred→totp), the mobile drawer open/close, the error banner mount/unmount, and the landing hero `<section>` entry stagger.

---

### F-02 — Hard-coded `emerald-*` Tailwind classes everywhere; dark-mode will shatter
**Severity:** high
**Files (representative):**
- `frontend/src/features/landing/LandingPage.tsx` lines 51-52, 68, 104-105
- `frontend/src/features/auth/AuthLayout.tsx` lines 28, 71, 74
- `frontend/src/features/errors/NotFoundPage.tsx` line 39
- `frontend/src/features/errors/ComingSoonPage.tsx` lines 48-49
- `frontend/src/features/auth/LoginPage.tsx` line 168
**Evidence (LandingPage.tsx:51):**
```tsx
className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-700 text-white font-bold"
```
**Evidence (AuthLayout.tsx:28):**
```tsx
className="hidden lg:flex flex-col justify-between bg-gradient-to-br from-emerald-700 via-teal-700 to-slate-900 ..."
```
`index.css` defines `--brand: 160 84% 30%` and `--brand-fg: 0 0% 100%` but they are almost never consumed — instead every file reaches for the literal `bg-emerald-700`. Tailwind's dark-mode variants can't redefine literal palette classes. In dark mode the emerald sidebar becomes a blinding saturated green against a near-black background, and the `from-emerald-700 via-teal-700` gradient loses the subtle contrast its light-mode backdrop provides.
**Recommendation:** Add `bg-brand` / `text-brand` / `border-brand` utilities to `tailwind.config.js` mapping to the CSS vars. Replace every `bg-emerald-*`/`text-emerald-*` in the feature files with the semantic utility. The brand panel gradient should become `from-[hsl(var(--brand)/0.9)]` or equivalent dark-mode-aware stops.

---

### F-03 — `text-grant` typo produces invisible text in success states (VerifyEmailPage + TwoFactorEnrollPage)
**Severity:** high
**Files:**
- `frontend/src/features/auth/VerifyEmailPage.tsx` line 61
- `frontend/src/features/auth/TwoFactorEnrollPage.tsx` line 84
**Evidence (VerifyEmailPage.tsx:60-62):**
```tsx
<p role="status" className="text-sm text-grant">
  {t("Email verified. You can now sign in.")}
</p>
```
**Evidence (TwoFactorEnrollPage.tsx:83-86):**
```tsx
<p role="status" className="text-sm text-grant">
  {t("2FA enabled. Save these recovery codes...")}
```
`text-grant` is not a Tailwind class. The text falls back to `text-foreground` (black in light mode) with no explicit success color, silently breaking the green success feedback the developer intended (`text-green-*` or `text-emerald-700`). This is a UX regression on two critical confirmation screens.
**Recommendation:** Replace `text-grant` with `text-emerald-700 dark:text-emerald-400` in both files. Add a vitest test that asserts the success paragraph is present and has the correct accessible role.

---

### F-04 — `ProtectedRoute` loading state is plain `"Loading..."` text — no skeleton or spinner
**Severity:** medium
**File:** `frontend/src/features/layout/ProtectedRoute.tsx` lines 30-38
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
On a slow device or cold cache this text string is what every user sees for ~200–500 ms before any content appears. A professional SaaS product uses a spinner or skeleton shimmer. There is no visual hierarchy or branded feel.
**Recommendation:** Replace the text with a `<Loader2 className="animate-spin" />` lucide icon (already imported throughout the project) or a branded skeleton shimmer. If framer-motion is added (F-01), add a subtle fade-in to avoid flash.

---

### F-05 — `OrgChooserPage` has no empty-state illustration, bare minimum styling
**Severity:** medium
**File:** `frontend/src/features/layout/OrgChooserPage.tsx` lines 14-51
**Evidence:**
```tsx
if (!user) return <div />;
...
<div className="mx-auto max-w-2xl p-6">
  <h1 className="mb-2 text-2xl font-semibold">
    {t("Choose an organization")}
  </h1>
```
`return <div />` on `!user` is a silent render (screen-reader invisible, no loading state, no redirect). The page has no outer shell/card, no icon treatments on membership cards, no hover/active animation, and the zero-memberships empty state is just a `<p>` element with no illustration.
**Recommendation:** Guard `!user` with a redirect to `/login` or a `<Loader2>` spinner. Wrap the page in a max-width centered card. Add an icon to each org card (e.g. a `Building2` lucide icon). Use a styled empty-state illustration (SVG or a large icon with muted text) for the zero-org case.

---

### F-06 — `OrgComingSoonPage` is stripped-down compared to `ComingSoonPage`; inconsistent pattern
**Severity:** medium
**Files:**
- `frontend/src/features/layout/OrgComingSoonPage.tsx` lines 16-39
- `frontend/src/features/errors/ComingSoonPage.tsx` lines 32-68
**Evidence (OrgComingSoonPage.tsx:18-39):**
```tsx
<div className="flex flex-col gap-4 p-6">
  <Card>
    <CardHeader>
      <CardTitle>{t("Coming soon")}</CardTitle>
      ...
    </CardHeader>
    <CardContent className="text-sm">
      <Link to={routes.orgDashboard(orgSlug)} className="text-primary underline">
        {t("Back to dashboard")}
      </Link>
```
`OrgComingSoonPage` has no icon, no centered layout, no `Button` CTA — just a raw `<Link>` with a plain `text-primary underline` class while `ComingSoonPage` (which it parallels) has a centered card, a `<Sparkles>` icon badge, and a proper `<Button>`. Two pages serving the same conceptual function have visually divergent implementations.
**Recommendation:** Merge `OrgComingSoonPage` into `ComingSoonPage` (which already accepts `feature` and `description` props) and delete the duplicate. Wire every "coming soon" route through the single component.

---

### F-07 — Landing page hero has no dark-mode-safe gradient (`from-emerald-50 via-white to-slate-50` are light-only)
**Severity:** medium
**File:** `frontend/src/features/landing/LandingPage.tsx` line 77
**Evidence:**
```tsx
<section className="relative overflow-hidden border-b border-border/60 bg-gradient-to-br from-emerald-50 via-white to-slate-50">
```
`emerald-50` and `slate-50` are extremely light tints. In dark mode (`bg-background` is near-black per `index.css`) these classes are not overridden by any `dark:` variant, so the hero section will render as a jarring near-white block in an otherwise dark UI.
**Recommendation:** Add `dark:from-emerald-950/20 dark:via-background dark:to-slate-950/20` to the gradient classes. Ensure the inline `radial-gradient` style uses CSS custom properties or a `dark:` Tailwind JIT variant.

---

### F-08 — `AuthLayout` brand panel is `aria-hidden="true"` but contains a navigable `<Link>`
**Severity:** medium
**File:** `frontend/src/features/auth/AuthLayout.tsx` lines 28-66
**Evidence:**
```tsx
<aside
  className="hidden lg:flex flex-col justify-between ..."
  aria-hidden="true"
>
  ...
  <Link
    to="/"
    className="inline-flex items-center gap-2 ... focus-visible:ring-2 focus-visible:ring-white/80 ..."
  >
```
`aria-hidden="true"` on an ancestor removes all descendants from the accessibility tree, including focusable elements. The `<Link to="/">` inside the `aria-hidden` panel will be *reachable by Tab* (it is not `inert`) but invisible to screen readers — a WCAG 2.1 SC 4.1.2 violation. Keyboard-only users can Tab into a link they cannot discover via AT.
**Recommendation:** Add `tabIndex={-1}` to the `<Link>` inside the `aria-hidden` aside (so it is not reachable by Tab), or remove `aria-hidden` from the `<aside>` and instead use `aria-label` to contextualise the decorative branding. The second option preserves the wordmark for branding purposes.

---

### F-09 — `LoginPage` shows store `error` immediately on mount if a previous error was not cleared
**Severity:** medium
**File:** `frontend/src/features/auth/LoginPage.tsx` lines 107-114
**Evidence:**
```tsx
{error ? (
  <div
    role="alert"
    className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
  >
    {error}
  </div>
) : null}
```
**Confirmed known issue (see system prompt item (b)):** `/api/accounts/me/` returns 403 on logout instead of 401. The bootstrap interprets a non-401 error and sets `error` on the store. When the user then lands on `/login`, that `error` string is immediately displayed as a red banner *before any interaction*, giving a false impression that login itself failed. The `LoginPage` renders `error` straight from store state with no mount-time reset.
**Recommendation:** Call `useAuthStore.getState().clearError()` (or equivalent) in a `useEffect` on mount in `LoginPage` before rendering. This decouples page-level login errors from bootstrap errors. Alternatively, make `bootstrap()` not set `error` for 403 responses that just mean "not logged in" — those should be treated the same as 401 silently.

---

### F-10 — `AboutPage` is a placeholder stub with no terms content; `terms of service` link on Signup leads here
**Severity:** low
**File:** `frontend/src/features/landing/AboutPage.tsx` lines 11-53
**File:** `frontend/src/features/auth/SignupPage.tsx` line 229
**Evidence (SignupPage.tsx:228-232):**
```tsx
<Link
  to={routes.about()}
  className="font-medium text-emerald-700 hover:underline ..."
>
  {t("terms of service")}
</Link>
```
**Evidence (AboutPage.tsx:38-41):**
```tsx
{t(
  "Detailed terms and a public roadmap are coming soon. Until then, get in touch via your organization administrator.",
)}
```
A user must check "I agree to the terms of service" but the link sends them to a stub page that says "terms coming soon". While acceptable as a Phase 1A placeholder, it risks users accepting terms they cannot read — a legal and UX concern. The `AboutPage` also lacks the shared header/footer nav pattern used by `LandingPage`.
**Recommendation:** At minimum, add a short "v1 Beta — use at own risk" inline terms block to `AboutPage`. Long-term, separate `/about` from `/terms` so the checkbox links to `/terms`. Keep the `AboutPage` header consistent with `LandingPage` by extracting a shared `PublicHeader` component.

---

### F-11 — `PasswordResetCompletePage` uses bare `setTimeout` for auto-redirect; not cancelled on unmount
**Severity:** low
**File:** `frontend/src/features/auth/PasswordResetCompletePage.tsx` lines 42-43
**Evidence:**
```tsx
setTimeout(() => navigate(routes.login()), 1500);
```
This timeout is not captured in a ref and not cleaned up in a return-from-effect. If the component unmounts before 1500 ms (e.g. user navigates away manually), the `navigate()` call fires on a dead component. React 19 would warn; in some React versions this causes the "Can't perform a React state update on an unmounted component" error.
**Recommendation:** Wrap in `useEffect` with cleanup: `const id = setTimeout(...); return () => clearTimeout(id);`. Or use a ref to track mount status.

---

### F-12 — `TwoFactorChallengePage` does not use `AuthLayout`; inconsistent branded shell
**Severity:** low
**File:** `frontend/src/features/auth/TwoFactorChallengePage.tsx` lines 35-70
**Evidence:**
```tsx
return (
  <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
    <Card className="w-full max-w-sm">
```
`LoginPage`, `SignupPage`, `PasswordResetRequestPage`, and `PasswordResetCompletePage` all use `AuthLayout` (two-column with brand panel). `TwoFactorChallengePage` and `TwoFactorEnrollPage` render plain centered cards — no brand wordmark, no emerald sidebar — breaking visual consistency in the authentication flow.
**Recommendation:** Wrap `TwoFactorChallengePage` and `TwoFactorEnrollPage` in `<AuthLayout title=... subtitle=...>`. This is a one-line change per file.

---

### F-13 — `VerifyEmailPage` has no `AuthLayout` shell; loading state has no spinner
**Severity:** low
**File:** `frontend/src/features/auth/VerifyEmailPage.tsx` lines 39-79
**Evidence:**
```tsx
<div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
  <Card className="w-full max-w-sm">
    ...
    {state === "loading" ? (
      <p role="status" className="text-sm">
        {t("Verifying...")}
      </p>
    ) : null}
```
Same brand inconsistency as F-12. The loading state is bare text rather than a spinner. The `idle` state (no token in URL) gives no CTA to get a new verification email.
**Recommendation:** Wrap in `AuthLayout`. Replace the `"Verifying..."` text with `<Loader2 className="animate-spin" />`. Add a "Resend verification email" link for the `idle` state.

---

## Test Coverage Gaps

### T-01 — `ProtectedRoute` has zero dedicated test file
**Severity:** high
**File:** `frontend/src/features/layout/ProtectedRoute.tsx` (no corresponding `__tests__/` file)
The guard covers four distinct branches: pre-bootstrap loading, requires2FA redirect, unauthenticated redirect with `?next=`, and zero-memberships redirect to `/orgs`. None of these are directly tested. `AppShell.test.tsx` partially exercises the shell *after* authentication, but the guard logic itself is untested. A broken guard would let unauthenticated users see protected content.
**Recommendation:** Add `frontend/src/features/layout/__tests__/ProtectedRoute.test.tsx` covering: (1) renders `role="status"` when `!bootstrapped`, (2) redirects to `/2fa/challenge` when `requires2FA && !user`, (3) redirects to `/login?next=<encoded>` when `!user`, (4) redirects to `/orgs` when user has zero memberships, (5) renders children when fully authenticated.

---

### T-02 — `VerifyEmailPage` has no tests at all
**Severity:** high
**File:** `frontend/src/features/auth/VerifyEmailPage.tsx` (no `__tests__/` file)
Three critical states (`idle`, `loading`, `ok`, `error`) are entirely untested. The `text-grant` typo (F-03) would have been caught by a test asserting the success paragraph is visible with the right color class or at least present at all.
**Recommendation:** Add `frontend/src/features/auth/__tests__/VerifyEmailPage.test.tsx` covering: (1) idle state (no token) shows instruction text, (2) ok state (mock API success) shows success message and sign-in link, (3) error state (mock API failure) shows `role="alert"` with error text, (4) loading state shows `role="status"`.

---

### T-03 — `TwoFactorChallengePage` and `TwoFactorEnrollPage` have no tests
**Severity:** high
**File:** `frontend/src/features/auth/TwoFactorChallengePage.tsx` / `TwoFactorEnrollPage.tsx` (no `__tests__/` files)
2FA enrollment and the standalone challenge page are security-critical flows. There are no tests verifying that the TOTP submit button is disabled until 6 digits are entered, that error banners render on bad codes, or that QR code rendering works.
**Recommendation:** Add tests for both pages covering: disabled submit until 6 digits, error display on API rejection, success navigation.

---

### T-04 — `PasswordResetCompletePage` and `PasswordResetRequestPage` have no tests
**Severity:** medium
**Files:** Both auth pages lack `__tests__/` files.
The password reset flow includes a `setTimeout` auto-redirect (F-11) and an anti-enumeration design choice (always shows success even on error). These are non-obvious behaviors that should be regression-protected.
**Recommendation:** Add tests for: token-missing guard, form validation, success state transition, the anti-enumeration pattern (API error still shows success).

---

### T-05 — `ErrorPage` component has no dedicated unit test; only tested transitively via `ErrorBoundary`
**Severity:** medium
**File:** `frontend/src/features/errors/ErrorPage.tsx` (tested only via `ErrorBoundary.test.tsx`)
`ErrorPage` has its own prop interface (`error`, `onRetry`) and a `<details>` disclosure widget. The `onRetry` callback default (`window.location.reload`) and the `<details>` toggle state are not tested directly.
**Recommendation:** Add `frontend/src/features/errors/__tests__/ErrorPage.test.tsx` covering: (1) renders without `error` prop (no `<details>`), (2) renders with `error` (shows `<details>` with message + stack), (3) custom `onRetry` callback is called on button click, (4) default onRetry triggers `location.reload`.

---

### T-06 — `ComingSoonPage` and `OrgComingSoonPage` have no tests
**Severity:** low
**Files:** `frontend/src/features/errors/ComingSoonPage.tsx` / `frontend/src/features/layout/OrgComingSoonPage.tsx`
Neither placeholder page has any test, even though `ComingSoonPage` has prop-conditional logic (`feature`, `description`, `slug` fallback).
**Recommendation:** Add a brief test for `ComingSoonPage` asserting it renders the `feature` name in the title and that the "Back to dashboard" link points to the correct route.

---

### T-07 — `LoginPage.test.tsx` does not test the pre-mount error clearing behavior (F-09)
**Severity:** medium
**File:** `frontend/src/features/auth/__tests__/LoginPage.test.tsx`
The known 403-on-bootstrap bug means the store may contain an `error` string when `LoginPage` mounts. The test at line 119 manually sets `error: "Invalid credentials"` in the store to verify the banner renders — but no test verifies that a *bootstrap-era* error in the store is cleared or suppressed on mount (the current behavior is that it is NOT cleared, so the banner shows).
**Recommendation:** Add a test: `it("does not show a stale bootstrap error on mount", ...)` that sets a non-null `error` in the store *before* rendering the page and asserts the alert is **not** present (or is cleared after mount).

---

## Summary Statistics

| Severity | Findings | Gaps |
|----------|----------|------|
| high | 3 (F-01, F-02, F-03) | 3 (T-01, T-02, T-03) |
| medium | 6 (F-04–F-09) | 3 (T-04, T-05, T-07) |
| low | 4 (F-10–F-13) | 1 (T-06) |

**Priority order for the overhaul sprint:** F-03 (typo causes invisible text) → F-09 (login bug) → F-01 (install framer-motion) → F-02 (dark-mode color tokens) → T-01 (ProtectedRoute tests) → T-02/T-03 (auth page tests) → F-08 (aria-hidden link) → F-04 (loading spinner) → F-12/F-13 (AuthLayout consistency) → remaining.
