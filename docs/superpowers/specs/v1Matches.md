# v1 — Matches: Match State Machine, MatchEvent Log, Lineups & Live Scoring

> **Status:** Draft v1 (design) — 2026-06-04
> **Owner:** graceschooledu@gmail.com
> **App:** `backend/apps/matches` (+ `backend/apps/live` for transport) — Phase 1B
> **Companion to:** PRD §5.4–§5.9, §7.3, §8 (data model); v1Users.md §5.7–§5.10 (Match scorer/Referee), Appendix A.2 (match modules); v1Fixtures.md §1 (typed deps), §7 (Match lives in `apps.matches`)
> **Implements invariants:** #1 UUIDv7, #2 org isolation, #3 idempotent writes, #4 DB-first event log + on_commit publish, #5 append-only audit, #6 state machines, #7 per-match rule freeze, #8 Person↔Player, #9 typed match deps + advancement hook, #10 inputs_hash/manual-edit, #11 SSE/WS split, #12 module RBAC, #13 i18n+a11y, #14 UTC, #15 session auth

This document is the implementation-ready design for the **matches subsystem**: the `Match` lifecycle, the append-only `MatchEvent` event log that is the system of record, `Lineup` submission, idempotent scorer writes, per-match rule freeze, typed `home_source`/`away_source` advancement, and the WebSocket/SSE live-scoring flows. It depends on `apps.tournaments` (Tournament + structured_rules), `apps.teams` (Team/Person/Player), and `apps.fixtures` (which emits `Match` rows) — each designed separately. Where this design touches those, it states the contract it consumes.

---

## 0. Scope boundary (what this app owns)

**Owns:** `Match`, `MatchStateTransition`, `MatchAssignment`, `Lineup`, `MatchEvent`, `MatchClock` (computed), `PlayerSuspension` (consumes card events), the match state machine, the scorer/referee API, and the advancement hook (`home_source`/`away_source` resolution). The `apps.live` app owns the WebSocket consumers + SSE endpoints + Redis publish chokepoint that deliver `MatchEvent`/state changes.

**Consumes (contracts, not owned here):**
- `Tournament.structured_rules` (JSONB, §5.13 catalog) and `Tournament.status`/`rule_freeze_at` — from `apps.tournaments`.
- `Team`, `Player` (per-tournament, FK→`Person`), `Lineup` validation against squad/suspensions — `apps.teams`.
- `Match` rows + advancement edges (`home_source`/`away_source` JSONB) created by the fixtures generator — `apps.fixtures`.
- `Dispute` lifecycle and cascade — `apps.disputes` (this doc only specifies the `disputed` overlay + advancement-pause hook).

**Out of scope (deferred):** detailed-stats events (`corner`/`foul`/`offside` — gated by `detailed_stats_enabled`, schema-ready but UI v1.5), two-person verification enforcement (stored only), photo/video dispute evidence, player-claim flow.

---

## 1. Reused chassis (do NOT reinvent)

| Need | Reuse | Location |
|---|---|---|
| UUID v7 PK | `from apps.accounts.models import uuid7` | `apps/accounts/models.py:30` |
| Org-scoped queryset | `ScopedQuerySetMixin` w/ `ORG_FIELD="organization"` (denormalized on Match/MatchEvent) | `apps/organizations/scope.py:21` |
| Accessible org IDs | `OrganizationMembership.objects.user_org_ids(user)` | `apps/organizations/models.py:87` |
| Audit emission (inline, atomic w/ state change) | `emit_audit(...)` | `apps/audit/services.py:24` |
| Audit after commit | `emit_audit_on_commit(...)` | `apps/audit/services.py:80` |
| Module visibility gate | `has_module(user, org, "match.scoring_console")` | `apps/permissions/services/resolver.py:135` |
| Verb-level RBAC (§3.2) | permissions matrix service | `apps/permissions/services/matrix.py` + `tests/test_permission_matrix.py` |
| DRF org permission base | `_OrgMembershipPermission`, `IsOrgMember` | `apps/organizations/permissions.py:69` |
| Front-end fetch w/ CSRF + session cookie | `api.post(path, body)` | `frontend/src/api/client.ts:88` |
| Route helpers | `routes.orgScoring`, `routes.orgReferee` (already stubbed) | `frontend/src/lib/routes.ts:36-38` |

**Idempotency contract (PRD §7.6, already proven in chassis):** `emit_audit` dedupes on `idempotency_key` (`apps/audit/services.py:45-48`). The scorer write path uses the **same UUID** the client sends as `MatchEvent.event_id` AND as the audit `idempotency_key`, so re-submission returns the existing rows for both tables.

**Live-transport prep gaps that MUST close first (from `cross-inv-4.md` G1–G6):**
- G1: switch `CHANNEL_LAYERS` to `channels_redis.core.RedisChannelLayer` (`channels-redis>=4.2` already in `pyproject.toml:14`).
- G2: switch `CACHES` to Redis.
- G3: rewrite `fixture/asgi.py` to a `ProtocolTypeRouter({"http": ..., "websocket": URLRouter(...)})`.
- G4: add `prod.py` settings; G5: add `docker-compose.dev.yml` (Postgres + Redis). G6: register `apps.matches`, `apps.live` in `LOCAL_APPS` (`fixture/settings/base.py:46-53`).

---

## 2. Data model (`apps/matches/models.py`)

All PKs `uuid7`. All `DateTimeField` UTC (`USE_TZ=True`, #14). All tenant-scoped via denormalized `organization` FK (#2). Soft-delete via `deleted_at` where a row can be withdrawn.

### 2.1 Enums

```python
class MatchStatus(models.TextChoices):           # PRD §5.5 — primary line
    SCHEDULED               = "scheduled"
    LINEUP_PENDING          = "lineup_pending"
    LINEUP_SUBMITTED        = "lineup_submitted"
    LIVE_PRE_KICKOFF        = "live_pre_kickoff"
    LIVE_FIRST_HALF         = "live_first_half"
    LIVE_HALFTIME           = "live_halftime"
    LIVE_SECOND_HALF        = "live_second_half"
    LIVE_EXTRA_TIME         = "live_extra_time"
    LIVE_PENALTY_SHOOTOUT   = "live_penalty_shootout"
    AWAITING_REFEREE_APPROVAL = "awaiting_referee_approval"
    FINAL                   = "final"
    ARCHIVED                = "archived"
    # Side states (any active state → these; PRD §5.5 "Side states")
    POSTPONED               = "postponed"
    WALKOVER                = "walkover"
    ABANDONED               = "abandoned"
    CANCELLED               = "cancelled"
    # `disputed` and `stranded` are OVERLAYS, not in this enum — see §3.4.

LIVE_STATES = frozenset({  # "any live_* state" used by freeze + decline guards
    "live_pre_kickoff","live_first_half","live_halftime","live_second_half",
    "live_extra_time","live_penalty_shootout"})
TERMINAL_STATES = frozenset({"final","archived","walkover","abandoned","cancelled"})

class MatchEventType(models.TextChoices):        # PRD §5.6 event types (v1)
    GOAL_OPEN_PLAY = "goal_open_play"
    GOAL_PENALTY = "goal_penalty"
    GOAL_OWN_GOAL = "goal_own_goal"
    GOAL_VOIDED = "goal_voided"
    CARD_YELLOW = "card_yellow"
    CARD_RED = "card_red"
    CARD_SECOND_YELLOW = "card_second_yellow"
    SUBSTITUTION = "substitution"
    CAPTAIN_ARMBAND_TRANSFER = "captain_armband_transfer"
    PERIOD_EVENT = "period_event"          # payload.period ∈ kickoff/half_end/...
    PENALTY_SHOOTOUT_KICK = "penalty_shootout_kick"   # payload.made bool
    WALKOVER_DECLARED = "walkover_declared"
    MATCH_ABANDONED = "match_abandoned"
    # gated by detailed_stats_enabled (schema-ready, UI v1.5):
    CORNER="corner"; FOUL="foul"; OFFSIDE="offside"; SHOT="shot"
    SHOT_ON_TARGET="shot_on_target"; POSSESSION_SAMPLE="possession_sample"

class EventStatus(models.TextChoices):           # PRD §5.6
    ACTIVE = "active"; VOIDED = "voided"; CORRECTED = "corrected"

class AssignmentRole(models.TextChoices):
    MATCH_SCORER = "match_scorer"; REFEREE = "referee"

class AssignmentStatus(models.TextChoices):      # v1Users.md §5.9
    ASSIGNED="assigned"; DECLINED="declined"; REPLACED="replaced"
    COMPLETED="completed"; REVOKED="revoked"
```

### 2.2 `Match`

Field list is PRD §8 row "Match" + v1Fixtures §7, with the chassis conventions applied.

```python
class Match(models.Model):
    id = UUIDField(pk, default=uuid7)
    organization = FK("organizations.Organization", PROTECT)   # denormalized (#2, #4 query speed)
    tournament   = FK("tournaments.Tournament", PROTECT, related_name="matches")
    stage        = FK("tournaments.Stage", null=True, on_delete=PROTECT)
    group        = FK("tournaments.Group", null=True, on_delete=PROTECT)
    round        = PositiveIntegerField(null=True)             # bracket round / RR matchday
    slot         = PositiveIntegerField(null=True)             # position within round

    # Typed dependency pointers (#9) — JSONB, NEVER inferred from bracket shape.
    home_source  = JSONField(default=_tbd_source)   # see §6 shape
    away_source  = JSONField(default=_tbd_source)
    home_team    = FK("teams.Team", null=True, on_delete=PROTECT, related_name="home_matches")
    away_team    = FK("teams.Team", null=True, on_delete=PROTECT, related_name="away_matches")

    venue        = FK("fixtures.Venue", null=True, on_delete=SET_NULL)
    scheduled_at = DateTimeField(null=True, db_index=True)     # UTC

    status       = CharField(choices=MatchStatus.choices, default="scheduled", db_index=True)
    is_disputed  = BooleanField(default=False)                 # overlay (#§3.4)
    is_stranded  = BooleanField(default=False)                 # overlay (v1Users §5.9)
    paused_state_before = CharField(blank=True)                # for resume from postponed/disputed

    score_home   = PositiveIntegerField(default=0)             # regulation+ET running tally (materialized from events)
    score_away   = PositiveIntegerField(default=0)
    pens_home    = PositiveIntegerField(null=True)             # shootout result
    pens_away    = PositiveIntegerField(null=True)
    periods      = JSONField(default=list)                     # [{period, started_at, ended_at, stoppage_min}]
    two_legged_aggregate = JSONField(null=True)                # {leg, sibling_match_id, agg_home, agg_away}

    lineup_home  = FK("Lineup", null=True, on_delete=SET_NULL, related_name="+")
    lineup_away  = FK("Lineup", null=True, on_delete=SET_NULL, related_name="+")

    kicks_off_team   = FK("teams.Team", null=True, on_delete=SET_NULL, related_name="+")   # coin toss
    defends_side_team= FK("teams.Team", null=True, on_delete=SET_NULL, related_name="+")

    is_bye       = BooleanField(default=False)
    parent_match = FK("self", null=True, on_delete=SET_NULL, related_name="children")

    # Per-match rule freeze (#7): snapshot taken at live_first_half entry.
    frozen_rules = JSONField(null=True)            # immutable copy of effective structured_rules
    rules_frozen_at = DateTimeField(null=True)

    # Clock authority (PRD §5.6 "Server computes authoritative clock")
    clock_started_at = DateTimeField(null=True)    # kickoff of CURRENT period
    current_period   = CharField(blank=True)       # first_half/second_half/et1/et2/pens
    paused_intervals = JSONField(default=list)     # [{from, to}] within current period

    # Conflict-warning (#10) — Match is an auto-generated artifact (fixtures).
    inputs_hash       = CharField(blank=True)
    last_manual_edit_at = DateTimeField(null=True)
    locked            = BooleanField(default=False)   # manual schedule lock (fixtures)

    referee_approval_required = BooleanField(default=True)   # snapshot of rule at freeze
    deleted_at = DateTimeField(null=True, db_index=True)
    created_at = DateTimeField(auto_now_add=True)
    updated_at = DateTimeField(auto_now=True)

    objects = MatchManager()         # default (incl soft-deleted) — mirrors Organization pattern
    active_objects = ActiveMatchManager()

    class Meta:
        indexes = [
            Index(fields=["tournament","scheduled_at"]),     # PRD §6 mandated index
            Index(fields=["organization","status"]),
            Index(fields=["status","scheduled_at"]),          # auto-transition cron sweep
        ]
        constraints = [
            CheckConstraint(condition=Q(home_team__isnull=True)|~Q(home_team=F("away_team")),
                            name="match_home_ne_away"),
        ]
```
`_tbd_source()` returns `{"type": "tbd"}`.

### 2.3 `MatchStateTransition` (PRD §8) — audit-grade transition log

```python
class MatchStateTransition(models.Model):
    id = UUIDField(pk, default=uuid7)
    match = FK(Match, PROTECT, related_name="transitions")
    from_state = CharField()
    to_state   = CharField()
    actor = FK(User, null=True, on_delete=SET_NULL)
    actor_role = CharField()                      # snapshot (ActorRole taxonomy)
    reason = TextField(blank=True)                # required for cancel/postpone/abandon/force-finalize
    trigger = CharField()                         # "scorer_kick_off" | "auto_clock" | "referee_approve" | ...
    created_at = DateTimeField(auto_now_add=True)
    class Meta:
        indexes = [Index(fields=["match","created_at"])]
```
This is *operational* history; the platform-wide `AuditEvent` (append-only at DB role, #5) is **also** written for every transition via `emit_audit` — the two are complementary (the transition table is queried for the match timeline UI; AuditEvent is the legal record).

### 2.4 `MatchAssignment` (v1Users.md §5.7 — locked schema)

```python
class MatchAssignment(models.Model):
    id = UUIDField(pk, default=uuid7)
    organization = FK("organizations.Organization", PROTECT)   # denormalized for isolation
    match = FK(Match, PROTECT, related_name="assignments")
    user  = FK(User, PROTECT)
    role  = CharField(choices=AssignmentRole.choices)
    status= CharField(choices=AssignmentStatus.choices, default="assigned")
    assigned_by = FK(User, null=True, on_delete=SET_NULL)
    assigned_at = DateTimeField(auto_now_add=True)
    declined_at = DateTimeField(null=True); declined_reason = TextField(blank=True)
    replaced_by_assignment = FK("self", null=True, on_delete=SET_NULL)
    completed_at = DateTimeField(null=True); revoked_at = DateTimeField(null=True)
    class Meta:
        constraints = [
            UniqueConstraint(fields=["match","user","role"], condition=Q(status="assigned"),
                             name="unique_active_match_assignment"),   # v1Users §5.7
        ]
        indexes = [Index(fields=["match","role","status"]),
                   Index(fields=["user","status"])]
```

**Separation-of-duties (v1Users §5.9, locked):** a user cannot be both `match_scorer` AND `referee` (status=assigned) on the same match. Enforced by (1) the assignment **service** as first line, and (2) a `pre_save` signal on `MatchAssignment` running in the same transaction (Django `CheckConstraint` can't express the subquery). Postgres `EXCLUDE` constraint is the v1.5 DB-level hardening target.

**Authorization invariant (v1Users §5.7):** to act as scorer on Match M a user needs BOTH `OrganizationMembership(role=match_scorer, is_active)` in `M.organization` AND `MatchAssignment(match=M, role=match_scorer, status=assigned)`. The Org-only row = "in the pool, assignable." This is the canonical permission check, layered on top of `has_module(... "match.scoring_console")`.

### 2.5 `Lineup` (PRD §8, §5.4)

```python
class Lineup(models.Model):
    id = UUIDField(pk, default=uuid7)
    organization = FK("organizations.Organization", PROTECT)   # denormalized
    match = FK(Match, PROTECT, related_name="lineups")
    team  = FK("teams.Team", PROTECT)
    formation = CharField()                       # from rule default_formations, e.g. "4-4-2"
    starters  = JSONField()  # [{player_id, person_id, jersey_no, position, is_gk, is_captain}]
    bench     = JSONField()  # same shape
    captain   = FK("teams.Player", null=True, on_delete=SET_NULL, related_name="+")
    gk        = FK("teams.Player", null=True, on_delete=SET_NULL, related_name="+")
    submitted_at = DateTimeField(null=True)
    submitted_by = FK(User, null=True, on_delete=SET_NULL)
    is_override  = BooleanField(default=False)     # admin override submit (audit-logged)
    # Conflict-warning (#10): lineup is auto-fillable from squad but manually edited.
    version      = PositiveIntegerField(default=1) # bump on each (late) edit (PRD §5.4)
    confirmed_at_kickoff_by = FK(User, null=True, on_delete=SET_NULL, related_name="+")  # scorer confirm
    created_at = DateTimeField(auto_now_add=True); updated_at = DateTimeField(auto_now=True)
    class Meta:
        constraints = [UniqueConstraint(fields=["match","team"], name="one_lineup_per_team_per_match")]
```
`starters`/`bench` store a **snapshot** of player attributes (jersey, position) so a later Player.jersey_no edit (PRD §5.3) does not retroactively rewrite history. The same snapshot principle governs `MatchEvent.payload`.

### 2.6 `MatchEvent` — the system of record (#4), append-only (#5)

```python
class MatchEvent(models.Model):
    id = UUIDField(pk, default=uuid7)
    organization = FK("organizations.Organization", PROTECT)   # denormalized (#4)
    match = FK(Match, PROTECT, related_name="events")
    sequence_id = BigIntegerField()               # monotonic per-match ordering (server-assigned)
    event_id = UUIDField(unique=True)             # CLIENT-generated idempotency key (#3, #7.6)
    type  = CharField(choices=MatchEventType.choices)
    minute = PositiveIntegerField(null=True)      # match-minute (display)
    stoppage_time = PositiveIntegerField(null=True)  # the "+N"
    period = CharField(blank=True)                # which period the event belongs to
    payload = JSONField(default=dict)             # snapshot: {player_id, person_id, jersey_no, team_id, assist_id, in_id, out_id, period, made, ...}
    actor_user = FK(User, null=True, on_delete=SET_NULL)
    actor_role = CharField()                      # snapshot of role at write time
    server_ts  = DateTimeField(auto_now_add=True) # authoritative timestamp
    client_ts  = DateTimeField(null=True)         # for drift display (PRD §5.6); NEVER trusted
    event_status = CharField(choices=EventStatus.choices, default="active", db_index=True)
    voided_by_event_id      = UUIDField(null=True)  # the void event that killed this
    corrected_from_event_id = UUIDField(null=True)  # this event corrects that one
    created_at = DateTimeField(auto_now_add=True)
    class Meta:
        constraints = [
            UniqueConstraint(fields=["event_id"], name="matchevent_event_id_unique"),  # #3
            UniqueConstraint(fields=["match","sequence_id"], name="matchevent_match_seq_unique"),
        ]
        indexes = [
            Index(fields=["match","sequence_id"]),                      # PRD §6 mandated
            Index(fields=["organization","-server_ts"]),
            Index(fields=["match"], condition=Q(event_status="active"), name="matchevent_active_idx"),  # PRD §6 partial
        ]
```

**Append-only enforcement (#5):** `MatchEvent` rows are **never** UPDATEd or DELETEd in the void/correct flow. Voiding inserts a NEW `goal_voided`/correction event and sets the *original's* `event_status`/`voided_by_event_id` — that is the ONE exception (a status flip on the original). The PRD §3.2 matrix makes "Delete MatchEvent row" ❌ for **every** role including super-admin (`prd.md:183`). To honor #5 at the DB-role level the same way `AuditEvent` does, the migration grants the app role `INSERT` + a column-restricted `UPDATE` on `match_event` limited to `(event_status, voided_by_event_id)` only, and **denies DELETE**. (Simpler v1 alternative if column-grants prove fragile: model void as a pure insert and compute `event_status` from the presence of a voiding event — chosen at build time; default = column-restricted UPDATE for query simplicity, matching the §6-mandated partial index on `event_status`.)

### 2.7 `PlayerSuspension` (PRD §5.8) — derived from card events

```python
class PlayerSuspension(models.Model):
    id = UUIDField(pk, default=uuid7)
    organization = FK("organizations.Organization", PROTECT)
    player = FK("teams.Player", PROTECT)
    tournament = FK("tournaments.Tournament", PROTECT)
    applies_to_match = FK(Match, null=True, on_delete=SET_NULL, related_name="suspensions_blocking")
    reason = CharField()              # "two_yellows" | "red_card" | "second_yellow" | "admin"
    source_event = FK(MatchEvent, null=True, on_delete=SET_NULL)
    status = CharField()             # "active" | "served" | "overridden"
    overridden_by = FK(User, null=True, on_delete=SET_NULL); override_reason = TextField(blank=True)
    created_at = DateTimeField(auto_now_add=True)
```
Created by the `card_issued` on_commit hook (§7). Consumed by lineup validation as a hard block (§5.4 / §5.8).

---

## 3. Match state machine (PRD §5.5)

### 3.1 Transition table (canonical — must match PRD §5.5 exactly)

| From | To | Trigger | Precondition | Side-effects (on_commit) |
|---|---|---|---|---|
| `scheduled` | `lineup_pending` | auto at `kickoff − lineup_deadline_minutes_before_kickoff×2` | — | notify TMs (lineup-deadline-approaching) |
| `lineup_pending` | `lineup_submitted` | both lineups submitted + validation pass | both `Lineup.submitted_at` set, validation clean | — |
| `lineup_pending` | `walkover`/`postponed` | `lineup_miss_policy` fires at deadline | one/both missing | walkover advancement OR reschedule |
| `lineup_submitted` | `live_pre_kickoff` | scorer "Begin pre-kickoff" (after coin toss) | scorer assigned; coin toss recorded | — |
| `live_pre_kickoff` | `live_first_half` | scorer "Kick off" | — | **freeze rules** (#7); set `clock_started_at`; emit `period_event:kickoff` |
| `live_first_half` | `live_halftime` | scorer "End half" (+stoppage) | — | pause clock; `period_event:half_end` |
| `live_halftime` | `live_second_half` | scorer "Kick off 2nd half" | — | resume clock; `period_event:half_resume` |
| `live_second_half` | `live_extra_time` | scorer "Start ET" | rules permit ET + scores level | `period_event:extra_time_start` |
| `live_extra_time` | `live_penalty_shootout` | scorer "Start penalties" | rules permit pens | `period_event:pen_shootout_start` |
| any `live_*` | `awaiting_referee_approval` | scorer "Full time"/end ET/end pens | — | stop clock; `period_event:full_time`; notify referee (`score_pending_approval`) |
| `awaiting_referee_approval` | `final` | referee approves (or `referee_approval_required=False` → auto) | referee assigned approves | **fire advancement** (#9); recompute standings/leaderboard; suspensions finalize; notify (`score_approved`, `match_ended`); start dispute window |
| `awaiting_referee_approval` | most-recent `live_*` | referee rejects (reason) | — | notify scorer (`score_rejected`) |
| `awaiting_referee_approval` | `final` | Admin/GameCoord force-finalize after `referee_approval_timeout_hours` (default 24) | timeout elapsed | as referee-approve; audit reason required |
| any non-terminal | `postponed` | Admin/Coord (reason) | not terminal | reschedule; notify |
| any | `walkover` | scorer/Coord (reason) | not terminal | apply `walkover_score`; advancement |
| any `live_*` | `abandoned` | scorer/Coord (reason) | live | per `abandonment_policy` |
| any non-terminal | `cancelled` | Admin (reason ≥20) | not terminal | bracket-aware (dependent gets bye/walkover) |
| `final` | `archived` | auto after tournament `archive_after_days` | — | — |

**Overlays (do not replace base state):** `disputed` (a dispute is open → `is_disputed=True`, advancement paused), `stranded` (v1Users §5.9 — live match, no `MatchEvent` 30 min, no scorer connection → `is_stranded=True`; auto-postpone 15 min later).

### 3.2 Implementation (`apps/matches/services/state_machine.py`)

A single `transition(match, to_state, *, actor, role, trigger, reason="", request=None)` service function:
1. `with transaction.atomic():`
2. Validate `(from_state → to_state)` against a `_ALLOWED: dict[str, set[str]]` map + per-transition precondition callable. Illegal transition → `InvalidTransition` (maps to HTTP 409 `conflict`).
3. `select_for_update()` the `Match` row (prevents the two-scorer race; see §8).
4. Mutate `match.status` (+ clock/freeze fields), save.
5. Insert `MatchStateTransition` row.
6. `emit_audit(event_type=f"match.{to_state}", target_type="match", target_id=match.id, idempotency_key=..., reason=..., match_id=..., tournament_id=..., organization_id=...)` — **inline** (shares atomicity, per audit B.4).
7. Register domain-event hooks via `transaction.on_commit(...)` (advancement, suspensions, notifications, Redis publish).

**Auto-transitions** (`scheduled→lineup_pending`, `scheduled→live` window, archive, lineup-miss-policy, stranded sweep) run from a management command `run_match_scheduler` invoked by a 1-minute systemd timer / Channels worker (mirrors `mark_orphaned_orgs` command pattern at `apps/organizations/management/commands/`). Each auto-transition uses `actor=None, actor_role=ActorRole.SYSTEM`.

### 3.3 Per-match rule freeze (#7, PRD §5.5)

On `live_pre_kickoff → live_first_half`, copy the **effective** structured rules into `Match.frozen_rules` and stamp `rules_frozen_at`. After that, any tournament-level rule amend (even an active one mid-grace-period) is ignored for this match: every rule lookup during scoring reads `match.frozen_rules` (falling back to `tournament.structured_rules` only when `frozen_rules is None`, i.e. pre-kickoff). A mid-match rule-edit attempt is blocked at the API with `conflict` + i18n message "Match rules are frozen once the match has started" (PRD §5.6 conflict-scenario row).

### 3.4 Disputed overlay (advancement pause)

When `apps.disputes` raises a dispute on a `final` match within the window, it calls `matches.services.mark_disputed(match)` → `is_disputed=True`, pauses advancement (dependent matches show "pending"). `clear_disputed(match)` (all disputes resolved) recomputes advancement **once** per `dispute_cascade_policy`. This doc only owns the flag + the recompute entry point; the cascade engine lives in `apps.disputes`.

---

## 4. Lineups (PRD §5.4)

### 4.1 Submission flow
- Both team managers (or Admin override) POST a lineup. `lineup_pending → lineup_submitted` only when **both** present and **both** validate.
- **Validation (hard blocks):** all players in registered squad; no suspended players (query `PlayerSuspension(status=active, applies_to_match=M)`); squad size within `squad_size_min/max`; ≥1 GK in starters; ≥1 GK on bench if bench>0; captain ∈ starters; jersey numbers unique per team. Failures return `validation_error` with field-keyed messages.
- **Deadline:** `lineup_deadline_minutes_before_kickoff` (default 60). Miss → `lineup_miss_policy` (`auto_walkover_against_missing` default / `auto_postpone` / `notify_admin_only`).
- **Late edit** (after deadline, before kickoff): allowed only with referee approval; bumps `Lineup.version`; audit-logged.
- **Kickoff confirmation:** scorer confirms lineup at `live_pre_kickoff`; mismatch → scorer+referee resolve (sets `confirmed_at_kickoff_by`).

---

## 5. Scorer & referee flows

### 5.1 Scorer event-write path (the idempotent core — #3, #4)

`POST /api/matches/{id}/events/` with body `{event_id (UUID), type, minute, stoppage_time, payload, client_ts}`:

```
1. AuthZ: session (#15) → has_module(user, org, "match.scoring_console")
          → §3.2 verb "Live scoring (enter events)" allowed for role
          → MatchAssignment(match, user, role=match_scorer, status=assigned) exists
          → match.status in LIVE_STATES (else 409 conflict)
2. with transaction.atomic():
   a. dedupe = MatchEvent.objects.filter(event_id=body.event_id).first()
      if dedupe: return 200 + serialized(dedupe)         # idempotent replay (#3)
   b. match = Match.objects.select_for_update().get(id=...)   # serialize concurrent scorers (#8)
   c. validate event vs FROZEN rules (sub count ≤ substitutes_allowed, etc.)
   d. seq = (match.events.aggregate(Max(sequence_id)) or 0) + 1
   e. MatchEvent.objects.create(event_id=body.event_id, sequence_id=seq, server_ts=now,
                                event_status="active", payload=snapshot(body.payload), ...)
   f. apply side-effect to materialized Match fields (score_home/away tally) inside txn
   g. emit_audit(idempotency_key=body.event_id, event_type=f"match.event.{type}", ...)  # inline
3. transaction.on_commit(lambda: publish("match:{id}", event_envelope))   # Redis (#4, #11)
   transaction.on_commit(domain hooks: card_issued → suspensions; goal → leaderboard)
4. return 201 + serialized(event)
```

The **same `event_id`** is the `MatchEvent.event_id` AND the audit `idempotency_key`, so a retried write returns the existing row from both tables (proven dedupe at `apps/audit/services.py:45`). The server timestamp is authoritative; `client_ts` is stored only to render the drift banner (PRD §5.6) and is never used for ordering.

### 5.2 Void / correct (pre-final) — append-only (#5)
- **Void:** insert a `goal_voided` event with `payload.target_event_id`; set the original `event_status="voided"`, `voided_by_event_id=new.id`. Original retained (strikethrough in UI). §3.2 verb "Void MatchEvent" — never DELETE.
- **Correct:** insert a new event of the corrected type with `corrected_from_event_id=original.id`; original `event_status="corrected"`. Referee (or scorer with referee approval) only.

### 5.3 Clock authority (PRD §5.6)
Server computes the live minute from `clock_started_at + Σ(period durations) − Σ(paused_intervals)`; the SSE/WS payload carries `{current_period, server_now, clock_started_at, paused_intervals}` and clients render locally. Stoppage time is explicit on the wire.

### 5.4 Referee flow (PRD §5.6)
- Subscribes to the match WS room; sees scorer events in real time; can flag draft entries, correct entries (creating `corrected` events), and at full time uses the **approval UI** (grouped goals/cards/subs/period) to `awaiting_referee_approval → final` (approve) or → most-recent `live_*` (reject + reason).
- **Recusal** (v1Users §5.9): `MatchAssignment.status=declined` only in `scheduled`/`lineup_pending`/`lineup_submitted` (never live). Coordinator creates a replacement assignment; original `replaced_by_assignment` points at it.
- Force-finalize (Admin/GameCoord) after timeout (§3.1 row).

### 5.5 Penalty shootout
`penalty_shootout_kick` events with `payload={team_id, player_id, made: bool, round}`; running totals materialized into `pens_home`/`pens_away`; sudden-death after `penalty_shootout_initial_rounds`. End → `awaiting_referee_approval`.

---

## 6. Typed dependencies & advancement (#9)

### 6.1 Source pointer shape (JSONB, v1Fixtures §1, §7)
```jsonc
{ "type": "team",           "team_id": "<uuid>" }                       // concrete
{ "type": "winner_of",      "match_id": "<uuid>" }
{ "type": "loser_of",       "match_id": "<uuid>" }
{ "type": "group_position", "group_id": "<uuid>", "position": 1 }
{ "type": "tbd" }                                                       // unresolved
```

### 6.2 Advancement hook (on_commit, on `→ final`)
`matches.services.advancement.resolve_dependents(finalized_match)`:
1. Find matches whose `home_source`/`away_source` reference `finalized_match` (`winner_of`/`loser_of`) — a JSONB containment query (`home_source__contains={"match_id": id}`).
2. Resolve the concrete team (winner/loser by `score_home/away`, pens tiebreak); set `home_team`/`away_team`; rewrite the source to `{"type":"team",...}` is **not** done (keep the typed pointer for provenance; just fill the FK).
3. For group-stage finals, on every `match_finalized` in a group, recompute standings (`apps.tournaments` tiebreaker service) and resolve `group_position` pointers when the group completes.
4. Notify `your_team_advanced` / `your_next_match_set` (PRD §5.14).
5. If `finalized_match.is_disputed` → **do not** advance (paused until cleared).

Advancement is an explicit hook fired in `transaction.on_commit`, **never** inferred from bracket structure — this is what lets re-draw/re-schedule run independently (v1Fixtures §1).

---

## 7. Domain-event hooks (PRD §7.3) — all `transaction.on_commit`

| Hook | Trigger | Action | Owner |
|---|---|---|---|
| `match_finalized` | `→ final` | advancement (§6); standings; leaderboard; notifications; open dispute window | matches + tournaments |
| `card_issued` | `card_red`/`card_second_yellow`/`card_yellow` event | recompute suspensions → create `PlayerSuspension` | matches §2.7 / §5.8 |
| `dispute_resolved` | disputes app | recompute advancement per `dispute_cascade_policy` (once after all resolved) | disputes → matches |
| `match_state_changed` | any transition | Redis publish to `match:{id}`; role notifications | live + notifications |
| `team_disqualified` | teams app | walkovers for future matches; `dq_stats_policy` | teams → matches |

Every hook is registered inside the state-machine/event-write transaction via `transaction.on_commit`, so the Redis publish (delivery only, #4/#11) can never reference an uncommitted row — directly fixing the copy-paste hazard flagged in `cross-inv-4.md` F1.

---

## 8. Concurrency, isolation, idempotency (invariants #2, #3, #8-race)

- **Two scorers:** `select_for_update()` on the `Match` row serializes `sequence_id` assignment and clock mutation; server orders by `(sequence_id, server_ts)` (PRD §5.6). The "another scorer present" indicator comes from the WS room presence set (Redis), not the DB.
- **Idempotent retry:** unique `event_id` + the dedupe-first branch (§5.1a) → re-POST returns 200 with the existing event (PRD §7.6). The frontend localStorage queue (PRD §5.6) re-flushes with the original `event_id`, so flush is safe.
- **Cross-org isolation (#2):** every query path (`MatchViewSet`, `MatchEventViewSet`, the SSE endpoint, the WS consumer's `connect`) filters via `Match.objects.scoped_for(user)` / `MatchAssignment` membership; `organization` is denormalized on `Match`/`MatchEvent`/`Lineup`/`MatchAssignment` so isolation never needs a join. **Isolation test is mandatory** for every endpoint AND the WS/SSE channels (user A in Org X cannot subscribe to a `match:{id}` in Org Y).

---

## 9. API surface (`apps/matches/urls.py`, `apps/live/urls.py`)

DRF, session auth (#15), CSRF on unsafe verbs, `event_id` on all writes. All under `/api/`. AuthZ stack per endpoint = `has_module` gate + §3.2 verb + scope (assignment/membership).

| Method & path | Purpose | AuthZ |
|---|---|---|
| `GET /api/tournaments/{tid}/matches/` | list matches (filter by status/stage/round) | org member; public subset via `/api/public/...` |
| `GET /api/matches/{id}/` | match detail (admin overlay if module) | `match.center_admin_view` or public |
| `POST /api/matches/{id}/assignments/` | assign scorer/referee (+ COI soft-warn) | Admin/Co-org/GameCoord(scoped) |
| `POST /api/matches/{id}/assignments/{aid}/decline/` | recuse (reason ≥20; not in live) | assigned user |
| `POST /api/matches/{id}/lineups/` | submit lineup | TM(own team) / Admin override; `match.lineup_submission` |
| `POST /api/matches/{id}/transition/` | drive state machine (kickoff/half/full-time/etc.) | scorer(assigned)+`scoring_console`; referee for approve/reject; Admin for postpone/cancel/force-finalize |
| `POST /api/matches/{id}/coin-toss/` | record toss (kicks_off/defends) | referee/scorer |
| `POST /api/matches/{id}/confirm-lineup/` | scorer kickoff confirmation | scorer(assigned) |
| `POST /api/matches/{id}/events/` | **write event (idempotent, #3)** | scorer(assigned)+`scoring_console`; match live |
| `POST /api/matches/{id}/events/{eid}/void/` | void event (append-only) | scorer/referee per §3.2 |
| `POST /api/matches/{id}/events/{eid}/correct/` | correct event | referee (or scorer+approval) |
| `GET /api/matches/{id}/events/` | full event log (incl voided) | `match.center_admin_view` / public active-only |
| `POST /api/matches/{id}/approve/` | referee approve → final | referee(assigned)+`referee_console` |
| `POST /api/matches/{id}/reject/` | referee reject → live_* | referee(assigned) |
| **Live transport (`apps/live`):** | | |
| `GET /api/live/matches/{id}/stream` (SSE) | viewer one-way (#11) — events+clock+state | public (rate-limited 100 conns/IP, PRD §7.7) |
| `WS /ws/matches/{id}/score` | scorer/referee bidirectional room (#11) | scorer/referee assigned; presence set |
| `GET /api/live/users/{uuid}/notifications` (SSE) | bell (owned by notifications) | self |

**Idempotent writes return 200 (existing) not 201** for replayed `event_id` (PRD §7.6). Errors use the chassis `ApiError` shape (`frontend/src/types/api.ts`): `validation_error` / `conflict` / `permission_denied`.

---

## 10. Frontend (`frontend/src/features/matches`, `scoring`, `referee`, `viewer`)

Reuses `api` client (`frontend/src/api/client.ts`), TanStack Query, the existing `routes` helpers (`orgScoring`/`orgReferee` already stubbed at `routes.ts:36-38`), shadcn/ui + the locked SaaS overhaul (lucide + framer-motion + dark mode). i18n via `t()` (#13); WCAG 2.1 AA on all **non-scorer** surfaces (scorer is tap-optimized, polish v1.5).

| Route | Page | Notes |
|---|---|---|
| `/o/:slug/t/:tslug/matches` | Match list (admin) | status filters, assign scorer/referee |
| `/o/:slug/m/:mid/scoring` | **Scoring Console** (`match.scoring_console`) | tap UI; clock; event picker; optimistic + status pill (Live ✓ / Reconnecting / Offline N); localStorage queue keyed by `event_id`; concurrent-scorer badge; clock-drift banner; penalty-shootout UI |
| `/o/:slug/m/:mid/referee` | **Referee Console** (`match.referee_console`) | live event feed (WS); flag/correct; grouped approval form; reject+reason |
| `/m/:mslug/:mid` (public) | **Match Center** (SSE) | summary, lineups (SVG formation), events, stats, H2H, tournament context; shows `disputed` without details |

**Client transport:** `EventSource` for public viewer + bell (SSE, #11); `WebSocket` for scoring/referee rooms. The scoring store (Zustand) holds the optimistic queue; each queued action carries a client-generated UUID used as `event_id` so reconnect-flush is idempotent. SSE/WS reconnect with backoff; on reconnect the client re-fetches the event log to reconcile.

---

## 11. Tests to write (tests-first for non-trivial logic — project convention)

**Backend (`apps/matches/tests/`):**
- `test_state_machine.py` — **every** allowed transition AND every blocked transition (PRD §5.5); auto-transitions with `actor=SYSTEM`; force-finalize after timeout; per-match rule-freeze blocks mid-match amend.
- `test_event_idempotency.py` — same `event_id` twice → one `MatchEvent`, one `AuditEvent`, 200 on replay (#3).
- `test_event_append_only.py` — void/correct never DELETE; original retained with flipped status; DB-role denies DELETE on `match_event` (mirrors audit append-only test #5).
- `test_concurrent_scorers.py` — two parallel writes → contiguous `sequence_id`, no gap/dup (select_for_update).
- `test_lineup_validation.py` — squad/suspension/GK/captain/jersey rules; deadline-miss policies.
- `test_advancement.py` — `winner_of`/`loser_of`/`group_position` resolution on `→ final`; paused when `is_disputed`; re-draw independence (#9).
- `test_suspension_calc.py` — 2 yellows / red / second-yellow → `PlayerSuspension`; carries-across-stages toggle; admin override (PRD §5.8).
- `test_assignment_lifecycle.py` — assign/decline/replace/revoke/complete; unique-active constraint; **scorer≠referee on same match** (signal); recuse-blocked-when-live.
- `test_match_isolation.py` — **mandatory** (#2): user A/Org X gets 404/403 on every match endpoint + cannot subscribe to Org Y `match:{id}` SSE/WS.
- `test_module_matrix.py` extension — parametrize `match.scoring_console` / `match.referee_console` / `match.lineup_submission` over roles (default-deny #12).
- `test_rbac_verbs.py` — PRD §3.2 match rows (live scoring, void, approve, force-finalize) parametrized over all roles.

**Frontend (`features/scoring|referee|viewer/__tests__/`, vitest + Playwright):**
- optimistic event entry + rollback on reject; localStorage queue survives reload; idempotent flush; clock rendering from server fields; SSE reconnect reconcile; referee approval flow; a11y (axe) on Match Center; query-count / no-cross-org-leak in API hooks.

---

## 12. Migration / build order

1. **Prep (close inv-4 gaps):** Redis `CHANNEL_LAYERS` + `CACHES`; `ProtocolTypeRouter` `asgi.py`; `prod.py`; `docker-compose.dev.yml`; register `apps.matches` + `apps.live` in `LOCAL_APPS`.
2. **Depends-on:** `apps.tournaments` (Tournament, Stage, Group, structured_rules, tiebreakers), `apps.teams` (Team, Person, Player, squad), `apps.fixtures` (Venue, Match emission) — these are siblings; `Match` FKs them. Build models with `PROTECT` FKs; if siblings land later, use string FK refs.
3. **`apps.matches` models** → migration 0001 (Match, MatchStateTransition, MatchAssignment, Lineup, MatchEvent, PlayerSuspension).
4. **Append-only migration** (RunSQL): grant column-restricted UPDATE + deny DELETE on `match_event` for the app role (mirrors the `AuditEvent` role-deny migration the audit agent owns).
5. **Services:** state_machine, event-write, advancement, suspensions, assignment, lineup-validation; the `transaction.on_commit` publish chokepoint (a single `live.services.publish()` so every Redis fan-out is lint-enforceable).
6. **`apps.live`:** WS consumers (scorer/referee room w/ presence), SSE endpoint (viewer), Redis pub/sub bridge.
7. **API + serializers + URLs;** then frontend features.
8. **Tests at each layer** (§11). **Migration policy:** migrations are blocked while any tournament is `live` (CLAUDE.md / PRD §6) — pre-flight check in the deploy script.

---

## 13. Open questions (deferred)

- **Append-only mechanism for `MatchEvent`:** column-restricted UPDATE vs. pure-insert + computed status. Default chosen: column-restricted UPDATE (keeps the §6-mandated partial `event_status` index trivial). Revisit if Postgres column-grant proves brittle in the role-deny migration.
- **`sequence_id` source:** `Max()+1` under `select_for_update` (chosen, simple, correct) vs. a per-match Postgres sequence (faster at extreme write rates; v1 traffic is ≤50 live matches so `Max()+1` is fine).
- **Stranded-match auto-postpone (v1Users §5.9):** confirmed 30 min no-event + no-connection → `stranded`, +15 min → auto-postpone; the "no scorer connection" signal depends on the Redis presence set — needs the WS room built first.
- **`detailed_stats_enabled` event UI** — schema present; UI deferred to v1.5.
