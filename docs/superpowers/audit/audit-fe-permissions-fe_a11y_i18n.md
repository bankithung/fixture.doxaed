# Audit: fe-permissions — a11y & i18n (WCAG 2.1 AA / invariant #13)

**Scope:** `frontend/src/features/permissions/` (3 source files + 2 test files)
**Lens:** unwrapped user-visible strings (non-`t()`); missing aria/labels/`for`; keyboard nav & focus management; dialog focus traps; alt text; WCAG 2.1 AA contrast.
**Date:** 2026-06-04

---

## Findings

### F-01 — CRITICAL | Contrast: `bg-grant` + `text-white` fails WCAG 3:1 for UI components

**File:** `frontend/tailwind.config.js:47-48` (consumed by `GrantCell.tsx:53,59`)

**Evidence:**
```js
grant: {
  DEFAULT: "hsl(142 71% 45%)",   // ≈ RGB(33,196,84)
  muted: "hsl(142 50% 92%)",
},
```
`GrantCell.tsx` line 53: `"bg-grant text-white border-grant"`

**Why it matters:** White text (`#fff`, relative luminance = 1.0) on `hsl(142 71% 45%)` (relative luminance ≈ 0.38) yields a contrast ratio of approximately **2.44:1**. WCAG 2.1 SC 1.4.11 (Non-text Contrast) requires **3:1** for UI component boundaries and graphical objects. The icon (`CheckCircle2`) and the button border both fail. This is the "granted" state cell used throughout the entire permissions matrix — every "granted" cell fails.

**Recommendation:** Darken `grant.DEFAULT` to at least `hsl(142 71% 30%)` (≈ #158233, contrast with white ≈ 4.8:1), or switch the foreground to a dark ink color (e.g. `hsl(142 71% 10%)`) that achieves 4.5:1 against the current green background. Add a dark-mode variant via CSS variable so the color adapts (the current value is hardcoded in `tailwind.config.js`, not a CSS variable, so it does NOT adapt in dark mode).

---

### F-02 — HIGH | Wrong ARIA role: `role="switch"` used for a 3-state control

**File:** `frontend/src/features/permissions/GrantCell.tsx:84-85`

**Evidence:**
```tsx
role="switch"
aria-checked={state === "grant"}
```

**Why it matters:** `role="switch"` is a 2-state ARIA widget (checked/unchecked). This control has **three** meaningful states: `default`, `grant`, and `deny`. With the current mapping, both `default` and `deny` produce `aria-checked="false"`, making them indistinguishable to screen readers — a user navigating by keyboard will hear "toggle button, off" for both `default` and `deny` states and have no way to know which state they are in beyond the (non-accessible) `title` tooltip. WCAG 2.1 SC 4.1.2 requires name, role, and **value** to be programmatically determinable.

**Recommendation:** Replace `role="switch"` + `aria-checked` with `role="button"` + `aria-pressed` is still only 2-state. The correct pattern is to use no additional role (native `<button>`) and expose state purely through `aria-label` (which already includes the human-readable state string). Remove `role="switch"` and `aria-checked`; the composed `aria-label` already communicates the full state (`"alice@example.com — Org Settings: denied (override)"`). Alternatively, use `aria-label` + `aria-describedby` with a live region that announces the new state on change.

---

### F-03 — HIGH | `grant` and `deny` color tokens lack dark-mode variants

**File:** `frontend/tailwind.config.js:47-58` (consumed by `GrantCell.tsx:53-59`, `ConflictOfInterestBanner.tsx:29`)

**Evidence:**
```js
grant: { DEFAULT: "hsl(142 71% 45%)", muted: "hsl(142 50% 92%)" },
deny:  { DEFAULT: "hsl(0 72% 51%)",   muted: "hsl(0 60% 95%)"  },
warn:  { DEFAULT: "hsl(38 92% 50%)",  muted: "hsl(38 92% 95%)" },
```
All values are hardcoded HSL literals. The CSS variable pattern used for all other tokens (`hsl(var(--primary))`) is NOT used here.

**Why it matters:** In dark mode (`.dark` class) these colors do not shift. `grant-muted` (`hsl(142 50% 92%)`) is a near-white tint with `text-grant` (`hsl(142 71% 45%)`) — in dark mode the card background is `hsl(222.2 84% 4.9%)` and the grant-muted cell becomes a very light patch (near-white background) in a very dark layout with low-luminance text, potentially creating an inconsistent and unreadable UI. WCAG 2.1 SC 1.4.3 and 1.4.11 apply in all rendering modes.

**Recommendation:** Migrate `grant`, `deny`, and `warn` tokens to CSS variables in `index.css` (both `:root` and `.dark` blocks), following the same pattern as the existing design tokens. For the dark-mode equivalents, reduce lightness for `muted` variants (e.g., `grant-muted` → `hsl(142 30% 20%)` in dark mode) and ensure the foreground color maintains 3:1+ against each background.

---

### F-04 — MEDIUM | Unwrapped i18n string: `" rows"` in unsaved-edits counter

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:258`

**Evidence:**
```tsx
{editedRowCount > 1 ? ` (${editedRowCount} rows)` : ""}
```

**Why it matters:** The word `rows` is embedded in a template literal without `t()`. Invariant #13 requires every user-visible string to be wrapped in `t()`. When i18next/Lingui is added, this string will silently remain in English.

**Recommendation:** Refactor to: `` ` (${editedRowCount} ${t("rows")})` `` or better, pass the full phrase as a parameterised message: `t("{{count}} rows", { count: editedRowCount })`.

---

### F-05 — MEDIUM | `title`-only column descriptions are inaccessible to keyboard and touch users

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:335`

**Evidence:**
```tsx
<th
  key={m.key}
  scope="col"
  title={m.description}
  ...
>
  <div className="w-24 truncate">{m.label}</div>
</th>
```

**Why it matters:** `title` attributes are only surfaced on mouse-hover. Keyboard users (Tab to the `<th>`) and touch-screen users have no way to discover the module description. Module labels are also truncated to 24 chars (`w-24 truncate`), compounding the problem. WCAG 2.1 SC 1.3.1 (Info and Relationships) and SC 1.4.13 (Content on Hover or Focus) require that tooltip content is also available on keyboard focus.

**Recommendation:** Use a `<Tooltip>` component (shadcn/ui Tooltip wraps Radix's `TooltipContent` which triggers on both hover and focus) to expose `m.description`. Alternatively, add a visually hidden `<span className="sr-only">` inside the `<th>` that contains the description.

---

### F-06 — MEDIUM | `scope="colgroup"` used without actual `<colgroup>` elements

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:313-318`

**Evidence:**
```tsx
<th
  key={g.scope}
  scope="colgroup"
  colSpan={g.mods.length}
  ...
>
  {t(SCOPE_LABEL[g.scope] ?? g.scope)}
</th>
```

**Why it matters:** `scope="colgroup"` is only meaningful when there is a corresponding `<colgroup>` element in the table. Without `<colgroup>` elements marking the column groups, screen readers may not correctly associate the scope-band header with its child column headers. WCAG 2.1 SC 1.3.1 requires that structural relationships (header-cell associations) are programmatically determinable. According to the HTML spec, `scope="colgroup"` should be used on `<th>` elements that are the header of a `<colgroup>`, not on arbitrary spanning header cells.

**Recommendation:** Either add `<colgroup>` / `<col>` elements in the `<table>` to properly declare column groups, or change `scope="colgroup"` to `scope="col"` (since these cells span multiple individual columns, `scope="colgroup"` is semantically intended for this, but only with proper colgroup markup). A practical fix is to add explicit `<colgroup>` elements with appropriate `<col span={g.mods.length}>` children before `<thead>`.

---

### F-07 — MEDIUM | Em-dash placeholder in "Save" column has no accessible label

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:396-399`

**Evidence:**
```tsx
<span className="text-[10px] text-muted-foreground">
  —
</span>
```
Rendered in the sticky "Save" column cell when a row has no unsaved edits.

**Why it matters:** Screen readers announce the em-dash character as "—" (dash) or simply skip it, providing no useful context. A user tabbing through the table hears nothing meaningful for clean rows in the Save column. WCAG 2.1 SC 1.3.1 and SC 4.1.2 require that cell content conveys its meaning programmatically.

**Recommendation:** Replace with `<span aria-label={t("No unsaved changes")} className="..." aria-hidden="false">—</span>` or use a visually hidden label: `<span aria-hidden="true">—</span><span className="sr-only">{t("No unsaved changes")}</span>`.

---

### F-08 — MEDIUM | `ConflictOfInterestBanner` renders the `message` prop without `t()`

**File:** `frontend/src/features/permissions/ConflictOfInterestBanner.tsx:39`

**Evidence:**
```tsx
<p className="text-muted-foreground">{message}</p>
```

**Why it matters:** The `message` prop is a raw string with no `t()` wrapping applied at the call site OR inside the component. Since this is a dynamic value supplied by callers, the component itself cannot wrap it — but the contract is not documented, leaving callers likely to pass unwrapped English literals. Any caller passing a string literal without `t()` violates invariant #13.

**Recommendation:** Document in the prop type that callers MUST pass an already-translated string (`message: string // must be pre-translated via t()`). Audit all call sites of `ConflictOfInterestBanner` and ensure every `message` prop value is wrapped in `t()` at the call site.

---

### F-09 — LOW | `<tr aria-label>` uses email but full name is the visual primary identity

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:348`

**Evidence:**
```tsx
<tr key={row.user_id} aria-label={row.user_email}>
```
Visually, the cell shows `row.user_full_name` prominently with `row.user_email` as secondary text.

**Why it matters:** The row's accessible name is the email address, but screen reader users hear the email when entering the row, while sighted users read the full name first. This is a minor inconsistency. WCAG 2.1 SC 2.4.6 (Headings and Labels) recommends labels be descriptive.

**Recommendation:** Use both: `aria-label={`${row.user_full_name} (${row.user_email})`}` to match the visual presentation order.

---

### F-10 — LOW | Role badge strings in `MemberCell` are not wrapped in `t()`

**File:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:435-443`

**Evidence:**
```tsx
{row.roles.map((r) => (
  <span key={r} className="...">
    {r}
  </span>
))}
```

**Why it matters:** Role names (e.g., `"admin"`, `"scorer"`) are server-supplied enum values. They are displayed raw without `t()`. If role labels are ever localised or display-label-mapped (e.g., `"admin"` → `"Administrator"`), this is a gap. While enum values themselves may not change, the invariant #13 intent is to wrap every user-visible string. If role display labels are ever stored server-side as keys, the client should translate them.

**Recommendation:** Define a `ROLE_LABELS` map in a shared types file (e.g., `{ admin: t("Admin"), scorer: t("Scorer"), ... }`) and render `ROLE_LABELS[r] ?? r` rather than the raw server value. This also allows capitalisation to be consistent.

---

### F-11 — LOW | `ConflictOfInterestBanner` warning icon is a bare `!` text character

**File:** `frontend/src/features/permissions/ConflictOfInterestBanner.tsx:34-36`

**Evidence:**
```tsx
<span aria-hidden="true" className="text-base font-bold">
  !
</span>
```

**Why it matters:** This is correctly `aria-hidden="true"` so it does not interfere with screen readers. However, the banner has `role="alert"` which will announce the entire text content including "! Conflict of interest [message]...". The `!` does not add meaning and the `role="alert"` is already sufficient to convey urgency. No WCAG violation, but the implementation could be cleaner.

**Recommendation (informational):** Replace the `!` text character with a Lucide `AlertTriangle` icon (matching the project's icon library), kept `aria-hidden="true"`. This improves visual consistency with the rest of the UI and avoids the quirky punctuation-as-icon pattern.

---

## Gaps (forward-looking, not current violations)

| # | Area | Gap | Needed for | Effort |
|---|------|-----|-----------|--------|
| G-01 | i18n infrastructure | `t()` is a no-op passthrough. No locale file, no plural support, no ICU message format. When `editedRowCount` strings like `"{{count}} rows"` need pluralisation (e.g., "1 row" vs "2 rows"), the current `t()` shim cannot handle it. | Proper i18n when second language added | M |
| G-02 | Dark-mode color tokens | `grant`, `deny`, `warn` tokens are hardcoded HSL values, not CSS variables. A dark-mode color audit across the entire matrix will be needed once dark mode is actively tested. | Dark mode UI | S |
| G-03 | Focus management on matrix save | After a row Save completes (success or error), focus is not explicitly managed. If the Save button disappears on success, focus is lost (browser moves it to `<body>`). | WCAG 2.1 SC 2.4.3 | S |
| G-04 | Horizontal scroll + keyboard | The table overflows horizontally (`overflow-x-auto`). There is no `tabindex="0"` on the scroll container, so keyboard users cannot scroll it horizontally via arrow keys. | WCAG 2.1 SC 1.3.4 / 2.1.1 | S |
| G-05 | Live region for cell-change announcements | Cycling a cell state (default → grant → deny) does not announce the new state to assistive technology other than via the updated `aria-label`. Screen reader announcements depend on AT detecting the attribute change, which is not guaranteed for `aria-label` on non-live elements. An `aria-live="polite"` region announcing the change would be more robust. | Reliable screen reader UX | M |
| G-06 | Playwright a11y tests | No end-to-end or `axe-core` automated accessibility tests exist for the permissions matrix (unit tests cover interaction logic only). | CI a11y gate | M |
| G-07 | `ConflictOfInterestBanner` caller audit | No audit has been done of call sites for this component to verify all `message` props are `t()`-wrapped. | Invariant #13 compliance | S |

---

*Audited files:*
- `frontend/src/features/permissions/ConflictOfInterestBanner.tsx`
- `frontend/src/features/permissions/GrantCell.tsx`
- `frontend/src/features/permissions/ModuleMatrixPage.tsx`
- `frontend/tailwind.config.js` (color tokens)
- `frontend/src/index.css` (CSS variables / dark-mode tokens)
