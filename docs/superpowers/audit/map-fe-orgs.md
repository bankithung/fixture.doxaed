# fe-orgs Area Map

**Generated:** 2026-06-04  
**Scope:** `frontend/src/features/orgs/` + `frontend/src/api/orgs.ts`  
**Status:** Phase 1A implemented and running; Phase 1B not built.

---

## Overview

The `fe-orgs` area covers every org-management surface visible to authenticated
users: the org/role switcher embedded in the app shell, the invite create and
accept flows, the member directory, org settings, org branding, the org-scoped
audit log, the ownership transfer modal, and the dashboard-card configuration
model. It is the most complete and densely tested frontend feature area in the
current codebase.

---

## File Inventory

| File | Purpose |
|------|---------|
| `frontend/src/api/orgs.ts` | API client layer — typed wrappers around DRF org endpoints |
| `frontend/src/features/orgs/OrgSwitcherStore.ts` | Zustand store — mirrors URL slug + active role for non-routed components |
| `frontend/src/features/orgs/OrgSwitcher.tsx` | Org-selector `<select>` + multi-role radiogroup embedded in `AppShell` |
| `frontend/src/features/orgs/InviteAcceptPage.tsx` | Standalone `/accept?token=` page; calls `acceptInvitation`, re-bootstraps auth |
| `frontend/src/features/orgs/InviteCreateModal.tsx` | Dialog — invite form (email, roles, optional message) + sent-view with copy-link |
| `frontend/src/features/orgs/InvitationsListPanel.tsx` | Companion panel for pending invites: revoke + copy link per row |
| `frontend/src/features/orgs/MemberDirectoryPage.tsx` | Member table with search, inline remove action, module-gated |
| `frontend/src/features/orgs/OrgSettingsPage.tsx` | PATCH form for org name + time zone; slug read-only |
| `frontend/src/features/orgs/OrgBrandingPage.tsx` | Phase 1B stub — identity preview + disabled fieldset; branding fields pending migration |
| `frontend/src/features/orgs/OrgAuditLogPage.tsx` | Cursor-paginated audit event table; module-gated (`org.audit_log`) |
| `frontend/src/features/orgs/OwnershipTransferModal.tsx` | Transfer form (new_owner_user_id + reason); conflict-of-interest banner; event_id |
| `frontend/src/features/orgs/dashboardCards.ts` | Pure function `computeDashboardCards` + `MODULES` constants for dashboard layout |
| `frontend/src/features/orgs/__tests__/` | 6 test files covering: InviteCreateModal (4), OrgSwitcher (2), MemberDirectory (6), OrgBrandingPage (4), OrgSettingsPage (4), dashboardCards (12) |

---

## Models / Types

**From `api/orgs.ts`:**

- `Organization` — re-exported from `components["schemas"]["Organization"]` (OpenAPI codegen); fields: `id`, `slug`, `name`, `status`, `time_zone`, `created_at`, etc.
- `Membership` — `components["schemas"]["OrganizationMembership"]`; used only for `acceptInvitation` response shape.
- `OrgMember` — hand-authored interface for `GET /api/orgs/{slug}/members/`; includes `id` (membership UUID), `user_id`, `email`, `full_name`, `roles: string[]`, `is_org_owner`, `joined_at`, `is_active`.
- `InvitationListItem` — `id`, `email`, `roles`, `status` (pending|accepted|expired|revoked), `expires_at`, `invited_by_email`, `token?`.
- `MembersResponse = OrgMember[] | Paginated<OrgMember>` — dual-shape for list or DRF envelope.
- `InvitationsResponse = InvitationListItem[] | Paginated<InvitationListItem>` — same dual-shape.

**From `OrgSettingsPage.tsx` / `OrgBrandingPage.tsx`:**

- `OrgDetail` — locally-defined interface (duplicated in both files); not pulled from `api/orgs.ts` or the generated schema.

**From `dashboardCards.ts`:**

- `DashboardCardKey` — union of 9 string literals.
- `DashboardCardConfig` — `{ key, icon, title, description, href?, action?, badge? }`.
- `MODULES` — `const` map of module code strings aligned to `apps/permissions/fixtures/modules.json`.

---

## Endpoints Called

| Method | Path | Called from |
|--------|------|------------|
| `GET` | `/api/orgs/` | `orgsApi.list` (not called inside `fe-orgs`; used upstream) |
| `GET` | `/api/orgs/{slug}/` | `OrgSettingsPage`, `OrgBrandingPage` (via `api.get` directly, not through `orgsApi`) |
| `PATCH` | `/api/orgs/{uuid}/` | `OrgSettingsPage.update` |
| `GET` | `/api/orgs/{slug}/members/` | `MemberDirectoryPage` |
| `DELETE` | `/api/orgs/{orgUuid}/members/{membershipId}/` | `MemberDirectoryPage.removeMember` |
| `GET` | `/api/orgs/{slug}/invitations/` | `InvitationsListPanel` |
| `POST` | `/api/orgs/{slug}/invitations/` | `InviteCreateModal` |
| `DELETE` | `/api/orgs/{slug}/invitations/{id}/` | `InvitationsListPanel.revoke` |
| `POST` | `/api/orgs/invitations/accept/` | `InviteAcceptPage` |
| `POST` | `/api/orgs/{slug}/ownership/transfer/` | `OwnershipTransferModal` |
| `GET` | `/api/audit/orgs/{slug}/` | `OrgAuditLogPage` (via `auditApi.list`) |
| `PATCH` | `/api/auth/me/` | `OrgSwitcher` (persist `last_active_org_id`) |

---

## Routes Registered (App.tsx)

| Path | Component |
|------|-----------|
| `/accept` | `InviteAcceptPage` (unprotected) |
| `/o/:orgSlug/members` | `MemberDirectoryPage` |
| `/o/:orgSlug/audit` | `OrgAuditLogPage` |
| `/o/:orgSlug/settings` | `OrgSettingsPage` |
| `/o/:orgSlug/branding` | `OrgBrandingPage` |
| `/o/:orgSlug/tournaments-coming-soon` | `ComingSoonPage` (not from `fe-orgs`) |

`OrgSwitcher` is rendered inside `AppShell` (not a route).  
`InviteCreateModal`, `InvitationsListPanel`, `OwnershipTransferModal` are rendered as children of other pages (no own routes).

---

## Findings

### F-01 — CRITICAL: `OwnershipTransferModal` is exported but never imported anywhere

**File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx`  
**Evidence:** Grep for `OwnershipTransferModal` finds only the definition file; no other file imports it.  
**Why it matters:** The ownership-transfer feature (v1Users.md §2.14) is fully implemented on both backend and frontend but is completely unreachable by users — there is no UI surface that opens the modal. The `MemberDirectoryPage` has member-remove logic but no ownership-transfer entry point. The `OrgSettingsPage` has no "Dangerous zone" / transfer section.  
**Recommendation:** Wire the modal into `OrgSettingsPage` or `MemberDirectoryPage` (owner row) with an explicit "Transfer ownership" button guarded by `isOrgOwner`. Also add a test for the modal itself (currently zero tests exist for it).

---

### F-02 — HIGH: `OrgDetail` interface is duplicated; not sourced from generated schema

**Files:**  
- `frontend/src/features/orgs/OrgSettingsPage.tsx:41–51`  
- `frontend/src/features/orgs/OrgBrandingPage.tsx:37–47`

**Evidence:**
```ts
// OrgSettingsPage.tsx:41
interface OrgDetail {
  id: string; slug: string; name: string; status: string;
  time_zone?: string; created_at: string;
  archived_at: string | null; suspended_at: string | null;
  suspended_reason: string;
}
```
The same interface is copy-pasted verbatim in `OrgBrandingPage.tsx:37–47`. The canonical type exists in the generated schema as `components["schemas"]["Organization"]` (already re-exported as `Organization` in `api/orgs.ts`).  
**Why it matters:** If the backend adds or renames a field (e.g. `logo`, `primary_color`), only `api/orgs.ts` and `api.generated.ts` are updated — these two local duplicates silently drift. The branding page especially needs the logo/color fields.  
**Recommendation:** Delete both local `OrgDetail` definitions. Import and use `Organization` from `@/api/orgs` (which already re-exports the generated schema type). Add `time_zone` to the generated schema if it is currently missing; if not missing, use it directly.

---

### F-03 — HIGH: `OrgBrandingPage` is a visually complete stub — brand asset fields are hardcoded and non-functional

**File:** `frontend/src/features/orgs/OrgBrandingPage.tsx:199–250`  
**Evidence:**
```tsx
// OrgBrandingPage.tsx:219
<Input id="brand-color" type="text" value="#10b981" readOnly ... />
```
The fieldset is `disabled`, the color is hardcoded `"#10b981"`, and the logo input has an empty `value`. The note at line 246 explicitly says:
```
"Branding fields coming with Phase 1B. The Organization model does not yet
store color or logo, so saves are disabled until that migration ships."
```
**Why it matters:** The route `/o/:orgSlug/branding` is live, module-gated, and listed in the dashboard. Users who have the `org.branding` module will navigate here and see a non-functional form. The comment in `App.tsx:167–170` still labels it as a "placeholder" while `OrgBrandingPage` comments call it a replacement for the `ComingSoonPage`.  
**Recommendation:** Either replace with an explicit `ComingSoonPage` (same pattern as `tournaments-coming-soon`) until the backend migration ships, or document clearly in the page UI that this is a preview. Track as a Phase 1B prerequisite: add `primary_color` and `logo` columns to `Organization`, then activate the form.

---

### F-04 — HIGH: `OrgSettingsPage` — PATCH uses UUID but fetches by slug; two round-trips required

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:157–204`  
**Evidence:**
```ts
// OrgSettingsPage.tsx:157–159
queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),  // fetch by slug
...
// OrgSettingsPage.tsx:184
return api.patch<OrgDetail>(`/api/orgs/${orgQuery.data.id}/`, values);  // PATCH by UUID
```
The page must first `GET` by slug to obtain the `id`, then `PATCH` using that UUID. This is intentional (the backend rejects `PATCH` by slug — noted in the comment), but the UUID is never stored in `orgsApi` or a cache key; each page mount triggers a fresh fetch.  
**Why it matters:** Minor UX friction (latency on cold load before the form can submit), and more importantly, the `Update` button is enabled only after the GET resolves — any failure on the GET silently blocks saving. The pattern also means this information is not shared with `OrgBrandingPage`, which performs an identical GET independently.  
**Recommendation:** Add a `detail(slugOrUuid)` function to `orgsApi` so both pages share one cache entry `["org", slug, "detail"]`. Consider prefetching the org detail in the route loader or in `AppShell` so it is available before the page renders.

---

### F-05 — MEDIUM: `InviteAcceptPage` — typo in success status class `text-grant` is valid but unintuitive

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:83`  
**Evidence:**
```tsx
<p role="status" className="text-sm text-grant">
  {t("You're now a member.")}
</p>
```
`text-grant` is a real Tailwind token defined in `tailwind.config.js:47` (`grant: { DEFAULT: "hsl(142 71% 45%)" }`) for the module-override matrix. Using it on an invite-accept success message is semantically correct (green = positive) but leaks a domain-specific colour token into an unrelated context. The same pattern appears in `VerifyEmailPage` and `TwoFactorEnrollPage`.  
**Why it matters:** Low risk now, but if the `grant` colour is ever changed for permission-matrix branding reasons, success messages across unrelated pages change color unexpectedly.  
**Recommendation:** Use `text-emerald-600` or introduce a semantic token `--success` / `text-success` in `index.css`. The change is cosmetic but matters for maintainability.

---

### F-06 — MEDIUM: `InviteCreateModal` — fallback clipboard path uses deprecated `document.execCommand("copy")`

**File:** `frontend/src/features/orgs/InviteCreateModal.tsx:301–305`  
**Evidence:**
```ts
} else if (typeof document !== "undefined") {
  const el = document.getElementById(inputId) as HTMLInputElement | null;
  el?.select();
  document.execCommand("copy");  // deprecated
}
```
`navigator.clipboard.writeText` is tried first and is available in all modern browsers over HTTPS. The `execCommand` fallback is deprecated (removed in most contexts on secure origins) and is unreachable in practice since the app runs HTTPS.  
**Why it matters:** Low functional risk; the dead code adds confusion and will trigger ESLint `no-deprecated-api` if that rule is enabled.  
**Recommendation:** Remove the `execCommand` branch. Keep only the `navigator.clipboard.writeText` path. `InvitationsListPanel.tsx` already does this correctly (no `execCommand`).

---

### F-07 — MEDIUM: `MemberDirectoryPage` — `window.confirm` used for remove-member confirmation

**File:** `frontend/src/features/orgs/MemberDirectoryPage.tsx:319–325`  
**Evidence:**
```ts
if (
  typeof window !== "undefined" &&
  !window.confirm(t(`Remove ${displayName} from this organization?`))
) {
  return;
}
```
`window.confirm` is a blocking modal outside React's render cycle and cannot be i18n-styled or accessibility-tested with standard testing tools. Tests that exercise `onRemove` would need to mock `window.confirm`.  
**Why it matters:** Poor UX (browser-native dialog, unstyled), cannot be localized with `gettext` in a way that changes display formatting, and blocks automated accessibility testing.  
**Recommendation:** Replace with a small inline confirmation state or a custom confirmation `Dialog` component. This is consistent with how `OwnershipTransferModal` handles confirmation.

---

### F-08 — MEDIUM: `OrgAuditLogPage` — no tests; module check uses `.includes()` not a `Set`; "Previous" pagination is broken by design

**File:** `frontend/src/features/orgs/OrgAuditLogPage.tsx`  
**Evidence (no tests):** No `__tests__/OrgAuditLogPage.test.tsx` file exists anywhere in the repo.  
**Evidence (includes vs Set):**
```ts
// OrgAuditLogPage.tsx:66
const hasModule = membership?.effective_modules?.includes("org.audit_log");
```
Other pages use `new Set(...)` for O(1) lookup; this is O(n) but trivially fast for the small module list.  
**Evidence (Previous pagination):**
```ts
// OrgAuditLogPage.tsx:68
const [cursor, React.useState<string | null>(null);
// OrgAuditLogPage.tsx:95–96
const nextCursor = query.data?.next_cursor ?? null;
const prevCursor = query.data?.previous_cursor ?? null;
```
The Previous button sets `cursor` to `prevCursor`. Because the query key is `["audit", slug, cursor]`, going to page 2 then clicking Previous re-fetches page 1, but only if `previous_cursor` from the page 2 response points to a valid cursor. Whether the backend implements `previous_cursor` for cursor-based pagination needs to be verified; many cursor implementations are forward-only.  
**Why it matters:** Zero test coverage for a security-critical surface (append-only audit record). If the backend does not return `previous_cursor`, the Previous button is permanently disabled, giving the illusion of forward-only pagination without explanation.  
**Recommendation:** (a) Add test file covering: module gate shows access-required card; table renders rows; pagination controls hidden when no cursor. (b) Confirm with backend whether `previous_cursor` is implemented; if not, remove the Previous button and add a note that logs are append-only and forward-paginated. (c) Add a date-range filter `<input>` since the `auditApi.list` already accepts `from` / `to` params but the UI exposes no way to use them.

---

### F-09 — MEDIUM: `OrgSwitcher` — uses a plain `<select>` element; not consistent with Pro SaaS UI/UX goal

**File:** `frontend/src/features/orgs/OrgSwitcher.tsx:52–69`  
**Evidence:**
```tsx
<select
  id="org-switcher"
  value={current.org_slug}
  onChange={...}
  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
>
```
The locked product decision calls for "Pro SaaS UI/UX overhaul" using shadcn/ui + lucide + framer-motion. The `<select>` element is a native OS control that cannot be styled consistently across browsers and does not follow the shadcn design language.  
**Why it matters:** Visual inconsistency in the primary navigation chrome. The role radiogroup also uses plain `<button>` elements without a shadcn `RadioGroup` equivalent.  
**Recommendation:** Upgrade to a shadcn `Select` (Radix UI based) for the org picker and `ToggleGroup` for the role switcher. This is a Phase 1B / UI overhaul task.

---

### F-10 — LOW: `OrgSwitcher` — `activeRole` state is written but never read by any consumer

**File:** `frontend/src/features/orgs/OrgSwitcherStore.ts:15` and `OrgSwitcher.tsx:23`  
**Evidence:**
```ts
// OrgSwitcherStore.ts:15
activeRole: string | null;
setActiveRole: (role: string | null) => void;
```
`setActiveRole` is called from `OrgSwitcher.tsx:44` when a role radio is clicked, and `activeRole` is read only within `OrgSwitcher.tsx` itself (to style the active radio). No other file reads `useOrgSwitcher((s) => s.activeRole)`.  
**Why it matters:** The store comment says this is for "multi-role users" who need different permission views, but there is no code path that actually changes any permission check, data filter, or route based on `activeRole`. It is dead state at the application level.  
**Recommendation:** Either (a) implement actual role-scoped views that consume `activeRole`, or (b) remove the store field and the role radio UI until Phase 1B defines the spec for multi-role context switching.

---

### F-11 — LOW: `dashboardCards.ts` — `CARD_ICONS` exports `ClipboardList` but no card uses it; icon is imported but unused

**File:** `frontend/src/features/orgs/dashboardCards.ts:255–265`  
**Evidence:**
```ts
// dashboardCards.ts:255
export const CARD_ICONS = {
  Users, Settings, Shield, FileText, Trophy, Palette,
  UserRound, Bell, MessageSquare,
  ClipboardList,  // <-- imported at line 8 but not used in any card config
} as const;
```
`ClipboardList` is imported at the top of the file and added to the exported map, but `computeDashboardCards` never uses it.  
**Why it matters:** Dead import; will fail tree-shaking if the bundler does not detect the re-export pattern. Creates confusion about whether a "Clipboard" card was planned.  
**Recommendation:** Remove `ClipboardList` from the import and `CARD_ICONS` export, or add the planned card that uses it.

---

### F-12 — LOW: `InviteCreateModal` — `message` field is collected but not sent to the backend

**File:** `frontend/src/features/orgs/InviteCreateModal.tsx:97–104`  
**Evidence:**
```ts
mutationFn: (values: FormValues) =>
  orgsApi.createInvitation(orgSlug, {
    email: values.email,
    roles: values.roles,
    event_id: newEventId(),
    // values.message is NOT included here
  }),
```
The form schema defines `message: z.string().max(500).optional()` and the textarea renders and accepts input, but the `createInvitation` payload omits it entirely.  
**Why it matters:** Users may type a personal note expecting it to be sent with the invite email. The field is silently dropped.  
**Recommendation:** Either (a) add `message` to `createInvitation`'s payload type and the `POST /api/orgs/{slug}/invitations/` body (if the backend accepts it), or (b) remove the `message` textarea and its schema field until the backend supports it.

---

### F-13 — INFO: `dashboardCards.ts` — `computeDashboardCards` has excellent test coverage (12 test cases)

**File:** `frontend/src/features/orgs/__tests__/dashboardCards.test.ts`  
The only pure-function utility in the area; thoroughly tested for all 7 roles, backward-compat modes, edge cases (null membership, empty modules), and badge/action sentinel values. This is a reference implementation for other feature-area utilities.

---

### F-14 — INFO: `InviteAcceptPage` — unprotected route; handles unauthenticated state gracefully

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:62–79`  
`InviteAcceptPage` is mounted outside `ProtectedRoute` (App.tsx:111). When `user` is null it shows a "Sign in to continue" link with a `?next=` redirect back to the accept URL. This is the correct flow per v1Users.md §2.13.

---

### F-15 — INFO: `orgsApi.removeMember` uses membership `id`, not `user_id`; correct but fragile

**File:** `frontend/src/api/orgs.ts:88–94`  
The comment correctly notes:
```ts
// The membership id (NOT user id) is required — it is the row primary key,
// available as OrgMember.id.
```
`MemberDirectoryPage` correctly passes `m.id` (the membership UUID). The `OrgMember` interface exports both `id` and `user_id` which are easy to confuse. No type guard prevents passing `user_id` to `removeMember`.  
**Recommendation:** Consider renaming `OrgMember.id` to `OrgMember.membership_id` to make the distinction explicit, or add a JSDoc `@param` type-guard comment at the call site.

---

## Gaps

1. **No tests for `OwnershipTransferModal`** — the most security-critical flow in the area (irreversible ownership transfer with audit-log requirement) has zero test coverage.

2. **No tests for `OrgAuditLogPage`** — module-gated security surface; no test for the access-denied path, table rendering, or cursor pagination.

3. **No tests for `InviteAcceptPage`** — the invite accept flow (unprotected route, session re-bootstrap, token validation) is untested.

4. **No tests for `InvitationsListPanel`** — revoke mutation, copy-link affordance, and "pending only" filtering are untested.

5. **`OwnershipTransferModal` is unreachable** — no page opens it; the feature is dead-end UX despite being fully implemented.

6. **`OrgBrandingPage` branding fields** — backend `Organization` model does not have `primary_color` or `logo`; the form is deliberately disabled but is registered as an active route. Phase 1B prerequisite.

7. **`auditApi` filter params unused in UI** — `actor_id`, `event_type`, `from`, `to` query params are accepted by the backend but no filter controls exist in `OrgAuditLogPage`.

8. **`activeRole` store field** — collected in the switcher but consumed nowhere in the app; the multi-role context-switching feature is unfinished.

9. **No pagination in `MemberDirectoryPage`** — the page calls `unwrapList` to normalise a `Paginated<OrgMember>` envelope, but there is no UI for navigating pages. If an org has > page-size members, the table silently truncates.

10. **Slug-change UI absent** — `OrgSettingsPage` notes that slug changes go through `POST /api/orgs/{uuid}:change_slug/` but no UI surface exposes this. The endpoint is present in the generated schema (`types/api.generated.ts:560`).
