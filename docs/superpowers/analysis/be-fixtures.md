# Backend Subsystem Analysis — `apps.fixtures` (generation + advancement)

> Deep read prepared for a complete platform restructuring. Ground truth only:
> what exists, how it actually works, what it couples to, what must not break,
> and where the seams are. Citations are `file:symbol`.

## 1. Purpose

`apps.fixtures` turns a tournament's registered teams into a concrete schedule of
`matches.Match` rows, and resolves bracket dependencies as results come in. It owns
three concerns:

1. **Generation** — produce `Match` rows for three formats: grouped round-robin,
   single-elimination, and groups→knockout (`services/generate.py`).
2. **Advancement** — fill `winner_of`/`loser_of` placeholder matches once a feeder
   match finishes, invoked from a post-commit hook (`services/advance.py`).
3. **Constraint catalog + shape validation** — the FET-style hard/soft constraint
   type registry and a validator for a tournament's stored `constraints` JSONB
   (`services/constraints.py`). The actual *scheduler* (enforcement) is explicitly
   deferred (see smell §8).

It is a thin **service layer**: it has no models, no `urls.py`, no serializers, and
exactly one view (`views.py::GenerateFixturesView`). All persistence is to
`matches.Match`. The app config is `apps.py::FixturesConfig` (label `fixtures`).

## 2. File-by-file roles

- `apps/fixtures/services/generate.py` (189 LOC) — the three generators plus the
  private circle-method helper `_round_robin` and the group-label table
  `_GROUP_LABELS` (A–Z).
- `apps/fixtures/services/advance.py` (46 LOC) — `advance_from_match(match_id)`,
  the typed-pointer resolver.
- `apps/fixtures/services/constraints.py` (48 LOC) — `CONSTRAINT_TYPES` catalog,
  `_BY_TYPE` index, `validate_constraints(items)`.
- `apps/fixtures/views.py` (46 LOC) — `GenerateFixturesView`, a DRF
  `GenericAPIView` that authorizes and dispatches by `format`.
- `apps/fixtures/apps.py` — Django AppConfig.
- `apps/fixtures/tests/test_generate.py` — round-robin pairing counts, group
  splitting, idempotency.
- `apps/fixtures/tests/test_advance.py` — single-elim bracket shape, winner
  pointers, advancement on score, groups→knockout, power-of-2 guard.
- **No `urls.py` in this app.** The endpoint is wired from
  `apps/tournaments/urls.py:77-81`. This is an important coupling: the prompt
  expected `fixtures/urls.py`; it does not exist.

## 3. Data model (owned vs. read/written)

`apps.fixtures` defines **no models**. It reads/writes `matches.Match`
(`apps/matches/models.py::Match`) and reads `teams.Team`, `tournaments.Tournament`.

Fields on `Match` that this subsystem depends on:

- `stage` (CharField, `"group"`/`"knockout"`), `group_label` (`"Group A"`),
  `round_no` (PositiveSmallInt, default 1), `match_no` (PositiveInt, order within
  tournament).
- `home_team`/`away_team` (nullable FK to `teams.Team`, `SET_NULL`).
- `home_source`/`away_source` (`JSONField(default=dict)`) — the typed dependency
  pointers (invariant #9). Pointer shapes observed in code:
  `{"type":"team","team_id":<uuid>}`, `{"type":"winner_of","match_id":<uuid>}`,
  `{"type":"loser_of","match_id":<uuid>}`. The model comment also names
  `group_position`, `tbd` — **declared in comments/CLAUDE.md but NOT produced or
  consumed anywhere in code** (see smell §8).
- `inputs_hash` (CharField(64)) — only set by `generate_round_robin` (per-group
  SHA-256 of sorted team ids). The single-elim and knockout generators **leave it
  blank**.
- `winner_id`/`loser_id` — derived `@property` on `Match`
  (`apps/matches/models.py:107-124`): returns a team id only when status is
  `COMPLETED`/`WALKOVER` and scores differ; `None` on draw or non-terminal.
- `status` (`MatchStatus`, default `SCHEDULED`), `home_score`/`away_score`,
  `deleted_at` (soft delete; all queries filter `deleted_at__isnull=True`).

`Team` fields used: `status` (`TeamStatus.REGISTERED`), `seed`, `name`, `pool`
(written by round-robin to mirror `group_label`), `id` (UUIDv7).

**Critical correction to the brief:** `last_manual_edit_at` does **not** exist on
`Match`. It exists only on `Tournament` (`apps/tournaments/models.py:78`) and is set
by `apps/tournaments/services/rules.py::update_settings`. The invariant-#10
"generated artifact stores `inputs_hash` + `last_manual_edit_at`" pair is only
half-implemented at the `Match` level: `inputs_hash` is present (and partly unset),
`last_manual_edit_at` is absent. Any regenerate/keep/diff UX at the fixture level is
not yet supported by the data model.

## 4. Core algorithms (step-by-step, with file:function refs)

### 4.1 `generate.py::_round_robin(teams)` — circle method
- Copies the team list; if odd, appends `None` as a bye marker (so `n` is even).
- For `r` in `0..n-2` (i.e. `n-1` rounds): pairs `arr[i]` vs `arr[n-1-i]` for
  `i` in `0..n/2-1`; skips any pair containing the bye `None`.
- **Home/away alternation:** even rounds keep `(home, away)`, odd rounds swap to
  `(away, home)` for fairness.
- Rotation fixes element 0 and rotates the rest:
  `arr = [arr[0]] + [arr[-1]] + arr[1:-1]` (standard circle rotation).
- Returns `list[(round_no, home, away)]` with each pair exactly once
  (`C(n,2)` for even n). Verified by `test_round_robin_4_teams_makes_6_unique_pairings`.

### 4.2 `generate.py::generate_round_robin(tournament, group_size=5)`
- **Idempotency:** if any non-deleted `Match` exists for the tournament, returns
  them unchanged (no regeneration). Note this is keyed on *any* match, so calling
  it after a knockout exists would also no-op.
- Loads `REGISTERED`, non-deleted teams ordered by `(seed, name)`; raises
  `ValueError` if `< 2`.
- Chunks teams into groups of `group_size` (last group may be smaller; a group of
  1 produces no matches — silent edge case).
- For each group `gi`: sets `team.pool = "Group {LETTER}"` (saves `pool`,
  `updated_at`), computes a per-group `inputs_hash` = SHA-256 of the sorted team
  ids, then emits `Match` rows from `_round_robin` with `stage="group"`,
  `group_label`, `round_no`, an incrementing tournament-wide `match_no`,
  concrete `home_team`/`away_team`, `status=SCHEDULED`, `inputs_hash=ih`.
- All inside one `transaction.atomic()`; persisted via `bulk_create`. **Returns the
  in-memory `to_create` list** (not refetched).

### 4.3 `generate.py::generate_single_elimination(tournament, teams, stage="knockout")`
- Guard: `n>=2` and a power of two (`n & (n-1) == 0`), else `ValueError`.
- `match_no` seeds from the current `Match.count()` for the tournament so knockout
  numbering continues after group matches. **Note:** this count is *not*
  `deleted_at`-filtered, unlike the read queries elsewhere — a minor inconsistency.
- **Round 1:** pairs `teams[i]`,`teams[i+1]` into concrete matches with
  `home_source={"type":"team",...}` / `away_source={"type":"team",...}`,
  `round_no=1`; `bulk_create`d.
- **Later rounds:** while `len(prev) > 1`, builds round `round_no` from pairs of
  the previous round's matches, with
  `home_source={"type":"winner_of","match_id":prev[i].id}` and
  `away_source` pointing at `prev[i+1]`. Each round `bulk_create`d, then becomes
  `prev`. Placeholder rounds have **no** `home_team`/`away_team` until advancement.
- Returns all created matches. Bracket size for n teams = `n-1` matches.
  Verified by `test_single_elim_4_teams_makes_3_matches_with_winner_pointers`.

### 4.4 `generate.py::generate_knockout_from_groups(tournament, advance_per_group=2)`
- Idempotent on existing non-deleted `stage="knockout"` matches.
- Collects distinct non-empty `group_label`s from `stage="group"` matches, sorted;
  raises if none.
- For each group calls `apps.matches.services.standings.compute_standings(
  tournament, group_label=g)` (lazy import) and takes the top
  `advance_per_group` `team_id`s; raises if a group yields `< 2` qualifiers
  ("hasn't finished enough matches").
- **Cross-seed:** for `n` groups, builds `seed_ids` as
  `[group[i].winner, group[(i+1)%n].runner_up, ...]` — group i's winner vs the
  *next* group's runner-up (FIFA-style cross bracket).
- Materializes `Team` objects (`Team.objects.get(id=tid)` in a loop — N queries)
  and delegates to `generate_single_elimination(..., stage="knockout")`.
- Verified by `test_knockout_from_groups_advances_top_two` (8 teams → 2 groups of
  4 → top-2 each → 4-team bracket = 3 matches).

### 4.5 `advance.py::advance_from_match(match_id)`
- Loads the (non-deleted) source match; returns `[]` if missing.
- Reads `winner_id`/`loser_id` properties; returns `[]` if `winner_id is None`
  (draw or not yet final) — **so `loser_of` pointers are never resolved on a
  draw**, which is correct since the source is terminal-with-result here.
- Iterates **all** non-deleted matches in the same tournament (`deps`), skipping
  itself. For each `side` in `("home","away")`, if `src["match_id"]` equals this
  match's id: `winner_of` → sets `{side}_team_id = winner_id`; `loser_of` →
  `loser_id`. Saves only changed deps (`update_fields=["home_team","away_team",
  "updated_at"]`) and collects them.
- Returns the list of updated dependent matches. Idempotent in effect (re-running
  re-sets the same value). Verified by `test_scoring_semis_advances_winners_into_final`.

### 4.6 `constraints.py::validate_constraints(items)`
- `CONSTRAINT_TYPES`: 5 entries — `no_double_booking_team`, `min_rest_minutes`
  (params `{minutes:int}`), `venue_single_use`, `preferred_window`
  (`{days, from, to}`, soft), `avoid_back_to_back` (soft). Each has
  `label`, `hard` default, `params_schema` (for the UI builder).
- `validate_constraints`: requires a list; each item must be a dict with a known
  `type`, else `ValueError`. Normalizes to
  `{type, scope(def "all"), hard(def from spec), weight(def None), params(dict)}`.
  Non-dict `params` is coerced to `{}`. **Validation is shape-only** — it does not
  check `params` against `params_schema` (smell §8).

## 5. API / endpoint surface

- **Exported service API** (the real seam other code uses):
  `generate_round_robin`, `generate_single_elimination`,
  `generate_knockout_from_groups`, `advance_from_match`, `validate_constraints`,
  `CONSTRAINT_TYPES`.
- **HTTP:** one endpoint, `POST /api/tournaments/<uuid:tournament_id>/generate-fixtures/`
  (registered in `apps/tournaments/urls.py:77`, name `tournament-generate-fixtures`).
  `views.py::GenerateFixturesView`:
  1. 404 (`NotFound("tournament_not_found")`) if the tournament isn't in
     `accessible_tournaments(request.user)` — no existence leak (invariant #2).
  2. 403 (`PermissionDenied("not_tournament_manager")`) via
     `can_manage_tournament`.
  3. Dispatch on `request.data["format"]`: `"knockout"` → loads registered teams
     ordered by `(seed, name)` and calls single-elim; `"knockout_from_groups"` →
     groups→knockout; default/`"round_robin"` → round-robin with
     `group_size` (default 5, `int()`-coerced).
  4. `ValueError`/`TypeError` → `DRFValidationError({"detail": str(e)})`.
  5. Returns `201 {"generated": <count>, "format": <fmt>}`.
- **Note:** there is no GET/list of fixtures here; reading matches/brackets lives
  in `apps.matches`. The constraint catalog is exposed by *tournaments*
  (`apps/tournaments/views.py:160` returns `CONSTRAINT_TYPES`), not by this app.

## 6. Invariants that MUST be preserved

1. **Typed dependency pointers (invariant #9).** `home_source`/`away_source` JSONB
   is the source of truth for advancement; bracket shape is never re-inferred.
   `advance_from_match` keys solely on `src["match_id"]` + `src["type"]`.
2. **Advancement is a post-commit hook.** `apps/matches/services/state.py:69`
   schedules `transaction.on_commit(lambda: _fire_advancement(mid))` only when the
   new status is in `_TERMINAL_WITH_RESULT = (COMPLETED, WALKOVER)`. The hook
   (`state.py:73`) swallows all exceptions and logs — **it must never crash the
   request**. Tests call `advance_from_match` directly because `on_commit` doesn't
   fire inside the test transaction.
3. **Idempotent generation.** Round-robin no-ops if any match exists;
   groups→knockout no-ops if a knockout exists. Re-POSTing must not duplicate.
4. **Multi-tenancy scoping.** Every generated `Match` carries
   `organization = tournament.organization`; the view gates on
   `accessible_tournaments` + `can_manage_tournament` (404-before-403 leak rule).
5. **Soft-delete filtering.** All reads filter `deleted_at__isnull=True`
   (except the `match_no` seed count in single-elim — preserve or fix deliberately).
6. **Power-of-2 contract** for single-elim; raise `ValueError` otherwise.
7. **Home/away fairness alternation** in the circle method (round parity swap).
8. **`winner_id`/`loser_id` semantics** (terminal status + differing scores; `None`
   on draw) are relied on by advancement.
9. **Constraint normalization shape** `{type, scope, hard, weight, params}` is the
   stored contract that `tournaments.services.rules.update_settings` writes into
   `Tournament.constraints`.

## 7. Dependencies / coupling

**Outgoing (this app → others):**
- `apps.matches.models.Match`, `MatchStatus` — primary write target + status enum.
- `apps.teams.models.Team`, `TeamStatus` — team source + `pool` write.
- `apps.tournaments.models.Tournament`, `.permissions.can_manage_tournament`,
  `.scope.accessible_tournaments` — used by the view.
- `apps.matches.services.standings.compute_standings` — lazy import in
  groups→knockout; **couples fixture generation to standings/rules** (points +
  tiebreakers), so seeding depends on the rules engine.

**Incoming (others → this app):**
- `apps/matches/services/state.py::_fire_advancement` → `advance_from_match`
  (the production trigger; lazy import).
- `apps/tournaments/urls.py` → `GenerateFixturesView`.
- `apps/tournaments/services/rules.py::update_settings` → `validate_constraints`.
- `apps/tournaments/views.py` → `CONSTRAINT_TYPES`.
- `apps/tournaments/management/commands/run_e2e_demo.py:110` → `generate_round_robin`.
- Tests in `apps/matches` (`test_scorer_flow.py`, `test_standings_rules.py`) call
  `generate_round_robin` as a fixture builder.

## 8. Tech debt / smells / duplication

- **`last_manual_edit_at` missing on `Match`.** Invariant #10's conflict-warning
  UX (regenerate/keep/diff after manual edit when inputs change) is not backed at
  the fixture level. `inputs_hash` is also only set by round-robin (blank for both
  knockout generators), so even hash-based change detection is incomplete.
- **Pointer-type catalog drift.** Comments/CLAUDE.md advertise
  `group_position`, `team`, `tbd`, `loser_of`; only `team`, `winner_of`,
  `loser_of` are ever *written* (and `loser_of` only by hand—no generator emits
  it). `group_position` is never produced or consumed.
- **Constraint enforcement is vaporware (by design, but a real gap).**
  `validate_schedule`/`score_schedule` are referenced in the docstring but absent;
  constraints are stored and validated for *shape only* — `params` is never checked
  against `params_schema`. The catalog is currently inert.
- **`advance_from_match` does a full-tournament scan.** It loads every non-deleted
  match and Python-filters by pointer, on every completion. Fine at small scale,
  O(matches) per result; a `match_id`-indexed query (or a JSONB containment filter)
  would be the obvious fix.
- **N+1 in groups→knockout:** `Team.objects.get(id=tid)` in a loop; should be one
  `in_bulk`/`filter(id__in=...)`.
- **Return-value inconsistency:** generators return in-memory unsaved-but-created
  objects (`bulk_create` doesn't refresh defaults/DB-side values); `winner_id`
  count seed query in single-elim ignores `deleted_at`.
- **Idempotency is coarse.** Round-robin keys on *any* match existing; there's no
  notion of "regenerate" or partial generation, and no `event_id` idempotency key
  on the generate endpoint (invariant #3 says mutation endpoints take `event_id`;
  this one does not).
- **No transaction wrapper in the view / advancement.** The view calls generators
  (each wraps its own `atomic`) but `advance_from_match` saves deps one-by-one with
  no outer atomic; a mid-loop failure leaves a partially advanced bracket.
- **Duplication:** the "registered teams ordered by (seed, name)" query appears in
  both `views.py` (knockout path) and `generate_round_robin`.

## 9. Restructuring seams & risks

- **Cleanest seam: the service functions.** They are pure-ish (tournament/teams in,
  Match rows out) and already the integration boundary. A restructure can swap the
  generator internals while preserving the four service signatures + the
  `home_source`/`away_source` JSONB contract and `advance_from_match`.
- **Advancement contract is the load-bearing seam.** Anything that changes the
  pointer schema must update both `generate.py` (producers) and `advance.py`
  (consumer) *and* the `Match.home_source/away_source` shape and the
  `state.py` on-commit trigger. Keep these synchronized; consider a single
  `pointers.py` module that owns pointer construction + resolution to kill the
  drift in §8.
- **Risk: standings coupling.** Groups→knockout silently depends on rules/points/
  tiebreakers via `compute_standings`. Restructuring standings/rules can change
  seeding output without any fixture test catching it (the existing test only
  asserts *counts* and that round-1 teams are concrete, not *which* teams).
- **Risk: idempotency redesign.** Adding real regenerate/diff requires the missing
  `Match.last_manual_edit_at` + consistent `inputs_hash` across all generators +
  an `event_id` on the endpoint — a migration plus view change. Do this before any
  "regenerate" UI.
- **Risk: the endpoint lives in `tournaments/urls.py`.** Moving routing into a real
  `fixtures/urls.py` (more cohesive) means updating the `tournaments` include and
  any reverse() callers/tests using `tournament-generate-fixtures`.
- **Performance hot spots to fix during restructure:** the full-scan in
  `advance_from_match`, the N+1 in groups→knockout, and the unfiltered count in
  single-elim's `match_no` seed.
- **Ambiguity flagged:** whether `loser_of` / third-place / `group_position`
  pointers are intended for v1 is unclear — they are documented but unbuilt. Decide
  scope explicitly before generalizing the resolver.
