# Flow: Data Model / ERD / Multi-Tenancy

End-to-end trace of the persistence layer of the Fixture Platform: every model, its PK/FK semantics, JSONB columns, the `organization` tenant FK, how cross-org isolation is enforced at read/write time, append-only audit, and the idempotency/uniqueness constraints. Backend is Django (`backend/apps/*`); the frontend (React/Vite) consumes a server-resolved tenancy boundary and never carries an org id in writes.

## 1. The PK convention (invariant 1)

Every model uses a UUID v7 PK defaulted by `apps.accounts.models.py::uuid7` — a stdlib `uuid.UUID` wrapping `uuid_utils.uuid7()`. There is no auto-increment anywhere. UUID v7 is time-ordered, so `created_at + PK` gives natural insertion ordering (see `AuditEvent.Meta` comment in `apps/audit/models.py` deliberately *not* setting `ordering`). The single `uuid7` helper is imported across all apps, making it the one seam to change if PK strategy ever moves.

## 2. The model census (32 models across 11 apps)

- **accounts** (`apps/accounts/models.py`): `User` (custom, `AbstractUser`, `USERNAME_FIELD="email"`, email lowercased in `save()`, soft-delete via `deleted_at` + `soft_delete()` PII anonymization, `last_active_org_id` UUID for the SPA switcher), `TwoFactorDevice`, `RecoveryCode`, `PasswordResetToken`, `EmailVerificationToken`. The four auth-trail models FK to `User` with `on_delete=CASCADE` (auth secrets die with the user).
- **organizations** (`apps/organizations/models.py`): `Organization` (the tenant root — soft-delete, `active_objects` manager filters deleted), `OrganizationMembership` (user×org×role), `AdminInvitation`, `SlugRedirect`.
- **tournaments** (`apps/tournaments/models.py`): `Tournament` (org-scoped, state machine, `rules`/`constraints` JSONB), `TournamentMembership` (the 6 tournament-scoped roles).
- **teams** (`apps/teams/models.py`): `Person` (platform identity, NO org FK — invariant 8), `Team`, `Player`, `RegistrationLink`.
- **matches** (`apps/matches/models.py`): `Match`, `Lineup`, `LineupEntry`, `MatchIncident`, `MatchEvent`.
- **disputes**: `Dispute`. **notifications**: `Notification`. **forms**: `Form`, `FormShareLink`, `FormResponse`, `FormFileUpload`. **permissions**: `Module`, `MembershipModuleGrant`. **sports**: `Sport` (platform metadata, NO org FK). **sadmin**: `Feedback`, `UsageEvent`, `KPISnapshot`. **audit**: `AuditEvent`.

## 3. The tenancy boundary (invariant 2)

`Organization` is the tenant root and is intentionally a *hidden personal workspace* — users never see "orgs", they see tournaments. The boundary is drawn by the **`organization` FK present on every tenant-scoped row**: `Tournament`, `Team`, `Player`, `Match`, `Lineup`, `MatchIncident`, `MatchEvent`, `Dispute`, `Form`, `FormShareLink`, `FormResponse`, `FormFileUpload`, and `MembershipModuleGrant` all carry `organization = FK(Organization, on_delete=CASCADE)`. Deliberately org-LESS: `Person` and `Sport` (cross-tournament/platform metadata), and the audit/usage tables which store `organization_id` as a **bare `UUIDField`** (not a FK) so a row survives org deletion.

The denormalized `organization` FK on deep rows (e.g. `MatchEvent` carries both `organization` and `tournament` even though tournament implies the org) is a redundant-but-fast tenancy tag. It is populated, not derived: `record_match_event` copies `locked.organization_id`/`tournament_id` onto each event (`apps/matches/services/events.py`). **This is an integrity coupling** — nothing at the DB level forces `MatchEvent.organization_id == Match.tournament.organization_id`; the service layer is the only guarantor.

## 4. Cross-org isolation enforcement (no existence leak)

Isolation is *not* row-level-security; it is a queryset funnel. `apps/tournaments/scope.py::accessible_tournaments(user)` returns the set of tournaments a user may see: union of (a) tournaments in orgs where the user is an active `OrganizationMembership` admin, and (b) tournaments where the user holds an active `TournamentMembership`. Every list/detail/mutation view funnels through it:

- `apps/tournaments/views.py:44/69`, `apps/teams/views.py:36/101`, `apps/matches/views.py:53/64` all gate on `accessible_tournaments(user).filter(id=...).exists()`.
- `apps/matches/views.py::_match_or_404` loads the match, then re-checks `accessible_tournaments(user).filter(id=match.tournament_id).exists()` — **object→tournament→access**, returning `NotFound("match_not_found")` (404, not 403) so existence never leaks.

Confirmed by `apps/forms/tests/test_isolation.py`: an outsider GET/PATCH/POST/DELETE on another org's form returns 404, and listing/creating on another's tournament returns 404 (or 403 for create). Write authorization beyond visibility goes through `apps/tournaments/permissions.py::can_manage_tournament` (active tournament admin/co-organizer OR active org admin).

**Client/server sync flag:** the frontend (`frontend/src/api/*`, `frontend/src/types/user.ts`) never sends an `organization` id on writes; tenancy is server-resolved from the session. `last_active_org_id` is a pure UI hint. The server must remain the sole authority — a future client must not be trusted to scope.

## 5. JSONB columns (data-driven, FET-style)

- `Tournament.rules` (dict) + `Tournament.constraints` (list): the scoring/format/tiebreaker engine. `apps/tournaments/services/rules.py::DEFAULT_RULES` is the whitelist; `merge_rules` rejects unknown keys; `compute_standings` reads `rules.points`/`rules.tiebreakers`.
- `Match.home_source` / `Match.away_source` (dict): typed dependency pointers (`{"type":"winner_of","match_id":...}` etc., invariant 9). `MatchEvent.detail`, `Lineup`/n.a., `Form.schema`, `FormResponse.answers`, `FormShareLink.bound_entity`/`prefill`, `Module.default_for_roles`, `AuditEvent.payload_before`/`payload_after`, `sadmin.UsageEvent.payload`, `KPISnapshot.metrics`.

## 6. FK on_delete semantics (the deletion graph)

- `CASCADE` for ownership edges: `organization→tournament→{team,player,match,event,form,...}`, and `Match→{Lineup,LineupEntry,MatchEvent,MatchIncident}`. Deleting an org cascades the entire subtree (but soft-delete is preferred app-side).
- `PROTECT` where deletion must be blocked: `Tournament.sport` (can't delete a sport with live tournaments), `Player.person` (can't delete a Person with registrations), `MembershipModuleGrant.module`.
- `SET_NULL` for "preserve history when the actor/team vanishes": all `created_by`/`reported_by`/`scorer`/`assigned_by` user FKs, `Match.home_team`/`away_team` (so a team can be removed without destroying the fixture), `MatchEvent.team`/`player`, `Dispute.match`, `AuditEvent.actor_user` (with `deleted_user_handle` snapshot preserved).
- `MatchEvent.voids = FK("self", SET_NULL)`: the reversal pointer.

## 7. Append-only audit (invariant 5)

`AuditEvent` (`apps/audit/models.py`) is written ONLY via `apps/audit/services.py::emit_audit` (service-layer, never signals). The append-only guarantee is enforced **at the database layer** by `apps/audit/migrations/0002_audit_append_only.py`: a plpgsql `BEFORE UPDATE OR DELETE` trigger that `RAISE EXCEPTION ... ERRCODE='42501'`. Triggers fire even for superusers, so a mutating migration physically fails. `idempotency_key` is `unique` — replaying a verb returns the existing audit row.

## 8. Idempotency & uniqueness (invariant 3)

Every mutation endpoint takes a client `event_id`/`idempotency_key` UUID:
- `MatchEvent.event_id` (`unique`), `MatchIncident.event_id` (`unique`), `Dispute.event_id` (`unique`), `Notification.event_id` (`unique`), `FormResponse` via `UniqueConstraint(form, event_id)`.
- `record_match_event` does a pre-check `MatchEvent.objects.filter(event_id=...).first()` returning the prior row (200 replay). `emit_audit` and `create_tournament` (`apps/tournaments/services/create.py`) do the same against `idempotency_key`.
- Scoped uniqueness: `unique_tournament_slug_per_org`, `unique_team_slug_per_tournament`, `unique_person_per_tournament`, `unique_jersey_per_team`, `unique_captain_per_team`, `unique_event_seq_per_match`, `unique_active_role_per_user_per_org`, `unique_active_tournament_role`, `one_owner_per_org`, `unique_grant_per_user_org_module`. Most use partial `condition=Q(deleted_at__isnull=True)` / `Q(status="active")` so soft-deleted/inactive rows don't block re-use.

## 9. Ordering / transactions / on_commit (load-bearing)

- **Gapless sequence:** `record_match_event` runs `select_for_update().get(pk=match.pk)` then `Max(sequence_no)+1` inside `transaction.atomic()` — the row lock serializes concurrent scorers; `unique_event_seq_per_match` is the backstop.
- **Derived score:** `recompute_score` recomputes home/away from non-voided events and `Match.objects.filter(pk=...).update(...)` (cached, not source of truth).
- **Publish after commit:** both `record_match_event` and `apps/matches/services/state.py::transition_match` use `transaction.on_commit` — WS/SSE fan-out (`publish_match_event`) and knockout advancement (`apps/fixtures/services/advance.py::advance_from_match`) only fire post-commit (invariants 4, 9, 11). Delivery failures never roll back the DB write.
- **Rule freeze:** `apps/tournaments/services/rules.py::can_edit_rules` allows edits only in `draft`/`published`; `freeze_rules` stamps `rules_frozen_at` on transition to `registration_open` (invariant 7).

## ERD in prose

`User` 1—* `OrganizationMembership` *—1 `Organization` 1—* `Tournament` 1—* {`Team`, `Match`, `Form`, `Dispute`}. `Team` 1—* `Player` *—1 `Person` (platform-global). `Match` references `home_team`/`away_team` (`Team`, SET_NULL) and `home_source`/`away_source` (JSONB pointers to other Matches); `Match` 1—* `MatchEvent` (the event-sourced log) and 1—* `Lineup` 1—* `LineupEntry`. `Tournament` *—1 `Sport` (PROTECT). `User` *—* `Tournament` via `TournamentMembership`. `AuditEvent` is a leaf with bare-UUID scope columns (org/tournament/match), no FK in. Every box except `User`/`Person`/`Sport`/`Module`/`KPISnapshot`/`AuditEvent`/`UsageEvent` carries an `organization` FK.

## Invariants this flow depends on

1. Every tenant-scoped row has a populated `organization` FK consistent with its tournament's org (service-enforced, not DB-enforced).
2. All reads/writes funnel through `accessible_tournaments` / `can_manage_tournament`; 404 (not 403) on no-access.
3. UUID v7 PKs everywhere; ordering relies on time-sortable PKs.
4. `MatchEvent` is the system of record; `Match.home_score`/`away_score` are caches.
5. `AuditEvent` is immutable at the DB layer; `idempotency_key` dedupes.
6. `sequence_no` is gapless under `select_for_update`.
7. Post-commit hooks fire advancement/fan-out, never inside the txn.

## Failure modes

- **Org/tournament FK drift:** if a service writes a child with the wrong `organization_id`, isolation queries (which filter by tournament, not org, on deep models) may still leak — there is no DB CHECK tying `organization_id` to `tournament.organization_id`.
- **`one_owner_per_org` is IMMEDIATE, not DEFERRABLE:** the spec's `DEFERRABLE INITIALLY DEFERRED` for atomic owner-swap was deferred to a follow-up RunSQL that is **not present** (only the declarative constraint in `0001_initial.py`). An in-transaction owner swap can trip the constraint mid-statement.
- **Bare-UUID scope on audit/usage:** no referential integrity; a typo'd `organization_id` is unverifiable.
- **`recompute_score` is O(events):** full re-scan per event; large matches degrade.
- **on_commit silent loss:** if the process dies between commit and `on_commit`, advancement/fan-out is dropped with no retry/outbox.
- **Soft-delete vs CASCADE mismatch:** app prefers `deleted_at`; a hard org delete still CASCADEs and bypasses soft-delete invariants.

## Restructuring seams (clean re-architecture points)

1. **Centralize tenancy:** replace per-view `accessible_tournaments(...).filter(...).exists()` with a tenant-aware base manager / DRF base viewset (or Postgres RLS keyed on a session `org_id`), eliminating the chance any new endpoint forgets to scope.
2. **DB-enforce the org/tournament invariant:** composite FK `(organization_id, tournament_id)` or a CHECK/trigger so `organization` denormalization can't drift.
3. **Make `uuid7` the single PK source** (already true) — easy to swap to native PG `uuid_generate_v7()` defaults.
4. **Transactional outbox** for `on_commit` publish/advancement to remove the silent-loss window.
5. **Materialize the deferrable owner constraint** via the missing RunSQL migration.
6. **Score snapshots:** persist incremental score deltas instead of full `recompute_score` re-scan.
7. **Unify the share-link/token pattern:** `RegistrationLink`, `FormShareLink`, `AdminInvitation`, and the auth tokens all repeat the `sha256(token)` + `expires_at` + counters shape — extract a base `HashedToken`.
