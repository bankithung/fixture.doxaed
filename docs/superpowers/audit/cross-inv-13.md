# Cross-Cutting Audit — Invariant 13 (i18n + a11y from Day 1)

**Invariant:** Every user-visible string wrapped in `gettext`/`t()` (even though
only English ships v1); WCAG 2.1 AA on all non-scorer UIs.

**Scope:** Entire backend (`backend/apps`, `backend/fixture`) + frontend
(`frontend/src`), excluding `.venv` and `node_modules`. Phase 1A is implemented;
Phase 1B is not built (assessed for readiness/prep only).

**Verdict:** PARTIAL. The *intent* is wired in (frontend `t()` shim used in 43
files; backend `gettext_lazy` on model metadata), but the invariant is not
actually satisfied:
- Backend has **no translation infrastructure at all** (no `LocaleMiddleware`,
  no `LOCALE_PATHS`, no catalogs) and **all serializer/service error strings and
  all sadmin templates are hardcoded English**, unmarked.
- Frontend a11y has real gaps (no skip link, modal has no focus trap, literal
  `x` close buttons, two untranslated `aria-label`s, native `window.confirm`,
  no `prefers-reduced-motion`), and the `t()` shim's lack of interpolation has
  produced an **untranslatable template-literal anti-pattern in 12 call sites**.
- a11y is **not enforced** (no `eslint-plugin-jsx-a11y`).

---

## Findings

### F1 — Backend: no `LocaleMiddleware`, no `LOCALE_PATHS`, no catalogs (gettext is inert)
- **Severity:** high
- **File:** `backend/fixture/settings/base.py:59-74` (MIDDLEWARE), `:128-132` (i18n block)
- **Evidence:**
  ```python
  USE_I18N = True
  USE_TZ = True
  ```
  MIDDLEWARE has no `django.middleware.locale.LocaleMiddleware`. Grep for
  `LocaleMiddleware` across `backend/` → **No matches found**. Grep for
  `LOCALE_PATHS`/`LANGUAGES` → none. No project `locale/` dir exists
  (`find backend -type d -name locale` excluding `.venv` → empty).
- **Why it matters:** `USE_I18N=True` plus `gettext_lazy` markers do nothing
  without (a) `LocaleMiddleware` to activate a language from `Accept-Language`
  and (b) compiled message catalogs in `LOCALE_PATHS`. Even Django's and DRF's
  *built-in* translations (the only thing that would localize DRF's default
  field errors like "This field is required.") never activate. The invariant
  says i18n "from day 1"; currently the runtime cannot serve any non-English
  string and the markup is decorative.
- **Recommendation:** Add `django.middleware.locale.LocaleMiddleware` (after
  `SessionMiddleware`, before `CommonMiddleware`); set
  `LOCALE_PATHS = [BASE_DIR / "locale"]`; add a `LANGUAGES` list and a
  `makemessages`/`compilemessages` step to the build. Document the workflow in
  CLAUDE.md "Commands". v1 can ship English-only but the chassis must exist.

### F2 — Backend: serializer & service-layer error strings hardcoded English, unmarked
- **Severity:** high
- **File:** `backend/apps/organizations/serializers.py:64,74,104`;
  `backend/apps/permissions/serializers.py:46`;
  `backend/apps/organizations/services/invitation.py:133,138,141,146,156,170,181,244,251,256,264,267,269,272,276,333`;
  `backend/apps/organizations/services/lifecycle.py:51,92,121,123,162,166,197,237`;
  `backend/apps/organizations/services/ownership.py:58,70,82`;
  `backend/apps/organizations/services/slug.py:35,38,44,49,55,58`;
  `backend/apps/organizations/views.py:80,85,200`;
  `backend/apps/accounts/services/signup.py:279`
- **Evidence:**
  ```python
  # organizations/serializers.py:64
  raise serializers.ValidationError(f"Unknown IANA time zone '{value}'.")
  # organizations/services/invitation.py:251
  raise ValidationError("Invalid invitation token.")
  # organizations/views.py:85
  raise DRFValidationError("Expected a UUID.")
  ```
  Grep confirms `from django.utils.translation import gettext_lazy as _` exists
  **only** in the six `models.py` files — never in serializers, views, or
  services. No `_()` wraps any of the strings above.
- **Why it matters:** These are user-visible API error messages (they surface in
  the SPA's toasts/field errors). Per invariant 13 they must be marked for
  translation. They are also DB/value-formatted (f-strings) — marking them needs
  `_("Unknown IANA time zone '%(tz)s'.") % {"tz": value}` so the placeholder
  survives extraction.
- **Recommendation:** Import `gettext_lazy as _` in each module and wrap every
  user-facing message; convert f-strings to `%`-placeholder + params. Add a
  parametrized test (or a `makemessages --all` CI lint) that fails on unmarked
  user-facing strings.

### F3 — Backend: sadmin console HTML templates have zero i18n
- **Severity:** medium
- **File:** all of `backend/apps/sadmin/templates/sadmin/*.html` (14 files), e.g.
  `_base.html:30,32-36,43`; `login.html`; `dashboard.html`; `orgs/*.html`;
  `users/*.html`; `feedback/list.html`; `audit/search.html`
- **Evidence:**
  ```html
  <!-- _base.html:30 -->
  <h1 class="text-lg font-semibold mb-6">Super-admin</h1>
  <!-- _base.html:43 -->
  <button type="submit" ...>Sign out</button>
  ```
  Grep for `{% load i18n %}`/`{% trans %}`/`{% blocktrans %}` across
  `sadmin/templates/` → **no matches**. Every label is hardcoded English.
- **Why it matters:** Invariant 13 says "every user-visible string." sadmin is
  an internal operator console (lower audience), but it is still a user-facing
  UI and is uncovered. Lower severity than F1/F2 because the audience is the
  single super-admin operator.
- **Recommendation:** Add `{% load i18n %}` and wrap labels in `{% trans %}` /
  `{% blocktranslate %}`. Lower priority than tenant/public surfaces.

### F4 — Frontend: `t()` shim has no interpolation → 12 untranslatable template-literal call sites
- **Severity:** high
- **File:** `frontend/src/lib/t.ts:7` (shim);
  call sites: `features/errors/ComingSoonPage.tsx:53`;
  `features/layout/OrgChooserPage.tsx:36`;
  `features/orgs/InvitationsListPanel.tsx:141,152,174`;
  `features/orgs/InviteCreateModal.tsx:271,328`;
  `features/orgs/MemberDirectoryPage.tsx:152,321,336,405`
- **Evidence:**
  ```ts
  // lib/t.ts:7
  export const t = (s: string): string => s;
  ```
  ```tsx
  // ComingSoonPage.tsx:53
  <CardTitle>{t(`${feature} — coming soon`)}</CardTitle>
  // MemberDirectoryPage.tsx:321
  !window.confirm(t(`Remove ${displayName} from this organization?`))
  // MemberDirectoryPage.tsx:405
  {t(`No members match "${search}".`)}
  ```
- **Why it matters:** The whole point of `t()` is that the literal becomes a
  stable catalog key. Passing a template literal that embeds runtime data
  (`feature`, `displayName`, `search`, counts) produces a *different string every
  render*, so no catalog entry can ever match — these are permanently
  English/untranslatable the moment a real i18n lib is added. It also blocks
  message extraction (extractors need static keys). This silently violates the
  invariant while *appearing* compliant.
- **Recommendation:** Give the shim an interpolation signature now —
  `t(key: string, vars?: Record<string,string|number>) => string` that replaces
  `{name}` placeholders — and rewrite the 12 sites to
  `t("{feature} — coming soon", { feature })`. This is also the one file that
  changes when i18next/Lingui lands (per the shim's own docstring), so fixing
  the contract now avoids a 12-site rewrite later.

### F5 — Frontend: no "skip to content" link (WCAG 2.4.1 Bypass Blocks, Level A)
- **Severity:** medium
- **File:** `frontend/src/features/layout/AppShell.tsx:119-291` (no skip link;
  `<main>` at `:287` has no `id`); also `main.tsx` / `App.tsx`
- **Evidence:** Grep for `skip`/"Skip to" in `frontend/src` returns only
  unrelated `skipCsrf` matches. `<main className="flex-1">` (AppShell.tsx:287)
  has no `id`; no `<a href="#main" class="sr-only focus:...">` exists anywhere.
- **Why it matters:** Keyboard/screen-reader users must tab through the entire
  header nav on every page. WCAG 2.1 AA requires a bypass mechanism. The
  invariant explicitly targets AA on non-scorer UIs.
- **Recommendation:** Add a visually-hidden, focus-visible skip link as the
  first focusable element in `AppShell` (and `AuthLayout`) targeting
  `<main id="main-content">`.

### F6 — Frontend: modal Dialog has no focus trap / focus management
- **Severity:** medium
- **File:** `frontend/src/components/ui/dialog.tsx:18-49`; same pattern in
  `features/layout/AppShell.tsx:223-285` (mobile drawer)
- **Evidence:**
  ```tsx
  // dialog.tsx — only Escape + click-outside; no focus capture
  React.useEffect(() => { if (!open) return; const onKey = ... Escape ... }, ...);
  // role="dialog" aria-modal="true" but focus is never moved into the dialog,
  // never trapped, and never restored to the trigger on close.
  ```
  The component's own comment admits it is a placeholder: "Replace with
  @radix-ui/dialog when shadcn primitives are formally adopted."
- **Why it matters:** `aria-modal="true"` is a *promise* to AT that focus is
  contained; without a focus trap + initial focus + return-focus, keyboard users
  can tab to the obscured background page (WCAG 2.4.3 Focus Order; 1.3.1).
  Affects every modal: invite create, ownership transfer, password reauth.
- **Recommendation:** Adopt `@radix-ui/react-dialog` (already the stated plan) or
  add focus-trap + initial/return focus to the hand-rolled `Dialog` and the
  AppShell drawer.

### F7 — Frontend: untranslated `aria-label`s and literal `x` close glyphs in toast
- **Severity:** medium
- **File:** `frontend/src/components/ui/toast.tsx:69,92,96`
- **Evidence:**
  ```tsx
  aria-label="Notifications"            // :69 — not wrapped in t()
  aria-label="Dismiss notification"     // :92 — not wrapped in t()
  ...>x</button>                        // :96 — literal letter "x" as close icon
  ```
  Grep for literal `aria-label="` across `frontend/src` (excluding tests) finds
  these two as the only non-`t()` aria-labels.
- **Why it matters:** aria-labels are user-visible to AT and must be translatable
  (invariant 13). The literal `x` is announced as the letter "x" by screen
  readers and is poor typography — should be a lucide `X` icon with
  `aria-hidden` plus an sr-only/`aria-label` text.
- **Recommendation:** Wrap both aria-labels in `t()`; replace the `x` text with
  `<X aria-hidden />` (lucide) and keep the translated `aria-label`. Same `x`
  literal also appears in `dialog.tsx:112` (`DialogCloseButton`).

### F8 — Frontend: native `window.confirm` for destructive action (not accessible/themeable/translatable surface)
- **Severity:** low
- **File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:321`
- **Evidence:**
  ```tsx
  if (!window.confirm(t(`Remove ${displayName} from this organization?`))) ...
  ```
- **Why it matters:** Native `confirm()` cannot be styled, can be suppressed by
  browsers, has inconsistent AT behavior, and (combined with F4) carries an
  untranslatable string. Inconsistent with the app's own `Dialog` primitive.
- **Recommendation:** Replace with the in-app confirmation `Dialog`.

### F9 — Frontend: no `prefers-reduced-motion` handling (WCAG 2.3.3 / motion safety)
- **Severity:** medium
- **File:** `frontend/src/index.css:1-82` (no media query); whole `frontend/src`
  (grep for `reduced-motion`/`useReducedMotion` → none)
- **Evidence:** `index.css` defines a global `:focus-visible` ring (good) but no
  `@media (prefers-reduced-motion: reduce)` block; the file uses
  `transition-*`/animation utilities elsewhere (e.g. AppShell `transition-colors`,
  DashboardCard `transition-shadow`).
- **Why it matters:** AA-adjacent (2.3.3 is AAA, but motion-safety is part of a
  credible "WCAG 2.1 AA day 1" posture, and the locked roadmap adds
  **framer-motion**). Without a reduced-motion baseline, the planned animation
  overhaul will ship motion to users who opted out.
- **Recommendation:** Add a global `@media (prefers-reduced-motion: reduce)` rule
  that neutralizes transitions/animations; gate all future framer-motion via
  `useReducedMotion()`.

### F10 — Frontend: `<html lang>` is static "en" and never reflects active locale
- **Severity:** low
- **File:** `frontend/index.html:2` (`<html lang="en">`); backend
  `apps/sadmin/templates/sadmin/_base.html:2` and `login.html:2` likewise static
- **Evidence:** `<html lang="en">`; no code sets `document.documentElement.lang`
  (grep → none).
- **Why it matters:** WCAG 3.1.1 (Language of Page) requires `lang` to match the
  rendered language. English-only today makes this benign, but it is a prep gap:
  the moment a second language is added, `lang` must update or AT mispronounces.
- **Recommendation:** Drive `document.documentElement.lang` from the active
  locale when i18n is wired; in Django templates use `{% get_current_language %}`.

### F11 — Frontend: a11y is not enforced (no `eslint-plugin-jsx-a11y`)
- **Severity:** medium
- **File:** `frontend/package.json` / `frontend/eslint.config.js`
- **Evidence:** Grep for `jsx-a11y`/`eslint-plugin-jsx` in both files → none.
- **Why it matters:** With WCAG AA as an invariant, the absence of lint
  enforcement means regressions (missing alt, label-less inputs, role misuse)
  land silently. The per-module a11y audits in `docs/superpowers/audit/*_a11y_i18n.md`
  are manual snapshots, not a gate.
- **Recommendation:** Add `eslint-plugin-jsx-a11y` (recommended config) to the
  flat config; consider an axe-core check in Playwright e2e for the key flows.

### F12 — Frontend: dark-mode tokens exist but `.dark` is never applied (dead theme)
- **Severity:** info
- **File:** `frontend/src/index.css:45-65` (`.dark {…}`),
  `frontend/tailwind.config.js:3` (`darkMode: ["class"]`)
- **Evidence:** `.dark` token block + `darkMode: ["class"]` are present, but no
  code ever adds the `dark` class or reads `prefers-color-scheme` (grep for
  `setTheme`/`toggleTheme`/`prefers-color-scheme` in `frontend/src` → none).
- **Why it matters:** Not an invariant-13 violation per se, but the locked
  product direction wants dark mode in the UI/UX overhaul; the tokens are ready
  yet inert. Recording as a prep gap so the overhaul wires a theme provider.
- **Recommendation:** Add a theme provider/toggle that applies `.dark` and
  honors `prefers-color-scheme`; persist choice.

---

## Phase 1B readiness (does 1A BLOCK inv-13 for 1B?)

**No hard blocker.** The chassis pieces exist (frontend `t()` shim used widely;
backend `gettext_lazy` already imported in models). Phase 1B (tournaments,
matches, fixtures, live, notifications, disputes) can adopt the same patterns.
However, several **prep gaps must be closed before 1B scales**, or 1B will
inherit and multiply the defects:

- The `t()` interpolation gap (F4) must be fixed first — 1B has far more
  dynamic strings (scores, team names, schedule times) and will otherwise create
  hundreds of untranslatable keys.
- Backend translation infra (F1) and the "wrap service errors in `_()`" habit
  (F2) must be established before 1B's larger service layer is written.
- a11y enforcement (F11) and focus-trap primitive (F6) should land before the
  scoring/bracket UIs, which are interaction-heavy.

---

## Gaps (summary)

| # | Area | Missing | Blocking 1B? | Effort |
|---|------|---------|--------------|--------|
| G1 | Backend i18n infra | LocaleMiddleware + LOCALE_PATHS + catalogs + makemessages workflow | No (but needed before 1B services) | M |
| G2 | Backend strings | `_()` wrapping of all serializer/service/view error messages | No | M |
| G3 | sadmin templates | `{% load i18n %}` + `{% trans %}` across 14 templates | No | M |
| G4 | `t()` contract | Interpolation params; rewrite 12 template-literal sites | No (but high-leverage before 1B) | S |
| G5 | a11y enforcement | `eslint-plugin-jsx-a11y` + axe-core e2e | No | S |
| G6 | a11y primitives | Skip link, modal focus trap/return, reduced-motion baseline | No | M |
| G7 | Locale plumbing | Dynamic `<html lang>`, theme provider for `.dark` | No | S |
