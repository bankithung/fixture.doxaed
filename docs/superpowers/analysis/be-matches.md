# Backend · `apps.matches` — event-sourced scoring (deep read)

**Scope:** `backend/apps/matches/` (models, `services/{events,scoring,state,lineups,incidents,standings}.py`, `views.py`, `urls.py`, `serializers.py`, `tests/`). Read against the platform invariants in `CLAUDE.md` and PRD §5.5.

## Purpose

`matches` is the domain unit that *gets scored*. A `Match` is org-scoped (invariant #2), its `status` is a guarded state machine (invariant #6), and it carries typed home/away dependency pointers (invariant #9) so knockout advancement resolves later. The headline pattern is **event sourcing**: the live score is *derived* from an append-only `MatchEvent` log (invariant #4), never edited in place; corrections are `VOID` events. The app also owns lineups, post-match incident reports, the match state machine, and league-table computation, and is the publisher into the live WebSocket transport.

## File-by-file roles

- **`models.py`** — `MatchStatus` / `MatchEventType` enums; `SCORING_EVENT_TYPES` frozenset (`GOAL`, `PENALTY_SCORED`); models `Match`, `Lineup`, `LineupEntry` (+ `LineupRole`), `MatchIncident` (+ `MatchIncidentKind`), `MatchEvent`. Has the only domain logic in the model layer: `Match.winner_id` / `Match.loser_id` derived properties.
- **`services/events.py`** — the event-sourcing core: `record_match_event`, `recompute_score`, `void_match_event`, `publish_match_event`.
- **`services/scoring.py`** — aggregate result path: `assign_scorer`, `record_score` (final result → `COMPLETED`), `_is_tournament_member` helper.
- **`services/state.py`** — `ALLOWED_TRANSITIONS`, `can_transition`, `transition_match`, `_fire_advancement` (post-commit advancement hook).
- **`services/lineups.py`** — `set_lineup`, `confirm_lineup`, `_validate_team`.
- **`services/incidents.py`** — `file_incident`.
- **`services/standings.py`** — `compute_standings`, `_sort_key` (rules-driven league table).
- **`views.py`** — 10 DRF `GenericAPIView`s (see API surface) + helpers `_match_or_404`, `_accessible_tournament_or_404`, `_can_score`, `_team_in_match_or_400`, `_csv_safe`.
- **`serializers.py`** — `MatchSerializer` (+ `_mini` team), input serializers for each verb, read serializers for lineups/incidents.
- **`urls.py`** — match-scoped routes, mounted at `/api/matches/`. (`TournamentMatchListView` / `TournamentStandingsView` live in `matches/views.py` but are routed by `apps/tournaments/urls.py`.)
- **`tests/`** — `test_events.py`, `test_scoring.py`, `test_state.py`, `test_event_api.py`, `test_match_api.py`, `test_scorer_flow.py`, `test_lineups.py`, `test_incidents.py`, `test_standings_rules.py`.

## Data model

**`Match`** (`matches_match`): UUIDv7 PK; FKs `organization` (CASCADE), `tournament` (CASCADE), `home_team`/`away_team` (`teams.Team`, SET_NULL nullable — knockout slots start empty), `scorer` (User SET_NULL). Structural fields `stage`, `group_label`, `round_no`, `match_no`. Typed pointers `home_source`/`away_source` (JSONField default `dict`) holding `{"type": "team"|"winner_of"|"loser_of"|"group_position"|"tbd", ...}`. Cached `home_score`/`away_score` (PositiveSmallInteger, nullable). `status` (db_index), `scheduled_at`, `venue`, `current_period`, `inputs_hash` (#10), soft-delete `deleted_at`. Indexes: `(tournament,status)`, `(tournament,group_label)`. Derived props `winner_id`/`loser_id` only return non-null when status ∈ {COMPLETED, WALKOVER} and both scores present (draw → None).

**`MatchEvent`** (`matches_match_event`): the system of record. FKs org/tournament/match (all denormalized from the match), `team`/`player`/`related_player` (SET_NULL), self-FK `voids` (SET_NULL → the event being reversed, `related_name="voided_by"`). `sequence_no` (PositiveInteger, gapless per match), `event_type`, `minute`, `period`, `detail` (JSONB), `event_id` (UUID, **unique**, nullable — idempotency #3), `created_by`. **UniqueConstraint `(match, sequence_no)`** = `unique_event_seq_per_match` (DB-level gaplessness guard). Default ordering `["match","sequence_no"]`.

**`Lineup`** (`matches_lineup`): org+match+team, `confirmed_at`/`confirmed_by`, soft-delete. **Partial UniqueConstraint** `(match,team)` where `deleted_at IS NULL` = one live lineup per (match,team). **`LineupEntry`** (`matches_lineup_entry`): `lineup`+`player`+`role`+`shirt_no`, ordered `["role","shirt_no"]`. Note: `LineupEntry` has **no** `organization`/`deleted_at` (it inherits scope from `Lineup`; entries are hard-deleted + recreated on each `set_lineup`).

**`MatchIncident`** (`matches_match_incident`): org+match, `reported_by`, `kind`, `description`, `minute`, `player` (SET_NULL), `event_id` (unique, idempotency). Append-only — no update/delete endpoint. Ordered `["-created_at"]`.

## Core algorithms / services (file:function, step-by-step)

### `events.py::record_match_event`
1. **Idempotency short-circuit** (#3): if `event_id` given and a `MatchEvent` with that id exists, return it (no new row, no rescore).
2. `transaction.atomic()`: `Match.objects.select_for_update().get(pk=...)` locks the row so concurrent scorers can't race the sequence.
3. `next_seq = (Max(sequence_no) for match) or 0) + 1` — **gapless sequence under the row lock** (the DB UniqueConstraint is the backstop).
4. Create the `MatchEvent` (denormalizing org/tournament from the locked match; `period` defaults to `match.current_period`).
5. `recompute_score(locked)` derives + caches the score.
6. `emit_audit(event_type="match_event_recorded", idempotency_key=event_id, ...)`.
7. `transaction.on_commit(lambda: publish_match_event(mid, eid))` — fan-out AFTER commit (#4/#11).

### `events.py::recompute_score`
1. Collect `voided_ids` = the `voids_id` of every `VOID` event for the match.
2. Iterate all events (`.only("id","event_type","team")`): skip if in `voided_ids` or itself a `VOID`.
3. For `SCORING_EVENT_TYPES` (GOAL, PENALTY_SCORED): +1 to the event's own side. For `OWN_GOAL`: +1 to the **opponent**. (PENALTY_MISSED/cards/etc. don't score.)
4. `Match.objects.filter(pk=...).update(home_score, away_score)` and mirror onto the in-memory instance. **Full recompute every event** — O(events) per append; correct and simple, not incremental.

### `events.py::void_match_event`
Thin wrapper: calls `record_match_event` with `event_type=VOID`, `voids=target_event`, copying the target's `team`, `detail={"voids_seq": ...}`. Reversal is append-only (#4). Note: **no guard** prevents double-voiding the same event, voiding a non-scoring event, or voiding a `VOID` (recompute already ignores VOIDs, so it's harmless to score but creates noise rows).

### `events.py::publish_match_event`
Post-commit, best-effort. Lazily imports channels, `get_channel_layer().group_send("match_<id>", {"type": "match.event", "data": {"match_id","event_id"}})`. Any exception is logged and swallowed (delivery never affects the commit). The payload is **only ids** — clients re-fetch the snapshot (`apps/live/views.py::LiveMatchSnapshotView`).

### `scoring.py::record_score`
The *aggregate* result path (sets a final score directly; **does not** create MatchEvents). 1) Idempotency via `AuditEvent.filter(idempotency_key=event_id, event_type="match_scored")` → return match unchanged. 2) `select_for_update`. 3) **Guard:** status must be SCHEDULED or LIVE else `ValidationError` (re-scoring COMPLETED is blocked; corrections go through a separate amend verb that does not yet exist). 4) Capture before-image, set scores, `status=COMPLETED`. 5) Audit. 6) `on_commit(_fire_advancement(mid))` (#9).

### `scoring.py::assign_scorer`
`_is_tournament_member` (active `TournamentMembership`, or org ADMIN `OrganizationMembership`) gate → else `ValidationError`; atomic save + audit.

### `state.py::transition_match`
`select_for_update`; reject if `to` ∉ `ALLOWED_TRANSITIONS[from]`. Side-effects: `LIVE` with empty period → `current_period="first_half"`; `HALF_TIME` → `"half_time"`. Audit `match_status_changed` with before/after. If `to ∈ {COMPLETED, WALKOVER}` → `on_commit(_fire_advancement)`. **`ALLOWED_TRANSITIONS`** (the binding table):
`SCHEDULED→{LIVE,CANCELLED,POSTPONED,WALKOVER}`; `LIVE→{HALF_TIME,COMPLETED,ABANDONED}`; `HALF_TIME→{LIVE,COMPLETED,ABANDONED}`; `POSTPONED→{SCHEDULED,LIVE,CANCELLED}`; `COMPLETED/CANCELLED/ABANDONED/WALKOVER→{}` (terminal).

### `state.py::_fire_advancement` → `fixtures/services/advance.py::advance_from_match`
Post-commit, exception-swallowing. `advance_from_match` loads the match, computes `winner_id`/`loser_id` (draw → no-op), then scans sibling matches in the same tournament and fills `home_team`/`away_team` where `*_source == {"match_id": <this>, "type": "winner_of"|"loser_of"}`. **`group_position` / `tbd` are NOT resolved here** (groups→knockout seeding is handled elsewhere in fixtures).

### `lineups.py::set_lineup`
Idempotency on `AuditEvent(idempotency_key, "lineup_set")` → return existing live lineup. Validate team plays in match; resolve every entry's `Player` (must be non-deleted and `player.team_id == team.id`); validate role. Under lock: **freeze guard** — `status != SCHEDULED` raises (invariant #7, lineups freeze at kickoff). `get_or_create` the live lineup, **delete all entries and `bulk_create`** the new set (full replace). Audit. `confirm_lineup` sets `confirmed_at`/`confirmed_by` once, idempotent, audited.

### `incidents.py::file_incident`
Idempotency on `MatchIncident.event_id`. If `player` given, must belong to a match team. Create + audit + **notify the tournament creator** via `apps.notifications.services.dispatch.create_notification`.

### `standings.py::compute_standings`
Reads `merge_rules(tournament.rules)` for `points` (win/draw/loss) and `tiebreakers`. Aggregates only `COMPLETED`, non-deleted matches (optionally per `group_label`); builds P/W/D/L/GF/GA/Pts rows, computes GD, sorts by `_sort_key` over the configured tiebreaker list (`head_to_head` and unknowns are no-ops in v1; final fallback is name). **`WALKOVER` matches are excluded from standings** even though they have a winner.

## API / endpoint surface

Mounted at `/api/matches/` (`urls.py`); all `IsAuthenticated`:
- `POST /{id}/score/` → `RecordScoreView` (`_can_score`) — returns 200 `MatchSerializer`.
- `POST /{id}/scorer/` → `AssignScorerView` (manager only).
- `POST /{id}/events/` → `RecordMatchEventView` (`_can_score`) — 201; resolves `side`→team and `player_id`/`related_player_id` (must be in-tournament, on a match team).
- `GET /{id}/events/export/` → `MatchEventsExportView` — CSV timeline (any match viewer), with `_csv_safe` formula-injection guard.
- `POST /{id}/transition/` → `TransitionMatchView` (`_can_score`).
- `GET/POST /{id}/lineups/` → `MatchLineupView` (GET any viewer; POST `_can_score`; 200 on replace / 201 on first create).
- `POST /{id}/lineups/confirm/` → `ConfirmLineupView` (`_can_score`).
- `GET/POST /{id}/incidents/` → `MatchIncidentView` (GET any viewer; POST `_can_score`).

Routed from `apps/tournaments/urls.py`: `GET /api/tournaments/{id}/matches/` (`TournamentMatchListView`), `GET /api/tournaments/{id}/standings/` (`TournamentStandingsView`). Public read-only `GET /api/live/match/{id}/` (`apps/live/views.py`, `AllowAny`) and WS `ws/match/<id>/` are *consumers* of this model, defined in `apps.live`.

`_can_score` = `can_manage_tournament(user, t)` OR `match.scorer_id == user.id` OR active `MATCH_SCORER` `TournamentMembership`. Access resolves via `apps/tournaments/scope.py::accessible_tournaments` → **404 (no existence leak)** for cross-org (verified by isolation tests in every test module).

## Invariants that must be preserved

1. **Gapless `sequence_no` per match**, assigned under `select_for_update`, backstopped by the `(match, sequence_no)` UniqueConstraint. Any rewrite of `record_match_event` must keep both the lock and the constraint.
2. **Score is derived, never authored** (via the event path). `recompute_score` is the single source of truth for event-driven scores: GOAL/PENALTY_SCORED → own side; OWN_GOAL → opponent; voided + VOID events excluded.
3. **Corrections are append-only `VOID` events** — never UPDATE/DELETE of `MatchEvent` (#4).
4. **Idempotent writes** (#3): events/incidents on their own unique `event_id`; score/lineup/confirm on `AuditEvent.idempotency_key`. Replay returns the existing record (200, not 201 — except incidents/events which the API returns 201 on replay, see smells).
5. **Publish only on `transaction.on_commit`** (#4/#11); delivery is best-effort and must never break the commit.
6. **State machine is authoritative** (#6); `ALLOWED_TRANSITIONS` matches PRD §5.5 and is enforced under a row lock with an audit row per transition. Terminal states have no exits.
7. **Lineups freeze once `status != SCHEDULED`** (#7).
8. **Advancement is a post-commit hook** resolving typed pointers (#9), and must never crash the request.
9. **Org-scope on every model + endpoint** (#2); cross-org returns 404.
10. **`winner_id`/`loser_id` semantics** (None on draw / non-terminal) are depended on by `advance_from_match` and standings.

## Dependencies / coupling

**Outgoing:** `apps.audit.services.emit_audit` (every verb); `apps.audit.models.ActorRole/AuditEvent`; `channels.layers.get_channel_layer` (publish, lazy); `apps.fixtures.services.advance.advance_from_match` (lazy, post-commit); `apps.tournaments.services.rules.merge_rules` (standings); `apps.tournaments.permissions.can_manage_tournament` + `scope.accessible_tournaments` (views); `apps.tournaments.models` (`TournamentMembership*`); `apps.teams.models.Player/Team` (lazy in views/lineups); `apps.notifications.services.dispatch.create_notification` (incidents); `apps.organizations.models` (member check in scoring).

**Incoming:** `apps.tournaments.urls` (mounts list/standings views) + `run_e2e_demo` command (uses `record_score`/`assign_scorer`/`compute_standings`); `apps.live.views` + `apps.live.tests` (read `Match`/`MatchEvent`, call `record_match_event`); `apps.live.consumers` (binds to `match_<id>` group + `match_event` handler — coupled to the `publish_match_event` payload contract); `apps.fixtures.services.generate` (creates `Match` rows with `home_source`/`away_source`; reads via `compute_standings`); `apps.fixtures.services.advance` (reads/writes `Match`, depends on `winner_id`/`loser_id`); `apps.disputes.views` (looks up `Match`).

## Tech debt / smells / duplication

- **Two divergent score paths.** `record_score` (aggregate, sets `home_score`/`away_score` + COMPLETED directly) and the event path (`record_match_event`→`recompute_score`) are independent and *can disagree*: a match scored via events then `record_score`'d overwrites the derived score; a `record_score`'d match has no events. There is no "complete from event log" verb that reconciles them. This is the biggest correctness seam.
- **No correction/amend verb for `record_score`.** The guard blocks re-scoring COMPLETED and the docstring promises "a separate audited amend verb" that does not exist.
- **Cross-verb `event_id` collision risk.** `AuditEvent.idempotency_key` is **globally unique**, but the per-verb idempotency lookups (`record_score`, `set_lineup`, `confirm_lineup`) additionally filter on `event_type`. Reusing one `event_id` across two different verbs passes the lookup (different `event_type`) then hits the unique constraint on insert → `IntegrityError` (uncaught 500). `MatchEvent`/`MatchIncident` use their own `event_id` columns, so the namespace is split three ways with inconsistent semantics.
- **Replay returns 201, not 200, for events & incidents.** `RecordMatchEventView` always returns 201 and `MatchIncidentView` always 201 even on idempotent replay (the service returns the prior row but the view hardcodes the status). Lineups correctly return 200 on replay. Invariant #3 says replay should be 200 — partially violated.
- **`recompute_score` is a full O(n) recompute per event** and runs two queries each call; fine at football scale but not incremental.
- **Snapshot/void logic duplicated** in `apps/live/views.py` (re-derives `voided_ids` and visible events independently of `recompute_score`). Two implementations of "what counts" can drift.
- **`void_match_event` is unguarded** (double-void, voiding non-scoring/VOID events, voiding across matches not checked) and has **no view/endpoint** — it's service-only, so VOID corrections are currently unreachable from the API despite being a headline feature.
- **`TransitionSerializer.to_status` is a free `CharField`** (not a `ChoiceField`); an unknown status falls through to `can_transition` returning False → ValidationError, so it's safe but loose; `reason` length unbounded.
- **`LineupEntry` lacks `organization`/soft-delete**, breaking the otherwise-uniform multi-tenant + soft-delete pattern (entries are hard-deleted on replace, losing history).
- **`MatchStatus.WALKOVER` excluded from `compute_standings`** while `winner_id` treats it as a result — standings and advancement disagree on whether walkovers count.
- **`MatchEventType` has many types the engine ignores** (SHOT/SAVE/CORNER/FREE_KICK/FOUL/PENALTY_AWARDED/PENALTY_MISSED) — recorded for the timeline but no stats aggregation; migration 0002 lists a smaller choice set than the model (historical drift).
- **Denormalized org/tournament on `MatchEvent`** can theoretically drift from the match's (set once at create from the locked match, so currently safe).

## Restructuring seams & risks

- **Unify the score path.** The cleanest restructuring is to make `record_score` either (a) emit a synthetic event set / completion event and delegate to `recompute_score`, or (b) explicitly become a "manual final score" override that is mutually exclusive with the event log, with a documented precedence. Today both write `Match.home_score/away_score` with no reconciliation — the highest-risk seam.
- **Extract a `MatchEventLog` abstraction** (append + recompute + publish) so the gapless-sequence + lock + on_commit-publish contract lives in one place; `live/views.py`'s snapshot derivation should reuse the same "visible events" function to kill duplication.
- **Add the missing API surface for VOID** and a `record_score` amend verb before any rewrite, since callers (frontend scorer console) presumably need corrections; wire `void_match_event` behind `_can_score`.
- **Normalize idempotency.** Consider a dedicated idempotency table (or per-model `event_id` everywhere) instead of overloading the globally-unique `AuditEvent.idempotency_key`; eliminates the cross-verb collision and the `event_type`-scoped lookup inconsistency. Watch the 201-vs-200 replay contract when touching views.
- **Advancement coupling.** `_fire_advancement` lives in `state.py` but is *also* called from `scoring.py::record_score`; the actual logic is in `apps.fixtures`. Both `record_score` and `transition_match→COMPLETED` can fire it. Centralize the "match reached terminal result" event so advancement fires exactly once and from one place.
- **Concurrency:** all mutating verbs already use `select_for_update`; preserve this. The `Max+1` sequence is safe only under the lock — do not move it out of the atomic block.
- **`MatchEvent` denormalization** (org/tournament) is convenient for `apps.live`/audit queries; if restructured into a generic event store, keep these for tenant-scoped reads.
- **Risk:** many isolation/idempotency/state tests assert exact status codes and error `detail` strings; a restructuring must keep `404`-on-no-access, the `ValidationError`→`{"detail": ...}` mapping, and the transition table verbatim (tests in `test_state.py`, `test_event_api.py`, `test_lineups.py`, `test_incidents.py`, `test_scorer_flow.py`).
