# Audit: frontend/src/features/orgs — UI/UX Quality & Test Coverage

**Date:** 2026-06-04
**Lens:** Visual/UX quality vs professional SaaS bar (shadcn/ui, lucide, framer-motion, cohesive colors, dark mode) + missing vitest coverage for guards/permission gating/error states.

---

## Findings

### F-01 [HIGH] No Radix UI / true shadcn Dialog — hand-rolled modal lacks focus trap and portal

**File:** `frontend/src/components/ui/dialog.tsx:9`
**Evidence:**
```tsx
// Tiny accessible modal-dialog primitive. We avoid pulling Radix into this
// scaffold to keep the package surface minimal. Replace with @radix-ui/dialog
// when shadcn primitives are formally adopted.
```
The `Dialog` implementation is a custom div that renders inline in the DOM (no React portal), has no focus trap, and its "close on outside click" relies on `e.target === e.currentTarget` which breaks if any child's `stopPropagation` fires. The admitted comment says "replace with @radix-ui/dialog" — but both `InviteCreateModal` and `OwnershipTransferModal` use this modal for consequential destructive actions. On a pro SaaS bar this is a critical gap: modals must trap focus (WCAG 2.1 AA §2.1.2), return focus on close, and mount in a portal so they are not clipped by overflow containers.

**Recommendation:** Install `@radix-ui/react-dialog` (or the full shadcn/ui CLI), replace `dialog.tsx` with the shadcn Dialog primitive. All existing consumers keep the same JSX API shape.

---

### F-02 [HIGH] `OrgSwitcher` uses a raw `<select>` — looks like a 2012 browser default

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:53-69`
**Evidence:**
```tsx
<select
  id="org-switcher"
  value={current.org_slug}
  onChange={...}
  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
>
```
The `<select>` element is not styleable across OS/browser. It appears as a native OS dropdown (grey/chrome default on Windows, macOS system font on Mac). SaaS platforms like Linear, Vercel, and Notion all replace org switchers with a composable Popover + Command palette. The role-radiogroup adjacent to it (a group of `<button role="radio">`) is also tightly cramped and has no animation or active state beyond `font-medium shadow-sm`.

**Recommendation:** Replace the native `<select>` with a Radix `Popover` + `Command` (shadcn/ui `Combobox`) pattern. The role radiogroup becomes a `ToggleGroup`. Both get coherent motion via `framer-motion` `AnimatePresence`.

---

### F-03 [HIGH] `framer-motion` is not installed — zero animation throughout the org feature

**File:** `frontend/package.json` (no `framer-motion` in dependencies)
**Evidence:** `package.json` lists no `framer-motion` entry. The entire `frontend/src/features/orgs/` tree has zero `motion.*` or `AnimatePresence` usage. The owner explicitly wants framer-motion as part of the overhaul. Currently: page transitions are instantaneous, modals pop in with no enter animation, loading skeletons appear without fade, list items appear without stagger.

**Recommendation:** `npm install framer-motion`. Add `AnimatePresence` + `motion.div` to: modal open/close, loading skeleton fade, member row stagger mount, dashboard card hover lift, page-level slide-in transitions.

---

### F-04 [HIGH] `OrgBrandingPage` hardcodes raw Tailwind `bg-emerald-100/text-emerald-700` — bypasses the design-token system

**File:** `frontend/src/features/orgs/OrgBrandingPage.tsx:173,226`
**Evidence:**
```tsx
className="inline-flex h-12 w-12 ... rounded-md bg-emerald-100 text-emerald-700"
// and
className="inline-block h-8 w-8 rounded-md border bg-emerald-500"
```
These hardcoded `bg-emerald-*` values are outside the CSS-variable token system defined in `tailwind.config.js` (`--primary`, `--brand`, etc.). In dark mode the `bg-emerald-100` swatch does not invert — it will appear the same washed-out green on a dark background. The system already defines `brand.DEFAULT`, `brand.muted`, and `brand.ink` tokens for this exact purpose.

**Recommendation:** Replace `bg-emerald-100 text-emerald-700` with `bg-brand-muted text-brand` and `bg-emerald-500` with `bg-brand`. This makes the placeholder swatch honour the design-token layer and respond correctly in dark mode.

---

### F-05 [MEDIUM] Dark mode CSS variables are defined but no `class="dark"` toggle exists — dark mode is unreachable by users

**File:** `frontend/src/index.css:45-65`
**Evidence:**
```css
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  ...
}
```
The CSS variables for dark mode are fully defined in `index.css` and `tailwind.config.js` sets `darkMode: ["class"]`. However there is no theme toggle anywhere in `frontend/src/features/orgs/` or the AppShell. The `.dark` class is never applied. Users cannot activate dark mode. For a "pro SaaS UI/UX overhaul" this is a showstopper omission.

**Recommendation:** Add a `ThemeStore` (Zustand, persists to `localStorage`) and a `<ThemeToggle>` button (sun/moon icons from lucide) in the AppShell header. On mount, read stored preference or `prefers-color-scheme` media query and apply `document.documentElement.classList.toggle('dark')`.

---

### F-06 [MEDIUM] `window.confirm()` used for destructive "Remove member" confirmation — breaks pro SaaS feel and is untestable

**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:320-325`
**Evidence:**
```tsx
if (
  typeof window !== "undefined" &&
  !window.confirm(t(`Remove ${displayName} from this organization?`))
) {
  return;
}
```
`window.confirm()` is a blocking browser dialog that cannot be styled, does not respect the app's theme, looks completely alien in a modern SaaS UI, and must be explicitly mocked in every test. In jsdom it returns `true` by default (silently allowing removals in tests). The pattern contradicts the existing `Dialog`+`Button` component system used elsewhere.

**Recommendation:** Replace with a small inline confirmation `Dialog` (same pattern as `OwnershipTransferModal`) that shows the member's name, has Cancel/Remove buttons, and uses `variant="destructive"` on the confirm button. This is already testable via `userEvent.click`.

---

### F-07 [MEDIUM] `OrgSettingsPage` timezone dropdown is a raw `<select>` with only 16 options — not searchable

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:300-314`
**Evidence:**
```tsx
<select
  id="org-tz"
  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ..."
  {...form.register("time_zone")}
>
  {TIMEZONE_OPTIONS.map((tz) => (
    <option key={tz} value={tz}>{tz}</option>
  ))}
</select>
```
Only 16 timezones are offered. IANA has 600+. A sports platform serving Nagaland needs at least the full Asia/\* range. The native `<select>` is not searchable. Users from other supported regions (e.g., Australia, Americas) will have to pick whatever is closest in the list.

**Recommendation:** Use `Intl.supportedValuesOf('timeZone')` (or a curated 80-entry list covering Asia and common global cities) behind a shadcn `Combobox` with search filtering. Pair with `@radix-ui/react-select` or full shadcn Select component so it is styleable in dark mode.

---

### F-08 [MEDIUM] `OrgAuditLogPage` audit table has no column resizing, no date-range filter, no search — bare minimum

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx:149-181`
**Evidence:**
```tsx
<table className="min-w-full text-sm">
  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
    <tr>
      <th className="px-3 py-2 font-medium">{t("When")}</th>
      <th className="px-3 py-2 font-medium">{t("Event")}</th>
      <th className="px-3 py-2 font-medium">{t("Actor")}</th>
      <th className="px-3 py-2 font-medium">{t("Target")}</th>
    </tr>
  </thead>
```
The audit table is a plain `<table>` with no sticky header, no event-type filter, no actor search, and no date-range picker. Cursor-based pagination exists but Previous/Next buttons are the only navigation. Pro SaaS audit logs (Vercel, Linear, GitHub) offer at minimum an event-type chip filter and an actor search.

**Recommendation:** Add an event-type multi-select chip filter (above the table) and an actor email search input. Derive these as client-side filters over the current page; server-side filter params can come later. Also fix the `<th>` heading row so it is sticky on scroll (`sticky top-0 z-10`).

---

### F-09 [MEDIUM] `InviteAcceptPage` success paragraph uses `text-grant` — an undefined/non-standard Tailwind class

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:83`
**Evidence:**
```tsx
<p role="status" className="text-sm text-grant">
  {t("You're now a member.")}
</p>
```
`text-grant` is a custom token defined in `tailwind.config.js` as `grant: { DEFAULT: "hsl(142 71% 45%)" }` (green). However the `text-grant` utility would need to be `text-grant-DEFAULT` or just `text-[hsl(...)]` to work — Tailwind generates `text-grant` as the DEFAULT only for colour maps defined at the root level; nested objects generate `text-grant` as a shorthand. Empirically this is the correct pattern for the config as written, BUT in dark mode `hsl(142 71% 45%)` is a bright green that does not invert. The success text is nearly invisible on a dark card background.

**Recommendation:** Replace with `text-green-600 dark:text-green-400` or add a dedicated `--success-foreground` CSS variable pair (light + dark) in `index.css` and consume via `text-success-foreground`.

---

### F-10 [MEDIUM] `InviteCreateModal` `CopyField` uses deprecated `document.execCommand('copy')` as clipboard fallback

**File:** `frontend/src/features/orgs/InviteCreateModal.tsx:300-306`
**Evidence:**
```tsx
} else if (typeof document !== "undefined") {
  const el = document.getElementById(inputId) as HTMLInputElement | null;
  el?.select();
  document.execCommand("copy");
}
```
`document.execCommand` is deprecated and removed from browsers since Chrome 104. The fallback path is dead in all modern engines and will silently fail. The `try/catch` masks the failure.

**Recommendation:** Remove the `execCommand` fallback. Modern browsers all support `navigator.clipboard.writeText`. If clipboard API is genuinely unavailable (non-HTTPS iframe), show a "Copy manually" toast and focus+select the input instead of silently failing.

---

### F-11 [MEDIUM] `OwnershipTransferModal` accepts a raw user-ID string in a plain `<Input>` — no member autocomplete

**File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:119-126`
**Evidence:**
```tsx
<Label htmlFor="transfer-target">{t("New owner (user ID)")}</Label>
<Input
  id="transfer-target"
  value={toUserId}
  onChange={(e) => setToUserId(e.target.value)}
  placeholder="01HF..."
/>
```
The label literally says "user ID" — forcing an admin to know a UUID v7 value. A professional UX replaces this with a searchable member picker (Combobox filtered from the org's `/members` list). An admin should never need to manually type a UUID.

**Recommendation:** Replace the plain `Input` with a Combobox that fetches from the `["org", orgSlug, "members"]` query (already cached by MemberDirectoryPage). Show avatar + name + email in the dropdown. Retain the hidden UUID as the form value.

---

### F-12 [MEDIUM] `DashboardCard` icon container uses `bg-secondary` uniformly — no per-card color identity

**File:** `frontend/src/components/ui/DashboardCard.tsx:53`
**Evidence:**
```tsx
className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"
```
Every dashboard card icon has the same dull `bg-secondary` (grey) color. Pro SaaS dashboards (Linear, Notion, Vercel) use color-coded icons per category — settings cards get a slate/blue, members cards get an indigo, audit gets amber, etc. The uniform grey makes the grid look like a feature list rather than a visual navigation system.

**Recommendation:** Add an optional `iconColor?: string` prop to `DashboardCard` (consuming CSS token or Tailwind class pair) and set category-specific colors in `dashboardCards.ts` configs (e.g., members=indigo, settings=slate, audit=amber, branding=violet, tournaments=emerald).

---

### F-13 [LOW] `OrgSwitcher` role radiogroup buttons display raw snake_case role strings — `co_organizer`, `match_scorer`

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:88`
**Evidence:**
```tsx
<button ... >
  {r}
</button>
```
The role value is rendered directly (e.g. `co_organizer`, `match_scorer`). `InviteCreateModal` already has a `ROLE_LABELS` map that translates these to human strings. The switcher should reuse those labels.

**Recommendation:** Import `ROLE_LABELS` from `InviteCreateModal` (or extract to a shared `@/lib/roles.ts` constant) and render `ROLE_LABELS[r] ?? r` in the switcher button text.

---

### F-14 [LOW] `InvitationsListPanel` renders nothing on error — silent failure

**File:** `frontend/src/features/orgs/InvitationsListPanel.tsx:66-70`
**Evidence:**
```tsx
const all = unwrapList(query.data);
const pending = all.filter((i) => i.status === "pending");
if (pending.length === 0) return null;
```
If `query.isError` is true, `query.data` is `undefined`, `unwrapList` returns `[]`, and the component silently renders nothing. The user has no indication that invitations failed to load. The member directory's own error state renders a retry-able error alert; the invitations panel should do the same.

**Recommendation:** Add `if (query.isError) return <error card with Retry>` before the `pending.length === 0` early return.

---

## Missing Test Coverage (Gaps)

### G-01 [BLOCKING] `OrgAuditLogPage` has zero test file

No test file exists for `OrgAuditLogPage.tsx`. The page has non-trivial logic: module-gating (`org.audit_log`), cursor pagination state, error state, loading skeleton, empty state, and the `EventTypeBadge` namespace-split rendering. The permission gate is critical — a referee must not see admin audit events (even though server-side row scoping is Phase 1B, the client gate should still be tested).

**Needed tests:**
- Shows "Access required" card when `org.audit_log` not in effective_modules (permission gate)
- Renders audit rows with correct `EventTypeBadge` namespace split
- Shows loading skeleton then rows on success
- Shows error card with Retry button on fetch failure
- Shows empty-state card when `results` is `[]`
- Previous/Next pagination buttons disabled/enabled correctly

---

### G-02 [BLOCKING] `InviteAcceptPage` has zero test file

`InviteAcceptPage` has four distinct states: no token, unauthenticated user, accept success, accept error. None are tested. The unauthenticated redirect (renders a sign-in link) and the success state (`refreshMe()` is called, org slug is set) are especially important.

**Needed tests:**
- No-token case sets error state immediately
- Unauthenticated user sees "Sign in to continue" link pointing to `/login?next=...`
- Accept success: `orgsApi.acceptInvitation` is called, `refreshMe` is called, success text rendered
- Accept error: `ApiError.payload.detail` is shown in the alert

---

### G-03 [BLOCKING] `InvitationsListPanel` has zero test file

`InvitationsListPanel` has permission gating (`canManage=false → null`), empty-pending filtering (renders null when no pending invites), and a revoke mutation path. The revoke button's optimistic disabled state while revoking is not tested anywhere.

**Needed tests:**
- Returns null when `canManage=false`
- Returns null when there are no pending invitations
- Renders one row per pending invitation with email, roles, expiry
- Revoke button calls `orgsApi.revokeInvitation` and invalidates the cache
- Revoke button is disabled while revoking is in flight
- Shows error toast on revoke failure

---

### G-04 [HIGH] `OwnershipTransferModal` has zero test file

This is a destructive, irreversible action modal with a conflict-of-interest banner, a reason-length guard (`reason.trim().length < 8`), a `conflictAck` checkbox gate, and an idempotent event_id. None are tested.

**Needed tests:**
- Submit button disabled when `toUserId` is empty
- Submit button disabled when `reason` is fewer than 8 characters
- Conflict banner renders when `conflictDetected=true`; submit blocked until `conflictAck` checked
- Successful transfer calls `orgsApi.transferOwnership` with correct payload including event_id
- Error message displayed on transfer failure

---

### G-05 [HIGH] `OrgSwitcher` role-radiogroup path is not tested

`orgSwitcher.test.tsx` only tests the org-switch path for a user with one role (Acme) and asserts the radiogroup is absent. The multi-role path (Globex has `["match_scorer","referee"]`) — where the radiogroup appears and `setActiveRole` is called — is never exercised.

**Needed tests:**
- Selecting the org with multiple roles renders a radiogroup
- Clicking a role button in the radiogroup calls `setActiveRole` with the correct role key

---

### G-06 [MEDIUM] `MemberDirectoryPage` remove-member flow is not tested

The `onRemove` handler calls `window.confirm` then fires `removeMember.mutate`. No test covers the mutation success/error paths (toast shown, query invalidated). The `window.confirm` gate also makes the test require mocking the global, which is a good reason to replace it with a Dialog (F-06).

**Needed tests:**
- Remove member: `window.confirm` returns true → `orgsApi.removeMember` called with correct `(orgUuid, memberId)`
- Success toast shown; members query is invalidated
- Error toast shown on mutation failure
- `window.confirm` returns false → `orgsApi.removeMember` NOT called

---

### G-07 [LOW] `OrgSwitcher` does not test error/pending state for `persistLastActive` mutation

If `authApi.patchMe` rejects, the org navigation still proceeds (the mutation is intentionally non-blocking). No test asserts this behaviour. Given that it is explicitly designed as a best-effort call, a test that verifies navigation still completes on PATCH rejection would lock in that contract.

---
