# Flow: Tournament lifecycle (create → freeze gates)

End-to-end trace of one tournament from self-serve creation to knockout
advancement, across the Django backend and the React/Vite frontend. Citations are
`file::symbol`. All paths are relative to `/home/ubuntu/Fixture`.

## Diagram-in-prose

```
[React CreateTournamentPage] --POST /api/tournaments/--> TournamentListCreateView.post
   -> create_tournament  ==(atomic)==> provision_personal_workspace (Org + admin OrgMembership)
                                      + Tournament(status=DRAFT) + TournamentMembership(admin)
                                      + emit_audit(tournament_created, idempotency_key=event_id)
[settings PATCH] -> update_settings -> merge_rules / validate_constraints  (freeze gate)
[registration]   -> RegistrationLink (teams app)  OR  Form (forms app) --map_response--> register_school
                    register_school ==(atomic)==> Team(REGISTERED) + Person + Player rows
[generate]       -> GenerateFixturesView dispatch by `format`:
                    round_robin | knockout | knockout_from_groups -> Match(SCHEDULED) rows (+ home/away_source)
[matches]        -> transition_match (state machine)  /  record_match_event (event-sourced) / record_score
[scoring]        -> recompute_score (derive from MatchEvent log)   --on_commit--> publish_match_event (WS)
[standings]      -> compute_standings (rules.points / rules.tiebreakers)
[advancement]    -> terminal status (completed|walkover) --on_commit--> advance_from_match (typed pointers)
```

## Ordered walkthrough

### 1. Create + auto-provision workspace
The frontend `features/tournaments/CreateTournamentPage.tsx::CreateTournamentPage`
collects only a name, mints a client `event_id` (`lib/eventId.ts`), and calls
`api/tournaments.ts::tournamentsApi.create`. Server entry is
`apps/tournaments/views.py::TournamentListCreateView.post`, which **gates on
`request.user.email_verified_at`** (403 `verify_email_first`) before delegating to
`apps/tournaments/services/create.py::create_tournament`.

`create_tournament` is the single atomic provisioning operation:
1. **Idempotency replay** — looks up a prior `AuditEvent` keyed
   `(idempotency_key=event_id, event_type="tournament_created")` and returns the
   existing `Tournament` if found (invariant 3).
2. Inside `transaction.atomic()`: resolves the org via
   `apps/organizations/services/workspace.py::provision_personal_workspace`
   (creates an ACTIVE `Organization` + ACTIVE admin/owner `OrganizationMembership`,
   no super-admin approval), creates `Tournament(status=DRAFT)` inheriting the
   org's `time_zone`, creates the creator's `TournamentMembership(role=ADMIN,
   status=ACTIVE)`, and emits `tournament_created` audit.

Slug uniqueness is per-org via `create.py::_pick_unique_tournament_slug` (matches
the `unique_tournament_slug_per_org` partial unique constraint in
`apps/tournaments/models.py`). The public identity is the `(org_slug,
tournament_slug)` pair.

### 2. Status state machine
`apps/tournaments/models.py::TournamentStatus` defines the 7 states
(`draft → published → registration_open → scheduled → live → completed →
archived`). **CRITICAL GAP:** there is no Tournament status-transition service or
endpoint. `apps/tournaments/urls.py` exposes settings/members/teams/matches but no
`status`/`transition` route; `TournamentSerializer.status` is read-only; the
frontend `TournamentDetailPage.tsx` only *renders* a status badge
(`statusBadge`). Grep confirms no production writer of `Tournament.status` after
creation — only `services/create.py` (DRAFT) and tests set it. The state machine
is declared but not yet driven.

### 3. Rules + freeze gate
Rules/constraints are data, not code: `Tournament.rules` (JSONB) and
`.constraints` (JSONB). `apps/tournaments/views.py::TournamentSettingsView`
(GET/PATCH `/settings/`) is manager-gated via
`apps/tournaments/permissions.py::can_manage_tournament` and delegates writes to
`apps/tournaments/services/rules.py::update_settings`, which:
- replays on `event_id` (`tournament_settings_updated` audit),
- enforces the **freeze gate**: `can_edit_rules` returns True only in
  `DRAFT`/`PUBLISHED`; otherwise `update_settings` raises
  `PermissionError("rules_frozen")` → 409, unless `amend=True` + a reason
  (invariant 7),
- merges via `rules.py::merge_rules` (defaults < stored < partial, whitelisting
  every top-level and nested key — unknown keys raise `ValueError`) and validates
  constraints via `apps/fixtures/services/constraints.py::validate_constraints`.

`rules.py::freeze_rules` stamps `rules_frozen_at` and is meant to fire on the
transition to `registration_open` — **but because there is no status-transition
machine (step 2), `freeze_rules` is never called in production** (only in
`tests/test_rules.py`). Today the freeze gate is enforced purely by
`status in {DRAFT, PUBLISHED}`, so a tournament stuck in DRAFT is editable forever
and `rules_frozen_at` stays null.

### 4. Registration (links + forms)
Two parallel ingestion channels both funnel into one writer,
`apps/teams/services/registration.py::register_school`:
- **Registration link** (teams app): `apps/teams/views.py::RegistrationLinkCreateView`
  mints a token (sha256-hashed, plaintext shown once) via
  `registration.py::create_registration_link`. Public submission is
  `teams/views.py::PublicRegistrationView` (`AllowAny`, `RegistrationRateThrottle`),
  which resolves the token with `registration.py::resolve_registration_link`
  (active / not-expired / under `max_submissions`) then calls `register_school`
  and increments `submission_count` with an `F()` expression.
- **Form builder** (forms app): `apps/forms/services/forms.py` (create/publish/
  close, with a destructive-edit `version` bump mirroring the rules-freeze
  pattern); a submitted `FormResponse` of purpose `team_registration` is mapped by
  `apps/forms/services/mapping.py::map_response` → `_map_team_registration`, which
  **reuses `register_school`** with a *derived* `uuid5` event_id to avoid
  colliding with the submit audit's globally-unique idempotency key (see the
  module docstring — a real correctness landmine).

`register_school` (atomic, idempotent on `event_id` via the `school_registered`
audit) creates `Team(status=REGISTERED)`, `Person`, and `Player` rows
(`apps/teams/models.py`; Person↔Player split = invariant 8). Note: teams are
created **directly as REGISTERED**, bypassing the `pending_approval` path the
`TeamStatus` enum allows.

### 5. Fixture generation
`apps/fixtures/views.py::GenerateFixturesView.post` is manager-gated and
dispatches on `format` to `apps/fixtures/services/generate.py`:
- `round_robin` → `generate_round_robin`: loads `TeamStatus.REGISTERED` teams
  ordered by `(seed, name)`, chunks into groups of `group_size`, sets each team's
  `pool`, and emits matches via the **circle method** (`_round_robin`, home/away
  alternated by round). Stores a per-group `inputs_hash` (invariant 10).
- `knockout` → `generate_single_elimination`: requires a **power-of-2** team
  count; round 1 has concrete teams with `home_source={"type":"team",...}`, later
  rounds carry `{"type":"winner_of","match_id":...}` typed pointers (invariant 9).
- `knockout_from_groups` → `generate_knockout_from_groups`: calls
  `compute_standings` per group, takes top `advance_per_group`, cross-seeds winner
  i vs runner-up (i+1), then reuses `generate_single_elimination`.

All produce `Match(status=SCHEDULED)` (`apps/matches/models.py`). Generation is
**idempotent by presence** — `generate_round_robin`/`generate_knockout_from_groups`
return existing matches if any exist, rather than by `inputs_hash`. The frontend
triggers this via `TournamentDetailPage.tsx` `generate` mutation →
`tournamentsApi.generateFixtures`.

### 6. Matches → scoring
Two scoring paths converge on the same state machine and audit:
- **Aggregate**: `apps/matches/services/scoring.py::record_score` —
  `select_for_update` lock (no TOCTOU between scorers), guards `status in
  {SCHEDULED, LIVE}`, sets scores + `COMPLETED`, audits `match_scored`, and
  schedules `_fire_advancement` on commit.
- **Event-sourced**: `apps/matches/services/events.py::record_match_event` —
  locks the match, assigns a gapless `sequence_no` (`Max+1` under lock),
  appends an immutable `MatchEvent`, then `recompute_score` **derives** home/away
  from non-voided GOAL/PENALTY_SCORED/OWN_GOAL events. Corrections are append-only
  `VOID` events (`void_match_event`). Publishes to the `match_<id>` channel group
  on `transaction.on_commit` (invariant 4 — DB first, transport after commit).

State transitions go through `apps/matches/services/state.py::transition_match`
(`ALLOWED_TRANSITIONS`, guarded + audited under `select_for_update`); on a terminal
`(COMPLETED, WALKOVER)` it fires advancement on commit. Endpoints:
`apps/matches/views.py` (`RecordScoreView`, `RecordMatchEventView`,
`TransitionMatchView`), all gated by `views.py::_can_score`.

### 7. Standings (rules-driven)
`apps/matches/services/standings.py::compute_standings` reads
`merge_rules(tournament.rules)["points"]` and `["tiebreakers"]`, tallies only
`MatchStatus.COMPLETED` matches (optionally per `group_label`), and sorts via
`_sort_key`. Caveat: `head_to_head` is a documented **no-op** in v1, so tied teams
fall through to GD/GF/name. Surfaced by `TournamentStandingsView` and
`TournamentDetailPage.tsx` (`t-standings` query, invalidated after each score).

### 8. Advancement (typed source pointers)
`apps/fixtures/services/advance.py::advance_from_match` reads the completed
match's `winner_id`/`loser_id` (computed properties on `Match`), scans sibling
matches, and fills `home_team`/`away_team` wherever `*_source.match_id` matches and
`type` is `winner_of`/`loser_of`. Invoked only from the post-commit hooks in
`scoring.py` and `state.py::_fire_advancement` (wrapped in try/except so the hook
never crashes the request). Confirmed by `apps/fixtures/tests/test_advance.py`.

## Subsystems crossed
tournaments, organizations (workspace), audit, teams (registration), forms (form
builder), fixtures (generate/advance/constraints), matches (state/events/scoring/
standings), live (channel-layer fan-out), permissions/scope, and the React
features `tournaments`, `registration`, `forms`, `matches`.

## Invariants this flow depends on
1. UUID v7 PKs; public URL = `(org_slug, tournament_slug)`.
2. Org-scoping enforced via `scope.py::accessible_tournaments` (404, no existence
   leak) + `permissions.py::can_manage_tournament`.
3. Idempotent writes keyed on client `event_id` at create/settings/register/score.
4. DB-first event log; WS/SSE publish on `transaction.on_commit`.
6. Status as enums (Tournament + Match).
7. Rule freeze in `draft`/`published`; match rules additionally frozen once live.
9. Match dependencies as typed `home_source`/`away_source` pointers; advancement
   is an on_commit hook.
10. Generators stamp `inputs_hash` / `last_manual_edit_at`.

## Failure modes
- **No Tournament status machine**: `published`/`registration_open`/`scheduled`/
  `live`/`completed` are unreachable in production; `freeze_rules` /
  `rules_frozen_at` never fire; freeze relies solely on the DRAFT/PUBLISHED check.
- **Generation idempotency is presence-based, not hash-based**: a manual edit then
  re-generate is a no-op; `inputs_hash` is written but never compared
  (invariant 10's regenerate/keep/diff UX is unimplemented).
- **Client/server pointer divergence**: `MatchSerializer` omits
  `home_source`/`away_source`; `BracketView.tsx` infers bracket shape from
  `round_no`/`match_no` geometry instead of the authoritative typed pointers.
- **`advance_from_match` scans all sibling matches** (O(n) per completion) and only
  resolves `winner_of`/`loser_of` — `group_position`/`tbd` pointer types are never
  resolved by code.
- **Draws in knockout** leave dependents permanently `null` (`winner_id` is None);
  no penalties/extra-time resolution despite `rules.match.penalties`.
- **on_commit silence**: advancement and WS publish are best-effort; a swallowed
  exception leaves dependents unfilled with only a log line.
- **Audit idempotency-key collision** between `submit_response` and
  `register_school` (handled only by the `uuid5` derivation in `mapping.py`).

## Restructuring seams (clean re-architecture points)
1. **Introduce `apps/tournaments/services/state.py`** mirroring the match state
   machine (`ALLOWED_TRANSITIONS` + guarded/audited `transition_tournament`), and
   call `freeze_rules` on the `→ registration_open` edge. This is the single
   biggest missing seam; everything downstream (freeze, registration windows, TZ
   lock per invariant 14) hangs off it.
2. **Unify the generators behind one `generate(tournament, rules)` dispatcher**
   driven by `rules.format`, replacing the `format` string branching in
   `GenerateFixturesView` and the presence-based idempotency with `inputs_hash`
   comparison (enabling the invariant-10 regenerate/keep/diff flow).
3. **Make typed pointers first-class end-to-end**: expose `home_source`/
   `away_source` in `MatchSerializer`, render the bracket from pointers, and
   centralize resolution (all four pointer types) in one `resolve_sources`
   service consumed by both generation seeding and post-match advancement.
4. **Collapse the two registration channels** (RegistrationLink in `teams` vs Form
   in `forms`) onto the forms engine, leaving `register_school` as the sole
   domain writer (mapping already does this — make it the only path).
5. **Single post-commit dispatch bus** for advancement + live publish so ordering
   and error handling are uniform rather than duplicated in `scoring.py` and
   `state.py`.

docs file: docs/superpowers/analysis/flow-tournament.md
