# Frontend Subsystem: Orgs / Permissions / Roles / Invitations / Notifications / Theme

> Deep read for the platform-wide restructuring. Ground truth as of 2026-06-08.
> Paths are relative to `frontend/src/` unless absolute.

## Purpose

This subsystem is the **org-management and account-chassis UI layer** (Phase 1A "user/account chassis"). It owns:

1. **Org context** — the org+role switcher and the URL→store mirror that makes `:orgSlug` the source of truth.
2. **Org admin surfaces** — settings, branding (stub), member directory, audit log.
3. **Module-RBAC UI** — the per-user module override matrix (grant/deny/default tri-state).
4. **Membership lifecycle** — invite creation (admin side), pending-invite inbox (invitee side), token-link accept, ownership transfer.
5. **Role landing pages** + the post-login `redirectByRole` decision.
6. **Cross-cutting chrome** — notification bell, theme (light/dark/system) toggle + provider.

It is almost entirely a **presentation + TanStack-Query orchestration layer**. Business rules (effective modules, role defaults, invite token validity, audit immutability) live on the backend; the FE mirrors serializer shapes and gates surfaces client-side as an affordance, never as security.

## File-by-file roles

### `api/*` (thin fetch wrappers over `api/client.ts`)
- **`api/orgs.ts`** — `orgsApi`: `list`, `members(slug)`, `invitations(slug)`, `createInvitation`, `revokeInvitation`, `acceptInvitation(token)`, `removeMember(orgUuid, membershipId)`, `transferOwnership(slug)`. Exposes `OrgMember`, `InvitationListItem`, `MembersResponse`/`InvitationsResponse` (array OR `Paginated<T>`), and the `unwrapList<T>()` normaliser. Note the **mixed routing convention**: members/invitations use `slug`, but `removeMember` and the `PATCH` in OrgSettings use the **UUID** (`org_id`).
- **`api/permissions.ts`** — `permissionsApi`: `modules()` (catalog), `myModules(slug)`, `matrix(slug)` (aggregate `{modules, members}`), `setGrants(slug, userId, {cells, reason?, event_id})` (PUT, replaces full per-user cell map).
- **`api/invitations.ts`** — `invitationsApi`: `myInvitations()` (current user's pending), `acceptInvitation(id)` / `declineInvitation(id)`. Uses **colon-verb routes** `/api/invitations/{id}:accept/` (encoded).
- **`api/notifications.ts`** — `notificationsApi`: `list()` (`{results, unread_count}`), `markRead(id)`, `markAllRead()`.
- **`api/audit.ts`** — `auditApi.list(slug, params)`: cursor-paginated; `buildQuery` serialises `cursor/actor_id/event_type/from/to/limit`. Types re-exported from OpenAPI codegen (`AuditEvent`, `AuditEventListResponse`).
- **`api/disputes.ts`** — `disputesApi` (tournament-scoped; not consumed by this subsystem's pages — belongs to tournaments but listed in scope).
- **`api/feedback.ts`** — `feedbackApi.submit(payload)` → `POST /api/feedback/submit/`. Consumed by `OrgDashboardPage` feedback dialog.

### `features/orgs/*`
- **`OrgSwitcherStore.ts`** — Zustand store `{currentSlug, activeRole, setSlugFromUrl, setActiveRole}`. Denormalised mirror of the URL slug; only `AppShell` writes `currentSlug` (`setSlugFromUrl`).
- **`OrgSwitcher.tsx`** — Topbar dropdown (custom `Select`) + a multi-role radiogroup (lg+). Picking an org navigates to `orgDashboard(slug)` then `PATCH /me/ {last_active_org_id}`. Reads memberships from `authStore`.
- **`OrgSettingsPage.tsx`** — Edit `name` + `time_zone` (react-hook-form + zod). `GET /api/orgs/{slug}/`, `PATCH /api/orgs/{uuid}/`. Slug read-only. Permission gate `canEdit`.
- **`OrgBrandingPage.tsx`** — **Stub**: read-only name/slug preview + a disabled fieldset; backend `Organization` has no color/logo columns yet. Same permission gate.
- **`MemberDirectoryPage.tsx`** — Member table/cards, search, remove-member (confirm dialog), embeds `InviteCreateModal` + `InvitationsListPanel`. Gated on `org.member_directory`; manage actions on `org.settings` OR admin/owner.
- **`OrgAuditLogPage.tsx`** — Cursor-paginated append-only feed; namespace chips, client-side namespace filter, mobile cards. Gated on `org.audit_log`.
- **`InviteCreateModal.tsx`** — Email + role-checkboxes (from `ROLE_KEYS`) + optional message; POST with fresh `event_id`; success swaps to a "Sent" view exposing the one-shot token + `${origin}/accept?token=` share link with copy-to-clipboard.
- **`InvitationsListPanel.tsx`** — Pending invites under the directory; revoke + copy-link (only if token still surfaced). Renders nothing when empty.
- **`InviteAcceptPage.tsx`** — Public `/accept?token=` landing. Logged-in → one-click accept. Logged-out new user → inline account creation (name + password ≥12). `401 detail:"login_required"` → sign-in CTA. On success `refreshMe()` then go to tournaments.
- **`OwnershipTransferModal.tsx`** — Typed reason (≥8 chars) + new-owner user-id + optional `ConflictOfInterestBanner` ack. POST `transferOwnership`.
- **`dashboardCards.ts`** — `computeDashboardCards()` pure function + `MODULES` code constants. **ORPHANED**: no non-test runtime consumer (see Smells).

### `features/permissions/*`
- **`ModuleMatrixPage.tsx`** — The module override matrix. Sticky-header table (sticky-left Member col, sticky-right Save col), modules grouped by scope (`platform→org→tournament→match`), per-row dirty tracking, optimistic per-row PUT, "Reset to defaults", mobile stacked-card variant. 403 → graceful "no access".
- **`GrantCell.tsx`** — 3-state `role="switch"` cell; cycles default→grant→deny→default; tinted by `roleDefault`. Uses semantic tokens `bg-grant`/`bg-deny`/`bg-grant-muted`.
- **`ConflictOfInterestBanner.tsx`** — Reusable soft-warning + acknowledgement checkbox (Appendix B.22). Used by `OwnershipTransferModal`.

### `features/roles/*`
- **`redirectByRole.ts`** — `pickLandingPathForUser(user)`: pure first-match-wins routing by primary membership (last-active else first). Owner/admin/co_organizer/game_coordinator → dashboard; match_scorer→scoring; referee→referee; team_manager→team; else dashboard.
- **`routes.tsx`** — `roleRoutes: RouteObject[]` for the 3 role landings + `/me` + `/me/notifications`. **Currently NOT imported by `App.tsx`** (routes are duplicated inline there).
- **`RoleLandingShell.tsx`** — Shared hero + optional "available now" CTA + preview tiles + "what you can do today" (profile / notifications / feedback) footer.
- **`ScorerLandingPage.tsx` / `RefereeLandingPage.tsx` / `TeamManagerLandingPage.tsx`** — Thin `RoleLandingShell` wrappers; all point at `routes.tournaments()`, `tiles={[]}`.
- **`MyProfilePage.tsx`** — `/me`: name edit (`PATCH /me/`), email (read-only) + verified state, 2FA status/link, memberships list with deep links, change-password link, "Sign out everywhere".
- **`NotificationPrefsPage.tsx`** — `/me/notifications`: Phase-1B placeholder stub.

### `features/notifications/*`
- **`NotificationBell.tsx`** — Topbar bell; `useQuery` polling every 30s; unread badge ("9+" cap); dropdown with mark-one / mark-all; click-outside + Escape close.

### `features/theme/*`
- **`themeStore.ts`** — Zustand `{theme, resolved, setTheme, init}`; persists to `localStorage["fixture.theme"]`; toggles `documentElement.classList("dark")`; subscribes to `prefers-color-scheme` while in `system`.
- **`ThemeProvider.tsx`** — Calls `init()` on mount.
- **`ThemeToggle.tsx`** — 3-state cycle light→dark→system with icon.

## Data model (FE types — mirror backend serializers)

Defined in `types/user.ts` (most re-exported from `types/api.generated.ts`):

- **`User`** (`MeSerializer`): `id, email, name, is_superuser, has_2fa_enrolled, twofa_enrolled_at, email_verified_at, last_active_org_id, last_active_org_slug, memberships[], deleted_at`.
- **`OrgMembership`** (aggregated per-org): `org_id, org_slug, org_name, roles: Role[], is_org_owner, effective_modules: string[], active_role?` (client-only). **Roles are de-duplicated and `is_org_owner` is OR-of-all-rows** server-side; ownership is a boolean, NOT a role value.
- **`Role`** = `Schemas["RoleEnum"]`. Six tournament-scoped roles: `admin, co_organizer, game_coordinator, match_scorer, referee, team_manager`. A legacy `"owner"` string still appears in old payloads/fixtures and is defensively accepted everywhere.
- **`ModuleDef`** `{key, scope: ModuleScope, label, description}`; `ModuleScope = org|tournament|match|platform`.
- **`GrantState`** = `default|grant|deny`. **`ModuleMatrixRow`** `{user_id, user_email, user_full_name, roles, cells: Record<key,GrantState>, role_defaults: Record<key,boolean>}`. **`ModuleMatrixResponse`** `{modules, members}` (catalog + rows in one round-trip — avoids client join).
- **`OrgInvitation`** `{id, org_id, email, roles, token?, status, invited_by_email, expires_at}`. **`OrgMember`** (`api/orgs.ts`) `{id (membership row PK), user_id, email, full_name, roles: string[], is_org_owner, joined_at, is_active}`. **`MyInvitation`** (`api/invitations.ts`) is the invitee-side view with `role` (singular), `organization_name`, nullable `tournament_id/tournament_name`.
- **`NotificationItem`** `{id, kind, title, body, url, read_at, created_at, tournament}`; list adds `unread_count`.
- **`AuditEvent`** (codegen): `{id, event_type, actor_email_at_time, target_type, target_label, created_at, ...}`; list adds `next_cursor`/`previous_cursor`.

## Core algorithms / services (file:function, step-by-step)

- **`redirectByRole.ts::pickLandingPathForUser`** — (1) no memberships → `/orgs`; (2) pick membership = `last_active_org_slug` match else `memberships[0]`; (3) compute `isOwner = is_org_owner || roles.includes("owner")`; (4) admin-tier → `orgDashboard`; (5) else scorer→scoring, referee→referee, team_manager→team; (6) fallthrough → dashboard. Called by `LoginPage` and `LandingPage`.
- **`OrgSwitcher.tsx::onPickOrg`** — guard same-org; `navigate(orgDashboard(slug))`; fire-and-forget `PATCH /me/ {last_active_org_id}`. **Note: navigates to dashboard regardless of the target org's roles** — a scorer-only org still lands on `/dashboard`, diverging from `pickLandingPathForUser`.
- **`ModuleMatrixPage.tsx::onCellChange`** — diff against stored value: if `next === stored` drop the edit, else record; prune empty row maps. Keeps "dirty" purely as a delta over server state.
- **`ModuleMatrixPage.tsx::onSaveRow`** — merge `{...row.cells, ...rowEdits}` → `setGrants` PUT (full cell map, fresh `event_id`). `onSuccess` clears that row's edits + invalidates query; `onError` **keeps edits** + toasts (never silently loses input). `useMemoModulesByScope` buckets modules by `SCOPE_ORDER` and appends unknown scopes (forward-compat).
- **`GrantCell.tsx`** — `NEXT` map cycles state; styling + tooltip + composed `aria-label` derived from `(state, roleDefault)`.
- **`InviteAcceptPage.tsx::finishAccept`** — `acceptInvitation(token, opts)` → `refreshMe()` → `state="ok"`; intercepts `ApiError 401 + detail "login_required"` → `state="login_required"`.
- **`InvitesPage.tsx::acceptMutation`** — accept → invalidate `["my-invitations"]` **and** `["tournaments"]`; navigate to `tournamentDetail(id)` if a tournament id is returned, else `tournaments()`.
- **`themeStore.ts::{apply,resolve,init}`** — `resolve` collapses `system`→OS preference; `apply` toggles `.dark`; `init` re-applies + wires the `change` listener (re-applies only while still `system`).
- **`NotificationBell.tsx`** — 30s polling query; `markOne/markAll` mutations invalidate `["notifications"]`.

## API / endpoint surface (consumed)

- Orgs: `GET /api/orgs/`, `GET /api/orgs/{slug}/`, `PATCH /api/orgs/{uuid}/`, `GET /api/orgs/{slug}/members/`, `DELETE /api/orgs/{uuid}/members/{membershipId}/`, `GET/POST /api/orgs/{slug}/invitations/`, `DELETE /api/orgs/{slug}/invitations/{id}/`, `POST /api/orgs/invitations/accept/`, `POST /api/orgs/{slug}/ownership/transfer/`.
- Permissions: `GET /api/permissions/modules/`, `GET /api/permissions/orgs/{slug}/me/modules/`, `GET /api/permissions/orgs/{slug}/grants/matrix/`, `PUT /api/permissions/orgs/{slug}/users/{userId}/grants/`.
- Invitations (invitee): `GET /api/invitations/`, `POST /api/invitations/{id}:accept/`, `POST /api/invitations/{id}:decline/`.
- Notifications: `GET /api/notifications/`, `POST /api/notifications/{id}/read/`, `POST /api/notifications/read-all/`.
- Audit: `GET /api/audit/orgs/{slug}/?cursor&actor_id&event_type&from&to&limit`.
- Accounts: `PATCH /api/accounts/me/` (name, `last_active_org_id`); `authStore.refreshMe`/`logout`.
- Feedback: `POST /api/feedback/submit/`.

Exported FE API surface: `orgsApi`, `permissionsApi`, `invitationsApi`, `notificationsApi`, `auditApi`, `feedbackApi`, `unwrapList`; route components consumed by `App.tsx` and chrome consumed by `AppShell.tsx`.

## Invariants that MUST be preserved

1. **`:orgSlug` is the source of truth** for active org; `OrgSwitcherStore` is a read-only mirror written only by `AppShell` (`setSlugFromUrl`). Any new switcher state must not write `currentSlug` independently.
2. **Idempotency** (CLAUDE.md #3): every mutation sends a client `event_id` UUID (invite create, set-grants, ownership transfer, feedback). Preserve `newEventId()` generation on each submit.
3. **Slug vs UUID routing split**: GET/list use slug; `PATCH /api/orgs/{uuid}/` and `removeMember` require the **UUID** (`org_id`). Mixing them up silently 400/404s.
4. **One-shot token**: the invite token is only returned at creation; list responses omit it. The copy-link UI must degrade when `token` is absent.
5. **Grant matrix semantics**: `default` defers to role; PUT replaces the **full** cell map per user; `role_defaults` are display-only (never sent). Saves are atomic per-row.
6. **Module gating is an affordance, not security** — backend re-checks (`IsOrgMember` + module gate; matrix 403). Removing FE gates must not be assumed to expand access.
7. **Conflict-of-interest = soft warning** (never blocks): ack is recorded server-side in the audit log; `conflict_acknowledged` only sent when a conflict was detected.
8. **Audit feed is append-only + cursor-paginated**; UI must not assume offset paging or mutate rows.
9. **Role catalog is wider than the `Role` union**; helpers widen to `string[]` and accept legacy `"owner"`. Don't narrow without backend alignment.
10. **i18n/a11y**: every visible string via `t()`; `role="switch"/menu/radiogroup/alert`, composed aria-labels, mobile stacked-card fallbacks via `useBreakpoint().isMobile`. WCAG 2.1 AA is contractual (CLAUDE.md #13).

## Dependencies / coupling

**Outgoing**: `authStore` (`user.memberships`, `effective_modules`, `is_org_owner`, `refreshMe`, `logout`); `api/client` + `ApiError`; TanStack Query (every page); `lib/routes`, `lib/t`, `lib/tailwind` (`cn`), `lib/useBreakpoint`; `types/user` + `types/api.generated`; `components/ui/*` (Select, dialog, toast, Button, Input, Label, card, Avatar, RoleBadge, PreviewTile); `react-hook-form` + `zod` (settings, invite, accept).

**Incoming**: `AppShell.tsx` mounts `OrgSwitcher`, `NotificationBell`, `ThemeToggle` and drives `setSlugFromUrl`; `App.tsx` mounts `ThemeProvider` and routes all pages (inline, not via `roleRoutes`); `LoginPage`/`LandingPage` call `pickLandingPathForUser`; `OrgDashboardPage` (layout) calls `feedbackApi` and is the post-login admin landing; `OwnershipTransferModal` imports `ConflictOfInterestBanner`; `MemberDirectoryPage` composes `InviteCreateModal` + `InvitationsListPanel`.

**Shared query keys** (cross-page cache coupling): `["org", slug, "members"|"invitations"|"detail"]`, `["permissions","matrix",slug]`, `["audit",slug,cursor]`, `["notifications"]`, `["my-invitations"]`, `["tournaments"]`, `["org", slug]` (transfer invalidation is a prefix-ish key, slightly loose).

## Tech debt / smells / duplication

- **`dashboardCards.ts` is orphaned dead code.** `computeDashboardCards`, `MODULES`, `ALL_CARD_KEYS`, `PHASE_1B_TEASERS`, `CARD_ICONS` have **no non-test runtime consumer** — the live `layout/OrgDashboardPage.tsx` is a tournaments dashboard, not a cards grid. Its `MODULES` constants are the only centralised module-code source, yet other pages re-hardcode the same strings (`"org.settings"`, `"org.member_directory"`, `"org.audit_log"`, `"org.branding"`). Either delete or rewire as the single source of truth.
- **`roleRoutes` (roles/routes.tsx) is unused**; `App.tsx` duplicates the same five routes inline. Drift risk.
- **Duplicated "isAdminish/canEdit" gating logic** copy-pasted across `OrgSettingsPage`, `OrgBrandingPage`, `MemberDirectoryPage`, `OrgAuditLogPage`, `dashboardCards`, each with subtly different rules (e.g. settings/branding include `game_coordinator`/`co_organizer`; directory's `isAdminish` only checks `admin`+owner; permissions card is `admin`+owner only). No shared `canAccessModule(membership, key)` helper. High risk of inconsistency.
- **Duplicated helpers**: `newEventId()` (3 copies: InviteCreateModal, OwnershipTransferModal, ModuleMatrixPage), `shareLinkFor()` (InviteCreateModal + InvitationsListPanel), copy-to-clipboard logic, relative-time formatters (`relativeJoined`, `relativeTime`, `formatExpires`).
- **Two parallel invitation models/flows**: org-side (`api/orgs.ts` `OrgInvitation`/`InvitationListItem`, plural `roles`, token+slug, `/accept` page) vs invitee-side (`api/invitations.ts` `MyInvitation`, singular `role`, colon-verb id routes, `/invites` inbox). Different role cardinality and accept endpoints for the same concept.
- **Design-token violations** (CLAUDE.md forbids hardcoded colors): `OrgBrandingPage` uses `bg-emerald-100/text-emerald-700/bg-emerald-500`; `InviteAcceptPage` uses `bg-emerald-700/hover:bg-emerald-800/text-emerald-700` and a hardcoded `bg-muted/40 min-h-screen` centered card (against the "fill width, no centered columns" rule — though acceptable for a standalone public page).
- **Native `<select>` in `OrgSettingsPage`** (timezone) despite the "no native dropdowns, use `Select`" rule; other pages correctly use `components/ui/Select`.
- **Bespoke menus instead of shared primitives**: `MemberDirectoryPage::RowActions` and `NotificationBell` each hand-roll click-outside/Escape dropdowns rather than a shared Popover/Menu component (3rd reimplementation of the same effect).
- **Branding page is a non-functional stub** (no backend columns); the gating + preview ship, the editor doesn't.
- **`OrgSwitcher.onPickOrg` ignores role-aware landing** (always `/dashboard`), inconsistent with `pickLandingPathForUser`.
- **`activeRole` in `OrgSwitcherStore`** is set by the switcher but never read by gating logic — purely cosmetic radiogroup state; intent (role-scoped views, §2.7) is unimplemented.
- **Fragile i18n**: many `t()` calls interpolate before translation (`t(`${total} members`)`, `t(`expires ${label}`)`) — these won't pluralise/localise correctly and defeat the message-catalog model.

## Restructuring seams & risks

- **Centralise module codes + access checks.** Promote `MODULES` to a shared `lib/modules.ts` and introduce one `useMembership(slug)` / `canAccessModule(membership, key)` + `isOrgAdmin(membership)` helper; replace the 5+ copy-pasted gates. This is the highest-leverage, lowest-risk cleanup. **Risk**: the gates are subtly different on purpose (permissions card excludes co_organizer/game_coordinator) — encode those rules explicitly, don't homogenise blindly.
- **Unify the invitation domain.** Collapse org-side and invitee-side invitation types/flows behind one `invitations` module with a discriminated `scope: org|tournament`. **Risk**: differing accept endpoints (`/api/orgs/invitations/accept/` token-based vs `/api/invitations/{id}:accept/` id-based) and role cardinality (plural vs singular) must both stay supported during migration.
- **Extract shared utilities** (`newEventId`, `shareLinkFor`, clipboard, relative-time, a `<CopyField>`, a `<Menu>` popover). Mechanical, test-covered, safe.
- **Make `OrgSwitcherStore` the single client context** and have org switching reuse `pickLandingPathForUser` for the target org — removes the dashboard/landing inconsistency.
- **Delete or wire `dashboardCards.ts` + `roleRoutes`.** Decide whether the cards UI is resurrected (then make it the canonical module-gated dashboard) or removed; either way kill the drift.
- **Branding/NotificationPrefs**: both await backend (org color/logo columns; per-event/channel prefs). Keep the permission shell, slot real forms when migrations land — clean seams already exist (gate + `useQuery` + disabled fieldset).
- **Tokenise colors** in `OrgBrandingPage`/`InviteAcceptPage` before any theme/branding work to avoid baking emerald into a themeable surface.
- **Query-key contract** is the integration surface with the rest of the SPA (notably `["tournaments"]` invalidation on invite accept, `["org", slug, ...]` family). Any cache-layer restructuring must preserve these or invitations/membership changes will look stale.
- **`active_role`/§2.7 role-scoped views** are stubbed; if restructuring formalises role-scoped UI, the store field exists but nothing reads it — design the consumer first.
