# Audit: fe-auth — Frontend UI/UX Quality & Test Coverage

**Audit area:** `frontend/src/features/auth/`
**Date:** 2026-06-04
**Lens:** Visual/UX quality vs. a professional SaaS bar (shadcn/ui, lucide, framer-motion, cohesive dark mode) + missing vitest coverage for guards/permission-gating/error states.

---

## Findings

### F-01 · No dark-mode support on any auth surface [HIGH]

**File:** `frontend/src/features/auth/AuthLayout.tsx` (all lines); `frontend/src/index.css` L44–65.

The CSS custom-property `.dark` block is defined in `index.css` and `tailwind.config.js` has `darkMode: ["class"]`, meaning dark mode is wired up at the design-system level. However, zero `dark:` variant classes appear anywhere inside `frontend/src/features/auth/`. The emerald gradient panel, hard-coded light backgrounds (`bg-emerald-50`, `bg-white` on the QR image), and success cards all render identically in dark mode, producing inverted-on-white artifacts and low contrast.

**Why it matters:** The owner explicitly listed dark mode as a target. Auth surfaces are the first thing new users see; broken dark mode is a first-impression failure.

**Recommendation:** Add `dark:` variants to `AuthLayout.tsx` (gradient panel, form column), replace hard-coded `bg-emerald-50` / `text-emerald-900` success banners with design-system tokens (`bg-brand-muted`, `text-brand-ink` with dark overrides), and add `dark:bg-white` to the QR code image wrapper in `TwoFactorEnrollPage.tsx`.

---

### F-02 · Hard-coded `text-emerald-700` / `bg-emerald-50` scattered across 6 files instead of brand tokens [HIGH]

**Files:** `LoginPage.tsx` L168, L193; `SignupPage.tsx` L114, L223, L231, L251; `PasswordResetRequestPage.tsx` L43, L52, L93; `PasswordResetCompletePage.tsx` L69, L86; `AuthLayout.tsx` L28, L72.

Evidence: `className="font-medium text-emerald-700 hover:underline focus-visible:underline focus-visible:outline-none"` — repeated verbatim 9 times across the auth feature. The tailwind config already declares `brand.DEFAULT = hsl(160 84% 30%)` (emerald-700) and `brand.fg`, yet the auth pages bypass these tokens and use Tailwind's raw palette.

**Why it matters:** If the brand colour ever changes (or dark-mode needs a lighter variant) every occurrence must be found manually. This is the classic "design token exists but isn't used" anti-pattern.

**Recommendation:** Replace `text-emerald-700` with `text-brand`, `bg-emerald-50` with `bg-brand-muted`, `bg-emerald-700` with `bg-brand`, and `border-emerald-200` with `border-brand/30`. Extract the repeated link class into a shared `authLinkCn` constant or a tiny `AuthLink` component.

---

### F-03 · `VerifyEmailPage` and `TwoFactorEnrollPage` use `text-grant` for success copy — class is undefined for text use [MEDIUM]

**Files:**
- `frontend/src/features/auth/VerifyEmailPage.tsx` L60: `className="text-sm text-grant"`
- `frontend/src/features/auth/TwoFactorEnrollPage.tsx` L84: `className="text-sm text-grant"`

`tailwind.config.js` L48 defines `grant: { DEFAULT: "hsl(142 71% 45%)", muted: "..." }`, so `bg-grant` and `text-grant` do resolve — but visually this produces Tailwind's green-500-equivalent which in dark mode is low-contrast against dark backgrounds. More critically the class is semantically wrong for auth success states (it is used in the permissions matrix for "granted" module cells) and creates coupling between unrelated features.

**Why it matters:** Success states on email verification and 2FA enrollment should use the design system's standard success/brand token path, not borrow a domain-specific matrix colour.

**Recommendation:** Replace `text-grant` with `text-brand` (or `text-emerald-700` until tokens are centralised) on auth success paragraphs and add `dark:text-emerald-400` for contrast.

---

### F-04 · No loading spinner — loading state is text-only ("Signing in...", "Verifying...") [MEDIUM]

**Files:** `LoginPage.tsx` L138–139, L186–187; `PasswordResetCompletePage.tsx` L127–128; `TwoFactorEnrollPage.tsx` L135–137.

The submit buttons replace their label with text like `{isLoading ? t("Signing in...") : t("Sign in")}` with no spinner icon. A professional SaaS bar uses an animated spinner (e.g. `lucide-react`'s `Loader2` with `animate-spin`) alongside or replacing text to give tactile feedback that a network call is in progress.

**Why it matters:** Text-only state changes can be missed, especially on slow connections. Spinner = clear, universally-understood signal.

**Recommendation:** Import `Loader2` from `lucide-react` (already in `package.json` L22) and render `<Loader2 className="h-4 w-4 animate-spin" />` inside the button when loading. The same pattern should be standardised across all auth submit buttons.

---

### F-05 · `VerifyEmailPage` diverges from `AuthLayout` — inconsistent chrome [MEDIUM]

**File:** `frontend/src/features/auth/VerifyEmailPage.tsx` L39–42.

```tsx
<div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
  <Card className="w-full max-w-sm">
```

Every other auth page (Login, Signup, PasswordReset*) wraps its content in `<AuthLayout>` which provides the two-column branded gradient panel. `VerifyEmailPage` instead rolls a one-off centered Card layout. Same applies to `TwoFactorEnrollPage` (L71) and `TwoFactorChallengePage` (L35).

**Why it matters:** A user clicking the email-verification link or hitting the 2FA challenge encounters a completely different visual shell (plain grey background, no brand gradient) vs. every other unauthenticated page. This breaks the brand story and looks unfinished.

**Recommendation:** Migrate `VerifyEmailPage`, `TwoFactorEnrollPage`, and `TwoFactorChallengePage` to use `<AuthLayout>` (or a `<CenteredAuthLayout>` variant that drops the brand panel but keeps the wordmark and background). The three pages together represent the entire post-signup onboarding journey.

---

### F-06 · `DialogCloseButton` in `dialog.tsx` renders raw "x" character instead of a lucide icon [MEDIUM]

**File:** `frontend/src/components/ui/dialog.tsx` L106–113.

```tsx
<button type="button" onClick={onClick} aria-label={t("Close dialog")}>
  x
</button>
```

The close button on the dialog primitive is a bare ASCII "x". The rest of the shell uses `lucide-react` icons (e.g. `X` from lucide in `AppShell.tsx` L241). The `DialogCloseButton` is exposed as part of the dialog's public API and called by `PasswordReauthModal`'s context (though `PasswordReauthModal` does not mount it directly). This is a half-finished primitive.

**Why it matters:** Inconsistency at the primitive level bleeds into every modal that reuses it.

**Recommendation:** Replace the raw "x" with `<X className="h-4 w-4" />` from `lucide-react`. While there, add `absolute positioning` so the button pins to the card top-right corner correctly.

---

### F-07 · `PasswordReauthModal` — custom Dialog lacks a focus-trap [MEDIUM]

**File:** `frontend/src/components/ui/dialog.tsx` (the DIY dialog used by `PasswordReauthModal.tsx`).

The dialog comment at L7 says "Replace with @radix-ui/dialog when shadcn primitives are formally adopted." The current bespoke implementation:
- Does NOT trap focus inside the modal (Tab will cycle through the entire document behind the overlay).
- Does NOT restore focus to the trigger element when the modal closes.
- Relies on `autoFocus` on the input (`PasswordReauthModal.tsx` L83) for initial positioning only.

**Why it matters:** WCAG 2.1 AA (invariant #13) requires modal dialogs to trap focus and restore it on close. A password re-auth modal that lets focus escape behind an opaque backdrop is a real accessibility failure.

**Recommendation:** Replace `dialog.tsx` with Radix UI `@radix-ui/react-dialog` (which ships with correct focus trap + restore + portal behaviour) or add a manual focus-trap hook (`useFocusTrap`) that catches Tab/Shift-Tab key events and constrains them to the modal's focusable children.

---

### F-08 · No page-entry animation / no `framer-motion` at all [LOW]

**File:** `package.json` — `framer-motion` is absent from both `dependencies` and `devDependencies`.

The owner's stated goal includes `framer-motion` for the SaaS overhaul. Currently auth pages transition instantly with no enter/exit animations. A simple `AnimatePresence` + `motion.div` fade-in on the form card and the TOTP form swap (the `requires2FA` conditional in `LoginPage.tsx` L116) would significantly lift perceived polish.

**Why it matters:** Auth flows (login → TOTP challenge, signup → success card) involve conditional content swaps. Without animation these feel jarring. The entire feature also lacks route-level page-in transitions.

**Recommendation:** Install `framer-motion`, wrap the `AuthLayout` children in `<AnimatePresence mode="wait">` and apply `initial={{ opacity: 0, y: 8 }}` / `animate={{ opacity: 1, y: 0 }}` / `exit={{ opacity: 0 }}` with `transition={{ duration: 0.18 }}` to each form panel.

---

### F-09 · No "show password" toggle on any password field [LOW]

**Files:** `LoginPage.tsx` L173–179; `SignupPage.tsx` L185–193; `PasswordResetCompletePage.tsx` L114–121.

All password inputs are unconditionally `type="password"` with no toggle button to reveal the text. This is a standard SaaS UX pattern (and is explicitly called for when a password manager is not present).

**Why it matters:** On mobile especially, users frequently mis-type passwords. The strength meter on SignupPage (which requires a long password) becomes harder to use without the ability to verify the typed value.

**Recommendation:** Add a small lucide `Eye`/`EyeOff` icon button (`type="button"`, `aria-label="Show/Hide password"`) inside the input row, toggling `type` between `"password"` and `"text"`. This can be extracted as a `PasswordInput` wrapper around shadcn `Input`.

---

### F-10 · Brand logo is a plain text "F" in a box — no real wordmark / SVG logo [LOW]

**Files:** `AuthLayout.tsx` L44–49 (sidebar logo), L70–73 (mobile logo).

```tsx
<span aria-hidden="true" className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-white/15 backdrop-blur-sm font-bold">
  F
</span>
```

The logo is a bold uppercase letter "F" in a coloured box. This is acceptable as a placeholder but the design brief calls for a professional SaaS overhaul.

**Why it matters:** The logo is the first element in the brand panel. A simple SVG glyph (even a stylised "F" or a football icon from lucide) would immediately lift the first-impression quality.

**Recommendation:** Create `src/assets/logo.svg` (or inline SVG) and replace the letterbox with it. If a real logo is not ready, use `lucide-react`'s `Trophy` or `Flame` icon as a temporary branded glyph.

---

### F-11 · `PasswordResetCompletePage` uses `setTimeout` for redirect — leak risk in tests [LOW]

**File:** `frontend/src/features/auth/PasswordResetCompletePage.tsx` L42.

```tsx
setTimeout(() => navigate(routes.login()), 1500);
```

Raw `setTimeout` is not cleared in a cleanup function or `useEffect`, so if the component unmounts before 1500 ms (e.g. a user navigates away), the callback fires against a stale navigator. This can also cause flaky tests.

**Why it matters:** While unlikely to cause a user-visible bug in practice, it is an unmount-safety issue and will cause vitest to warn about state updates on unmounted components if ever tested directly.

**Recommendation:** Wrap in `useEffect(() => { const id = setTimeout(..., 1500); return () => clearTimeout(id); }, [done, navigate])`.

---

### F-12 · `LoginPage` calls `useAuthStore.getState()` inside render function — selector bypass [LOW]

**File:** `frontend/src/features/auth/LoginPage.tsx` L72.

```tsx
const resolveDestination = (): string => {
  if (explicitNext) return explicitNext;
  const user = useAuthStore.getState().user;  // ← outside selector
```

`resolveDestination` is a closure called from `onCredSubmit` (an async event handler), not during render, so this works correctly — but calling `.getState()` inside a function that is defined inside the component body creates confusion: it looks like a hook violation even though it isn't. Additionally it bypasses React's reactivity entirely; if `user` were needed in JSX it would not re-render on change.

**Why it matters:** Code-clarity issue. Future maintainers may copy the pattern into a render path where it breaks.

**Recommendation:** Move `resolveDestination` outside the component or pass `user` explicitly, making the imperative nature clear.

---

## Gaps (missing test coverage)

### G-01 · `ProtectedRoute` has zero unit tests [blocking · effort M]

**Current state:** `frontend/src/features/layout/ProtectedRoute.tsx` has four distinct branches (loading spinner, 2FA redirect, unauthenticated redirect preserving `?next=`, zero-memberships redirect to `/orgs`) — none are covered by any vitest file. The only ProtectedRoute exercise is indirect via the AppShell integration test.

**Missing:** Tests for each branch: (1) renders loading state when `!bootstrapped`; (2) redirects to `/2fa/challenge` when `requires2FA && !user`; (3) redirects to `/login?next=<encoded>` when `!user`; (4) redirects zero-membership non-superuser to `/orgs`; (5) renders children when fully authenticated.

**Needed for:** Auth guard correctness, invariant #2 (no cross-org leak), and future role-module gating on protected routes.

---

### G-02 · `VerifyEmailPage` has no tests [blocking · effort S]

**Current state:** No test file exists for `VerifyEmailPage.tsx`. The page has three states (idle with no token, loading while verifying, ok/error after API call) none of which are covered.

**Missing:** Tests for: (1) renders idle copy when no `?token=`; (2) calls `authApi.verifyEmail(token)` on mount; (3) renders success link on `ok`; (4) renders error message on API failure; (5) cancels in-flight request on unmount.

---

### G-03 · `PasswordResetRequestPage` and `PasswordResetCompletePage` have no tests [blocking · effort S]

**Current state:** No test files exist for either page.

**Missing for `PasswordResetRequestPage`:** (1) renders email field; (2) shows anti-enumeration success state on submit (regardless of backend error); (3) validates email format.

**Missing for `PasswordResetCompletePage`:** (1) renders missing-token error when `?token=` absent; (2) validates 12-char minimum; (3) shows success card and redirects after API success; (4) shows error banner on API failure.

---

### G-04 · `TwoFactorEnrollPage` and `TwoFactorChallengePage` have no tests [high · effort S]

**Current state:** No test files exist for either 2FA page.

**Missing for `TwoFactorEnrollPage`:** (1) calls `totpEnrollBegin` on mount and renders QR; (2) handles `totpEnrollBegin` failure with error copy; (3) disables confirm button until 6 digits typed; (4) shows recovery codes on success; (5) handles wrong code rejection.

**Missing for `TwoFactorChallengePage`:** (1) disables button until 6 digits; (2) routes to root on success; (3) shows store error on wrong code.

---

### G-05 · `PasswordReauthModal` has no tests [high · effort S]

**Current state:** No test file for `PasswordReauthModal.tsx`.

**Missing:** (1) modal is hidden initially; (2) opens when `password_reauth_required` auth event fires; (3) calls `authApi.reauth` with entered password; (4) closes on success; (5) shows error on failure; (6) cancel button closes modal; (7) Escape key closes modal.

---

### G-06 · `authStore.bootstrap` error branch not tested [medium · effort S]

**Current state:** `authStore.test.ts` covers login, logout, and completeTotp but has no test for `bootstrap`. The bootstrap method has two distinct error branches (401 → sets bootstrapped but no error; other error → sets error message) that are fully untested.

**Missing:** (1) `bootstrap` with 401 → sets `bootstrapped: true`, `user: null`, no error; (2) `bootstrap` with network error → sets `bootstrapped: true`, sets `error` string; (3) `bootstrap` success sets `user`.

---

### G-07 · `authStore.completeTotp` without pending credentials not tested [medium · effort S]

**Current state:** The `completeTotp` guard at `authStore.ts` L107–110 (`if (!pendingCredentials) { set({ error: "Session expired..." }); throw; }`) has no test. A user who bookmarks `/2fa/challenge` and navigates there without credentials in memory would hit this branch.

**Missing:** Test: call `completeTotp` without a prior `login` call → `error` is set to "Session expired", call throws.

---

### G-08 · No tests for the TOTP submit path on `LoginPage` (completing 2FA) [medium · effort S]

**Current state:** `LoginPage.test.tsx` has a test that the TOTP form *renders* when `requires_2fa: true` is returned (L108–117) but no test that submitting the TOTP form calls `completeTotp` and routes successfully or shows an error on rejection.

**Missing:** (1) typing 6 digits and submitting TOTP calls store `completeTotp`; (2) successful `completeTotp` routes to landing; (3) failed `completeTotp` surfaces error alert.

---
*End of audit report.*
