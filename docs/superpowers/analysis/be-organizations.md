# Backend · organizations — Subsystem Analysis

**Scope:** `backend/apps/organizations/` (models, services, views, urls, serializers, permissions, scope, constants, management command, migrations, tests).
**Date:** 2026-06-08 · **Reviewer:** architecture deep-read for upcoming platform restructuring.

## 1. Purpose

`organizations` is the **multi-tenancy boundary** of the platform (PRD invariant #2). An `Organization` is a *hidden personal workspace* (decision #91): end users never "see" an org as a first-class concept — they see tournaments — but every tenant-scoped model in the platform hangs off an org FK, and org membership is the seed for both module-RBAC and tournament-scoped access. This app owns: the `Organization` lifecycle (pending_review → active → suspended/archived/orphaned), `OrganizationMembership` (the role table that drives RBAC), `AdminInvitation` (org- and tournament-scoped invites with token hashing), `SlugRedirect` (slug-history so old links resolve), ownership transfer, orphan detection, and the row-level scope-filter mixin (`ScopedQuerySetMixin`) that other apps' querysets plug into.

## 2. File-by-file roles

- **`models.py`** — four models + three enums (`OrgStatus`, `MembershipRole`, `InviteStatus`) + three managers (`OrganizationManager`, `ActiveOrganizationManager` filtering `deleted_at`, `OrganizationMembershipManager` with `user_org_ids`/`active_for`).
- **`constants.py`** — `SLUG_REGEX` (DNS-safe: `^(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`) and `RESERVED_SLUGS` (~40-entry frozenset of operational/product/brand subdomains).
- **`services/slug.py`** — `validate_slug`, `change_slug` (writes `SlugRedirect`, audits), `resolve_slug` (returns `(canonical, redirect_target)`).
- **`services/lifecycle.py`** — `create_organization`, `approve_org`, `reject_org`, `suspend_org`, `unsuspend_org`, `archive_org`, `detect_orphaned`.
- **`services/ownership.py`** — `transfer_ownership` (atomic owner-flag swap).
- **`services/invitation.py`** — `create_invitation`, `accept_invitation` (token), `accept_invitation_by_id` / `decline_invitation` (in-app by id), `revoke_invitation`, `get_invitation_by_token`, plus the shared `_accept_invitation_row` and the `_cycle_session` anti-fixation hook.
- **`services/workspace.py`** — `slugify_for_org`, `pick_unique_org_slug`, `provision_personal_workspace` (self-serve active org + admin/owner membership, no approval).
- **`views.py`** — ~20 DRF views: UUID colon-verb endpoints (AIP-136) + slug-routed SPA aliases. Thin; delegate to services.
- **`urls.py`** — route table (verbs/aliases ordered before the catch-all `<str:slug_or_uuid>/`).
- **`serializers.py`** — read/write serializers incl. the aggregated `OrgMemberDetailSerializer` and dual-field `TransferOwnershipSerializer`.
- **`permissions.py`** — `IsOrgMember/IsOrgAdminOrOwner/IsOrgOwner/IsSuperUser` + slug/UUID-aware `_resolve_org_from_view`.
- **`scope.py`** — `ScopedQuerySetMixin` / `OrgScopedQuerySet` (`.scoped_for(user)`).
- **`management/commands/mark_orphaned_orgs.py`** — cron wrapper over `detect_orphaned()`.
- **`migrations/0001–0004`** — initial schema; 0002 drops `single_org_per_admin_user`; 0003 widens the pending-invite uniqueness to include `tournament` + adds the `tournament` FK; 0004 adds `declined` to invite status choices.

## 3. Data model

**`Organization`** (`organizations_organization`): `id` (uuid7 PK), `slug` (unique, max 63), `name`, `status` (OrgStatus, default `pending_review`, indexed), `time_zone` (default `Asia/Kolkata`), `created_at`, `created_by` (SET_NULL), lifecycle marks `archived_at`/`suspended_at`/`suspended_reason`, soft-delete `deleted_at` (indexed). `is_deleted` property. Two managers: `objects` (all rows) and `active_objects` (excludes soft-deleted).

**`OrganizationMembership`** (`organizations_membership`): `id`, `user` (CASCADE), `organization` (CASCADE), `role` (MembershipRole), `is_org_owner` (bool), `is_active` (bool), `created_at`/`created_by`/`removed_at`. Constraints (see §4.1).

**`AdminInvitation`** (`organizations_admin_invitation`): `id`, `organization` (CASCADE), `email` (lowercased in `save()`), `invited_by` (SET_NULL), `role` (default co_organizer), nullable `tournament` FK (CASCADE; null = org-level invite), `token_hash` (sha256 hex, indexed), `status` (InviteStatus), `expires_at` (default now + `INVITE_TOKEN_TTL_DAYS`=7), `accepted_at`/`accepted_by_user`/`revoked_at`/`revoked_reason`. `is_expired()` + `effective_status` property (read-time pending→expired materialization). One partial-unique constraint: `unique_pending_invite_per_email_per_org_tournament` on `(organization, tournament, email) WHERE status='pending'`.

**`SlugRedirect`** (`organizations_slug_redirect`): `id`, `old_slug` (unique), `organization` (CASCADE), `created_at`.

**Relationships:** `Organization 1—* OrganizationMembership/AdminInvitation/SlugRedirect`; `AdminInvitation *—1 tournaments.Tournament` (optional). Tournament-scoped invites resolve into `tournaments.TournamentMembership`, NOT an `OrganizationMembership` — preserving isolation (an invited scorer gets one tournament, not the whole org).

## 4. Core algorithms / services

### 4.1 Membership constraints (the "4 constraints" — actually 3 live + 1 dropped)
Declared in `OrganizationMembership.Meta.constraints`:
1. `unique_active_role_per_user_per_org` — `UniqueConstraint(user, organization, role) WHERE is_active=True`. Multi-role per (user,org) is allowed *because role is in the key*.
2. `one_owner_per_org` — `UniqueConstraint(organization) WHERE is_org_owner=True AND is_active=True`.
3. `owner_flag_only_on_admin_role` — `CheckConstraint(is_org_owner=False OR role='admin')`.
4. `single_org_per_admin_user` — **DROPPED** in migration `0002` (decision #91; a user is now admin/owner of many personal workspaces).

**Accuracy note (load-bearing):** the model docstring/header and several comments claim `one_owner_per_org` is `DEFERRABLE INITIALLY DEFERRED` (checked at COMMIT) and that a follow-up `RunSQL` migration adds it. **No such migration exists** (`grep RunSQL/DEFERRABLE` across migrations is empty). The constraint is a partial unique index and is therefore IMMEDIATE. Correctness is preserved only by `transfer_ownership` ordering its writes (clear outgoing owner first). The `ownership.py` and `test_ownership_transfer.py` comments saying "Thanks to DEFERRABLE INITIALLY DEFERRED, the constraint is checked at COMMIT" are **stale/aspirational** and do not reflect runtime behaviour.

### 4.2 Slug validation & history — `services/slug.py`
- `validate_slug(value, exclude_org=None)`: rejects non-str/empty; requires `SLUG_REGEX` match (no silent lowercasing — `UPPERCASE` is invalid by contract); rejects `RESERVED_SLUGS`; rejects collision against `Organization.slug` (excluding `exclude_org`) AND `SlugRedirect.old_slug`. Reserved-check is **service-layer** (locked invariant), reachable even from super-admin verbs.
- `change_slug(org, new_slug, changed_by, request)`: re-validates with `exclude_org=org`; no-op if unchanged; in `transaction.atomic()` does `SlugRedirect.get_or_create(old_slug=...)`, updates `org.slug`, emits audit `org_settings_changed` (before/after slug).
- `resolve_slug(value)`: lowercases; returns `(org, None)` for a live canonical slug, `(None, target_org)` for a redirect (skips deleted target), `(None, None)` otherwise. Powers the 301 in `OrgDetailView.get`.

### 4.3 Lifecycle — `services/lifecycle.py`
Every verb is `transaction.atomic()` + inline `emit_audit`, returns the org. Precondition checks:
- `create_organization`: validates slug via service, requires name, status defaults `pending_review`, audit `org_created` (actor_role super_admin).
- `approve_org`/`reject_org`: require `status==pending_review`; reject requires reason ≥8 chars and sets `archived_at`. Audits `org_approved`/`org_rejected`.
- `suspend_org`: idempotent if already suspended; only from active/pending_review/orphaned; reason ≥3 chars. Audit `org_suspended` (super_admin).
- `unsuspend_org`: requires status==suspended → active, clears suspend marks. Audit `org_unsuspended`.
- `archive_org`: idempotent if archived; reason ≥3; emits audit `org_deleted` (note event_type name vs verb name mismatch; actor_role ADMIN).
- `detect_orphaned()`: iterates active, non-deleted orgs; for each with **no active admin membership**, flips status→`orphaned` inside its own atomic block + audit `org_orphaned` (actor SYSTEM). Returns count. **N+1 query** (one membership `.exists()` per org).

### 4.4 Ownership transfer — `services/ownership.py::transfer_ownership`
Rejects self-transfer. In `transaction.atomic()`: `select_for_update` the current owning admin membership (404→ValidationError) and the incoming admin membership (must already be an active admin → ValidationError). **Order matters**: clears `current.is_org_owner=False` and saves first, then sets `incoming.is_org_owner=True` — so the IMMEDIATE partial-unique never sees two owners. Audits `ownership_transfer_accepted`.

### 4.5 Invitations — `services/invitation.py`
- Tokens: `secrets.token_urlsafe(32)` plaintext (emailed only); DB stores `sha256` hex.
- `create_invitation`: lowercases email; resolves `effective_role` — when a `roles` list is given, picks the highest tier via `_ROLE_RANK` (admin>co_organizer>game_coordinator>match_scorer>referee>team_manager). **Idempotency** via `event_id`: looks up a prior `AuditEvent.idempotency_key` whose `target_type=='admin_invitation'` and returns the existing invitation. Guards: org must be active/pending_review; tournament must belong to org; one pending invite per (org,tournament,email) (service-level pre-check mirroring the DB partial-unique). Creates row, audits `member_invite_sent` (forwards idempotency_key), `send_mail` (fail_silently, console backend in dev).
- `accept_invitation(token)`: pre-checks/materializes expiry **outside** the atomic block (so a pending→expired flip survives a later rollback); inside atomic, `select_for_update`, rejects accepted/revoked/declined/expired, requires org active/pending_review, calls `_accept_invitation_row`, then `_cycle_session` post-commit (B.11 fixation defense).
- `_accept_invitation_row`: idempotent membership creation. If `tournament_id` set → create/reactivate `TournamentMembership` (ACTIVE), audit `tournament_membership`; else → create/reactivate `OrganizationMembership`, audit `organization_membership`. Flips invite→accepted, sets `accepted_by_user`, audits `member_invite_accepted`.
- `accept_invitation_by_id` / `decline_invitation`: in-app, email-ownership enforced (mismatch → `PermissionDenied`/403); only PENDING may be declined; same expiry-materialization pattern.

### 4.6 Self-serve workspace — `services/workspace.py::provision_personal_workspace`
Picks a unique slug (`slugify_for_org` then `pick_unique_org_slug` with numeric then random suffixes), creates an **ACTIVE** org (no super-admin approval) + an **ACTIVE admin/owner** `OrganizationMembership`, audits `workspace_provisioned`. Used by `tournaments/services/create.py::create_tournament`.

## 5. API / endpoint surface

Mounted at `/api/orgs/` (`fixture.urls`); invitation accept/inbox routes mounted at `/api/invitations…` directly.

UUID colon-verbs (canonical, AIP-136): `GET/POST /api/orgs/`; `GET/PATCH /api/orgs/{slug_or_uuid}/` (GET 301s on a `SlugRedirect` hit); `POST {uuid}:change_slug/`, `:suspend/`, `:unsuspend/`, `:archive/`, `:transfer_ownership/`; `GET {uuid}/members/`, `DELETE {uuid}/members/{membership_id}/`; `GET/POST {uuid}/invitations/`, `POST {uuid}/invitations/{id}:revoke/`.
Slug-routed SPA aliases: `GET {slug}/members/` (per-user aggregated), `GET/POST {slug}/invitations/`, `DELETE {slug}/invitations/{id}/` (= revoke), `POST {slug}/ownership/transfer/`, `POST /api/orgs/invitations/accept/`.
Invitation surfaces: `POST /api/invitations:accept/` (AllowAny; logged-out invitee can accept, inline account creation using the **invite's** email never the body), `GET /api/invitations/` (my pending inbox), `POST /api/invitations/{uuid}:accept/`, `POST /api/invitations/{uuid}:decline/`.
Exported Python API consumed cross-app: `OrganizationMembership.objects.user_org_ids`, `ScopedQuerySetMixin.scoped_for`, `IsOrg*` permission classes, all of `services.*`, `constants.RESERVED_SLUGS/SLUG_REGEX`.

## 6. Invariants that MUST be preserved

1. **One active owner per org** (`one_owner_per_org`) and **owner implies admin** (`owner_flag_only_on_admin_role`). Ownership transfer must keep clearing-before-setting ordering until/unless a real deferrable constraint is added.
2. **Multi-role per (user,org)** and **multi-org admin per user** are intentionally allowed (decision #91) — do not reinstate `single_org_per_admin_user`.
3. **Slug uniqueness spans `Organization.slug` ∪ `SlugRedirect.old_slug`**; reserved-list + format enforced at the **service layer**; slug changes always leave a redirect so old links 301.
4. **Tournament-scoped invites create only a `TournamentMembership`**, never an org-wide membership (isolation).
5. **Invite tokens stored hashed; plaintext only emailed/returned at creation**; accept reads email from the signed invite, never the request body (takeover guard); invite-accept never resets a pre-existing password.
6. **Session cycled on invite accept** (B.11). **Every state-change verb emits exactly one audit event** with `organization_id` (asserted by `test_audit_emission.py`).
7. **Soft-delete via `deleted_at`**; `active_objects` and every resolver filter `deleted_at__isnull=True`.
8. **Idempotent writes via `event_id`** (invitation create; ownership/tournament create at callers).
9. **Read-time expiry materialization**: a past-due pending invite surfaces as `expired` (`effective_status`) and is excluded from the inbox even without a sweeper.

## 7. Dependencies / coupling

**Outgoing:** `apps.accounts` (`uuid7`, `User`, optional `session_security.cycle_session_on_role_change`); `apps.audit` (`emit_audit`, `ActorRole`, `AuditEvent` for idempotency replay); `apps.tournaments` (lazy import of `Tournament`/`TournamentMembership` in invitation accept + the `tournament` FK); `apps.permissions` (`HasModule("org.member_directory")` on member-directory views); Django mail/settings (`INVITE_TOKEN_TTL_DAYS`, `FRONTEND_BASE_URL`, `DEFAULT_ORG_TIMEZONE`).

**Incoming (high blast-radius):** `apps.tournaments.scope`/`permissions` import `MembershipRole`/`OrganizationMembership` and `provision_personal_workspace`; `apps.tournaments.views` imports `create_invitation` (tournament-scoped invites); `apps.permissions.services.resolver/matrix/scope` read `OrganizationMembership` for `effective_modules`/the verb matrix; `apps.sadmin` verbs/views/kpi delegate to lifecycle services and read `Organization`/`OrgStatus`; `apps.accounts.serializers`/`signup` read org models + slug helpers; `apps.matches.services.scoring` reads `MembershipRole`/`OrganizationMembership`; `apps.audit.views` reads `Organization`. The `org.member_directory` module is referenced by name in both apps.

## 8. Tech debt / smells / duplication

- **Stale DEFERRABLE claims** (model header, `ownership.py` docstring + inline comment, `test_org_constraints.py` comment) describe a deferred constraint that was never implemented. High risk of misleading a future restructurer into assuming COMMIT-time checking.
- **"4 constraints" mismatch**: docstring/tests still enumerate `single_org_per_admin_user` (now dropped). Cosmetic but confusing.
- **Slug-logic duplication (3 copies):** `services/slug.py::validate_slug`, `services/workspace.py::slugify_for_org/pick_unique_org_slug/_slug_taken`, AND a *third* private copy in `apps/accounts/services/signup.py` (`_slugify_for_org` + its own slug-picker). `signup.py` also creates `Organization`+`OrganizationMembership` inline instead of reusing `provision_personal_workspace` — divergence risk (signup makes a `pending_review` org; workspace makes `active`).
- **`detect_orphaned` N+1**: per-org membership existence query; should be one aggregate/`annotate` pass. Also no notification/owner-alert on orphaning.
- **Routing fragility**: `urls.py` redefines `urlpatterns` twice (first definition is dead) and relies on strict ordering of `<str:slug>/...` aliases vs the catch-all `<str:slug_or_uuid>/`. Distinct kwarg names (`slug` vs `slug_or_uuid` vs `uuid`) are load-bearing for `_resolve_org_from_view`.
- **Audit event_type vs verb naming drift**: `archive_org` emits `org_deleted`; `change_slug` emits `org_settings_changed` (not `org_slug_changed` as its own docstring says). Downstream audit consumers filter on these strings.
- **Permission inconsistency**: archive permission is checked inline in `OrgArchiveView` (owner-or-super) while other verbs use permission classes; member-remove blocks removing the owner with a 403 but offers no demotion path. Permissions `_resolve_org_from_view` returns `True` (allow) when no org kwarg resolves — fail-open at the class level, relying on the view's own `get_object_or_404`.
- **Two nearly-identical accept code paths** (`accept_invitation` vs `accept_invitation_by_id`) with copy-pasted status/expiry guards; only the lookup + ownership check differ.
- **Idempotency coupled to audit**: invitation replay detection reads `AuditEvent.idempotency_key` rather than a dedicated key on the write model — couples invitation correctness to the audit table's shape.
- **`HasModule` resolves org via `get_organization()` swallowing all exceptions** → silent 403s if the slug resolver throws.

## 9. Restructuring seams & risks

- **Clean service seam**: views are genuinely thin; almost all logic is in `services/*` with explicit kwargs and `ValidationError`-as-contract. A restructuring can re-front these services (e.g., new API shape) with low risk if it preserves the `emit_audit` event-type strings and the return types.
- **Consolidate slug logic** into one module (the `organizations.services.slug` + `workspace` pair) and have `accounts.signup` call it — removes the third copy and the active-vs-pending divergence. This is the highest-value, lowest-risk cleanup.
- **Decide the deferrable question**: either add the real `RunSQL DEFERRABLE INITIALLY DEFERRED` migration (then simplify `transfer_ownership`) or delete all DEFERRABLE comments. Do not leave the gap.
- **Unify the two accept paths** behind `_accept_invitation_row` with a small pre-check helper; reduces drift risk on security-sensitive guards.
- **Membership model is the RBAC linchpin** — `permissions.resolver`, `tournaments.scope`, `matches.scoring`, and `sadmin` all read it. Any change to `OrganizationMembership` shape, the role enum, or the `is_active`/`is_org_owner` semantics ripples across ≥5 apps; treat its columns + the `user_org_ids` contract as a stable public interface.
- **Org-as-hidden-workspace is structural**: provisioning happens in two places (self-serve `workspace.py` and approval-flow `lifecycle.create_organization`). A restructure should make "how an org comes into existence and in what status" a single, named policy rather than two divergent constructors.
- **Risk:** `detect_orphaned` has no sweeper for expired invitations (read-time only) and no Celery — any move to async must preserve the read-time materialization invariant or add a real sweeper, not silently change observable status.
