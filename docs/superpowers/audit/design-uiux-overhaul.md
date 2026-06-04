# Deep Design — Professional SaaS UI/UX Overhaul

Status: DESIGN (implementation-ready). Date: 2026-06-04. Author: deep-design (uiux lens).
Scope: `frontend/` only. Phase 1A surfaces exist and pass build/tests (162 vitest tests green per `docs/superpowers/audit/cross-run-frontend.md`). This overhaul restyles them and adds a token + motion + theming layer **without breaking the existing test contracts** (the many `data-testid`, `role`, and `aria-label` selectors that tests depend on).

This is a *chassis* overhaul: it lands the design-token system, dark mode, a real shadcn/ui primitive set, lucide conventions, framer-motion patterns, and polished loading/empty/error states — then restyles five high-payoff screens. Confidence on the existing-code citations: HIGH (every file was read in full). Confidence on the precise HSL token values: MEDIUM (tuned for WCAG AA but must be verified with the `contrast-check` skill before merge — see §11 tests).

---

## 0. What exists today (evidence-cited baseline)

The frontend already has a *partial* shadcn-style foundation. The overhaul builds on it rather than replacing it.

- **CSS variables already define light + dark themes** but dark mode is never activated:
  - `frontend/src/index.css:6-43` — `:root` light tokens (`--background`, `--foreground`, `--primary`, `--radius: 0.5rem`, plus brand tokens `--brand: 160 84% 30%` "emerald", `--brand-ink: 222 47% 11%` "slate", `--brand-muted`, `--brand-fg`).
  - `frontend/src/index.css:45-65` — `.dark { ... }` block fully specified.
  - **Gap:** no code ever adds the `.dark` class to `<html>`. Confirmed: `grep dark` matches only `index.css`, `tailwind.config` (`darkMode: ["class"]`), `ModuleMatrixPage`, and one test. There is **no ThemeProvider, no toggle, no `prefers-color-scheme` read.** Dark mode is dead infrastructure.
- **Tailwind config** (`frontend/tailwind.config.ts`): maps the CSS vars to color utilities; adds domain swatches `grant` (`142 71% 45%`), `deny` (`0 72% 51%`), `warn` (`38 92% 50%`) each with a `.muted`; adds `brand` (`emerald 160 84% 30%` / `ink 222 47% 11%`). `borderRadius` derived from `--radius`. **No animation/keyframe extensions, no typography/shadow scale, no `tailwindcss-animate` plugin** (`plugins: []`).
- **Primitives present** in `frontend/src/components/ui/`: `button.tsx` (cva, 6 variants, 4 sizes), `card.tsx` (Card/Header/Title/Content/Footer/Description), `input.tsx`, `label.tsx`, `dialog.tsx` (hand-rolled, NOT Radix — comment at `dialog.tsx:6-9` says "Replace with @radix-ui/dialog when shadcn primitives are formally adopted"), `toast.tsx` (context-based, bottom-right viewport).
- **Custom composites present**: `Avatar.tsx` (deterministic hashed color, 12-hue palette, `initialsFor()` logic), `RoleBadge.tsx` (7-role palette + gold owner crown, `ROLE_KEYS`), `DashboardCard.tsx` (Link/button/div tri-mode), `PreviewTile.tsx` (Phase 1B teaser).
- **Primitives MISSING** (hand-rolled inline across screens, ripe for extraction): Badge, Skeleton, Spinner, EmptyState, Table, DropdownMenu/Menu, Tooltip, Textarea, Select, Switch, Tabs, Separator, Alert, Breadcrumb, PageHeader.
- **lucide-react** `^1.14.0` is installed and used (`Trophy`, `Calendar`, `Users`, `Activity`, `Shield`, `Sparkles`, `Crown`, `Bell`, `ChevronDown`, `Menu`, `UserRound`, `X`, `Search`, `UserMinus`, `UserPlus`, `MoreVertical`, `CheckCircle2`, `XCircle`, `Compass`, `AlertTriangle`). Icons consistently get `aria-hidden="true"` and `className="h-N w-N"` — a good convention already in place.
- **framer-motion: NOT installed** (confirmed absent from `package.json`). Zero animation beyond Tailwind `transition-colors` / `animate-pulse`.
- **i18n**: `frontend/src/lib/t.ts` is an identity `t()` passthrough; invariant #13 requires every visible string wrapped. Existing code complies.
- **a11y**: focus-visible ring is global (`index.css:78-80`); dialogs/menus already do Escape + click-outside; tables have `aria-label`; skeletons use `role="status" aria-live="polite"`. Good baseline to preserve.
- **Brand color is applied two inconsistent ways today**: (a) raw Tailwind palette classes `bg-emerald-700 hover:bg-emerald-800` hard-coded on buttons (`LandingPage.tsx:68,104`, `LoginPage`, `NotFoundPage:39`, `ErrorPage:56`), and (b) the token `--brand`/`brand` color. **This is the core inconsistency the overhaul fixes**: brand becomes a first-class semantic token so a single change re-themes every CTA, and dark mode works automatically.

### Toolchain caveat that constrains the design (must-read)
`cross-run-frontend.md` F1a documents that `eslint-plugin-react-hooks@7` flags `react-refresh/only-export-components` for files that export non-components (e.g. `buttonVariants`, `ROLE_KEYS`). **Therefore: new primitive files must put shared `cva` variant objects / constants in sibling `*.variants.ts` files** (e.g. `badge.variants.ts`), not co-located, OR the lint rule must be relaxed. This design assumes the sibling-file convention to keep `npm run lint` green.

---

## 1. Design principles (the "why")

1. **Token-first, never raw palette.** No component hard-codes `emerald-700`. Everything routes through semantic CSS variables → Tailwind utilities. One file (`index.css`) re-themes the whole app and gives dark mode for free.
2. **Preserve the test contract.** Every `data-testid`, `role`, `aria-label`, and visible English string that current tests assert on stays identical. Restyling changes classes, not selectors. (Tests enumerated in §11.)
3. **Motion is meaning, and optional.** All framer-motion is wrapped so `prefers-reduced-motion` collapses it to instant. Animations communicate state change (enter/exit/loading) — never decorate idle UI.
4. **Calm, professional, Nagaland-emerald.** Emerald primary + slate ink + generous whitespace + soft shadows. Not a flashy consumer app; a credible admin SaaS (think Linear/Vercel/Stripe restraint).
5. **AA everywhere non-scorer; AAA where cheap.** WCAG 2.1 AA is the floor (invariant #13). Scorer/referee UIs (Phase 1B) get a denser, high-contrast variant later.
6. **Progressive, low-risk rollout.** Land tokens + primitives first (no visual regressions if done right), then restyle screens one PR at a time, each independently shippable and testable.

---

## 2. Design-token system

All tokens live in `frontend/src/index.css` under `@layer base` and are surfaced to Tailwind via `tailwind.config.ts`. Tokens are HSL channel triples (shadcn convention: `H S% L%`, no `hsl()` wrapper) so Tailwind can apply opacity modifiers (`bg-primary/90`).

### 2.1 Color — semantic roles (light + dark)

Keep the existing shadcn names; **re-point `--primary` to emerald** so the app's primary CTA is the brand (today `--primary` is slate `222 47% 11%`, and brand is bolted on separately — the source of the inconsistency in §0). Slate becomes `--foreground`/`--ink` for text and headers.

```css
/* index.css — :root (LIGHT) */
:root {
  /* Surfaces */
  --background:        0 0% 100%;       /* page */
  --foreground:        222 47% 11%;     /* slate-900 ink — body text */
  --card:              0 0% 100%;
  --card-foreground:   222 47% 11%;
  --popover:           0 0% 100%;
  --popover-foreground:222 47% 11%;
  --muted:             210 40% 96%;     /* subtle fills, skeletons */
  --muted-foreground:  215 16% 42%;     /* secondary text (darkened from 46.9% for AA on muted) */

  /* Brand = primary (Nagaland emerald) */
  --primary:           160 84% 30%;     /* emerald-700; was slate */
  --primary-foreground:0 0% 100%;
  --primary-hover:     160 84% 26%;     /* emerald-800 — replaces hard-coded hover:bg-emerald-800 */
  --accent:            160 60% 94%;     /* emerald wash for hovers/selected */
  --accent-foreground: 160 84% 22%;

  /* Secondary (neutral chrome) */
  --secondary:         210 40% 96%;
  --secondary-foreground:222 47% 11%;

  /* Status (re-export existing grant/deny/warn so one source of truth) */
  --success:           142 71% 40%;     /* aligns with grant; darkened for AA text */
  --success-foreground:0 0% 100%;
  --success-muted:     142 50% 94%;
  --destructive:       0 72% 48%;       /* aligns with deny; AA on white */
  --destructive-foreground:0 0% 100%;
  --destructive-muted: 0 60% 96%;
  --warning:           38 92% 42%;      /* darkened amber for AA text */
  --warning-foreground:38 95% 12%;
  --warning-muted:     38 92% 94%;
  --info:              215 70% 45%;
  --info-foreground:   0 0% 100%;
  --info-muted:        215 60% 95%;

  /* Lines + focus */
  --border:            214 32% 91%;
  --input:             214 32% 91%;
  --ring:              160 84% 30%;     /* emerald focus ring (was slate) */

  --radius:            0.625rem;        /* 10px — slightly softer than 0.5rem */
}
```

```css
/* index.css — .dark */
.dark {
  --background:        222 47% 7%;      /* near-black slate */
  --foreground:        210 40% 96%;
  --card:              222 40% 11%;     /* lifted surface vs background */
  --card-foreground:   210 40% 96%;
  --popover:           222 40% 11%;
  --popover-foreground:210 40% 96%;
  --muted:             217 33% 17%;
  --muted-foreground:  215 20% 68%;

  --primary:           158 64% 52%;     /* brighter emerald for dark bg contrast */
  --primary-foreground:222 47% 9%;
  --primary-hover:     158 64% 58%;
  --accent:            158 40% 18%;
  --accent-foreground: 158 64% 70%;

  --secondary:         217 33% 17%;
  --secondary-foreground:210 40% 96%;

  --success:           142 60% 48%; --success-foreground:222 47% 9%; --success-muted:142 30% 16%;
  --destructive:       0 63% 50%;   --destructive-foreground:0 0% 100%; --destructive-muted:0 40% 16%;
  --warning:           38 90% 55%;  --warning-foreground:38 95% 10%;   --warning-muted:38 50% 16%;
  --info:              215 70% 60%; --info-foreground:222 47% 9%;      --info-muted:215 40% 18%;

  --border:            217 33% 20%;
  --input:             217 33% 22%;
  --ring:              158 64% 52%;
}
```

Notes:
- **Owner gold** (`amber-400` ring on `RoleBadge`) and the **12-hue Avatar palette** stay as literal HSLs — they are deterministic identity colors, not theme colors. But add dark-mode-aware lightness later if avatars look muddy on dark (low priority).
- The `grant`/`deny`/`warn` Tailwind colors in `tailwind.config.ts` are **kept** (the `GrantCell` and `toast` depend on them), but their canonical values now mirror `--success`/`--destructive`/`--warning` so there is one mental model. `GrantCell.tsx:52-59` continues to work unchanged.

### 2.2 Typography scale

System font stack stays (`index.css:75` — fast, no web-font payload), but add an explicit type scale via Tailwind `fontSize` extensions so screens stop ad-hoc-ing `text-2xl`/`text-[10px]`.

```ts
// tailwind.config.ts → theme.extend.fontSize (rem / line-height / letter-spacing)
fontSize: {
  "display": ["2.5rem", { lineHeight: "1.1",  letterSpacing: "-0.02em", fontWeight: "600" }], // hero h1
  "h1":      ["1.875rem",{ lineHeight: "1.2",  letterSpacing: "-0.015em", fontWeight: "600" }],// page titles
  "h2":      ["1.5rem",  { lineHeight: "1.25", letterSpacing: "-0.01em" }],
  "h3":      ["1.25rem", { lineHeight: "1.3" }],
  "body":    ["0.875rem",{ lineHeight: "1.5" }],   // default 14px
  "body-lg": ["1rem",    { lineHeight: "1.55" }],
  "caption": ["0.75rem", { lineHeight: "1.4" }],   // 12px secondary
  "overline":["0.6875rem",{ lineHeight: "1.3", letterSpacing: "0.08em", textTransform: "uppercase" }],
}
```
Weights used: 400 body, 500 medium (labels/nav), 600 semibold (headings/CTAs). No 700+ except numeric scoreboards (Phase 1B). A `font-tabular` utility (`font-variant-numeric: tabular-nums`) is added for tables/score columns.

### 2.3 Spacing, radius, shadow, z-index

- **Spacing**: stick to Tailwind's 4px base scale; codify page rhythm: page padding `p-6` (24px), section gap `gap-6`, card padding `p-6`, control gap `gap-4`, inline gap `gap-2`. Add a `max-w-6xl mx-auto` content container helper (landing already uses it; standardize for app pages too via a `PageContainer`).
- **Radius**: `--radius: 0.625rem`; `lg = var(--radius)`, `md = calc(var(--radius)-2px)`, `sm = calc(var(--radius)-4px)`, plus add `xl = calc(var(--radius)+4px)` for hero/auth cards and `full` for pills/avatars.
- **Shadow** (new, token-driven, dark-aware): add to `tailwind.config.ts → boxShadow`:
  ```ts
  boxShadow: {
    xs:  "0 1px 2px 0 hsl(222 47% 11% / 0.05)",
    sm:  "0 1px 3px 0 hsl(222 47% 11% / 0.08), 0 1px 2px -1px hsl(222 47% 11% / 0.06)",
    md:  "0 4px 12px -2px hsl(222 47% 11% / 0.10), 0 2px 6px -2px hsl(222 47% 11% / 0.06)",
    lg:  "0 12px 28px -6px hsl(222 47% 11% / 0.14)",
    "focus":"0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring))", // for non-ring focus cases
  }
  ```
  In dark mode shadows are nearly invisible; depth there comes from the `--card` being lighter than `--background` plus a hairline `--border`. (No per-mode shadow swap needed — keep it simple.)
- **Z-index scale** (stop magic numbers — current code uses `z-10/20/30/40/50` inconsistently): `--z-dropdown: 30`, `--z-sticky: 20`, `--z-drawer: 40`, `--z-modal: 50`, `--z-toast: 60`, `--z-tooltip: 70`. Toasts currently `z-50` collide with dialogs `z-50` — bump toasts to `z-60` so a toast fired from inside a modal is visible.

### 2.4 Motion tokens

```ts
// tailwind.config.ts → theme.extend
transitionDuration: { fast: "120ms", base: "180ms", slow: "280ms" },
transitionTimingFunction: { "out-quad": "cubic-bezier(0.25,0.46,0.45,0.94)" },
keyframes: {
  "fade-in":   { from: { opacity: "0" }, to: { opacity: "1" } },
  "fade-up":   { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "translateY(0)" } },
  "scale-in":  { from: { opacity: "0", transform: "scale(0.96)" }, to: { opacity: "1", transform: "scale(1)" } },
  "shimmer":   { "100%": { transform: "translateX(100%)" } }, // skeleton sheen
},
animation: {
  "fade-in":  "fade-in var(--dur, 180ms) ease-out both",
  "fade-up":  "fade-up 200ms ease-out both",
  "scale-in": "scale-in 150ms ease-out both",
  "shimmer":  "shimmer 1.6s infinite",
},
```
Add `tailwindcss-animate` to `devDependencies` and `plugins: [require("tailwindcss-animate")]` so Radix-based primitives (§3) get `data-[state=open]:animate-in` transitions for free.

### 2.5 Global reduced-motion guard
```css
/* index.css */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
```
This is the safety net; framer-motion components *also* read the hook (§5.1) so they don't even mount transition work.

---

## 3. Building out shadcn/ui properly

Decision: **adopt Radix primitives** for the interactive, focus-trapping, a11y-heavy components (dialog, dropdown, tooltip, select, switch, tabs, popover) — the `dialog.tsx:6-9` comment already plans for this. Keep the hand-rolled toast (it works and tests depend on it) but restyle it. Add new presentational primitives as plain `cva` components.

### 3.1 New dependencies
```
dependencies:    @radix-ui/react-dialog, @radix-ui/react-dropdown-menu,
                 @radix-ui/react-tooltip, @radix-ui/react-select,
                 @radix-ui/react-switch, @radix-ui/react-tabs,
                 @radix-ui/react-popover, @radix-ui/react-separator,
                 framer-motion (^11)
devDependencies: tailwindcss-animate
```
Bundle note: `cross-run-frontend.md` reports current JS bundle ~513 kB. Radix tree-shakes per-primitive; framer-motion adds ~30-50 kB gz. Acceptable for an authed admin SaaS; revisit with route-level code-splitting (`React.lazy`) for Phase 1B scorer routes.

### 3.2 Primitive inventory (build order within the primitives PR)

| Primitive | Source | Action | Notes / who consumes |
|---|---|---|---|
| `button.tsx` | exists | **extend** | Move `buttonVariants` → `button.variants.ts` (lint F1a). Add `brand` variant = `bg-primary` (now emerald), `success`, `warning` variants, `loading` prop (renders `Loader2` spinner + `aria-busy`, disables). Sizes add `xs`. Replaces all `bg-emerald-700 hover:bg-emerald-800` usages. |
| `card.tsx` | exists | keep + shadow | Use `shadow-sm`, hover `shadow-md` only on interactive cards. Add optional `<CardHeader>` action slot. |
| `input.tsx` | exists | restyle | Add `aria-invalid` red border state, leading/trailing icon slots (member search composes this manually today — `MemberDirectoryPage:358-374`). |
| `label.tsx` | exists | keep | — |
| `textarea.tsx` | **new** | add | Feedback modal hand-rolls a `<textarea>` (`OrgDashboardPage:196-204`); extract. |
| `dialog.tsx` | exists (hand-rolled) | **rewrite on Radix** | CRITICAL: preserve `role="dialog"`, `aria-modal`, `aria-label`, Escape, click-outside, and the named exports `Dialog/DialogHeader/DialogTitle/DialogDescription/DialogFooter/DialogCloseButton` with identical props (`open`, `onOpenChange`, `ariaLabel`) so `OrgDashboardPage`, `InviteCreateModal`, `OwnershipTransferModal`, `PasswordReauthModal` don't change. Add focus-trap (Radix gives it free) + `scale-in` enter. |
| `dropdown-menu.tsx` | **new** | add | Replace the 3 hand-rolled menus: AppShell user menu (`AppShell:155-218`), member-row actions (`MemberDirectoryPage:144-177`). Radix handles roving focus + Escape + outside-click (currently re-implemented per-site). Keep `role="menu"/"menuitem"` so tests pass. |
| `badge.tsx` | **new** | add | `cva` variants: `default/secondary/success/warning/destructive/outline`. `RoleBadge` keeps its bespoke palette but can sit on top. Dashboard "Phase 1B" pills, role pills, count chips all become `<Badge>`. |
| `skeleton.tsx` | **new** | add | `bg-muted animate-pulse rounded` + optional `shimmer` overlay. Replaces ad-hoc skeletons in `MemberDirectoryPage:183-202` and `ModuleMatrixPage:174-184`. |
| `spinner.tsx` | **new** | add | lucide `Loader2` + `animate-spin` + `role="status"` + sr-only label. Used by button `loading`, page-level `PageLoader`. |
| `empty-state.tsx` | **new** | add | icon + title + description + optional CTA. `MemberDirectoryPage` `EmptyState` (`:205-229`) and ModuleMatrix "No members yet" become this. |
| `table.tsx` | **new** | add | `Table/THead/TBody/TR/TH/TD` with sticky-header + `font-tabular` option. Member table + module matrix migrate. Keep `aria-label`, `data-testid` on the consuming `<table>`. |
| `tooltip.tsx` | **new** | add | Radix; for the matrix tz tooltip, grant-cell tooltip (currently native `title=`), truncated labels. |
| `alert.tsx` | **new** | add | `info/success/warning/destructive` banners; replaces inline error divs (`LoginPage:107-114`, `MemberDirectory` error block, `ConflictOfInterestBanner`). Keeps `role="alert"`. |
| `tabs.tsx` | **new** | add | Radix; for future org settings sections; low priority. |
| `switch.tsx` | **new** | add | Radix; theme toggle + future notification prefs. |
| `select.tsx` | **new** | add | Radix; invite-role picker, future filters. |
| `separator.tsx` | **new** | add | Radix; menu/section dividers. |
| `page-header.tsx` | **new** | add | Title + subtitle + actions + optional breadcrumb. Every org page hand-rolls `<h1 className="text-2xl font-semibold">` + subtitle (dashboard, members, matrix). Standardize. |
| `page-container.tsx` | **new** | add | `<main>`-friendly `max-w-6xl mx-auto p-6 flex flex-col gap-6` wrapper. |

### 3.3 Variant-file convention (lint-safe)
Each `cva` lives in `*.variants.ts`; the component file imports it and exports only the component. Existing offenders to also fix while here: `button.variants.ts`, `avatar.variants.ts` (the size map), `roleKeys.ts` (move `ROLE_KEYS`). This resolves `cross-run-frontend.md` F1a in the same sweep.

---

## 4. lucide icon usage conventions

Codify the (already-good) implicit conventions into a documented standard + a thin barrel:

- **Sizing**: `h-4 w-4` inline-with-text, `h-5 w-5` in buttons/cards, `h-7 w-7` in feature/hero medallions, `h-8 w-8`+ in empty/error states. Always pair with a colored circular medallion (`inline-flex h-10 w-10 items-center justify-center rounded-md bg-secondary` — pattern from `DashboardCard:51-56`).
- **a11y**: decorative icons get `aria-hidden="true"` (already universal); icon-only buttons get `aria-label` + `size="icon"`; never rely on icon alone for meaning (pair with text or sr-only).
- **stroke**: default `strokeWidth` except emphasis glyphs (`RoleBadge` crown uses `2.5`) — keep.
- **Semantic icon map** (single source so the same concept always uses the same glyph): create `frontend/src/lib/icons.ts` re-exporting named lucide icons under domain names: `IconTournament=Trophy`, `IconSchedule=Calendar`, `IconTeam=Users`, `IconLive=Activity`, `IconSecurity=Shield`, `IconMember=UserRound`, `IconInvite=UserPlus`, `IconRemove=UserMinus`, `IconSearch=Search`, `IconMore=MoreVertical`, `IconBell=Bell`, `IconGrant=CheckCircle2`, `IconDeny=XCircle`, `IconWarn=AlertTriangle`, `IconTheme=Sun/Moon`, `IconLoading=Loader2`, `IconChevron=ChevronDown`, `IconClose=X`, `IconMenu=Menu`. Screens import from here, so a future icon-set swap is one file.
- **Pin the version**: lucide `^1.14.0` — keep pinned; icon renames between majors break silently.

---

## 5. framer-motion animation patterns

Wrap framer-motion so it is (a) reduced-motion-aware and (b) trivially removable. Create `frontend/src/lib/motion.ts` and `frontend/src/components/motion/` helpers.

### 5.1 Reduced-motion gate (foundation)
```ts
// lib/motion.ts
import { useReducedMotion } from "framer-motion";
export function useMotionSafe<T>(variants: T, reduced: T): T {
  return useReducedMotion() ? reduced : variants;
}
export const EASE = [0.25, 0.46, 0.45, 0.94] as const;
export const DUR = { fast: 0.12, base: 0.18, slow: 0.28 };
```
Wrap the app once in `<MotionConfig reducedMotion="user">` (in `App.tsx`, inside `BrowserRouter`) so *all* motion respects the OS setting globally — the single most important a11y line for this feature.

### 5.2 Page / route transitions
A `<RouteTransition>` wrapping the `<Outlet/>` in `AppShell.tsx:287-289` and around public-route elements:
```tsx
// components/motion/RouteTransition.tsx — keyed by location.pathname
<AnimatePresence mode="wait">
  <motion.div key={pathname}
    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -4 }} transition={{ duration: DUR.base, ease: EASE }}>
    {children}
  </motion.div>
</AnimatePresence>
```
Subtle (8px, 180ms) — feels responsive, never sluggish. `mode="wait"` avoids overlap jank.

### 5.3 List / stagger (dashboard cards, member rows, matrix rows)
```tsx
const container = { show: { transition: { staggerChildren: 0.04 } } };
const item = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: DUR.base } } };
```
- Dashboard card grid (`OrgDashboardPage:140-166`): `motion.section` container + `motion.div` per card → cards fan in. Cap stagger so >12 items don't feel slow (`staggerChildren: Math.min(0.04, 0.4/n)`).
- Member rows / matrix rows: stagger only on **first paint**, not on search-filter re-renders (use `initial={false}` after mount) to avoid re-animating on every keystroke.

### 5.4 Micro-interactions
- **Buttons**: `whileTap={{ scale: 0.97 }}` (a `MotionButton` variant of Button). Hover handled by CSS `transition-colors` (cheaper than JS).
- **Cards (interactive)**: `whileHover={{ y: -2 }}` + shadow bump via CSS. Only for `DashboardCard` link/button modes, never disabled.
- **Toasts**: spring in from bottom-right (`initial={{ opacity:0, y:12, scale:0.98 }}`), exit `{ opacity:0, x:24 }`; wrap the toast list (`toast.tsx:72`) in `AnimatePresence` so dismissals slide out instead of vanishing. Preserve `role`, `aria-label`.
- **Dialog**: Radix + `tailwindcss-animate` `data-[state]` classes (no framer needed) — `scale-in` enter, `fade-out` exit; backdrop `fade-in`.
- **GrantCell** (`GrantCell.tsx`): a tiny `scale` pop (`whileTap`) on cycle + crossfade of the glyph — reinforces the default→grant→deny state change. Keep `role="switch"`, `aria-checked`, tooltip.
- **Theme toggle**: rotate/crossfade Sun↔Moon.
- **Nav active indicator**: `layoutId="nav-active"` shared-layout pill that slides between active nav items in `AppShell` (`renderNavLink`) — a signature "pro SaaS" touch, cheap with framer.

### 5.5 Performance rules (enforced)
Only animate `opacity` and `transform` (GPU-composited). Never animate `width/height/top/left/box-shadow` in JS. No layout-thrash. Use `will-change` sparingly via framer's auto handling. These match the `fixing-motion-performance` skill's guidance.

---

## 6. Loading / skeleton / empty / error states

Standardize the four "non-happy" states so every data screen behaves identically.

### 6.1 Loading
- **Inline / list**: `<Skeleton>` matching the final layout's shape (rows = avatar circle + 2 text bars). Already done well in `MemberDirectoryPage:183-202`; replace with the new `<Skeleton>` primitive + optional shimmer. Keep `role="status" aria-live="polite"` + sr-only "Loading…".
- **Page-level** (first load behind a query): `<PageLoader>` — centered `<Spinner>` + label, used while `ProtectedRoute` bootstraps (currently a bare "Loading…" flash).
- **Button-level**: `loading` prop on `<Button>` (replaces the manual `{isLoading ? t("Signing in...") : t("Sign in")}` pattern in `LoginPage:138,186` — keep those exact strings as the `loadingText`).
- **Optimistic**: matrix row save already optimistic (`ModuleMatrixPage:99-121`); add a subtle row-level saving shimmer.

### 6.2 Skeleton
`<Skeleton className="h-4 w-32" />`; compose into `<SkeletonTable rows cols>`, `<SkeletonCardGrid n>` for dashboard/members/matrix. Shimmer overlay = `before:absolute before:inset-0 before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-white/40 before:to-transparent` (disabled under reduced-motion via the global guard).

### 6.3 Empty
`<EmptyState icon title description action?>`. Tones: neutral (no data yet — "No members yet" with Invite CTA, already at `MemberDirectoryPage:205-229`) and filtered-empty ("No members match "x"" — `MemberDirectoryPage:404-406`, keep exact string, route through a `variant="filtered"` that shows a "Clear search" affordance).

### 6.4 Error
- **Inline**: `<Alert variant="destructive">` with retry button. Replaces `MemberDirectoryPage:381-397` and `ModuleMatrixPage:209-232` blocks; keep `role="alert"`, `data-testid="members-retry"`, the "Retry" string.
- **Permission-denied (403)**: a calm `<EmptyState>`/`<Card>` (not red) — the matrix `Access required` card (`ModuleMatrixPage:192-207`) and `NoPermissionCard` (`MemberDirectoryPage:231-257`) become a shared `<AccessDeniedCard module=>` so the message is consistent. Keep `data-testid="no-permission"`.
- **Page crash**: `ErrorPage.tsx` already good; restyle medallion + button to tokens, keep `role="alert"`, the `<details>` stack, retry.
- **404**: `NotFoundPage.tsx` keep structure; token-ize the emerald medallion/button.

### 6.5 State-machine summary (every data screen implements all 4)
`idle→loading (skeleton) → success (data | empty) → error (alert+retry) | denied (access card)`. This is a checklist the restyle PRs verify.

---

## 7. Theme (dark mode) implementation

This is net-new behavior (infrastructure exists, activation does not).

### 7.1 ThemeProvider
`frontend/src/features/theme/ThemeProvider.tsx` + `useTheme()` (Zustand store, matching the app's existing Zustand pattern — `authStore`, `OrgSwitcherStore`):
- State: `theme: "light" | "dark" | "system"` (default `"system"`).
- On mount + on change: resolve `system` via `matchMedia("(prefers-color-scheme: dark)")`, toggle `document.documentElement.classList` `dark`, persist to `localStorage("fixture.theme")`.
- Listen to `matchMedia` change events while in `system` mode.
- **FOUC guard**: inline `<script>` in `index.html` that reads localStorage and sets the class before React hydrates (prevents a white flash on load for dark users). This is the standard shadcn pattern.

### 7.2 Toggle UI
`<ThemeToggle>` (a `<DropdownMenu>` Light/Dark/System, or a 2-state `<Switch>` with Sun/Moon) placed in `AppShell` header (next to `OrgSwitcher`, `AppShell:151-153`) and in the public top bars (Landing header, AuthLayout). lucide `Sun`/`Moon`/`Monitor`.

### 7.3 Audit pass
Every screen that hard-codes light-only palette classes must be tokenized or given a `dark:` variant. The big offenders (all read): `LandingPage` (emerald-50 gradient, slate-900 text, white cards — needs `dark:` washes), `AuthLayout` (emerald→slate gradient panel works in both; right column uses tokens already), `RoadmapCard`/`Feature` tone maps in `LandingPage:216-225` (replace literal `emerald-50/slate-200` with token utilities). The app-shell, dashboard, members, and matrix mostly already use tokens (`bg-card`, `text-muted-foreground`, `bg-secondary`) and will "just work" once `.dark` is applied — that's the payoff of tokenization.

---

## 8. Prioritized screen restyle order (visible payoff first)

Each is an independent, shippable PR after the token+primitive PRs land. Priority = visibility × current-roughness × test-safety.

| # | Screen | File | Why first / what changes | Risk |
|---|---|---|---|---|
| **1** | **Landing** | `features/landing/LandingPage.tsx` | First impression / public marketing surface. Tokenize all `emerald-*`/`slate-*`; add `fade-up` hero entrance + staggered roadmap cards; add `<ThemeToggle>`; dark-mode the hero gradient; replace hard-coded buttons with `<Button variant="brand">`. Big perceived-quality jump for low risk (only 1 test: `LandingPage.test.tsx`). | LOW |
| **2** | **Login (+ auth surfaces)** | `features/auth/LoginPage.tsx`, `AuthLayout.tsx` | Every user hits it. Button `loading` prop (keep "Signing in…" strings), `<Alert>` for errors (keep `role="alert"`), `scale-in` on the form card, tokenize the brand panel for dark, add ThemeToggle. Propagates to signup/reset/2FA via shared `AuthLayout`. Tests: `LoginPage.test.tsx`, `SignupPage.test.tsx`. | LOW-MED |
| **3** | **Org Dashboard** | `features/layout/OrgDashboardPage.tsx` + `DashboardCard.tsx` | The post-login home; sets the tone for the authed app. `<PageHeader>`; staggered `DashboardCard` grid with `whileHover` lift; role pill → `<Badge>`; feedback `<textarea>` → `<Textarea>`; nav active `layoutId` pill in shell. Tests: `OrgDashboardPage.test.tsx`, `dashboardCards.test.ts`. Preserve `data-testid="dashboard-cards"`, `role-pill`, `phase1b-teaser`. | MED (test-rich) |
| **4** | **Member Directory** | `features/orgs/MemberDirectoryPage.tsx` | Densest "real" CRUD surface; showcases Table/EmptyState/Skeleton/Alert/DropdownMenu primitives together. Migrate table → `<Table>`, row menu → `<DropdownMenu>`, error → `<Alert>`, empty → `<EmptyState>`, search input → `<Input>` w/ icon slot. **Preserve every** `data-testid` (`member-row-*`, `members-table`, `member-search`, `members-retry`, `invite-button`, `member-skeleton`, `no-permission`) and `role`/`aria-label`. Tests: `MemberDirectoryPage.test.tsx`, `InviteCreateModal.test.tsx`. | MED-HIGH |
| **5** | **Module Matrix** | `features/permissions/ModuleMatrixPage.tsx` + `GrantCell.tsx` | The most complex/distinctive screen (sticky multi-axis grid). High payoff because it currently uses raw `<button className="rounded border ...">` save buttons — swap to `<Button size="xs">`; `<AccessDeniedCard>` for 403; `<Skeleton>`; GrantCell tap micro-interaction + glyph crossfade; tokenize. **Do NOT change** the cycle semantics, `role="switch"`, `aria-checked`, `data-state`, sticky layout, or per-row save. Tests: `ModuleMatrixPage.test.tsx`, `GrantCell.test.tsx`. | HIGH (most test-coupled) |

Order rationale: 1-2 are public + low-test-risk = fast visible wins to demo. 3 establishes the authed-app language. 4-5 are the deepest but reuse all primitives built in 1-3, so they go last when the toolkit is proven.

After these five: AppShell chrome (nav pill, dropdown, drawer animation), OrgChooser, role landing pages (Scorer/Referee/TeamManager `PreviewTile` grids), error/404 pages — all mechanical token swaps.

---

## 9. Models / API / routes (this is a frontend-only feature)

- **Backend models / migrations / endpoints: NONE.** This overhaul touches zero Django code. No new DRF endpoints, no schema, no migrations. (Theme preference is client-only via `localStorage`; *if* per-user server-side theme persistence is later wanted, it would be one nullable `User.ui_theme` charfield + the existing `/me/` PATCH — explicitly **out of scope** here.)
- **SPA routes**: unchanged. No new routes. (`App.tsx` route table stays; `<RouteTransition>` wraps existing `<Outlet>`/elements.)
- **New SPA modules added** (no routes):
  - `frontend/src/index.css` (token rewrite), `tailwind.config.ts` (scales/keyframes/plugin).
  - `frontend/src/components/ui/`: `textarea.tsx`, `dropdown-menu.tsx`, `badge.tsx` + `badge.variants.ts`, `skeleton.tsx`, `spinner.tsx`, `empty-state.tsx`, `table.tsx`, `tooltip.tsx`, `alert.tsx`, `tabs.tsx`, `switch.tsx`, `select.tsx`, `separator.tsx`, `page-header.tsx`, `page-container.tsx`, `access-denied-card.tsx`; `button.variants.ts`, `avatar.variants.ts`, `roleKeys.ts` (lint refactor).
  - `frontend/src/components/motion/`: `RouteTransition.tsx`, `MotionButton.tsx`, `Stagger.tsx`.
  - `frontend/src/lib/`: `motion.ts`, `icons.ts`.
  - `frontend/src/features/theme/`: `ThemeProvider.tsx`, `ThemeToggle.tsx`, `themeStore.ts`.
  - `index.html`: FOUC guard `<script>` + `<MotionConfig>`/`<ThemeProvider>` mounted in `App.tsx`.

---

## 10. Reused chassis (do NOT rebuild)

- `cn()` (`lib/tailwind.ts`) — the class-merge helper; every new primitive uses it.
- `t()` (`lib/t.ts`) — wrap all new strings; invariant #13.
- Existing CSS-var → Tailwind color mapping in `tailwind.config.ts` (extend, don't replace).
- `cva` pattern from `button.tsx` — template for all new variant components.
- Zustand store pattern (`authStore`, `OrgSwitcherStore`) — template for `themeStore`.
- TanStack Query loading/error states already wired in `MemberDirectoryPage`/`ModuleMatrixPage` — only the *presentation* changes.
- Global focus-visible ring (`index.css:78-80`) — keep; new `--ring` is emerald.
- Toast context (`toast.tsx`) — keep API; restyle + animate viewport only.
- Avatar hashing + RoleBadge palette — keep logic; they are deterministic-identity, not theme.

---

## 11. Tests to write / preserve (TDD per invariant + project convention)

**Preserve (must stay green — do not change selectors):** `LandingPage.test.tsx`, `LoginPage.test.tsx`, `SignupPage.test.tsx`, `OrgDashboardPage.test.tsx`, `dashboardCards.test.ts`, `MemberDirectoryPage.test.tsx`, `InviteCreateModal.test.tsx`, `ModuleMatrixPage.test.tsx`, `GrantCell.test.tsx`, `RoleBadge.test.tsx`, `Avatar.test.tsx`, `AppShell.test.tsx`, `computeNavItems.test.ts`, `NotFoundPage.test.tsx`, `ErrorBoundary.test.tsx`, `RefereeLandingPage`/`TeamManagerLandingPage`/`ScorerLandingPage`/`MyProfilePage`/`OrgBrandingPage`/`OrgSettingsPage`/`orgSwitcher` tests. These assert `data-testid`/`role`/`aria-label`/visible-string; the restyle keeps all of them.

**New vitest tests:**
- `themeStore.test.ts` — default `system`; resolves via mocked `matchMedia`; toggles `document.documentElement` class; persists/reads `localStorage`; reacts to media-query change while in `system`.
- `ThemeToggle.test.tsx` — renders, cycles light/dark/system, has accessible name.
- Primitive unit tests: `badge.test.tsx`, `skeleton.test.tsx` (`role="status"`/aria-hidden), `spinner.test.tsx`, `empty-state.test.tsx` (renders CTA only when provided), `alert.test.tsx` (`role="alert"` for destructive), `dropdown-menu.test.tsx` (Escape closes, `role="menu"/"menuitem"`, focus returns to trigger), `dialog.test.tsx` (post-Radix: focus trap, Escape, `aria-modal`, click-outside, named-export API parity), `table.test.tsx`, `tooltip.test.tsx`, `textarea.test.tsx`.
- `Button` `loading` prop test (`aria-busy`, disabled, shows spinner + loadingText).
- `RouteTransition.test.tsx` — under `useReducedMotion()=true` renders without transition (no exit delay); animates otherwise.
- `motion.test.ts` — `useMotionSafe` returns reduced variants when reduced-motion set.

**a11y / contrast (invariant #13):**
- Run the **`contrast-check` skill** against every `--*` / `--*-foreground` pair in §2.1 (light + dark) — must pass WCAG AA (4.5:1 text, 3:1 UI/large). This **gates the token PR**; the MEDIUM-confidence HSLs in §2.1 are explicitly subject to adjustment based on this.
- Optionally add `jest-axe`/`@axe-core/react` smoke tests on Landing, Login, Dashboard, Members, Matrix in both themes (no violations).
- Reduced-motion: assert global media-query guard + `<MotionConfig reducedMotion="user">` mounted.

**Lint gate (close `cross-run-frontend.md` F1):** the variant-file refactor (§3.3) must make `npm run lint` exit 0; add it to the verification checklist so parallel-agent work isn't blocked (F2).

---

## 12. Build / migration order (ordered milestones)

1. **M0 — Tokens & scales (no visual regression intended).** Rewrite `index.css` tokens (§2.1) + reduced-motion guard; extend `tailwind.config.ts` (typography, shadow, radius, motion keyframes); add `tailwindcss-animate`. Run `contrast-check` gate. Existing token-based screens auto-improve; hard-coded-emerald screens unchanged for now. Build + all tests must stay green.
2. **M1 — Theme.** `themeStore` + `ThemeProvider` + FOUC script + `<ThemeToggle>` (mounted in AppShell + public bars). Now dark mode is live for already-tokenized surfaces. Tests: themeStore/ThemeToggle.
3. **M2 — Motion foundation.** Add `framer-motion`; `<MotionConfig reducedMotion="user">` in `App.tsx`; `lib/motion.ts`; `RouteTransition` around outlet/public routes; `MotionButton`. Tests: motion/RouteTransition.
4. **M3 — Primitive library + lint refactor.** Build all §3.2 primitives (Radix-backed where noted) + `icons.ts` barrel; move variants/constants to sibling files (§3.3) closing F1a; rewrite `dialog.tsx` on Radix with API parity. Per-primitive tests. `npm run lint` → 0.
5. **M4 — Restyle Landing (screen #1).** Visible demo-able win.
6. **M5 — Restyle Login + AuthLayout (screen #2).**
7. **M6 — Restyle Org Dashboard + DashboardCard + AppShell nav pill (screen #3).**
8. **M7 — Restyle Member Directory (screen #4).**
9. **M8 — Restyle Module Matrix + GrantCell (screen #5).**
10. **M9 — Mop-up.** OrgChooser, role landings, error/404, OrgSettings/Branding/Audit — mechanical token swaps; dark-mode audit pass (§7.3); final axe + contrast sweep both themes.

Each milestone: build + typecheck + lint + vitest green before merge (project convention; `superpowers:verification-before-completion`). M5-M9 are independently shippable and can be parallelized by file ownership per the user's parallel-agent preference (one agent per screen, since they share only the already-merged primitive library).

---

## 13. Risks & open questions

- **R1 — Dialog rewrite on Radix is the highest-risk single change** (4 consumers + a11y tests). Mitigate: keep the exact named-export API and props from `dialog.tsx`; land it alone in M3 with a dedicated parity test before any screen depends on the new internals.
- **R2 — Test selector coupling.** Screens are heavily `data-testid`-tested; a careless class-only restyle could still break a test if markup nesting changes (e.g. moving a `data-testid` onto a wrapper). Rule: restyle = swap classes/wrappers but keep the *element that carries the testid/role/aria* in place.
- **R3 — Bundle size** (Radix + framer ≈ +60-90 kB gz on a 513 kB base). Acceptable for authed admin; flagged for Phase 1B route-splitting.
- **R4 — Contrast HSLs are MEDIUM confidence.** §2.1 values are tuned by eye for AA but MUST pass the `contrast-check` gate in M0; expect 1-2 lightness tweaks (esp. `--warning` on muted, dark-mode `--muted-foreground`).
- **OQ1 — Server-persisted theme?** Deferred; client `localStorage` only for v1.
- **OQ2 — Web font?** Staying on system stack (perf). If brand wants a display face later (e.g. Inter/Geist), it's a one-line `fontFamily` token change + `<link>`/self-host — designed-for but out of scope.
- **OQ3 — Scorer/referee dense theme.** Phase 1B will need a higher-contrast, denser variant of these tokens; the token system is structured so a `[data-density="compact"]` scope can override spacing/radius without touching color. Not built now.
