# Cross-cutting audit: i18n + a11y (Invariant #13)

Scope: `frontend/src/**` (excluding `node_modules`). Sweep for invariant #13 —
"every user-visible string wrapped in `t()`; WCAG 2.1 AA on all non-scorer UIs."
Each finding cites `file:line` with quoted evidence.

The frontend has a deliberately small `t()` shim (`frontend/src/lib/t.ts:7`,
`export const t = (s: string): string => s;`) whose own docstring states the
goal: "When we add i18next/Lingui later, this file is the only call-site that
changes." That future-swap promise is the lens for the i18n findings below —
several call sites pass *runtime-interpolated* strings into `t()`, which will
silently break translation lookups when a real backend lands, because the
lookup key is the already-substituted English sentence.

Overall the codebase is unusually disciplined about i18n and a11y. Findings
cluster into three buckets: (1) `t()` template-literal interpolation
anti-pattern, (2) a shared modal/menu **focus-trap + focus-restoration gap**
inherited from the `Dialog` primitive and the bespoke dropdowns, and (3) raw
role-enum keys rendered to users instead of localized labels.

---

## HIGH

### H1. `Dialog` primitive has no focus trap and no focus restoration
- **file:line:** `frontend/src/components/ui/dialog.tsx:18-49`
- **Evidence:** The `Dialog` component installs only an Escape listener
  (`if (e.key === "Escape") onOpenChange(false);`, line 27) and a backdrop
  click-to-close. There is no `role="dialog"` focus management: focus is never
  moved into the dialog on open, Tab is not trapped within the dialog, and
  focus is not returned to the trigger on close.
- **Why it matters:** WCAG 2.1 AA (2.4.3 Focus Order, 2.1.2 No Keyboard Trap
  inverse — here the problem is the *absence* of a trap). Keyboard and screen-
  reader users can Tab out of the open modal into the obscured page behind the
  backdrop, and lose their place entirely when it closes. Every modal in the
  app inherits this: `PasswordReauthModal`, `InviteCreateModal`,
  `OwnershipTransferModal`, and the feedback dialog in `OrgDashboardPage`.
- **Recommendation:** Either adopt `@radix-ui/react-dialog` (the file's own
  TODO at line 7-8 anticipates this) or add: focus the first focusable element
  (or a passed `initialFocusRef`) on open; cycle Tab/Shift+Tab within the
  dialog; store `document.activeElement` on open and restore it on close.

### H2. AppShell mobile nav drawer is `aria-modal` but not focus-trapped
- **file:line:** `frontend/src/features/layout/AppShell.tsx:223-285`
- **Evidence:** The drawer renders `role="dialog" aria-modal="true"`
  (lines 226-228) but has no focus management — no initial focus, no Tab trap,
  no focus restore to the hamburger button on close. Escape is not handled for
  the drawer either (only the user menu has an Escape listener, lines 65-67).
- **Why it matters:** Same WCAG 2.4.3 / keyboard-operability concern as H1, on
  the primary mobile navigation surface. `aria-modal="true"` tells AT the rest
  of the page is inert, but it is not, so AT users are misinformed.
- **Recommendation:** Trap focus inside the drawer panel, focus the close
  button (or first nav link) on open, restore focus to the hamburger on close,
  and add an Escape-to-close handler.

---

## MEDIUM

### M1. `t()` called with runtime-interpolated template literals (breaks future i18n)
This is the single most common i18n defect. When `t()` becomes a real lookup,
each of these keys will contain runtime data and never match a catalog entry.
The fix pattern is interpolation *outside* `t()` with placeholder tokens, e.g.
`t("Remove {name} from this org?").replace("{name}", displayName)` or an
ICU-style formatter.

- `frontend/src/features/orgs/MemberDirectoryPage.tsx:152` —
  `aria-label={t(\`Actions for ${displayName}\`)}`
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:321` —
  `!window.confirm(t(\`Remove ${displayName} from this organization?\`))`
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:336` —
  `t(\`${total} ${total === 1 ? "member" : "members"}\`)` (also bakes English
  pluralization into the key)
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:405` —
  `t(\`No members match "${search}".\`)`
- `frontend/src/features/orgs/InviteCreateModal.tsx:258` —
  ``t(`An email has been sent to ${invitation.email}. Share the link below directly if needed.`)``
- `frontend/src/features/orgs/InviteCreateModal.tsx:271` —
  `t(\`Expires ${expiryLabel}.\`)`
- `frontend/src/features/orgs/InviteCreateModal.tsx:328` —
  `aria-label={t(\`Copy ${label}\`)}`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:78` —
  `t(\`${pending.length} ${pending.length === 1 ? "invitation" : "invitations"} awaiting acceptance.\`)`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:141` —
  `t(\`expires ${expiresLabel}\`)`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:152` —
  `aria-label={t(\`Copy invitation link for ${invitation.email}\`)}`
- `frontend/src/features/orgs/InvitationsListPanel.tsx:174` —
  `aria-label={t(\`Revoke invitation for ${invitation.email}\`)}`
- `frontend/src/features/errors/ComingSoonPage.tsx:53` —
  `t(\`${feature} — coming soon\`)`
- `frontend/src/features/layout/OrgChooserPage.tsx:36` —
  `t(\`${m.effective_modules.length} modules accessible\`)`
- `frontend/src/features/permissions/ModuleMatrixPage.tsx:388` —
  `aria-label={\`${t("Save row for")} ${row.user_email}\`}` (lower risk — the
  translatable segment is isolated, but inconsistent with the placeholder
  pattern)

**Why it matters:** Invariant #13's whole premise is "the only call-site that
changes is `t.ts`." These call sites violate that: they will require rewrites,
and until then any translation catalog generated from source will contain
un-lookup-able keys. Pluralization baked into the key (`member`/`members`,
`invitation`/`invitations`) also can't be localized (other languages have 3-6
plural forms).

### M2. Raw role-enum keys rendered directly to users (i18n + UX)
Role identifiers like `game_coordinator` / `co_organizer` are shown verbatim
instead of via the existing localized `RoleBadge` label map
(`frontend/src/components/ui/RoleBadge.tsx:29-59`).

- `frontend/src/features/orgs/OrgSwitcher.tsx:91` — `{r}` (role-view radio
  buttons render `match_scorer`, `team_manager`, etc. raw)
- `frontend/src/features/permissions/ModuleMatrixPage.tsx:441` — `{r}` inside
  `MemberCell` role chips
- `frontend/src/features/roles/MyProfilePage.tsx:245` —
  `{(m.roles ?? []).join(", ")}`
- `frontend/src/features/layout/OrgChooserPage.tsx:32` — `{m.roles.join(", ")}`
- `frontend/src/features/layout/OrgDashboardPage.tsx:122` —
  `{t("You are:")} {roles.join(", ")}` (the prefix is translated; the role
  values are raw)

**Why it matters:** Untranslatable user-facing strings, and a polish defect —
users see snake_case machine identifiers ("game_coordinator") rather than
"Game coordinator." A `RoleBadge`/label map already exists and should be the
single source.
- **Recommendation:** Reuse `RoleBadge` (or export its `PALETTE[].label` /
  `prettify()` from `RoleBadge.tsx`) everywhere a role is displayed.

### M3. Toast region/dismiss aria-labels not wrapped in `t()`
- **file:line:** `frontend/src/components/ui/toast.tsx:69` and `:92`
- **Evidence:** `aria-label="Notifications"` (line 69, the live region) and
  `aria-label="Dismiss notification"` (line 92, the close button) are bare
  string literals — the only two user-visible/AT-visible strings in the file
  not passed through `t()`.
- **Why it matters:** Invariant #13 says *every* user-visible string, and these
  are announced by screen readers. Inconsistent with the rest of the file
  (toast `title`/`description` come from callers, which do use `t()`).
- **Recommendation:** Wrap both in `t()`; import already absent, add it.

### M4. Custom dropdown menus lack arrow-key navigation (roving focus)
- **file:line:** `frontend/src/features/layout/AppShell.tsx:174-217`
  (user menu, `role="menu"`), `frontend/src/features/orgs/MemberDirectoryPage.tsx:157-175`
  (member-actions menu, `role="menu"`)
- **Evidence:** Both expose `role="menu"`/`role="menuitem"` and handle Escape +
  click-outside at the document level (AppShell lines 65-67; MemberRow lines
  91-93) but neither implements Up/Down arrow navigation or Home/End between
  `menuitem`s, and focus is not moved into the menu on open.
- **Why it matters:** WAI-ARIA Authoring Practices for the `menu` pattern
  expect arrow-key roving focus; declaring `role="menu"` without it sets an AT
  expectation the widget doesn't fulfill. WCAG 2.1.1 (Keyboard) is technically
  met (items are Tab-reachable links/buttons), so this is medium, not high.
- **Recommendation:** Either implement roving tabindex + arrow keys, or
  downgrade to a plain non-`menu` popover (`role` removed) so AT doesn't
  promise menu semantics.

### M5. No skip-to-content link in the authenticated shell
- **file:line:** `frontend/src/features/layout/AppShell.tsx:120-289`
- **Evidence:** The shell renders `<header role="banner">` then a primary
  `<nav>` then `<main className="flex-1">` (line 287), but there is no
  "Skip to main content" link as the first focusable element, and `<main>` has
  no `id`/`tabIndex` target.
- **Why it matters:** WCAG 2.4.1 (Bypass Blocks). Keyboard users must Tab
  through the entire header nav on every page load. (Public `AuthLayout` and
  `LandingPage` have the same omission, but the repeated-nav burden is heaviest
  in the app shell.)
- **Recommendation:** Add a visually-hidden-until-focused
  `<a href="#main-content">Skip to content</a>` as the first child, and give
  `<main id="main-content" tabIndex={-1}>`.

---

## LOW

### L1. Modals do not autofocus their first field on open (partial)
- **file:line:** `frontend/src/features/layout/OrgDashboardPage.tsx:196-204`
- **Evidence:** The feedback `<textarea>` has a ref and is focused only on the
  *empty-submit* error path (line 75), not on dialog open. (Contrast
  `PasswordReauthModal.tsx:84` and `InviteCreateModal.tsx:151`, which do use
  `autoFocus`.) Once H1's focus trap lands this becomes moot, but today the
  feedback dialog opens with focus left on the page behind it.
- **Recommendation:** Focus the textarea on open (folded into the H1 fix).

### L2. Untranslated parenthetical in unsaved-edits counter
- **file:line:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:258`
- **Evidence:** `{editedRowCount > 1 ? \` (${editedRowCount} rows)\` : ""}` —
  the literal " rows)" is not wrapped in `t()` at all (and interpolates a
  count, compounding M1). Adjacent strings (lines 252, 257) do use `t()`.
- **Recommendation:** Move into a single placeholder-token translatable string.

### L3. Low-contrast metadata badge on landing roadmap
- **file:line:** `frontend/src/features/landing/LandingPage.tsx:224`
- **Evidence:** `future: "bg-slate-100 text-slate-500"` for the phase badge —
  `text-slate-500` (#64748b) on `bg-slate-100` (#f1f5f9) is ~3.0:1, below the
  4.5:1 AA threshold for the small uppercase label text it carries (line 237).
- **Why it matters:** WCAG 1.4.3 (Contrast Minimum). Low severity because it's
  decorative roadmap metadata, not load-bearing.
- **Recommendation:** Use `text-slate-600` (~4.6:1) or darker for this badge.

### L4. Format-example placeholders not wrapped in `t()`
- **file:line:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:124`
  (`placeholder="01HF..."`), `frontend/src/features/orgs/OrgBrandingPage.tsx:235`
  (`placeholder="https://"`)
- **Why it matters:** Borderline — these are format hints, not prose, but
  strictly invariant #13 says every user-visible string. Very low priority.
- **Recommendation:** Wrap in `t()` for consistency, or accept as format
  literals and document the carve-out.

---

## INFO / verified-good (no action)

- `frontend/index.html:2` — `<html lang="en">` present (WCAG 3.1.1 met).
- The QR `<img>` has a translated `alt`
  (`frontend/src/features/auth/TwoFactorEnrollPage.tsx:104`); it is the only
  `<img>` in the app. No missing-alt findings.
- `GrantCell` (`frontend/src/features/permissions/GrantCell.tsx`) is exemplary:
  `role="switch"`, `aria-checked`, composed `aria-label`, Space/Enter handler,
  visible focus ring. Use as the keyboard/aria reference for M4.
- `PreviewTile`, `DashboardCard`, `RoleBadge`, `Avatar`,
  `ConflictOfInterestBanner` all carry correct `aria-hidden` on decorative
  icons and real labels on interactive/role elements.
- Loading/empty/error states consistently use `role="status"`/`role="alert"` +
  `aria-live` + `sr-only` text (e.g. `MemberDirectoryPage.tsx:184-186`,
  `OrgSettingsPage.tsx:115-123`).
- Form inputs are consistently associated via `<Label htmlFor>` + matching
  `id`, with `aria-invalid` and `role="alert"` error text.

---

## Gaps

1. **No focus-trap utility / dialog library.** The single highest-leverage fix
   (H1, H2, M4, L1 all collapse into it) is adopting `@radix-ui/react-dialog`
   (already anticipated in `dialog.tsx:7-8`) or writing one shared focus-trap
   hook. Blocking for WCAG 2.1 AA sign-off on any modal/drawer surface.
2. **No centralized role-label localization.** M2 spans 5 files; there is no
   single `roleLabel(role)` helper exported for non-badge contexts (the labels
   live privately inside `RoleBadge.tsx`). Export one.
3. **No `t()` placeholder/interpolation convention.** M1 spans 13 call sites
   with three different ad-hoc interpolation styles. The project needs a
   documented pattern (ICU message format or `{token}` replace) *before* the
   real i18n backend is wired, or the migration will be a large rewrite.
4. **No automated i18n/a11y lint or test gate.** Nothing enforces invariant
   #13: no `eslint-plugin-jsx-a11y`, no `eslint-plugin-i18next`
   (`no-literal-string`), no axe/jest-axe in the vitest setup
   (`frontend/src/test/setup.ts`). A lint rule would have caught M1/M3/L2/L4
   mechanically.
5. **No skip-link / landmark-target convention** across the three shells
   (`AppShell`, `AuthLayout`, `LandingPage`/`AboutPage`). M5 is the app-shell
   instance; the public shells share it.
6. **`prefers-reduced-motion` not yet considered.** The product brief calls for
   framer-motion in the UI overhaul; no reduced-motion handling exists yet.
   Not a current defect (no animations of consequence ship today) but should be
   designed in before the motion work lands (WCAG 2.3.3).
