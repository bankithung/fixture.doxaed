# Subsystem analysis — Frontend · Design System + Shared Types

_Repo: `/home/ubuntu/Fixture`. Scope: `frontend/src/components/ui/*`, `frontend/src/index.css`, `frontend/tailwind.config.js`, `frontend/src/types/*`, `frontend/CONTRACT.md`, plus the `lib/` helpers the primitives depend on. Read against the test suites in `components/ui/__tests__/` and `types/__tests__/`. Date: 2026-06-08._

## Purpose

This subsystem is the visual + type foundation the rest of the SPA builds on. It supplies (a) a **token system** — light/dark CSS custom properties in `index.css` surfaced to Tailwind as semantic color names in `tailwind.config.js`; (b) a small set of **headless-ish component primitives** (`Button`, `Input`, `Select`, `Dialog`, toast, `Card`, `PasswordInput`, plus domain-flavored `Avatar`/`RoleBadge`/`DashboardCard`/`PreviewTile`); and (c) the **shared type layer** that pins frontend shapes to the backend contract (`api.generated.ts` from `drf-spectacular` → `openapi-typescript`, re-exported through `generated.ts`, with hand-written domain types in `user.ts`/`api.ts`). The deliberate design intent (per CLAUDE.md "Frontend design system" and CONTRACT.md) is **one consistent dropdown/dialog/toast language**, **tokens-only color**, and **backend-driven types** so serializer drift becomes a `tsc` failure.

## File-by-file roles

**Tokens / config**
- `frontend/src/index.css` — the source of truth for color. `:root` defines ~30 HSL-triplet CSS vars (surfaces, primary/accent, secondary, status: success/destructive/warning/info each with `*-muted`, border/input/ring, `--radius` = `0.625rem`, and back-compat `--brand*`). `.dark` re-declares the same names with dark values. Also: global `* { @apply border-border }`, body font stack (Inter + `font-feature-settings: "cv11","ss01"`), a global `:focus-visible` ring (WCAG AA), a `.font-tabular` utility, and a `prefers-reduced-motion` safety net.
- `frontend/tailwind.config.js` — `darkMode: ["class"]`; maps each CSS var to a Tailwind semantic color via `hsl(var(--x))`; defines the `borderRadius` scale off `--radius` (`xl`=+4px … `sm`=−4px), a custom `fontSize` ramp (`display`/`h1`/`h2`/`h3`/`body`/`caption`/`overline`), `boxShadow` xs–lg, `transitionDuration`/`timingFunction`, and keyframes/animations (`fade-in`, `fade-up`, `scale-in`, `shimmer`). Extra colors: `grant`/`deny`/`warn` (legacy module-matrix swatches) and `brand` (auth/landing back-compat). `plugins: []`.

**Primitives (`components/ui/`)**
- `button.tsx` — `cva`-based variant system: variants `default|destructive|outline|secondary|ghost|link`, sizes `default|sm|lg|icon`; `forwardRef`; defaults `type="button"`. Exports `buttonVariants` for non-button callsites.
- `input.tsx` — thin `forwardRef` input, h-10, `border-input bg-background`, focus ring; `type="text"` default.
- `label.tsx` — `forwardRef` label with `peer-disabled` styling.
- `card.tsx` — `Card`/`CardHeader`/`CardTitle`(h3)/`CardDescription`/`CardContent`/`CardFooter`, all `forwardRef`.
- `Select.tsx` — **custom accessible single-select** replacing native `<select>` (the most logic-heavy primitive; see below).
- `dialog.tsx` — minimal modal (`Dialog` + `DialogHeader/Title/Description/Footer/CloseButton`); deliberately no Radix (comment: "Replace with @radix-ui/dialog when shadcn primitives are formally adopted").
- `toast.tsx` — `ToastProvider` context + `ToastViewport` + `useToast()` hook; replaces `window.alert`.
- `PasswordInput.tsx` — wraps `Input`, adds an eye/eye-off visibility toggle (`tabIndex={-1}`), forwards ref for react-hook-form `register`.
- `Avatar.tsx` — deterministic initials avatar; exports `colourForEmail`, `initialsFor`.
- `RoleBadge.tsx` — role chip with a per-role palette + gold owner treatment; exports `RoleKey`, `ROLE_KEYS`, `SelectableRoleKey`.
- `DashboardCard.tsx` — composite over `Card`; renders `<Link>`/`<button>`/disabled `<div>` polymorphically.
- `PreviewTile.tsx` — non-interactive "coming in Phase 1B" teaser tile.

**Types (`types/`)**
- `api.generated.ts` — machine-generated (`openapi-typescript`); `paths` (43 endpoints), `components.schemas` (48 schemas), `operations`. **Never hand-edit.**
- `generated.ts` — ergonomic re-exports: `Schemas`, `ApiUser`(=`Me`), `ApiOrganization`, `ApiMembership`, `ApiModule`, `ApiRole`, `ApiGrantState`, auth/invite/lifecycle aliases.
- `user.ts` — hand-written domain types (`User`, `OrgMembership`, `Role`, `ModuleDef`, `GrantState`, `ModuleMatrixRow/Response`, `OrgInvitation`); `Role` is re-exported from the schema (`Schemas["RoleEnum"]`).
- `api.ts` — runtime `ApiError` class + `ApiErrorPayload`/`Paginated<T>`. `ApiError` exposes `isPasswordReauthRequired` and `isUnauthenticated` getters.

**Supporting `lib/` (outgoing deps of the primitives)**
- `lib/tailwind.ts` — `cn()` = `twMerge(clsx(...))`.
- `lib/t.ts` — `t = (s) => s` i18n placeholder (invariant #13; single future swap point).
- `lib/useBreakpoint.ts` — `useSyncExternalStore`-backed global screen detector (`useBreakpoint()`, `useScreenWidth()`); breakpoints mirror Tailwind defaults; `isMobile = width < 768`.

## Data model (types)

The wire contract is owned by backend DRF serializers; `drf-spectacular` emits `backend/schema.yml`, `openapi-typescript` emits `api.generated.ts`. Key schemas: `Me` (id, email, name, is_superuser, has_2fa_enrolled, twofa/email timestamps, `last_active_org_id/slug`, **`memberships: MembershipSummary[]`**, deleted_at), `MembershipSummary` (org_id/slug/name, `roles: string[]`, is_org_owner, effective_modules), `Organization`, `OrganizationMembership`, `Module`, `MatrixResponse`/`MatrixModule`/`MatrixMember`, `RoleEnum`/`StateEnum`, the auth flows, invitations, lifecycle ops, and `Sport`. Hand-written `user.ts` mirrors these but adds client-only extras (e.g. `OrgMembership.active_role`, `ModuleMatrixRow.cells/role_defaults`). `ROLE_KEYS` (RoleBadge) is a literal 6-tuple (catalog minus `owner`) used as the canonical selectable-role set in invite forms.

## Core algorithms / services (file:function, step-by-step)

**`Select.tsx::Select`** — the only non-trivial component.
1. State: `open`, `active` (highlighted index), `ref` (root div), `listId` (`useId`), `selected = options.find(value)`.
2. `useEffect([open,options,value])`: when opening, seeds `active` to the selected option's index (clamped ≥0); registers a `mousedown` document listener that closes on outside click; cleans up on unmount/close.
3. `onKeyDown`: closed → Enter/Space/ArrowDown opens; open → Escape closes, ArrowUp/Down move `active` (clamped), Enter/Space choose `options[active]`. `e.preventDefault()` on the nav keys.
4. `choose(v)` → `onChange(v)` + close.
5. Render: a `<button aria-haspopup="listbox" aria-expanded aria-controls aria-label>` trigger; when open, a `<ul role="listbox">` of `<li role="option" aria-selected>` rows, `bg-accent` on the active row, a `Check` on the selected value. Click on a row chooses; mouse-enter sets `active`.

**`Avatar.tsx::colourForEmail`** — djb2-style hash (`h = ((h<<5)+h+char)|0`) over lowercased email → `Math.abs(h) % 12` → fixed `PALETTE` HSL string. Deterministic across renders.

**`Avatar.tsx::initialsFor`** — priority cascade (documented as DEFECT-K fix): (1) multi-word name → first-of-first + first-of-last; (2) single-word name → first 2 chars; (3) no name → email local-part: multi-segment (split on `._-`) → first+first, single-segment → **first char + last char** (so `coord`→`CD`, `coorg`→`CG`, disambiguating what previously both collapsed to `CO`); single char → that char; empty → `?`. All upper-cased. Locked by `Avatar.test.tsx`.

**`RoleBadge.tsx::paletteFor` + `RoleBadge`** — looks up a `PALETTE` entry per `RoleKey`; unknown roles → `NEUTRAL` slate chip with a `prettify()`-ed label; `owner` (or forced `isOwner`) → amber/gold ring + `Crown` icon. Emits `data-role`/`data-owner` test hooks. `prettify` replaces `_-` with spaces + title-cases.

**`toast.tsx::ToastProvider`** — `push()` mints an id (`crypto.randomUUID()` with a `Math.random` fallback), appends, and schedules `dismiss` via `setTimeout(ttl)` (default 5000ms; `0`/undefined = sticky). `useToast` throws if used outside the provider. Viewport renders error toasts as `role="alert"`, others as `role="status"`.

**`ApiError` (api.ts)** — `isPasswordReauthRequired` (403 + `password_reauth_required` in detail/code) and `isUnauthenticated` (401, or 403 whose detail mentions "authentication credentials"/"not authenticated") drive the auth-redirect / step-up logic in the data layer.

## API / exported surface

This is a leaf/utility subsystem — it exports a component+type API, not HTTP endpoints. Public surface: `Button`/`buttonVariants`/`ButtonProps`; `Input`/`InputProps`; `Label`; `Card*`; `Select`/`SelectOption`/`SelectProps`; `Dialog*`; `ToastProvider`/`useToast`/`ToastMessage`/`ToastKind`; `PasswordInput`/`PasswordInputProps`; `Avatar`/`colourForEmail`/`initialsFor`/`AvatarProps`; `RoleBadge`/`RoleKey`/`ROLE_KEYS`/`SelectableRoleKey`; `DashboardCard`/`DashboardCardProps`; `PreviewTile`/`PreviewTileProps`; and from types: all `Api*` aliases (`generated.ts`), `User`/`OrgMembership`/`Role`/grant + matrix types (`user.ts`), `ApiError`/`Paginated` (`api.ts`). The **schema-derived endpoint catalog** lives in `api.generated.ts::paths` (43 paths) but is consumed by the `src/api/*` data layer, not this subsystem.

## Invariants that must be preserved

1. **Tokens-only color.** No hardcoded hex / raw palette in primitives; use semantic tokens (`bg-card`, `text-muted-foreground`, `bg-primary`, etc.). Both light + `.dark` must define every token (`* { @apply border-border }` will break if `--border` is dropped). (Exception by-design: `RoleBadge` uses raw Tailwind palette chips; `Avatar` uses inline HSL.)
2. **`.dark` is class-driven** (`document.documentElement.classList.toggle("dark")` in `features/theme/themeStore.ts`); `darkMode: ["class"]` must stay aligned with that mechanism.
3. **No native `<select>` / `window.alert|confirm|prompt`.** Use `ui/Select`, `ui/dialog`, `ui/toast`. (One native `<select>` still leaks — see smells.)
4. **`t()` wraps every user-visible string** (invariant #13). Primitives already do (`PasswordInput`, `RoleBadge`, `PreviewTile`, `DialogCloseButton`).
5. **WCAG AA a11y:** the global `:focus-visible` ring; `Select` is a real ARIA listbox with keyboard nav; `Dialog` is `role="dialog" aria-modal` with Escape; toasts use `role="status|alert"`; icons are `aria-hidden`; `Avatar` is `role="img"` with a label.
6. **`font-tabular` for all numbers** (59 callsites depend on the utility existing).
7. **`api.generated.ts` is machine-owned** — never hand-edit; regenerate via `npm run gen:types`. The contract round-trip (serializer → schema.yml → api.generated.ts → tsc) is the anti-drift guarantee; `types/__tests__/generated-types.test.ts` is the compile-time tripwire.
8. **`crypto.randomUUID()` ids** for idempotent client `event_id`s (the toast fallback pattern; mirrors backend idempotency invariant #3).

## Dependencies / coupling

**Outgoing (this subsystem → others):** `lib/tailwind.cn`, `lib/t.t`, `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react` (v1.14 — icons), `react-router-dom` (DashboardCard `<Link>`), and `react` 19. `user.ts`/`generated.ts` depend on `api.generated.ts`. No backend HTTP coupling here directly; the type layer couples (by contract) to `backend/schema.yml`.

**Incoming (high — this is a hub):** `ui/button` imported by ~39 files, `useToast` by ~16, `ui/Select` by ~16, `ui/dialog` by ~11. Tokens are referenced app-wide via Tailwind classes. Theme is driven externally by `features/theme/*` (`ThemeProvider`, `themeStore`, `ThemeToggle`). Because of this fan-out, any rename of a token, a `*Props` shape, or a `cva` variant is a wide blast radius — `get_impact_radius` on these symbols is warranted before restructuring.

## Tech debt / smells / duplication

- **Primitive vs. feature token divergence (highest-value cleanup).** `Button` default variant uses `hover:bg-primary/90`, but the design system defines a dedicated `--primary-hover` token, and ~7 feature files hand-roll `hover:bg-primary-hover` button markup instead of using `<Button>`. So there are effectively two "primary button" implementations with two different hover colors. Same drift for `VerifyEmailPage` (`hover:bg-primary/90`).
- **Radius inconsistency.** `Select` trigger/list use `rounded-lg`; `Input`/`Button` use `rounded-md`. A `Select` next to an `Input` won't share a corner radius.
- **Toast success uses legacy tokens.** `toast.tsx` success variant = `border-grant bg-grant-muted` (the legacy module-matrix swatch), while error uses the semantic `border-destructive`. The proper `--success`/`--success-muted` tokens exist but are unused by the toast. Mixed token vocabularies.
- **Stale tooling comments.** `index.css` references "framer-motion components additionally read `useReducedMotion()`" — **framer-motion is not a dependency and not imported anywhere** in `src`. `tailwind.config.js` says `tailwindcss-animate added in M3` but `plugins: []` and the package isn't installed; the `animate-*` utilities come from the inline `keyframes`/`animation` config instead (used in only ~2 places, incl. `Select`'s `animate-fade-in`).
- **Stale contract docs.** `CONTRACT.md` "Known deferral" (and `user.ts`/`generated.ts` header comments) claim `MeSerializer` does **not** expose `memberships[]`/`is_superuser`/`last_active_org_slug` — but the current `api.generated.ts` `Me` schema **does** expose all three (plus a real `MembershipSummary`). The migration described as pending is largely already possible; the hand-written `User`/`OrgMembership` now duplicate the generated `Me`/`MembershipSummary` (only `active_role?` is genuinely client-only).
- **`Select` a11y gap.** No `aria-activedescendant` linking the trigger to the highlighted `<li>` (each option has no stable id), and no type-ahead. It's a listbox-on-a-button pattern (popup not owned via `aria-owns` on focus). Functional and keyboard-navigable, but not a textbook combobox.
- **One native `<select>` survives** at `features/orgs/OrgSettingsPage.tsx:300` — violates invariant #3.
- **`DialogCloseButton` / toast dismiss use a literal `x` glyph** instead of an `X` icon from lucide (visual debt; the close has no real icon).
- **Dialog lacks focus-trap / initial-focus / focus-restore** — Escape + backdrop click only. Not fully modal per WCAG.
- **No barrel/index** for `components/ui` — every consumer deep-imports `@/components/ui/<file>`, and casing is mixed (`button.tsx`/`card.tsx` lowercase vs `Select.tsx`/`Avatar.tsx` PascalCase), which is a case-sensitivity hazard on Linux CI.
- **`lucide-react@^1.14.0`** is an unusually low major for lucide; worth verifying it's the intended package/version during restructuring.

## Restructuring seams & risks

- **Cleanest seam: the token layer.** All color flows through `index.css` vars → `tailwind.config.js` semantic names → class strings. Re-theming or consolidating tokens is low-risk *if* names are preserved; renaming a token requires a repo-wide class sweep (high blast radius). First cleanup: retire `grant/deny/warn`/`brand` legacy swatches into the semantic `success/destructive/warning`/`primary` tokens and update the ~6 callsites.
- **Unify the primary button.** Make `Button` default use `hover:bg-primary-hover` and migrate the ~7 hand-rolled feature buttons to `<Button>`. This both fixes the color drift and shrinks duplication. Risk: subtle visual diffs (size/padding) at migrated callsites — needs visual QA.
- **`Select` → combobox upgrade or Radix adoption.** The Dialog and Select both carry explicit "replace with Radix when shadcn primitives are adopted" intent. Swapping to Radix (`@radix-ui/react-select`, `react-dialog`) behind the same `SelectProps`/`DialogProps` surface is a contained refactor; risk is the keyboard/ARIA test (`Select.test.tsx`) and the 16 callsites' prop shapes. Keep `SelectOption`/`onChange(value)` stable to avoid touching consumers.
- **Type-layer convergence.** The safest single win: regenerate types, then replace hand-written `User`/`OrgMembership` with `ApiUser`/`MembershipSummary` (adding only the `active_role?` client field via an intersection), and rewrite the now-stale `CONTRACT.md`/comments. Risk: callsites relying on `Role[]` vs `string[]` (`MembershipSummary.roles` is `string[]`; hand-written is `Role[]`) — a `tsc` pass will surface them.
- **Add a `components/ui/index.ts` barrel + normalize file casing** before any large move, to make the rest of the restructuring import-stable and avoid Linux case bugs.
- **Risk hotspots for the broader restructuring:** because `Button`/`useToast`/`Select`/`Dialog` fan out to 11–39 files each and tokens are global, treat this subsystem as **API-frozen during restructuring** — change implementations behind the existing exported signatures, and run `npm run type-check` + the `components/ui/__tests__` + `types/__tests__` suites (part of the ~193 frontend tests) as the gate after every change.

## Ambiguities / things I could not fully confirm

- Whether `lucide-react@^1.14.0` is correct vs. a newer lucide major is unverified beyond `package.json`; it imports fine in the tested components.
- I did not exhaustively audit every feature file for token violations beyond the targeted greps; the `emerald/slate` raw-palette hits (~30) are dominated by the by-design `RoleBadge` chips and `Avatar`, but a small number may be genuine violations elsewhere (not in this subsystem's files).
