# Audit: fe-permissions — UI/UX Quality & Test Coverage

**Area:** `frontend/src/features/permissions/`
**Files audited:** `ModuleMatrixPage.tsx`, `GrantCell.tsx`, `ConflictOfInterestBanner.tsx`, `__tests__/GrantCell.test.tsx`, `__tests__/ModuleMatrixPage.test.tsx`
**Lens:** Visual/UX quality vs professional SaaS bar (shadcn/ui + lucide + framer-motion + cohesive colors/dark mode) + vitest coverage gaps for guards, permission gating, and error states.

---

## Findings

### F-01 · HIGH — Raw `<button>` elements bypass the shared `Button` component

**File:** `ModuleMatrixPage.tsx:222–229`, `ModuleMatrixPage.tsx:265–279`, `ModuleMatrixPage.tsx:379–398`

**Evidence (lines 222–229):**
```tsx
<button
  type="button"
  onClick={() => matrixQ.refetch()}
  className="rounded border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground"
>
```

**Why it matters:** The project has a `<Button>` CVA component at `frontend/src/components/ui/button.tsx` with variants (`default`, `outline`, `secondary`, `ghost`) that automatically handle hover states, focus-ring, `disabled:pointer-events-none`, and consistent sizing. All three buttons in `ModuleMatrixPage` replicate a subset of this logic with bespoke inline Tailwind strings that diverge from the design system. In dark mode the hardcoded `bg-primary` and `border-primary` classes resolve correctly via CSS vars, but the hover/disabled behaviours are not unified. A SaaS overhaul reviewer would flag this immediately.

**Recommendation:** Replace every bare `<button>` in the page with `<Button variant="default" size="sm">` (Retry, Save row) and `<Button variant="outline" size="sm">` (Reset to defaults). The `GrantCell` button is a special-case control and is acceptable as a raw element there, but the page-level actions must use the system component.

---

### F-02 · HIGH — `grant`/`deny`/`warn` Tailwind tokens not in dark-mode CSS vars — they break in dark mode

**File:** `frontend/src/index.css` (no `.dark` overrides for these tokens); `frontend/tailwind.config.js:47–58`

**Evidence (tailwind.config.js lines 47–58):**
```js
grant: {
  DEFAULT: "hsl(142 71% 45%)",
  muted: "hsl(142 50% 92%)",
},
deny: {
  DEFAULT: "hsl(0 72% 51%)",
  muted: "hsl(0 60% 95%)",
},
```

**Why it matters:** These are hardcoded HSL literals, not CSS custom properties. In dark mode the `bg-grant-muted` cell background (`hsl(142 50% 92%)`) is extremely close to white — visually invisible on a dark background. Similarly `bg-warn-muted` (`hsl(38 92% 95%)`) would produce a near-white banner on a dark card. The `ConflictOfInterestBanner` uses `bg-warn-muted` and `border-warn` directly. Because `darkMode: ["class"]` is active and the `.dark` block in `index.css` does not redefine these colours, they won't adapt.

**Recommendation:** Convert `grant`, `deny`, and `warn` to CSS custom properties alongside the other shadcn tokens in `index.css`, and add `.dark` overrides with darker, saturated-but-dimmer values:
```css
:root {
  --grant: 142 71% 45%;
  --grant-muted: 142 50% 92%;
  --deny: 0 72% 51%;
  --deny-muted: 0 60% 95%;
  --warn: 38 92% 50%;
  --warn-muted: 38 92% 95%;
}
.dark {
  --grant: 142 60% 55%;
  --grant-muted: 142 30% 18%;
  --deny: 0 65% 60%;
  --deny-muted: 0 35% 18%;
  --warn: 38 85% 55%;
  --warn-muted: 38 40% 18%;
}
```
Then reference them in `tailwind.config.js` as `"hsl(var(--grant))"`.

---

### F-03 · HIGH — `MemberCell` in `ModuleMatrixPage` ignores the existing `Avatar` and `RoleBadge` system components

**File:** `ModuleMatrixPage.tsx:413–447`

**Evidence (lines 413–447):**
```tsx
<span aria-hidden="true"
  className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
  {initials || "?"}
</span>
…
<span key={r}
  className="rounded border border-border bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
  {r}
</span>
```

**Why it matters:** The codebase already has `<Avatar>` (`frontend/src/components/ui/Avatar.tsx`) with deterministic colour derivation from email and disambiguating initials logic, and `<RoleBadge>` (`frontend/src/components/ui/RoleBadge.tsx`) with colour-coded role chips. The `MemberCell` reimplements both from scratch with a monochrome muted-background avatar that is visually undifferentiated and a plain border chip that doesn't reflect the role semantics. The inconsistency will be jarring in the planned SaaS overhaul.

**Recommendation:** Replace the bespoke initials span with `<Avatar email={row.user_email} name={row.user_full_name} size="sm" />` and each role span with `<RoleBadge role={r} />`. This removes ~25 lines, aligns with the system, and picks up the colour-hash disambiguation fix already implemented in `Avatar`.

---

### F-04 · MEDIUM — `ConflictOfInterestBanner` uses a bare `!` text glyph instead of a Lucide icon

**File:** `ConflictOfInterestBanner.tsx:34`

**Evidence:**
```tsx
<span aria-hidden="true" className="text-base font-bold">
  !
</span>
```

**Why it matters:** The project's `lucide-react` package (v1.14.0, listed in `package.json`) is already a direct dependency. Every other alert/warning surface in a SaaS application uses a proper `AlertTriangle` or `AlertCircle` icon. A lone `!` character is visually fragile (font-dependent size and weight, misaligned at some zoom levels) and looks unfinished at a SaaS quality bar.

**Recommendation:** Replace with `<AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warn" />` from `lucide-react`.

---

### F-05 · MEDIUM — `ConflictOfInterestBanner` uses a plain browser `<input type="checkbox">` with no styling

**File:** `ConflictOfInterestBanner.tsx:43–51`

**Evidence:**
```tsx
<label className="flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={acknowledged}
    onChange={(e) => onChangeAcknowledged(e.target.checked)}
  />
```

**Why it matters:** The project has a `label.tsx` shadcn primitive. A bare, unstyled browser checkbox is OS-rendered and will look inconsistent across Windows/Mac/Linux, has no focus ring alignment with the rest of the design system, and is not dark-mode aware. Given the owner's explicit pro-SaaS overhaul target this will be a visible gap.

**Recommendation:** Create a `Checkbox` shadcn primitive (thin wrapper around `<input type="checkbox">` with `rounded`, `border-input`, `accent-primary` or a custom-styled element) and use it here. At minimum add `className="accent-primary h-4 w-4 cursor-pointer"` to the existing input to align with the Tailwind design tokens while a proper component is built.

---

### F-06 · MEDIUM — Module column headers truncate to `w-24` with no tooltip fallback for long labels

**File:** `ModuleMatrixPage.tsx:331–340`

**Evidence:**
```tsx
<th key={m.key} scope="col" title={m.description} …>
  <div className="w-24 truncate">{m.label}</div>
</th>
```

**Why it matters:** The `title` attribute is set to `m.description`, not `m.label`. When a column header is truncated (e.g. "Scoring console" at 14 chars fits, but "Dispute management" at 18 chars would be clipped), the tooltip reveals the description rather than the full label. A user who doesn't know which module is behind the truncated label gets no quick way to read the full name — they see the description instead. Additionally, `title` is not accessible on keyboard (no visible tooltip on `:focus-visible`). At a SaaS quality level a proper Radix `Tooltip` or `<title>` SVG element should be used.

**Recommendation:** Set `title={m.label}` (or add a separate `data-description` attribute for description access); or replace with a Radix/shadcn `Tooltip` component that shows both label (heading) and description (body) on hover/focus. The header `<div>` should also receive the full label in an `aria-label`.

---

### F-07 · MEDIUM — No `framer-motion` animations anywhere in the feature; state transitions are abrupt

**File:** All three component files; `package.json` does not list `framer-motion`.

**Evidence (`package.json` dependencies section — `framer-motion` is absent):**
```json
"dependencies": {
  "@hookform/resolvers": "^5.2.2",
  "@tanstack/react-query": "^5.100.8",
  "class-variance-authority": "^0.7.1",
  …
}
```

**Why it matters:** The owner has explicitly called out `framer-motion` as part of the planned overhaul. Currently: the loading skeleton appears/disappears instantly with no fade; the per-row Save button pops in/out abruptly when a cell is edited or saved; the ConflictOfInterestBanner has no entry animation. For a permission management screen where the operator is making high-stakes changes, smooth micro-animations signal a polished, trustworthy tool.

**Recommendation:** Add `framer-motion` to `dependencies`. Apply `AnimatePresence` + `motion.button` to the per-row Save button (fade-in/scale on mount, fade-out on unmount). Use `motion.div` with a subtle fade on the loading skeleton → content transition. Use `motion.div` with slide-in for the ConflictOfInterestBanner.

---

### F-08 · LOW — `aria-checked` on `GrantCell` is semantically incorrect for a 3-state control

**File:** `GrantCell.tsx:85`

**Evidence:**
```tsx
role="switch"
aria-checked={state === "grant"}
```

**Why it matters:** `role="switch"` with `aria-checked` only conveys a binary on/off state. The `deny` state has `aria-checked="false"`, identical to the `default` state — assistive technology users cannot distinguish denied from default. The ARIA 1.1 spec allows `aria-checked="mixed"` for tri-state controls (or alternatively `role="button"` with `aria-pressed` and a composed `aria-label` already present). The composed `aria-label` does encode the full state, so screen readers get the right text, but the semantic role is still imprecise.

**Recommendation:** Either change `role="switch"` to `role="button"` (which has no `aria-checked` contract) and rely solely on the already-excellent composed `aria-label`; or keep `role="switch"` and use `aria-checked="mixed"` for the `deny` state to signal a non-default, non-granted condition. Option 1 is simpler and the aria-label is already WCAG-complete.

---

### F-09 · LOW — Loading skeleton uses static Tailwind `animate-pulse` with no dark-mode skeleton colour

**File:** `ModuleMatrixPage.tsx:175–182`

**Evidence:**
```tsx
<div key={i} className="h-8 animate-pulse rounded bg-muted" aria-hidden="true" />
```

**Why it matters:** `bg-muted` adapts correctly through CSS vars (dark: `hsl(217.2 32.6% 17.5%)`). However the skeleton has only 5 rows and does not approximate the table layout (sticky header, scope bands, module columns). On slow connections an operator loading a 20-member matrix will see a plain column of grey bars, then a jarring jump to a wide horizontal table. Pro SaaS implementations use a skeleton that mirrors the final layout — at least a scrollable-width shimmer row.

**Recommendation:** Replace with a `<table>`-shaped skeleton that mirrors the sticky-header + row structure, using `animate-pulse` on `<div>` cells within a minimal table structure. This is a medium-effort cosmetic improvement but meaningfully reduces perceived jank on first load.

---

### F-10 · LOW — `ConflictOfInterestBanner` is tested only via its one consumer (`OwnershipTransferModal`) — no isolated unit tests exist

**File:** No test file exists for `ConflictOfInterestBanner.tsx`.

**Evidence (from Glob result):** `frontend/src/features/permissions/__tests__/` contains only `GrantCell.test.tsx` and `ModuleMatrixPage.test.tsx`. `ConflictOfInterestBanner.tsx` has no corresponding test file.

**Why it matters:** The banner's acknowledgement checkbox is the only UI surface that signals to the operator (and triggers the audit-log path in the backend) that a conflict-of-interest action has been accepted. An incorrect `acknowledged` prop value or a broken `onChange` handler would silently allow unacknowledged operations to be submitted. No test verifies: (a) that the checkbox changes the acknowledged state, (b) that the message prop is rendered, or (c) that the `role="alert"` / `aria-live="polite"` attributes are present.

**Recommendation:** Add `frontend/src/features/permissions/__tests__/ConflictOfInterestBanner.test.tsx` covering: initial unchecked state, check/uncheck toggle, message prop rendered, `role="alert"` present.

---

### F-11 · LOW — `ModuleMatrixPage` tests do not cover the generic non-403 error state or the loading skeleton

**File:** `ModuleMatrixPage.test.tsx`

**Evidence:** The eight test cases cover: success render, dirty cell → Save enabled, PUT payload + event_id, optimistic state, save error + toast + edit preserved, Reset to defaults, 403 graceful card, empty members. Missing:
- A generic 500/network error renders the "Couldn't load permissions" card with a Retry button.
- The Retry button calls `matrixQ.refetch()`.
- The loading skeleton (`isLoading` state) renders a `role="status"` element.

**Why it matters:** The generic error card has its own JSX branch (lines 209–233) including a Retry button wired to `matrixQ.refetch()`. This is untested. The loading state is also exercised only implicitly by the success tests (they await `findBy*` which tolerates an intermediate loading state). A regression that breaks the Retry handler or removes the `role="status"` from the loading skeleton would go undetected.

**Recommendation:** Add three targeted tests: `"renders generic error card with Retry button"`, `"Retry button calls refetch"`, `"shows a loading skeleton while the query is in-flight"`.

---

### F-12 · INFO — No frontend permission-guard hook (`useModuleAccess` / `PermissionGate`) exists; the matrix page itself is only guarded by nav-item exclusion

**File:** `frontend/src/features/layout/computeNavItems.ts:92` (nav exclusion); no hook file.

**Evidence (computeNavItems.ts):**
```ts
key: "permissions",
```
The nav item is excluded if `effective_modules` doesn't include the required code. However, no `PermissionGate` component or `useModuleAccess` hook exists in `frontend/src/features/permissions/`. A user who navigates directly to `/o/acme/permissions` (bypassing the nav) encounters only the backend's 403, which is handled gracefully but is the sole enforcement.

**Why it matters:** For the planned Phase 1B expansion (tournaments, scoring, disputes) many routes will need module gating. The pattern will need to be established. Currently there is no reusable frontend guard primitive. The backend 403 fallback works for the MVP but is not a scalable pattern.

**Recommendation (gap, not a bug):** Introduce a `useModuleAccess(moduleCode: string): boolean` hook that reads `authStore.user.memberships[active].effective_modules` and a companion `<ModuleGate module="..." fallback={<AccessDenied />}>` component. Wire `ModuleMatrixPage` through it as the first consumer so the pattern is established before Phase 1B.

---

## Gaps (forward-looking, not current defects)

| # | Item | Missing | Needed for | Effort | Blocking |
|---|------|---------|-----------|--------|----------|
| G-01 | `framer-motion` dependency | Not in `package.json` | Pro SaaS overhaul (per owner brief) | S | No |
| G-02 | `Checkbox` shadcn primitive | No `frontend/src/components/ui/checkbox.tsx` | `ConflictOfInterestBanner` + future forms | S | No |
| G-03 | `Tooltip` shadcn primitive (Radix) | No `frontend/src/components/ui/tooltip.tsx` | Truncated column headers, cell hover info | S | No |
| G-04 | Dark-mode overrides for `grant`/`deny`/`warn` tokens | Not in `index.css .dark` block | Full dark mode support | S | No |
| G-05 | `useModuleAccess` hook + `ModuleGate` component | Absent from codebase | Phase 1B route gating | M | No |
| G-06 | `ConflictOfInterestBanner` isolated tests | No test file | Correctness assurance for audit-log path | S | No |
| G-07 | Matrix loading skeleton that mirrors table layout | Current: 5 plain `animate-pulse` rows | Reduced perceived jank; SaaS polish | M | No |
| G-08 | Tests for generic error card + Retry + loading state in `ModuleMatrixPage` | 3 missing test cases | Full branch coverage | S | No |
