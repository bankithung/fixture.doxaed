# Backend Subsystem Analysis: `apps/tournaments`

## Purpose

`apps/tournaments` is the **tenancy + authorization spine** of Phase 1B. It owns three things that almost every other domain app depends on:

1. The `Tournament` aggregate root (org-scoped, status state-machine enum, slug/URL identity, data-driven `rules`/`constraints` JSONB).
2. The `TournamentMembership` role/status model (6 tournament-scoped roles, 3 statuses) — the identity carrier that replaced per-org admin scoping.
3. The two reusable access primitives — `accessible_tournaments(user)` (visibility scope) and `can_manage_tournament(user, tournament)` (mutation gate) — which **every tenant-scoped endpoint in the platform routes through** (matches, fixtures, teams, forms, disputes, and tournaments itself).

It also hosts the self-serve creation flow, the data-driven rules/constraints service, the members directory + member-management API, and a tournament-scoped audit feed.

## File-by-file roles

- `models.py` — `Tournament`, `TournamentMembership`, and three `TextChoices` enums (`TournamentStatus`, `TournamentMembershipRole`, `TournamentMembershipStatus`). The only models in the app.
- `scope.py` — `accessible_tournaments(user)`: the read-visibility queryset (incoming dep for ~6 apps).
- `permissions.py` — `can_manage_tournament(user, tournament)`: the manage gate; `_MANAGE_ROLES = {ADMIN, CO_ORGANIZER}`.
- `services/create.py` — `create_tournament(...)`: atomic self-serve create + workspace provisioning + creator-as-admin + audit; idempotent on `event_id`. Helper `_pick_unique_tournament_slug`.
- `services/rules.py` — `DEFAULT_RULES`, `merge_rules`, `can_edit_rules`, `freeze_rules`, `update_settings`: the data-driven rules engine + freeze gate.
- `serializers.py` — five serializers: `TournamentSerializer` (read), `TournamentCreateSerializer`, `TournamentInvitationCreateSerializer`, `TournamentMembershipSerializer` (roster row), `TournamentMembershipUpdateSerializer`.
- `views.py` — 7 GenericAPIView classes + 2 module-private helpers (`_get_tournament_or_404`, `_settings_payload`).
- `urls.py` — routes for the tournaments app **plus aggregation of routes owned by other apps** (fixtures, teams, forms, matches, disputes) under the `<tournament_id>` prefix.
- `migrations/0001_initial.py` — base schema. `0002_...` — adds `rules`, `constraints`, `rules_frozen_at`.
- `management/commands/run_e2e_demo.py` — seeds a demo tournament with all role types (not production logic).
- `tests/` — 8 test files: `test_rules`, `test_settings_api`, `test_members_api`, `test_invite_api`, `test_accept_api`, `test_create_api`, `test_create_tournament`, `test_tournament_invite`.

## Data model

### `Tournament` (`tournaments_tournament`)
- `id` UUIDv7 PK (`apps.accounts.models.uuid7`, invariant 1).
- `organization` FK → `organizations.Organization` (`CASCADE`, invariant 2). The org is a *hidden personal workspace*.
- `sport` FK → `sports.Sport` (`PROTECT`, nullable).
- `slug` (max 63), `name` (max 200). Unique per-org **only among non-deleted rows** (`UniqueConstraint` with `Q(deleted_at__isnull=True)`, name `unique_tournament_slug_per_org`).
- `status` — `TournamentStatus` enum, default `DRAFT`, `db_index=True`.
- `time_zone` — default `"Asia/Kolkata"` on the field, but `create_tournament` overrides it with `org.time_zone`.
- `inputs_hash` + `last_manual_edit_at` — invariant 10 generator-conflict tracking. `last_manual_edit_at` is written by `update_settings`; `inputs_hash` is filled by fixtures generators, not here.
- `rules` JSONB (default `dict`), `constraints` JSONB (default `list`), `rules_frozen_at` datetime.
- `created_at`, `created_by` (FK user, `SET_NULL`), `deleted_at` (soft delete, indexed). `is_deleted` property.
- Composite index `trn_org_status_idx` on `(organization, status)`.

### `TournamentMembership` (`tournaments_membership`)
- `id` UUIDv7 PK. `user` FK (`CASCADE`), `tournament` FK (`CASCADE`, related `memberships`).
- `role` — `TournamentMembershipRole` (6 roles). `status` — `TournamentMembershipStatus` (3 statuses), default `ACTIVE`.
- `assigned_by` (FK user, `SET_NULL`), `assigned_at`, `revoked_at`.
- **Partial unique constraint** `unique_active_tournament_role` on `(user, tournament, role)` `WHERE status='active'` — a user may hold a role at most once *while active*, but revoked rows can coexist (allows re-invite).
- Indexes: `(tournament, role, status)`, `(user, status)`.

### Enums
- `TournamentStatus`: `draft → published → registration_open → scheduled → live → completed → archived` (PRD §5.2 subset). Stored as string, max_length 24.
- `TournamentMembershipRole`: `admin, co_organizer, game_coordinator, match_scorer, referee, team_manager` (decision #91).
- `TournamentMembershipStatus`: `active, suspended, revoked`.

## Core algorithms / services (file:function, step-by-step)

### `scope.py::accessible_tournaments(user)`
1. Unauthenticated → `Tournament.objects.none()`.
2. `admin_org_ids` = orgs where the user is an **active org `ADMIN`** (`OrganizationMembership`).
3. `member_tournament_ids` = tournaments where the user has an **active `TournamentMembership`** (any role).
4. Returns non-deleted tournaments matching `org_id IN admin_org_ids OR id IN member_tournament_ids`, `.distinct()`.
   - Note: org *owner* is not a concept here; only `MembershipRole.ADMIN` grants org-wide visibility. The docstring says "admin/owner" but the code only checks `ADMIN`.

### `permissions.py::can_manage_tournament(user, tournament)`
1. Unauthenticated → `False`.
2. `True` if an **active** `TournamentMembership` exists with `role IN {ADMIN, CO_ORGANIZER}`.
3. Else `True` if the user is an **active org `ADMIN`** of `tournament.organization_id`.
4. Else `False`. Two queries worst case; no caching.

### `services/create.py::create_tournament(...)`
1. Idempotency: if `event_id` matches a prior `tournament_created` `AuditEvent` (`idempotency_key`), return the existing `Tournament` by `target_id` (invariant 3).
2. Resolve `sport` from `sport_code` (silent `None` if not found).
3. Atomic block: provision/resolve the personal workspace (`provision_personal_workspace`) unless `workspace_org` passed; create the `Tournament` (`DRAFT`, `time_zone=org.time_zone`); create the creator's `TournamentMembership` (`ADMIN`/`ACTIVE`); `emit_audit("tournament_created")`.
- Slug uniqueness via `_pick_unique_tournament_slug` — `slugify_for_org(name)` then suffix `-2, -3, ...` truncated to 63 chars; **not race-safe** (the partial unique constraint is the real guard).

### `services/rules.py`
- `DEFAULT_RULES` — canonical football v1 ruleset; its key set is also the **whitelist** (`format`, `group_size`, `advance_per_group`, `points`, `tiebreakers`, `match`, `squad`, `discipline`).
- `merge_rules(partial, base=None)` — deep-copies defaults, then layers `defaults < base < partial`. For nested dict keys in `_NESTED = {points, match, squad, discipline}` it does a per-key `.update()` (shallow merge of one level); other keys are overwritten wholesale. Raises `ValueError` on any unknown top-level or nested key. `base` is the currently-stored rules so a partial PATCH preserves prior overrides.
- `can_edit_rules(tournament)` — `True` only in `DRAFT`/`PUBLISHED` (invariant 7 boundary).
- `freeze_rules(tournament)` — idempotently stamps `rules_frozen_at`. **Defined but has no production caller** (only `test_rules.py`); nothing wires it to a status transition.
- `update_settings(*, tournament, rules, constraints, by, amend, reason, event_id, request)`:
  1. Replay guard: prior `tournament_settings_updated` audit with same `event_id` → return unchanged.
  2. If `not can_edit_rules` and not `amend` → raise `PermissionError("rules_frozen")` (view → 409).
  3. If `amend` and blank `reason` → `ValueError("amend_reason_required")` (view → 400).
  4. Atomic: if `rules` given, `tournament.rules = merge_rules(rules, base=tournament.rules)`; if `constraints` given, `tournament.constraints = validate_constraints(constraints)` (delegates to `apps.fixtures.services.constraints`); stamp `last_manual_edit_at`; save; `emit_audit("tournament_settings_updated")` with full after-payload.
  - The 24h grace + notify portion of invariant 7 is **not implemented** — `amend` only requires a reason.

### `views.py` member management (`TournamentMemberDetailView.patch`)
- Resolve tournament (404 if inaccessible) → manager gate (403). Fetch membership scoped to the tournament (`get_object_or_404`).
- **Last-admin guard**: if demoting (role away from `ADMIN`) or deactivating (status away from `ACTIVE`) and no *other* active admin exists → `400 {"detail": "last_admin"}`.
- Apply role/status diffs; setting status `REVOKED` stamps `revoked_at`; save only changed fields; emit `tournament_member_updated` audit with before/after.

## API / endpoint surface

Owned by this app (all under `/api/tournaments/`, all `IsAuthenticated`):
- `GET/POST /` — `TournamentListCreateView`. GET = `accessible_tournaments` list; POST = self-serve create (403 `verify_email_first` if email unverified; 201 on success).
- `GET /constraint-types/` — `ConstraintTypesView` (static catalog from `fixtures.services.constraints.CONSTRAINT_TYPES`).
- `GET/PATCH /{id}/settings/` — `TournamentSettingsView`. GET returns `{rules (merged), constraints, rules_frozen_at, can_edit}`. PATCH manager-only, idempotent, 409 on frozen, 400 on invalid keys/missing amend reason.
- `POST /{id}/invitations/` — `TournamentInvitationCreateView`. Manager-only; delegates to `organizations.services.invitation.create_invitation`; token emailed never returned.
- `GET /{id}/members/` — `TournamentMembersView` (any member; active+suspended only).
- `PATCH /{id}/members/{membership_id}/` — `TournamentMemberDetailView` (manager-only; last-admin guard).
- `GET /{id}/audit/` — `TournamentAuditView` (manager-only; scoped to `tournament_id`; limit 1–200, default 50, newest first).

Routes **aggregated** in this app's `urls.py` but owned elsewhere: `registration-link/`, `teams/`, `forms/`, `matches/`, `standings/`, `generate-fixtures/`, `disputes/`. Acceptance (`POST /api/invitations:accept/`) lives in the organizations app but creates `TournamentMembership` rows.

Exported API surface (importable functions): `accessible_tournaments`, `can_manage_tournament`, `create_tournament`, `merge_rules`, `update_settings`, `can_edit_rules`, `freeze_rules`, `DEFAULT_RULES`, and the three enums.

## Invariants that must be preserved

1. **No existence leak**: inaccessible tournament → 404, never 403/200 (`_get_tournament_or_404`; tested for settings, members, invitations, audit).
2. **Manage gate = ADMIN/CO_ORGANIZER tournament role OR active org ADMIN** (mutating endpoints 403 otherwise).
3. **Visibility scope** = active membership (any role) OR active org-admin; all list/detail filter through `accessible_tournaments`.
4. **Rule freeze boundary** (invariant 7): rules editable only in `draft`/`published`; otherwise blocked unless `amend` + reason.
5. **Idempotency** on `event_id` for create and settings (invariant 3); replay returns existing, ignores new values.
6. **Whitelist merge**: unknown rule keys rejected; partial PATCH preserves existing overrides (`base` layer).
7. **Last-admin guard**: cannot revoke/demote the sole active admin.
8. **Creator becomes ADMIN/ACTIVE** atomically on create; tournament starts `DRAFT`.
9. **Soft delete** + partial unique slug constraint scoped to `deleted_at IS NULL`.
10. **Partial unique active role** per `(user, tournament, role)`.
11. **Audit everything**: create, settings update, member update emit `AuditEvent` rows with `tournament_id`/`organization_id`.

## Dependencies / coupling

### Outgoing (this app imports)
- `apps.accounts.models.uuid7` (PKs).
- `apps.organizations.models` (`Organization`, `OrganizationMembership`, `MembershipRole`) — in both `scope.py` and `permissions.py`.
- `apps.organizations.services.workspace` (`provision_personal_workspace`, `slugify_for_org`), `...services.invitation.create_invitation`.
- `apps.audit.models`/`services` (`emit_audit`, `ActorRole`, `AuditEvent`) — idempotency + audit feed.
- `apps.fixtures.services.constraints` (`validate_constraints`, `CONSTRAINT_TYPES`).
- `apps.sports.models.Sport` (lazy import in create).

### Incoming (other apps import this app)
- `scope.accessible_tournaments` + `permissions.can_manage_tournament` are imported by **disputes, fixtures, forms, matches, teams** views — the single most load-bearing seam in the platform.
- `models.TournamentMembership` / role / status enums consumed by `matches/views.py::_can_score` (checks `MATCH_SCORER`), `matches/services/scoring.py::_is_tournament_member`, `organizations/services/invitation.py` (accept creates memberships).
- `services.rules.merge_rules` consumed by `matches/services/standings.py` (`rules["points"]`, `rules["tiebreakers"]` drive standings).
- `services.create.create_tournament` used across many test fixtures and `run_e2e_demo`.

## Tech debt / smells / duplication

1. **The 6-role enum is triplicated**: `tournaments.models.TournamentMembershipRole`, `organizations.models.MembershipRole`, and `audit.models` all redefine the same six strings. `create_invitation` even validates a *tournament* role against `MembershipRole.values` — works only because the string values coincide. A drift in any one would silently break invitations.
2. **`freeze_rules` is dead in production** — defined and tested but never called on the `registration_open` transition. The freeze gate currently relies entirely on `status` being changed by *some other* code; `rules_frozen_at` is therefore never stamped in normal operation (only the test stamps it). Invariant 7's "stamp on freeze" is effectively unimplemented.
3. **No Tournament status state machine.** Despite invariant 6 ("state machines, not booleans") and the enum's intent, transitions happen via raw `tournament.status = X; .save()` (see `create.py` for DRAFT, tests for `REGISTRATION_OPEN`). There is no `transition_tournament` analogous to `matches/services/state.py::transition_match` — no `ALLOWED_TRANSITIONS`, no guard, no audit on transition, no freeze hook. This is the largest gap vs. the documented architecture.
4. **Three of six roles are inert.** Only `ADMIN`, `CO_ORGANIZER` (manage gate) and `MATCH_SCORER` (`_can_score`) influence behavior. `GAME_COORDINATOR`, `REFEREE`, `TEAM_MANAGER` exist as data/labels with no verb gating yet — the "PRD §3.2 verb matrix" layer is not realized in this app.
5. **`SUSPENDED` status is half-wired.** It's surfaced in the roster (`_ROSTER_STATUSES`) and settable via PATCH, but `accessible_tournaments` / `can_manage_tournament` only check `ACTIVE`, so a suspended member effectively loses all access (suspended == revoked for access purposes). No distinct behavior.
6. **Docstring vs. code mismatch**: `scope.py` and `permissions.py` docstrings say "org admin/owner" but only `MembershipRole.ADMIN` is checked.
7. **N+1/duplicate query pattern**: `_get_tournament_or_404` fetches the row, then re-queries `accessible_tournaments(...).filter(id=...).exists()` — two queries per request, and `accessible_tournaments` itself runs two subqueries. Manage-gated endpoints add another 1–2 queries via `can_manage_tournament`. No request-level memoization.
8. **`urls.py` is a cross-app router.** This app's URL module imports views from five other apps, inverting the usual dependency direction and coupling tournament routing to every sibling app's import health.
9. **Nested merge is shallow (one level).** `merge_rules` only merges the first dict level for `_NESTED` keys; deeper structures would be replaced wholesale (fine today since `DEFAULT_RULES` nesting is flat, but a latent constraint).
10. **`update_settings` audit `actor_role` is hardcoded `ADMIN`** even when the actor is a co-organizer or org admin.

## Restructuring seams & risks

- **Seam A — the access primitives (`accessible_tournaments` / `can_manage_tournament`).** These are the cleanest, highest-value refactor target: a small, pure, well-tested interface that 6 apps depend on. Any restructuring should preserve their exact signatures and 404-not-403 semantics, or it cascades into every domain view. Ideal candidate to fold into a `Policy`/`Scope` service object with query-count optimization and request caching — but the behavior contract (active membership OR active org-admin; ADMIN/CO_ORGANIZER to manage) is load-bearing and covered by isolation tests in *every* app.
- **Seam B — unify the role enum.** Collapse the three duplicate role enums into one canonical source (likely a shared `apps/permissions` or `apps/accounts` location). Risk: migrations reference the choices inline; values must stay byte-identical to avoid data migration.
- **Seam C — introduce the Tournament state machine.** Add `services/state.py::transition_tournament` mirroring matches: `ALLOWED_TRANSITIONS`, guarded + audited transitions, and an `on_commit`/in-transaction call to `freeze_rules` when entering `registration_open`. This wires up the currently-dead `freeze_rules` and satisfies invariant 6. Risk: any existing code doing raw `.status =` must be migrated to the new entrypoint; the deploy-time "migrations blocked while `live`" check and TZ-change-blocked-once-`scheduled` rule (invariant 14) also belong here.
- **Seam D — rules engine extraction.** `DEFAULT_RULES` + `merge_rules` are a clean, sport-agnostic unit but currently football-specific. To make the platform sport-agnostic, `DEFAULT_RULES` should come from the `Sport` (or a sport rules registry) rather than a module constant; `standings.py` already reads through `merge_rules`, so the swap is localized.
- **Seam E — settings/freeze completeness.** Implement the missing 24h grace + notify on amend, stamp `rules_frozen_at` on the real transition, and reconcile `update_settings`'s hardcoded `actor_role`.
- **Risk — soft-delete coverage.** `deleted_at` exists and is honored by `accessible_tournaments`/create slug logic, but there is **no delete endpoint or service** in this app; restructuring must not assume one exists. Cascades (`memberships` are `CASCADE` on the FK but rows aren't soft-deleted in lockstep) are unhandled.
- **Risk — `SUSPENDED` semantics.** If a future change gives suspended members read-but-not-write, both `accessible_tournaments` and `can_manage_tournament` must be touched together, plus the roster filter; today they disagree only by omission.

## Ambiguities (explicitly flagged)

- Whether `freeze_rules` is *intended* to be called elsewhere (a future increment) or is genuinely orphaned is not determinable from code alone; the rules spec (`2026-06-06-tournament-rules-constraints-design.md`) lists "constraint scheduler" and "Settings UI" as remaining, which suggests the transition wiring is deferred, not abandoned.
- The PRD §5.2 transition table is referenced as "canonical, v1 subset" but the actual allowed transitions are not encoded anywhere in this app, so the precise legal graph is unverifiable from `apps/tournaments` source.
