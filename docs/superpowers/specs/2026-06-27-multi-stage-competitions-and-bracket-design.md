# Composable Multi-Stage Competitions + Per-Game Scoring/Tie-breakers + Bracket Visualization — Design

> **Status:** Design v1 (2026-06-27). Authored from a multi-agent understanding+design workflow over the live fixture engine, plus inline design of the per-game scoring/tie-breaker layer. Owner: graceschooledu@gmail.com.
>
> **Owner intent (verbatim themes):** (1) competitions play in *any number* of *any-type* **stages** the user composes (group league with "each team plays at least N matches" -> top-N qualify -> knockout, or group->group->knockout, etc.) -- **full flexibility, per game**; (2) a **FIFA World-Cup-style bracket** generated per competition, *alongside* the existing group-wise table; (3) **per-game** (category) **scoring**: any number of sets, points-to-win, win-by-2 deuce, hard cap (15->17), timed/goals -- fully dynamic; (4) a **per-game tie-breaker** hierarchy (head-to-head -> set diff -> point diff -> total points -> coin toss), reorderable.
>
> **Granularity rule (owner, 2026-06-27): everything is PER GAME** (one competition leaf), never one global setting for all games. Sport-level controls are only convenience defaults; the game's own value always wins.
>
> Sections 1-12 are the synthesized workflow output (stages + bracket). Sections 13-15 are the per-game scoring/tie-breaker layer (engine already exists; gap is per-game resolution + UI), kept in the **frozen `rules`** per the section 9.3 contract -- NOT in `draw_config`.

---

All four load-bearing facts are confirmed against live code: `compute_inputs_hash` (generate.py:465-469) hashes every `effective_draw_config` key minus `_HASH_EXCLUDED_KEYS` (431-432); `_guard_knockout_draw` (state.py:133) keys on `stage == "group"`; `_resolve_group_positions` (advance.py:111-142) is hardcoded to `stage="group"` + `group_label`-only standings with the silent `1 <= pos <= len(rows)` bound; `DEFAULT_DRAW_CONFIG` (draw_config.py:28-63) deep-copies into the hashed payload. Here is the synthesized design.

---

# Composable Multi-Stage Competitions + Bracket Visualization — Implementation Design

## 1. Summary & goals

Today a competition (one category leaf) has exactly **one** format, chosen via a flat `draw_config[leaf].format` enum and dispatched by `generate_for_leaf` to one planner. The owner wants competitions that play in **ordered stages** — the headline case being *"15 schools → FIFA-style groups where each team plays at least 3 → top 2 of each group → knockout bracket that fills in live"* — plus a **data-driven FIFA-style bracket visualization** (two mirrored halves, QF/SF/Final flowing inward, a centre champion box).

**Design thesis.** The platform is *already covertly two-stage*: `groups_knockout` generates only the group round-robin, and the knockout is a separate, manual `{format:"knockout_from_groups"}` generation that reads standings (`plan_knockout_qualifiers`, generate.py:1656) and is wired by typed `group_position`/`winner_of` pointers resolved on `transaction.on_commit` (`advance.py`). Multi-stage is therefore a **generalization of an existing seam**, not greenfield. We:

1. add **one** new sparse `draw_config` key — `stages` — and **zero** new format strings (the composite "formats" decompose: `groups_knockout` = `[round_robin, knockout]`);
2. add **one** additive `Match` column — `stage_no` — keeping `Match.stage` as the bracket-role *type* label;
3. reuse every existing `plan_*`/`generate_*` primitive per stage, wiring cross-stage entry with the typed-pointer machinery `advance.py` already resolves;
4. ship a single data-driven `<Bracket>` React component that builds the tree from `winner_of`/`loser_of`/`group_position` source pointers, used across preview, internal, and public surfaces.

**Non-negotiable constraints that shape every decision:**
- **Hash stability (invariant 10, R1).** `compute_inputs_hash` runs over a deep copy of `DEFAULT_DRAW_CONFIG`; any new defaulted key that leaks into the hashed payload flips **every existing leaf** to "inputs_changed" → platform-wide 409s and regenerate banners. A single `_canonical_draw_for_hash` with a frozen-hash regression fixture is **increment 0**.
- **`Match.stage` is load-bearing** for `_guard_knockout_draw` (state.py:133), `_resolve_group_positions` (advance.py:112), and the bracket `stage === "knockout"` filter. It must stay the *type* label.
- **Back-compat by construction.** Single-stage competitions read as a one-element derived stage list and generate byte-identically; no data migration; LIVE `groups_knockout` keeps its manual two-call UX.

This document **freezes one canonical schema** (one `type` enum, one downstream-attached qualification block with an explicit `method`, one min-matches mechanism, one discriminator, one hash canonicalizer) before resolving the eager-vs-deferred product call, because the scheduler-null-team problem (§9), the bracket `group_position` rendering (§8), and deadlock handling (§5) all branch on it.

---

## 2. Current-state recap (with file anchors)

**Format config — `draw_config` (sparse, layered JSONB).** `DEFAULT_DRAW_CONFIG` (draw_config.py:28-63) holds the 17 generation knobs. `effective_draw_config` (draw_config.py:198-236) resolves 6 layers: defaults < legacy `rules` keys (`format`/`group_size`/`advance_per_group`) < `draw_config["*"]` < `draw_config["sport:<k>"]` < `draw_config[leaf]` < request overrides; each layer merges **wholesale per key** (`out[k]=v`). `merge_draw_config` (182-195) whitelists keys against `DEFAULT_DRAW_CONFIG`; `_validate_layer` (117-180) enforces enum/range/cross-field checks (e.g. `advance_per_group < group_size`, line 178). `update_draw_config` (257-315) is the idempotent (event_id → `draw_config_updated` AuditEvent) write verb behind `PATCH /api/tournaments/{id}/draw-config/`, gated on `tournament.bracket_editor`; it is **not** behind the invariant-7 rules freeze. `leaf_has_matches` (239-254) is the per-leaf freeze signal.

**Pairing core vs persistence.** Pure `plan_*` (zero DB) decide who-plays-whom: `_round_robin` (circle method, generate.py:49-72), `plan_round_robin`/`_plan_pool` (489-563), `plan_single_elimination` (584-683, byes + `winner_of` pointers + optional third-place), `plan_double_elimination` (686-788), `plan_swiss_round1` (1053-1082), `plan_knockout_qualifiers` (1656-1752, reads standings → cross/overall seeded bracket via `_cross_seed`/`_repair_same_group_pairs`). `generate_*` wrappers compute `compute_inputs_hash` (453-481) and call `_persist_plans` (1260-1285), which rewrites plan refs → `match_id` pointers. `generate_for_leaf` (1796-1858) dispatches on `cfg["format"]`. `GenerateFixturesView.post` (views.py:56-109) layers effective config and guards `expected_inputs_hash` (409 on drift).

**Stages & advancement today.** `Match.stage` (matches/models.py:60) is a free CharField type label (`group`/`knockout`/`swiss`/`losers`/`grand_final`/`plate`); `Match.home_source`/`away_source` (74-75) carry typed pointers `{type: team|winner_of|loser_of|group_position|tbd, …}`. On COMPLETED/WALKOVER, `state.py:110-112` fires `advance_from_match` (advance.py:19-75) post-commit: resolves `winner_of`/`loser_of` by `match_id`, and `_resolve_group_positions` (111-142) fills `group_position` slots once an entire `stage="group"` group is `_FINAL`, with the silent `1 <= pos <= len(rows)` bound. `_settle_unopposed` (and the `{"walkover_vacated": True}` stamp) prevent walkover deadlocks. The group→knockout bridge is the separate `generate_knockout_from_groups` (1755-1793), triggered manually by `AdvanceToKnockoutDialog.tsx:62` posting `{format:"knockout_from_groups"}`.

**Standings.** `compute_standings(tournament, group_label=None)` (standings.py:131-197) aggregates COMPLETED/WALKOVER matches per `group_label`, applies data-driven tiebreakers (`_sort_key`, h2h mini-tables from *same-group* matches), and **never assumes a complete RR** (partial leagues already work; `P` is in every row). `plan_knockout_qualifiers` normalizes cross-group best-thirds per game via `_norm_rates`.

**Scheduler.** `build_schedule_inputs` → `MatchSlotReq` (scheduler.py:617-631) carries `stage` but **not** `stage_no`. `schedule_matches` (765) orders pinned-first then `round_no`; team-scoped hard checks (`effective_rest_gap`, `effective_day_cap`, `team_blackouts`, shared-player links) **require concrete team ids**. `MatchSlotReq.home/away` may be `None`.

**Frontend.** Format is chosen in `CompetitionFormatBoard.tsx` (sport-level bulk, `staged` buffer → per-layer `updateDrawConfig` PATCH) and `CompetitionFormatWizard.tsx` (per-competition; `Form` state → `buildConfig` sparse layer, 311-347). Bracket display: `BracketView.tsx:50` `KnockoutTree` renders knockout-only with fixed geometry but **never follows source pointers** (assumes pre-sorted matches; can't mirror or place byes). `sideName.ts:7` resolves `winner_of`/`loser_of` to "Winner of p3". `CompetitionResultCard.tsx` and `StandingsTable` render group tables. Public: `PublicBracketPage.tsx` converts `PublicScheduleMatch → MatchRow`. Wall-clock rendering (invariant 14) is preserved by `.slice(11,16)`.

---

## 3. Data model — `draw_config[leaf].stages`

### 3.1 The canonical stage schema (frozen)

`stages` is a new whitelisted `draw_config` key. `None`/`[]`/absent = single-stage (derive from flat `format`); a non-empty list = the authoritative ordered stage plan. Each element is a **`StageSpec`**:

```jsonc
{
  "id": "0190c8e2-…",          // REQUIRED once stored. uuid7 str (invariant 1), minted
                               //   client-side; the write verb auto-fills if absent.
                               //   Stable handle that `from.stage` references; survives reorder.
  "name": "Group Stage",       // optional organizer label, i18n-rendered. Default from type.
  "type": "round_robin",       // REQUIRED. one of: round_robin | knockout | swiss | double_elim
  "group_size": 5,             // round_robin: authored group size (independent of min-matches)
  "balance_groups": true,      // round_robin: FIFA even split
  "min_matches_per_team": 3,   // round_robin: partial-RR target (§4). null/absent = full RR.
  "legs": 1,                   // round_robin
  "partition": "",             // round_robin: "" | "category" (the old by_category path)
  "seeding": "registration",   // any type: registration|random|snake|seeded
  "third_place": false,        // knockout
  "plate": false,              // knockout (consolation over round-1 losers — a PARAM, not a stage)
  "swiss_rounds": null,        // swiss
  "from": { … }                // qualification INTO this stage. ABSENT on stage 0.
}
```

**`type` is the small backend set already supported by the pure planners — `{round_robin, knockout, swiss, double_elim}`.** `groups_knockout`, `knockout_from_groups`, `by_category` are **not** stage types (they decompose). Array order is execution order; there is **no** `order` field, **no** `stage_no` in the config (positional index is derived at generation time, §6). `group`/`league`/`groups` are FE-only UI sugar that map to backend `type: round_robin` (§7).

### 3.2 The qualification block — `from` (downstream-attached, explicit method) — frozen

The qualification block is named **`from`**, lives on the **consuming** (downstream) stage (so one stage can have multiple consumers in future — winners→knockout, losers→plate), and carries an **explicit `method` verb** (needed for validation and future bracket chaining):

```jsonc
"from": {
  "stage": "0190c8e2-…",       // id of an EARLIER stage (backward-only, no cycles).
                               //   default = the immediately preceding stage's id.
  "method": "top_n_per_group", // v1 wired: top_n_per_group. reserved: winners|losers|all|overall_top_n
  "advance_per_group": 2,      // method=top_n_per_group: top N of each group
  "advance_best_thirds": 0,    // extra cross-group qualifiers at position advance_per_group+1
  "seeding": "cross"           // cross | overall (maps to existing knockout_seeding)
}
```

Field-name normalization is **mandatory and singular** across backend validator, generator, and FE `buildConfig`: `advance_per_group`, `advance_best_thirds`, `seeding` (values `cross|overall`). The FE editor's `intake{advance_per_group, advance_best_thirds, knockout_seeding}` maps `knockout_seeding → seeding` on write (§7). `method=top_n_per_group` maps directly onto `plan_knockout_qualifiers(advance_per_group=…, advance_best_thirds=…, knockout_seeding=seeding)`. `winners`/`losers`/`all`/`overall_top_n` are **accepted-and-validated but unwired in v1**; selecting one emits a soft `stage_method_unsupported` warning (plate stays a knockout *param*, not a chained stage, for v1).

### 3.3 Worked JSON — 15 schools, FIFA groups (≥3 each) → top-2 → knockout

```jsonc
// tournament.draw_config["football.u17_boys"]
{
  // --- derived flat mirror (back-compat readers; see §10.2). DO NOT hand-edit. ---
  "format": "groups_knockout",
  "group_size": 5,
  "advance_per_group": 2,
  // --- authoritative stage plan ---
  "stages": [
    { "id": "0190a1…", "name": "Group Stage", "type": "round_robin",
      "group_size": 5, "balance_groups": true, "min_matches_per_team": 3,
      "legs": 1, "seeding": "registration" },
    { "id": "0190b2…", "name": "Knockout", "type": "knockout",
      "third_place": false, "plate": false,
      "from": { "stage": "0190a1…", "method": "top_n_per_group",
                "advance_per_group": 2, "advance_best_thirds": 0, "seeding": "cross" } }
  ]
}
```

Single-format = a one-element list. Pure knockout:

```jsonc
{ "format": "knockout", "seeding": "seeded", "third_place": true,
  "stages": [ { "id": "0190…", "name": "Knockout", "type": "knockout",
               "seeding": "seeded", "third_place": true, "plate": false } ] }
```

### 3.4 Validation — `_validate_stages` (single source of truth, called from `_validate_layer`)

Extract the existing scalar checks in `_validate_layer` (draw_config.py:117-180) into `_validate_draw_scalars(d)` and call it on both flat layers and stage params (so greedy/validate never diverge). Then `_validate_layer` gains, after its scalar checks:

```python
if "stages" in layer:
    _validate_stages(layer["stages"])
```

`_validate_stages(stages)` rules (exact, v1):

1. `None`/`[]` → OK (inherit/derive). Else a `list`; `1 <= len <= _MAX_STAGES` (`_MAX_STAGES = 4`).
2. Each item a `dict`; unknown top-level keys (outside `{id,name,type,group_size,balance_groups,min_matches_per_team,legs,partition,seeding,third_place,plate,swiss_rounds,from}`) → `ValueError`.
3. `type` required, in `{round_robin, knockout, swiss, double_elim}`.
4. `id` if present: non-empty `str`, **unique** across the list. (Write verb auto-fills uuid7 when absent.)
5. `params` validated per-type whitelist via `_validate_draw_scalars` (only the keys legal for that type; `group_size>=2`, `legs in {1,2}`, `seeding in _SEEDINGS`, `swiss_rounds None or >=1`, bool flags, `partition in {"","category"}`). `min_matches_per_team`: `None` or `int >= 1` (allowed only on `round_robin`).
6. **`from`:** absent/`{}` on stage 0 (a `from` on stage 0 → `ValueError`). On index k>0: required; `from.stage` if present must reference an **earlier** stage's id (forward/self → `ValueError`), default = `stages[k-1].id`; `method` in the allowed set; `advance_per_group>=1`; `advance_best_thirds>=0`; `seeding in {cross,overall}`.
7. **Cross-stage cross-field (the FIFA guard, analogue of `advance < group_size` at draw_config.py:178):** if the resolved source stage is `round_robin` and `method=top_n_per_group`, then `advance_per_group < source.group_size`.
8. **Legal v1 chains (enumerated):**
   - 1 stage of any type.
   - `round_robin → knockout` (eager-capable, §5).
   - `round_robin → round_robin` (deferred only — a "super-group" second league phase; no eager pre-draw).
   - `swiss → knockout` (deferred only).
   - A **knockout/double_elim must be the last stage** (single-winner brackets don't chain out in v1; a stage after one → `ValueError("a knockout must be the last stage")`).
   - The last stage may be `round_robin` (a league-/group-only competition).
9. **v1 repeat-type guard:** at most one `swiss` stage and at most one stage with `seeding="random"`/randomized draw per competition (avoids the single-scalar `seed`/`swiss_byes` collision — §12 O6). Violation → `ValueError`.
10. The flat-layer `advance_per_group < group_size` check (178-179) still runs independently on the flat keys.

`merge_draw_config` needs no change beyond `stages` being whitelisted (it is, once in `DEFAULT_DRAW_CONFIG`). `update_draw_config` auto-fills missing stage ids and writes the derived flat mirror (§10.2) before persist.

### 3.5 Back-compat read mapping — `effective_stages` (zero migration)

```python
def effective_stages(tournament, leaf_key, cfg=None) -> list[dict]:
    """Normalized ordered stage list for one competition. cfg defaults to
    effective_draw_config(tournament, leaf_key). Non-empty cfg['stages'] wins
    (validated, ids filled). Else derive from the flat format."""

def _derive_stages_from_format(cfg) -> list[dict]:
    # round_robin     -> [round_robin(group_size, balance_groups, legs, seeding)]
    # knockout        -> [knockout(seeding, third_place, plate)]
    # swiss           -> [swiss(seeding, swiss_rounds)]
    # double_elim     -> [double_elim(seeding)]
    # by_category     -> [round_robin(legs, seeding, partition="category")]
    # groups_knockout -> [round_robin(group_size, balance_groups, legs, seeding)]  # ONE stage (P0 #5)
```

**Decision (P0 #5):** legacy `groups_knockout` derives a **one-stage** league list. Its knockout stays the separate manual `knockout_from_groups` call (today's `AdvanceToKnockoutDialog` UX is unchanged). Multi-stage auto-fire is opt-in **only** when an explicit `stages` list with ≥2 elements is stored. This preserves LIVE behavior exactly. Derived stages carry deterministic synthetic ids (`f"legacy:{leaf}:{i}"`) so id-keyed code is uniform.

---

## 4. Group "minimum matches per team" — partial round-robin (frozen mechanism)

**Decision (P0 #4):** adopt a **target-N partial round-robin = a balanced prefix of the circle-method rounds**, field name **`min_matches_per_team`**, scoped **only as a `round_robin` stage param** (never a top-level `draw_config` key — that is what would flood the hash). This is the only mechanism that satisfies the owner's literal ask ("groups of 5, play 3"); the rejected "derive `group_size`" approaches change group composition (groups of 4, uneven 4/4/4/3) and contradict the example.

**Why a round prefix is correct and fair.** `_round_robin` (generate.py:49-72) emits the full RR round-by-round; each round is a near-perfect matching. The first `d` rounds form a `d`-regular sub-tournament: an **even** group keeps the first `N` rounds → everyone plays exactly `N`; an **odd** group's per-round bye means after the prefix some teams have `N` and some `N+1` — exactly why the owner's framing is "**at least** N" (handshake lemma: a perfectly-N-regular graph needs `g·N` even). Slicing on round boundaries preserves the circle method's home/away alternation, creates **no None-team/phantom matches** (a bye here just means "didn't play that round" — no ledger, unlike Swiss).

**New pure helper** (generate.py, next to `_legs_for_group`):

```python
def _truncate_to_min_matches(pairings, group, min_matches, *, label="", warnings=None):
    """Keep the shortest ROUND prefix of a circle-method schedule so every team
    has played >= min_matches. Even pools land exactly on min_matches; odd pools
    on min/min+1. Degenerates to the full schedule when min_matches >= len(group)-1.
    Clamps target = min(min_matches, len(group)-1)."""
```

Emits `matches_per_team_full_rr` (informational, when target == full RR) or `matches_per_team_uneven {min,max}` warnings.

**Wiring (single-leg, partial RR bypasses small-group double-RR — document precedence):** add `min_matches_per_team: int|None = None` to `_plan_pool` (489), `plan_round_robin` (523), `plan_round_robin_pool` (566), `generate_round_robin` (1288). In `_plan_pool`, when set, force `group_legs=1` and call `_truncate_to_min_matches` after `_round_robin`. The stage runner passes it from the stage param.

**Worked output (owner's case):** 15 teams, `balance_groups`, `group_size=5` → 3 groups of 5; `min_matches_per_team=3` → keep **4 circle rounds = 8 matches/group (24 total)**; four teams play 3, one plays 4; `matches_per_team_uneven {min:3,max:4}`.

**Standings impact: none required.** `compute_standings` already handles partial leagues; `P` is shown. Cross-group qualification already normalizes per game (`_norm_rates`). Default standings stay raw FIFA points (owner's mental model, least surprise). **Optional opt-in** tiebreaker token `points_per_game` plugs into `_sort_key` (standings.py:14) and lives in `rules.tiebreakers` (frozen, invariant 7 — correct, it is a participant-facing scoring rule); it is **not** auto-added when `min_matches_per_team` is set (auto-mutating `rules` would couple a draw_config edit to the rules freeze).

Because `min_matches_per_team` is inside `stages` (hashed when `stages` is non-empty, §10.3), changing it correctly marks the draw stale. No top-level key, no legacy hash perturbation.

---

## 5. Stage qualification — typed pointers, finalize, advance

### 5.1 Two materialization modes (the eager/deferred product call — P0 #6)

**Decision:** **deferred is the v1 default** for downstream stage generation (lowest risk, reuses existing machinery). **Eager `group_position` pre-draw** is gated **strictly to the clean case** and is what powers the FIFA "empty bracket that fills in" headline:

- **Mode A — eager positional pre-draw.** Allowed iff `method=top_n_per_group` **and** `advance_best_thirds==0` **and** `seeding=="cross"`. Bracket slots are determined purely by group structure ("winner of A plays runner-up of B"), independent of *who* finishes there, so we draw the full knockout bracket at publish with round-1/bye sides as `group_position` pointers. Each slot fills the instant **its** source group finalizes (per-group cadence). The owner's exact scenario (top-2, cross, no best-thirds) **is** the clean case, so the headline visual is covered.
- **Mode B — deferred standings materialization.** Used for `advance_best_thirds>0`, `seeding=="overall"`, `swiss→…`, or `round_robin→round_robin`. The slot→group mapping is results-dependent and **cannot** be a static pointer. The next stage is **not** pre-drawn; it is materialized by the existing finalization hook once the whole source stage is final, via `plan_knockout_qualifiers` (reads standings) → `generate_single_elimination`. The bracket viz shows a "Qualification pending" placeholder until then.

`_materialization(stage, source)` picks the mode; both reuse the same qualifier-selection arithmetic.

### 5.2 Typed `group_position` pointer (Mode A) — stage-qualified

Extends the existing type (advance.py:131), namespaced for multi-stage uniqueness:

```jsonc
{ "type": "group_position", "leaf_key": "football.u17_boys",
  "stage_no": 0, "group_label": "U17 Boys — Group A", "position": 1 }
```

`stage_no` is the **positional index** of the source stage (Match rows carry positional `stage_no`, §6). At generation time the runner builds a `stage_id → index` map and stamps the source stage's index into the pointer. Later knockout rounds use `winner_of` refs exactly as today, rewritten plan-ref → `match_id` by `_persist_plans`. Mode B produces a fully concrete bracket (`winner_of` internally, teams resolved) identical to today's `generate_knockout_from_groups`.

### 5.3 Resolution wiring — generalize `_resolve_group_positions` (advance.py:111-142)

The current code is hardcoded to `stage=="group"` and `group_label`-only. Replace with a stage-/leaf-scoped version that (a) drops the `stage=="group"` guard in favor of a cheap "is there an unresolved `group_position` pointer at this group?" pre-scan, (b) scopes group finality by `(stage, leaf_key, group_label)`, (c) passes `stage_no` to standings, and (d) **walkover-vacates under-filled slots** instead of stalling:

```python
def _resolve_group_positions(m: Match) -> list[Match]:
    if not m.group_label or m.status not in _FINAL:
        return []
    deps = Match.objects.filter(tournament_id=m.tournament_id, deleted_at__isnull=True)
    pending = [
        (dep, side) for dep in deps for side in ("home", "away")
        if (src := getattr(dep, f"{side}_source") or {}).get("type") == "group_position"
        and src.get("group_label") == m.group_label
        and src.get("stage_no", 0) == m.stage_no          # legacy pointers omit -> default 0
        and getattr(dep, f"{side}_team_id") is None
    ]
    if not pending:
        return []                                          # replaces the old stage!="group" guard
    group = Match.objects.filter(
        tournament_id=m.tournament_id, stage=m.stage, leaf_key=m.leaf_key,
        stage_no=m.stage_no, group_label=m.group_label, deleted_at__isnull=True)
    if group.exclude(status__in=_FINAL).exists():
        return []
    from apps.matches.services.standings import compute_standings
    rows = compute_standings(m.tournament, group_label=m.group_label, stage_no=m.stage_no)
    resolved = []
    for dep, side in pending:
        pos = int((getattr(dep, f"{side}_source") or {}).get("position") or 0)
        if 1 <= pos <= len(rows):
            setattr(dep, f"{side}_team_id", rows[pos - 1]["team_id"])
            dep.save(update_fields=["home_team", "away_team", "updated_at"])
            resolved.append(dep)
        else:
            # P1 #8: under-filled group (mass walkover / group of 1 / phantom position).
            # Vacate the slot so the bracket advances instead of stalling forever.
            src = getattr(dep, f"{side}_source") or {}
            src["walkover_vacated"] = True
            setattr(dep, f"{side}_source", src)
            dep.save(update_fields=["home_source", "away_source", "updated_at"])
            resolved.append(dep)
    return resolved
```

The team is set only when currently `None` (idempotent re-fire safe). `_settle_unopposed` (called by the caller for each resolved dep) auto-walkovers a slot whose opponent is concrete and whose own side is vacated, mirroring the existing walkover-vacated path (advance.py:45-56). A **0-qualifier stage** vacates all its downstream slots → the downstream stage settles into walkovers rather than deadlocking.

### 5.4 Mode-B finalization hook + idempotency (P1 #9, R5)

Add a tail call in `advance_from_match` (after the `_resolve_group_positions` line, ~advance.py:73), inside the existing exception-swallowing `_fire_advancement` post-commit hook (state.py:190):

```python
resolved.extend(_resolve_group_positions(m))     # generalized above
for dep in resolved:
    _settle_unopposed(dep)
from apps.fixtures.services.stages import materialize_ready_stages
materialize_ready_stages(m)                       # Mode B: draw next stage if this one finalized
return resolved
```

`materialize_ready_stages` finds the next stage whose `from.stage` resolves to `m.stage_no`, requires Mode B + `stage_is_final(leaf, source_stage_no)` (all matches `_FINAL`, ≥1 exists), and **guards against the TOCTOU race** (two near-simultaneous final-match commits both drawing): it writes a `stage_materialized` `AuditEvent` with a deterministic `idempotency_key = uuid5(NS, f"{tournament_id}:{leaf_key}:{stage_no}")`, checked-and-written inside `transaction.atomic()` + `select_for_update` on the audit row, **before** persisting. Any manual "advance stage" endpoint includes `stage_no` in its event_id idempotency context (the `swiss_round_generated` pattern, views.py:145-149), so "advance stage 2" can't collide with "advance stage 3".

### 5.5 Stale qualifier slots after a result correction (P1 #11)

`_resolve_group_positions` fills only-when-`None` (correct for idempotent re-fire). If an admin **corrects a stage-1 score after** the slot was filled — changing who finished 1st/2nd, or a post-finality withdrawal void (`withdrawal_policy.rr_results`) reshuffling standings — the already-filled downstream slot does **not** auto-re-resolve. v1 **documents this honestly** and provides a manual **"Re-seed downstream from standings"** repair action (re-runs the qualifier selection for an already-materialized stage, gated on the stage not yet being live). Best-effort standings-drift detection emits a warning banner. This is the multi-stage extension of the existing single-stage advancement-staleness behavior.

---

## 6. Generation engine orchestration + the `Match` field/migration

### 6.1 The one discriminator (P0 #1) — frozen

`Match.stage` **stays the bracket-role type label** (`group/knockout/swiss/losers/grand_final/plate`) — it drives `_guard_knockout_draw` (state.py:133), the bracket filter, and advancement type. **Add one column:**

```python
# matches/models.py, alongside stage (line 60)
stage_no = models.PositiveSmallIntegerField(default=0, db_index=True)  # 0-based stage index in the leaf
# Meta.indexes += Index(fields=["tournament","leaf_key","stage_no"], name="match_leaf_stage_idx")
```

- **`default=0`** (not 1) — chosen so "legacy == stage 0" and pointers that omit `stage_no` match via `src.get("stage_no", 0)`. Every existing row reads as stage 0; every current query that doesn't yet filter `stage_no` returns identical results (the DB-layer back-compat guarantee). For a legacy `groups_knockout` leaf (group + knockout rows in one leaf, both at `stage_no=0`), the `stage` *type* still disambiguates them — `stage_no` buys nothing there but is harmless. An optional cosmetic data-migration backfilling `stage_no=2` for legacy knockout rows is **display-only** and not required.
- **No `stage_type` column** — `stage` already carries the type. **No Stage/Group FK** — that PRD §8 path stays deferred; the JSONB pointers carry stage-qualified refs, so a future FK is a pure extension.
- **Config references stages by stable `id`; Match rows + pointers carry positional `stage_no`** (P0 #1 cross-cut). The runner builds the `stage_id → index` map once per generation and resolves every `from.stage` (an id) to the source `stage_no` (an index) before stamping pointers. Reordering stages in the UI changes indices but ids are stable, so qualification references survive reorder (the map is recomputed each run).

`MatchPlan` (generate.py:27-46) gains `stage_no: int = 0`; `_persist_plans` (1260-1285) stamps `stage_no=p.stage_no` onto each `Match`.

### 6.2 Migration (additive, owner role, live-gated)

`apps/matches/migrations/00NN_match_stage_no.py`:

```python
operations = [
    migrations.AddField("match", "stage_no",
        models.PositiveSmallIntegerField(default=0, db_index=True)),
    migrations.AddIndex("match", models.Index(
        fields=["tournament","leaf_key","stage_no"], name="match_leaf_stage_idx")),
]
```

No data migration (`default=0` covers all rows). `stages` (JSONB) needs no migration. Run as `fixture_owner` (`fixture_app` cannot `ALTER TABLE`). **Blocked while any tournament is `live`** (PRD §5 / deploy/README.md) — schedule a maintenance window with no live tournament; land `stage_no` **early (Increment 1)** so later increments never re-block (R3).

### 6.3 Orchestration — `generate_stages_for_leaf` (in new `stages.py`)

`generate_for_leaf` (generate.py:1796) gains a front door that keeps its signature (so `GenerateFixturesView.post` and the publish-all loop are unchanged):

```python
def generate_for_leaf(*, tournament, leaf_key, cfg, warnings=None):
    stages = effective_stages(tournament, leaf_key, cfg)
    if len(stages) == 1:
        return _generate_single_stage(tournament, leaf_key, cfg, stages[0], warnings)  # == today's body
    return generate_stages_for_leaf(tournament=tournament, leaf_key=leaf_key,
                                    stages=stages, cfg=cfg, warnings=warnings)
```

`_generate_single_stage` is **literally today's `if fmt==…` ladder** with `stage_no=0` — the regression-safety seam (the ~710 backend tests stay green by construction). `generate_stages_for_leaf`:

```python
def generate_stages_for_leaf(*, tournament, leaf_key, stages, cfg, warnings=None):
    id_to_no = {s["id"]: i for i, s in enumerate(stages)}
    created = []
    for i, stage in enumerate(stages):
        if _stage_has_matches(tournament, leaf_key, i):          # idempotency per (stage_no, leaf)
            created += _stage_matches(tournament, leaf_key, i); continue
        if i == 0:
            plans = _plan_entry_stage(tournament, leaf_key, stage, warnings)   # dispatch on stage["type"]
        else:
            source_no = id_to_no[stage["from"].get("stage", stages[i-1]["id"])]
            if _materialization(stage) == "deferred":
                continue                                          # drawn later by the finalization hook
            plans = _plan_bridged_stage(tournament, leaf_key, stage, source_no, warnings)  # Mode A
        for p in plans:
            p.stage_no = i
            p.inputs_hash = compute_inputs_hash(tournament, leaf_key)
        with transaction.atomic():
            created += _persist_plans(tournament, plans)
    return created
```

- **Entry stage** dispatches over the existing planners on `stage["type"]` (round_robin → `plan_round_robin` with `min_matches_per_team`; knockout → `plan_single_elimination`; swiss → `plan_swiss_round1`; double_elim → `plan_double_elimination`; `partition=="category"` → `_plan_by_category`).
- **Mode A bridged stage** → new `plan_knockout_from_group_positions` (§6.4).
- **Mode B / deferred** → skipped at publish; the finalization hook (§5.4) draws it via `plan_knockout_qualifiers` (overall/best-thirds knockout) or qualifiers-as-concrete-teams → `plan_round_robin`/`plan_swiss_round1` (second league / swiss).

Idempotency narrows from per-`(stage, leaf)` to per-`(stage_no, leaf)`; re-running fills only gaps.

### 6.4 New planner — `plan_knockout_from_group_positions` + the `_build_elim_tree` refactor (P1 #13)

Extract `_build_elim_tree(entries, *, stage, stage_no, leaf_key, sport, third_place, label_prefix, start_ref)` from `plan_single_elimination` (584), where `entries[i]` is **either** a `Team` (→ concrete `{type:"team"}` side, real id) **or** a source-`dict` (→ `home_team_id=None`, `home_source=dict`). All byes/`winner_of`/third-place logic lives in one place. **Pointer-bye forwarding (the hard part, specify precisely + test first):** a bye seat whose entrant is a pointer dict forwards the dict into round 2 — today's `{"team": team}` round-2 slot becomes `{"src": <dict>}`, and `_side` returns `(None, dict)` so the round-2 match's side is the original `group_position` pointer (it resolves to the seeded team once that group finalizes). Both `plan_single_elimination` (entries = Teams; behavior **byte-identical** when no pointer entrants) and the new planner call `_build_elim_tree`. **Direct tests for pointer-bye forwarding land before the refactor.**

```python
def plan_knockout_from_group_positions(*, group_labels, source_stage_no,
        advance_per_group, knockout_seeding="cross", leaf_key="", sport="",
        third_place=False, label_prefix="", start_ref=0) -> list[MatchPlan]:
    """Single-elim bracket whose round-1 entrants are group_position PLACEHOLDER
    pointers (no standings read). Reuses _cross_seed/_repair_same_group_pairs over
    SLOT identifiers (group_label, position) instead of team ids, then builds the
    tree via _build_elim_tree. Valid only for knockout_seeding=='cross' and
    advance_best_thirds==0 (asserted)."""
```

Entrant construction: layers `[(A1,B1,C1,…),(A2,B2,C2,…),…]` up to `advance_per_group`, fed (as synthetic ids + `group_of`) into `_cross_seed` verbatim, then each seeded slot maps back to a `group_position` dict carrying `source_stage_no`. In preview (no persisted prior stage), `group_labels` come from the just-planned stage-1 plans, so preview ≡ commit on the bracket shape.

---

## 7. Stages UI (with ASCII mock)

Replace the single **format dropdown** on "How each competition plays" with an ordered add/remove **STAGES** editor in both surfaces. **Default stays trivial:** one stage = today's single format → `stagesToConfig` writes flat keys only, **no `stages` key**, generator path unchanged. Stages are additive progressive disclosure.

### 7.1 Shared module `frontend/src/features/fixtures/stages.ts`

The FE `kind` is UI sugar; the **wire `type` is canonical** (P0 #12, P2 #14): `league`/`groups` → backend `type: "round_robin"` (league = `group_size >= teamCount`, one group; groups = explicit `group_size`); `knockout`/`swiss`/`double_elim` map 1:1. The qualification key on the wire is `from` (FE state may call it `intake` internally but **serializes to `from` with `seeding` not `knockout_seeding`**). `min_matches_per_team` sends **`null` when blank — never `0`** (the backend validator rejects 0; absent/null = full RR).

```ts
export type StageKind = "league" | "groups" | "knockout" | "swiss" | "double_elim";
export interface Intake { advance_per_group: number; advance_best_thirds: number; seeding: "cross"|"overall"; }
export interface Stage {
  id: string;            // uuid7 (newEventId) — React key + stable handle
  name: string; kind: StageKind;
  groupSize: number; balanceGroups: boolean;
  minMatchesPerTeam: number | "";   // "" = blank = full RR -> serialize null
  twoLegs: boolean; thirdPlace: boolean; plate: boolean; swissRounds: number;
  seeding: string; intake?: Intake; // stage 1..n
}
export function stagesFromConfig(eff: DrawConfig, teamCount: number): Stage[];
export function stagesToConfig(stages: Stage[], teamCount: number): DrawConfigLayer; // 1 stage = flat only; >=2 = stages + flat mirror (§10.2)
export function validateStages(stages: Stage[], teamCount: number): Record<string,string>;
export function blankStage(kind: StageKind, teamCount: number): Stage;
```

`stagesFromConfig` back-compat read: `knockout→[knockout]`, `swiss→[swiss]`, `double_elim→[double_elim]`, `groups_knockout→[groups, knockout(intake)]`, `round_robin & group_size>=teamCount → [league]`, else `[groups]`. Reuses the wizard's existing prefill branch (CompetitionFormatWizard.tsx:248-259).

### 7.2 `StagesEditor` (new) + wiring

`StagesEditor.tsx` renders `StageCard` (kind radiogroup lifted from the wizard's `FORMATS`, `role="radio"`/`aria-checked`; per-kind params incl. **"Minimum matches per team"** numeric with helper *"Each team plays at least this many group matches. Leave blank for a full round-robin."*; a "More options" disclosure for legs/third-place/plate/seeding) and `StageConnector` (the intake band: "Top [2] of each group advance →", `+ best [0] next-placed`, `Order: [Winners v RU ▾]` via `components/ui/Select`). `+ Add stage` is disabled when the last stage is terminal (knockout/double_elim).

**Wizard** (`CompetitionFormatWizard.tsx`): `Form` drops the per-field format state, gains `stages: Stage[]`; reseed block sets `stages: stagesFromConfig(eff, teamCount)`; render swaps the format radiogroup for `<StagesEditor … errors={validateStages(...)} />`; `buildConfig` → `const cfg = stagesToConfig(f.stages, teamCount); if (f.matchDuration>0) cfg.match_duration_minutes = f.matchDuration; return cfg;`. CTA gating uses `Object.keys(validateStages(...)).length===0`. `persist` (one `updateDrawConfig` PATCH) unchanged.

**Board** (`CompetitionFormatBoard.tsx`): keeps `staged` + per-layer PATCH loop unchanged (`stages` rides inside the layer). The 5-preset Select stays the compact primary control; a `Custom (N stages)` option + **"Edit stages"** expander opens the inline `<StagesEditor>` bound to `staged["sport:"+sp]` (matches the "compact accordion rows, never stack everything" guidance). A flat-format preset write **collapses `stages`** (sets `stages: []`).

### 7.3 Validation messaging (inline, `text-destructive`, all `t()`-wrapped)

- **Terminal not last** — *"A knockout decides a winner, so it has to be the last stage."* (also drives the disabled `+ Add stage`).
- **Advance ≥ capacity** — reuse the existing string *"Fewer teams must advance than the group holds…"*.
- **Min-matches out of range** — `minMatchesPerTeam > groupSize-1` → *"A team can play at most {cap} matches in a group of {size}."*; blank = valid (full RR); odd `teamCount*k` → soft note *"…one team plays one fewer — the schedule balances as close as it can."*
- **Empty list** never allowed (Remove hidden at length 1).

### 7.4 ASCII mock (two stages, groups → knockout, connector shown)

```
┌─ Step 2 · How U17 Boys plays ────────────────────────────────┐
│ 15 teams are in. Pick how they play.                         │
│                                                              │
│  STAGES                                                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ ① Group stage                                    [🗑]   │ │
│  │  ( ) League   (•) Groups   ( ) Knockout                 │ │
│  │  ( ) Swiss    ( ) Double elimination                    │ │
│  │  Teams per group [ 5 ]   ☑ Balance sizes (FIFA)         │ │
│  │  Matches each team plays [ 3 ]  (blank = play everyone) │ │
│  │  ▸ More options (home & away, seeding)                  │ │
│  └────────────────────────────────────────────────────────┘ │
│        ┃                                                      │
│        ┃  Top [2] of each group advance       → Knockout     │  ← StageConnector (intake of ②)
│        ┃  + best [0] next-placed   Order:[Cross-group ▾]    │
│        ┃                                                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ ② Knockout                                       [🗑]   │ │
│  │  (•) Knockout   ☐ Third-place match  ☐ Plate           │ │
│  │  ▸ More options (seeding)                               │ │
│  └────────────────────────────────────────────────────────┘ │
│            [ + Add stage ]   (disabled — knockout ends it)   │
│                                                              │
│  Match length for this competition (minutes) [        ]     │
│ [Cancel] [Save for later]            [⚡ Preview the draw]    │
└──────────────────────────────────────────────────────────────┘
```

A one-stage competition collapses to a single `StageCard` with no connector and a hidden trash button — visually today's page.

---

## 8. Bracket visualization — data-driven `<Bracket>`

A single React component rendering the FIFA mockup (two mirrored halves, QF/SF/Final inward, centre champion + trophy) **entirely from match data** — `round_no` + `winner_of`/`loser_of`/`group_position` source pointers + names/byes — reused across preview, competition card, internal, and public. It replaces the knockout branch of `BracketView` (`KnockoutTree`, BracketView.tsx:50), which is geometry-only and never follows pointers. The group-table view stays; the bracket is a **toggle** alongside it.

### 8.1 Backend exposure (migration-free)

The model already stores `home_source`/`away_source` (models.py:74-75); they just aren't serialized. Add `"home_source","away_source"` to `MatchSerializer.Meta.fields` (serializers.py:25-31) **and** to the public `PublicScheduleMatch` serializer + the `tournaments.ts` `PublicScheduleMatch`/`MatchRow` types (so the public bracket is source-pointer-driven, not positional). Two field-name additions; no migration.

### 8.2 Component API + internal model

```tsx
export interface BracketProps {
  matches: BracketMatch[];                  // ONE leaf + ONE bracket stage (filter to stage==="knockout")
  teamNames?: ReadonlyMap<string,string>;
  label?: string; showLivePath?: boolean; testId?: string;
}
export function Bracket(props: BracketProps): React.ReactElement;
```

```ts
// bracketTree.ts (pure, unit-tested)
export type SourceRef =
  | { type: "team"; team_id: string }
  | { type: "winner_of"|"loser_of"; ref?: string; match_id?: string }
  | { type: "group_position"; stage_no?: number; group_label: string; position: number }  // P0 #12 — REQUIRED
  | { type: "tbd" };
export interface BracketSide { teamId?: string; name?: string; source?: SourceRef; isBye?: boolean; score?: number|null; }
export interface BracketMatch {
  key: string;            // ref ("p7") for preview, id (UUID) committed
  roundNo: number; matchNo: number; status: string;
  home: BracketSide; away: BracketSide; variant?: "main"|"3rd_place";
}
```

### 8.3 Tree-building (`buildBracket`) — from source pointers

A feeder edge is any side whose `source` is `winner_of`/`loser_of` pointing at another match's identity (`source.ref` preview, `source.match_id` committed). Algorithm: index by `key`; compute `feederKey(side)`; the **root = the unreferenced match in the highest round** (robust to the 3rd-place match sharing `final.round_no` — it is `loser_of`-fed and never referenced, plus `variant !== "3rd_place"` filtering); walk feeders depth-first, `column = final.roundNo - m.roundNo - 1`; the final's two feeders seed the two mirrored halves. `resolveSide` upgrades "Winner of SF1" → the real team once the feeder completes; a `group_position` side renders *"Group A #1"* (via `sideName` extended with a `group_position` case — P0 #12) until that group finalizes, then the resolved team name. Round names are **data-driven** (`labelRounds`: distance-from-final → `Final`/`Semi-final`/`Quarter-final`/`Round of {n}`), so QF/SF/Final headers fall out of the data with no hardcoding.

**Byes:** `plan_single_elimination` never creates a round-1 Match for a bye seat (the top seed appears directly as a `{type:"team"}` or pointer side in its round-2 match). The renderer detects "round-2 side with no feeder in round 1" and draws a faint `t("Bye")` stub in the outer column so the mirror stays symmetric — no phantom data invented.

### 8.4 Adapters, layout, tokens, a11y

`fromPreviewMatches` / `fromMatchRows` filter `stage==="knockout"`, tag `variant:"3rd_place"` by `group_label` regex, and carry `home_source`/`away_source`. Geometry reuses the deterministic `CARD_H=56`, `BASE_GAP=28`, `SLOT=84`, `gap=2**i*SLOT-CARD_H` from the current tree; the right half mirrors elbows on `right:100%`. **Tokens only** (no hex/`orange-*`): undecided edges `bg-border`; the advancing path + champion path `bg-primary`; live path `bg-primary motion-safe:animate-pulse`. Champion box `rounded-xl border border-primary bg-primary/10` + `Trophy` `text-primary` (no gold token; primary is the brand accent). Winner row `bg-accent/60 font-semibold` + `Check` icon (never colour alone). A `ResizeObserver` scales the tree to fit; below `useBreakpoint().isMobile` it renders a stacked round-by-round accordion (Final→SF→QF, champion banner on top — no horizontal scroll). `role="tree"`/`role="treeitem"`, focusable cards with full-pairing `aria-label`, `aria-hidden` connectors, every string via `t()` (invariant 13), wall-clock times via `.slice(11,16)` (invariant 14).

### 8.5 Surfaces

`CompetitionResultCard` gets a `Table | Bracket` segmented toggle (round-robin forces Table, knockout defaults Bracket). `DryRunPreviewPage` gets a "Bracket" tab feeding `fromPreviewMatches`. `BracketView.tsx:234` swaps `<KnockoutTree>` → `<Bracket>` (keeps `GroupTable` for round-robin); `PublicBracketPage` inherits it and lights the champion box live over the existing SSE tick. **Double-elimination** (losers + grand_final) is **out of scope** for this first cut (single-elim + optional 3rd-place); it gets a follow-up reusing `BracketColumn`.

---

## 9. Scheduler & rules implications

### 9.1 Null-team pointer matches (P1 #7) — frozen decision

Mode-A QF/SF matches carry `home/away_team_id=None` until groups resolve; the scheduler's team-scoped hard checks (`effective_rest_gap`, `effective_day_cap`, `team_blackouts`, shared-player links) **cannot evaluate a null team**. **Decision (option a):** pre-drawn pointer matches are **not time-scheduled at publish** — they exist structurally (the bracket renders with placeholders) but `scheduled_at` stays `null` (shown as "TBD" time) until their `group_position` pointers resolve. On resolution, the existing repair/`apply_schedule` pass schedules them with full constraint evaluation. This avoids placing a slot that later violates rest/blackout once the team is known.

**Stage ordering:** add `stage_no` to `MatchSlotReq` (scheduler.py:617) and a stage-ordering guard so when later stages *are* scheduled, stage k cannot start before stage k-1's last match (a `round_after_round`-style ordering keyed on `stage_no`, not just `round_no` — because `stage_no` resets `round_no` per stage). This lands with the eager path, **not** deferred to "polish," since eager pre-draw could otherwise interleave a knockout into the group window.

### 9.2 Standings scoping & head-to-head (P2 #16) — frozen

`compute_standings` gains an optional `stage_no=None` kwarg (filters Match by `stage_no` when provided); `_resolve_group_positions` passes `stage_no=m.stage_no`. Single-stage callers pass nothing → unchanged hot path. This is the **correctness** mechanism that also covers the `head_to_head` tiebreaker: its mini-tables are built from "same-group" matches, so without a stage filter two stages sharing a `group_label` would silently mix cross-stage matches into h2h. The `stage_no` filter prevents that; group labels are **additionally stage-namespaced for display** (the group-stage generator passes the stage `name` into `label_prefix`).

### 9.3 Rule-freeze interaction (P2 #21) — frozen

**Stages are NOT frozen at `registration_open`.** They live in `draw_config`, deliberately outside the invariant-7 freeze; `update_draw_config` has **no** `can_edit_rules` gate (contrast `update_settings`, rules.py:113). Generation inputs the owner cares about (group size, `min_matches_per_team`, advance N) change *who plays whom* → correctly governed by **invariant 10** (inputs_hash staleness), not invariant 7. **v1 keeps scoring tournament-wide in `rules`** (frozen) — knockout has no points anyway; `compute_standings` reads `tournament.rules`. **Per-stage scoring deltas (`rules.stages[id]`: points/tiebreakers/discipline) are explicitly DEFERRED** — and must live in `rules` (frozen), never `draw_config`, so no one breaks the freeze contract by putting a points table in draw_config.

---

## 10. Back-compat, migration, rule-freeze

### 10.1 Read path

`effective_stages` (§3.5) derives a one-element (or, for synthetic legacy parity, one-element league) list for any flat config with **zero stored change** and **zero generated-match change** (matches already exist; the derived list is only consulted by generation/preview/display, which already produced them). Synthetic stable ids (`legacy:{leaf}:{i}`) keep id-keyed code uniform.

### 10.2 Write path — `stages` authoritative, flat keys a derived mirror (P1 #4/R4)

One reconciliation rule, in **one place** (`update_draw_config`):
- **Flat write** (format board) → if the partial sets `format` and not `stages`, **clear `stages`** (`stages: []`, collapse to single-stage).
- **Stages write** (wizard) → `_mirror_flat_keys(stages)` mirrors stage 0 + the final qualification into the flat keys (`format` = `groups_knockout` for `[round_robin, knockout]`, else the single stage's type; `group_size`, `advance_per_group`, `advance_best_thirds`, `knockout_seeding`, `third_place`, `plate`, `legs`). Flat keys are **derived; do not hand-write once `stages` is present.** This keeps every legacy reader (readiness checks, format-board chips, the assistant, `BracketView` format branching) coherent without knowing about stages. The classic 2-stage groups→knockout round-trips to **exactly today's flat config**, so the existing generator handles it with zero backend change.

### 10.3 inputs_hash stability — the single canonicalizer (P0 #2 / R1)

Naively adding `stages` to `DEFAULT_DRAW_CONFIG` injects `"stages": null/[]` (and `json.dumps({"x":None})` is **not** empty) into every leaf's hashed payload → platform-wide spurious "inputs_changed" 409s and regenerate banners. **One canonicalizer**, applied in `compute_inputs_hash` (generate.py:465-469) replacing the dict-comp:

```python
def _canonical_draw_for_hash(cfg: dict) -> dict:
    c = {k: v for k, v in cfg.items() if k not in _HASH_EXCLUDED_KEYS}
    if not c.get("stages"):
        c.pop("stages", None)                    # legacy: byte-IDENTICAL hash to today
    else:
        # stages authoritative -> drop the derived flat mirrors (no double-count, no drift)
        for k in ("format","group_size","advance_per_group","advance_best_thirds",
                  "knockout_seeding","third_place","plate","legs",
                  "balance_groups","swiss_rounds"):
            c.pop(k, None)
        c["stages"] = _canonicalize_stages_for_hash(c["stages"])  # re-index ids -> positions,
                                                                  # rewrite from.stage -> index,
                                                                  # strip cosmetic name
    return c
```

`_canonicalize_stages_for_hash` replaces each stage `id` with its positional index, rewrites `from.stage` (an id) to the source index, and strips `name`, so renaming a stage or a fresh client uuid7 on identical structure does **not** read as "inputs changed" (invariant 10), while any structural/param change does. **`stages` and `min_matches_per_team` (nested) ARE generation inputs** — they enter the hash for stage-configured leaves and are **not** in `_HASH_EXCLUDED_KEYS`. The dangerous top-level `matches_per_team` from the partial-RR section is **rejected** (it would perturb every leaf); min-matches lives only inside `stages`.

**Increment 0 ships a frozen-hash regression fixture** asserting byte-identical hashes for **every** existing format (`round_robin`, `knockout`, `groups_knockout`, `swiss`, `double_elim`, `by_category`) before any other code merges. The narrower `not (k=="stages" and not v)` proposed in one section is insufficient (it misses the flat-mirror double-count); this canonicalizer is the one we ship.

### 10.4 Per-stage staleness — honest scope (P1 #10)

`compute_inputs_hash` is **leaf-scoped** and hashes the whole `stages` list. We do **not** claim per-stage staleness granularity: editing any stage's params changes the leaf hash → all the leaf's existing matches read stale and the regenerate/keep/diff banner fires. v1 documents whole-leaf staleness honestly. A per-stage sub-hash (stamping each Match with a stage-scoped sub-hash) is a noted future enhancement, not v1.

### 10.5 Permissions & multi-tenancy (P2 #20)

The manual "advance stage" path reuses `GenerateFixturesView`'s `tournament.bracket_editor` gate + `accessible_tournaments`/`can_manage_tournament` (404 on no-access, no existence leak). The auto-fire materialization hook is tournament-scoped (reads `m.tournament`). **Mandatory cross-org isolation tests** on every new endpoint and an assertion that the auto-fire hook never crosses tenants.

---

## 11. Phased increment plan

Each increment is green-on-merge (relevant pytest/vitest + `type-check`) and a real deliverable. **Mandatory test axes on every increment: state-machine (every transition + every blocked transition), multi-tenancy isolation, idempotency (event_id).**

**Increment 0 — Hash canonicalizer + frozen-hash fixture (safety net, no behavior change).**
`_canonical_draw_for_hash` + `_canonicalize_stages_for_hash` in `compute_inputs_hash`. *Test focus (make-or-break):* byte-identical inputs_hash for every existing format against a frozen fixture; preview≡commit unaffected; the `expected_inputs_hash` 409 guard still fires only on real input changes.

**Increment 1 — Data model + validation (no generation change).**
`stages` in `DEFAULT_DRAW_CONFIG`; `_validate_draw_scalars` extraction + `_validate_stages` (legal-chain enumeration, backward-only `from.stage`, cross-field guard, repeat-type guard, `_MAX_STAGES=4`); `Match.stage_no` migration (default 0, owner role, live-window); `MatchPlan.stage_no`; `effective_stages`/`_derive_stages_from_format` (read-path only). *Test focus:* schema validation (bad type, stage-0-`from`, forward ref, terminal-not-last, min-vs-group_size); migration default=0; `update_draw_config` multi-tenancy + idempotency on the `stages` PATCH; flat↔stages reconciliation in one place.

**Increment 2 — Stage runner, deferred materialization (regression net + owner's scenario).**
`generate_stages_for_leaf` consulting `effective_stages`; `_generate_single_stage` bit-identical to today; `_persist_plans` stamps `stage_no`; `min_matches_per_team` partial-RR (`_truncate_to_min_matches` + wiring); `compute_standings(stage_no=…)`; deferred downstream generation reuses `generate_knockout_from_groups`/`generate_swiss_next_round`; the generalized `_resolve_group_positions` + `materialize_ready_stages` finalization hook with the `uuid5` `stage_materialized` idempotency guard. *Test focus:* every existing single-format suite still green (regression); partial-RR even/odd/clamp + back-compat byte-for-byte; per-`(stage_no,leaf)` idempotency; TOCTOU double-draw guard; under-filled-group walkover-vacate (no deadlock); stage-advance event_id includes `stage_no`.

**Increment 3 — Eager qualification + bracket-viz enabler.**
`plan_knockout_from_group_positions` + the `_build_elim_tree` refactor (pointer-bye forwarding tests **first**); Mode-A gating (cross + no best-thirds); stage-qualified `group_position` resolution per-group; scheduler `MatchSlotReq.stage_no` + stage-ordering + null-team "don't time until resolved" + re-schedule-on-resolution. *Test focus:* per-group Mode-A fill; preview≡commit for the qualifier bracket; walkover/withdrawal interaction with vacated slots; null-team scheduling deferral; `_build_elim_tree` concrete-team output unchanged.

**Increment 4 — Stages UI.**
`stages.ts` (`stagesFromConfig`/`stagesToConfig`/`validateStages`), `StagesEditor`/`StageCard`/`StageConnector`; wizard + board wiring; flat↔stages collapse/mirror; preview renders the multi-stage stack + `deferred_stages` descriptor. *Test focus:* sparse-layer round-trip with the pinned wire contract (`type` not `kind`, `from` not `intake`, null-not-0 min-matches); re-seed-on-stored-change dirty-guard; i18n/a11y radiogroup; CTA gating.

**Increment 5 — FIFA `<Bracket>` visualization.**
`Bracket.tsx` + `bracketTree.ts`; `home_source`/`away_source` serializer + type additions (internal + public); `SourceRef.group_position` + `resolveSide`/`sideName` case; toggle in `CompetitionResultCard`/`DryRunPreviewPage`; `BracketView` swap; public live update. *Test focus:* render with unresolved `group_position`/`winner_of` (placeholders, null-team guards); 3rd-place outside centre; byes; mobile stacking; live SSE champion fill.

**Increment 6 — Polish.**
Stage-aware scheduling refinements; "re-seed downstream from standings" repair + standings-drift warning (§5.5); regenerate/keep/diff messaging for whole-leaf staleness; double-elim bracket follow-up scoping; assistant integration. *Test focus:* scheduler greedy≡validate alignment (the 2026-06-25 regression class); edge counts; idempotency.

---

## 12. Open questions & risks — and how the critique is resolved

**Critique resolution map (every P0/P1/P2 point):**

| # | Point | Resolution |
|---|---|---|
| P0-1 | Discriminator disagreement; `Match.stage`="ko" breaks guards | **`Match.stage` stays the TYPE label; add `Match.stage_no` (default 0)**. Config references stages by stable `id`; runner builds `id→index` map; Match rows + pointers carry positional `stage_no`. The Stage-to-Stage `stage="ko"` proposal is **rejected** (breaks `_guard_knockout_draw`/`_resolve_group_positions`/bracket filter, all confirmed). §6.1 |
| P0-2 | Hash flood; top-level `matches_per_team` | **One `_canonical_draw_for_hash`** (drops falsy `stages`, drops flat mirror when `stages` authoritative, re-indexes stages). `matches_per_team` is **stage-param only**, never top-level. Frozen-hash fixture = Increment 0. §10.3 |
| P0-3 | Five qualification schemas | **One block `from`**, downstream-attached, explicit `method`, normalized field names (`advance_per_group`/`advance_best_thirds`/`seeding`). §3.2 |
| P0-4 | Two min-matches mechanisms, three schedules | **Partial RR (round prefix), field `min_matches_per_team`**, satisfies "groups of 5, play 3" literally. Derive-group_size approaches rejected. New `_truncate_to_min_matches` is **in scope** (Increment 2). §4 |
| P0-5 | Legacy `groups_knockout` 1- vs 2-stage behavior change | **1-stage derivation**; knockout stays the manual `knockout_from_groups` call; auto-fire opt-in only for explicit `stages`. §3.5 |
| P0-6 | Eager vs deferred | **Deferred default; eager gated to clean case** (cross, no best-thirds) for the FIFA headline. §5.1 |
| P1-7 | Scheduler null-team | **Don't time pointer matches until resolved; re-schedule on resolution**; add `stage_no` + stage-ordering to `MatchSlotReq`. §9.1 |
| P1-8 | `pos>rows` deadlock | **Walkover-vacate under-filled slots** so the bracket advances. §5.3 |
| P1-9 | Auto-fire TOCTOU | **`uuid5` `stage_materialized` AuditEvent + `select_for_update` in `atomic()`** mandatory. §5.4 |
| P1-10 | Per-stage staleness on leaf-scoped hash | **Document whole-leaf staleness honestly**; per-stage sub-hash deferred. §10.4 |
| P1-11 | Stale qualifier after score correction | **Document; manual "re-seed downstream" repair + drift warning**. §5.5 |
| P1-12 | FE↔backend wire mismatch; missing `group_position` in `SourceRef` | **Pinned wire contract** (`type` not `kind`, `from` not `intake`, null-not-0); **`SourceRef.group_position` added** + `resolveSide`/`sideName`. §7.1, §8.2 |
| P1-13 | `_build_elim_tree` refactor + pointer-bye | **Extract shared builder; specify pointer-bye forwarding (`{"src":dict}`, `_side`→`(None,dict)`); tests-first**. §6.4 |
| P2-14 | Type vocabulary | Backend `type ∈ {round_robin,knockout,swiss,double_elim}`; FE `league`/`groups`→`round_robin`; no `groups_knockout` stage type. §3.1, §7.1 |
| P2-15 | Stage id scheme | **uuid7 id (stable), no `order` field, array index authoritative**; legacy synthetic ids. §3.1, §3.5 |
| P2-16 | `compute_standings` scoping + h2h | **Add `stage_no` kwarg** (covers h2h) + stage-namespaced labels for display. §9.2 |
| P2-17 | Validation conflicts | **Single `_validate_stages`, enumerated legal v1 chains, `_MAX_STAGES=4`, plate is a knockout param** (not a chained stage). §3.4 |
| P2-18 | Per-stage seed/swiss_byes | **v1 forbids two randomized/Swiss stages**; per-stage keying deferred. §3.4 rule 9 |
| P2-19 | `by_category` shape | **`partition:"category"`** (one spelling). §3.1 |
| P2-20 | Permissions/multi-tenancy | **Reuse `bracket_editor` + `accessible_tournaments`; tenant-scoped hook; mandatory isolation tests**. §10.5 |
| P2-21 | Per-stage scoring deltas | **v1 scoring tournament-wide in frozen `rules`; per-stage deltas deferred (must stay in `rules`, never `draw_config`)**. §9.3 |

**Genuinely open product questions (need owner sign-off, do not block the schema freeze):**
1. **Eager bracket UX for best-thirds/overall:** confirm "Qualification pending" placeholder is acceptable (a structural pre-draw for best-thirds would need a new `qualifier_position` pointer sub-type resolved at stage-finalization — out of v1).
2. **Cosmetic migration:** materialize derived stages into `draw_config[leaf].stages` for all existing competitions (so every wizard shows editable cards), accepting it must be a verified inputs_hash no-op — vs leave legacy as `stages` absent and materialize on first wizard edit. Recommend the latter.
3. **`round_robin → round_robin` (super-group) in v1:** ship as deferred-materialization (entrants concrete after stage-1 finality) or validate-only with a warning until a re-grouping planner is hardened? Recommend deferred-materialization, gated to no eager pre-draw.
4. **Double-elimination bracket viz:** confirm it is a follow-up (side-by-side winners/losers reusing `BracketColumn`), not forced into the first single-elim cut.
5. **Gold champion accent:** the design system has no gold token; champion maps to `text-primary`/`bg-primary/10`. Add a `--gold` CSS var only if the owner insists.

**Standing risks for engineers (highest blast radius first):**
- **R1 — inputs_hash perturbation.** Mitigated by Increment 0's canonicalizer + frozen fixture; nothing else merges first.
- **R2 — eager seeding without standings.** Static `group_position` pointers are correct only for `top_n_per_group` + cross + no best-thirds; best-thirds/overall are results-dependent and **must** stay deferred. The Mode-A gate enforces this.
- **R3 — `stage_no` migration under the live-gate.** Land it in Increment 1 in a no-live-tournament window so later increments never re-block.
- **R4 — flat↔stages drift.** Single reconciliation point (`update_draw_config`).
- **R5 — cross-stage advancement idempotency.** `event_id` keys include `stage_no`; auto-fire uses the deterministic `uuid5` audit guard.

---

## 13. Per-game scoring rules — frozen `rules.by_leaf[leaf].scoring` (owner ask, NOT in §1-12 workflow scope)

The owner wants every **game** (category leaf) to set its own match format: number of sets, points-to-win, win-by-2 deuce, a hard cap (the 15→17 ceiling), an optional different **deciding** set, or a timed/goal sport — *fully dynamic, per game*. This is **per-game**, not per-*stage* (P2-21 defers per-stage deltas — orthogonal and still deferred).

### 13.1 The engine already exists (reuse, don't rebuild)

`apps/matches/services/set_scoring.py` is already a complete, data-driven set/point engine: `SPORT_PROFILES` carries `{type:"sets", best_of, points, win_by, cap, deciding:{points,win_by,cap}}` and `{type:"goals"}`; `scoring_rules(sport_key, override)` resolves *override → profile* (an override `type:"goals"` turns a set sport goal-based, line 94); `_set_params(rules, deciding)` (line 120) is the deuce/cap math the scorer console already enforces. The owner's TT example maps **exactly**: `{type:"sets", best_of:3, points:15, win_by:2, cap:17}`. The scorer needs **zero change** — it already calls `rules_for_match`.

The **only gap** is granularity: `sport_override` (set_scoring.py:101) reads `Tournament.sports[].scoring` — one setting per **sport**. The owner wants per **category/game**.

### 13.2 Where it lives — frozen `rules`, NOT `draw_config` (the §9.3 contract)

Scoring/ranking are **participant-facing** (how a match is won) → they belong under invariant 7's rule-freeze, i.e. in `Tournament.rules`, edited through `update_settings` (rules.py:113, the `can_edit_rules` gate + amend/24h-grace/notify path). **Putting scoring in `draw_config` is explicitly forbidden** by §9.3 (it would dodge the freeze). So per-game scoring is a new sub-key of `DEFAULT_RULES`:

```jsonc
// Tournament.rules
{ "points": {...}, "tiebreakers": [...],          // existing tournament-wide defaults
  "by_leaf": {                                     // NEW — per-game overrides (frozen)
    "table_tennis.open.boys.1v1": {
      "scoring": { "type": "sets", "best_of": 3, "points": 15, "win_by": 2, "cap": 17 }
    }
  } }
```

`merge_rules` (rules.py) whitelists `by_leaf`; `update_settings` validates each `scoring` block with the existing `_validate_scoring`-style checks (`type in {sets,goals}`; for sets `best_of>=1` odd-preferred, `points>=1`, `win_by>=1`, `cap None or >points`, optional `deciding` same shape).

### 13.3 Resolution — extend `rules_for_match` precedence (one function)

`rules_for_match(match)` (set_scoring.py:110) gains a leaf layer **before** the sport layer:

```python
def leaf_override(match):
    by_leaf = (match.tournament.rules or {}).get("by_leaf") or {}
    return (by_leaf.get(match.leaf_key) or {}).get("scoring")

def rules_for_match(match):
    return scoring_rules(match.sport, leaf_override(match) or sport_override(match))
```

Precedence: **game (`rules.by_leaf[leaf].scoring`) → sport (`Tournament.sports[].scoring`) → `SPORT_PROFILES[sport]`**. `match.leaf_key` already exists. Goal-based games fall through to `None` (goal scoring) exactly as today. **No migration, no model change** — `rules` is JSONB.

### 13.4 UI — a "Scoring" section on the format card; write via `update_settings`

A **Scoring** section on each game's card in `CompetitionFormatBoard.tsx` (next to Match length): a **Points / Time** toggle → for points: *number of sets, points to win, win by, hard cap, ▸ different deciding set*; for time: *regulation minutes*. Sport defaults prefilled from `SPORT_PROFILES`, so the common case is one glance. **Crucial:** this section's writes go to **`PATCH …/settings/` (`update_settings`), not `update_draw_config`** — so once the tournament is past `registration_open` the UI shows the frozen-rules **"amend with reason + 24h grace"** flow (invariant 7), unlike the stages editor which is freely editable (draw_config). Sport-level convenience default + per-game override, the game's value winning — same UX shape as durations, different write verb.

### 13.5 Test focus

Per-leaf precedence (game > sport > profile); deuce/cap math unchanged (the `_set_params` suite stays green); a `type:"goals"` leaf override turning a set sport timed; `update_settings` freeze gate (mutable in draft/published, amend-only after `registration_open`, match-rules frozen once live); multi-tenancy isolation on the settings PATCH; idempotency (`event_id`).

---

## 14. Per-game tie-breakers — frozen `rules.by_leaf[leaf].tiebreakers` (owner ref hierarchy)

Owner's reference order (set sports): **head_to_head → set_difference → point_difference → points_for → coin_toss**, applied among teams level on match points, **per game**, reorderable.

### 14.1 The engine already does ordered tiebreakers + head-to-head (reuse)

`apps/matches/services/standings.py`: `_sort_key` (line 14) walks an ordered `tiebreakers` list; `_apply_head_to_head` (line 37) builds the **mini-league among only the teams tied on every prior criterion** (the subtle part — done correctly, stress-test #5). Order comes from `rules.tiebreakers` (DEFAULT `["points","goal_difference","goals_for","head_to_head","name"]`). Existing criteria: `points`, `goal_difference`(GD), `goals_for`(GF), `goals_against`(GA), `wins`, `head_to_head`, `name`.

**Set wins are mirrored into `home_score`/`away_score`** (set_scoring.py:8), so for a set sport `goal_difference` **is** set difference and `goals_for` **is** sets-won. Expose `set_difference`/`sets_for` as **UI aliases of GD/GF** (relabel; zero new computation).

### 14.2 Two real gaps

1. **Raw point aggregates** — `point_difference`, `points_for`, `points_against`. The actual points inside sets (21-15, 19-21…) live in `Match.set_scores` but are **not** aggregated into standings rows today. Add `PF_pts`/`PA_pts` accumulation in the row builder (standings.py ~131-197) by summing `set_scores`, and three `_sort_key` cases (`point_difference → -(PF_pts-PA_pts)`, `points_for → -PF_pts`, `points_against → PA_pts`). Goal sports leave these at 0 (never offered in their menu).
2. **`coin_toss`** — terminal, *non-computable*. Resolution: a stored, **audited** manual referee decision (a `tiebreak_resolution` record keyed `(tournament, leaf, group_label, stage_no)` carrying the ordered team ids), with a **deterministic seeded shuffle** (seed = stable hash of `tournament_id|leaf|group|stage_no`; **no `Math.random`/`Date.now`** — must be reproducible so preview≡commit) as the placeholder until a referee confirms. `_sort_key` gets a `coin_toss` case returning the stored/seeded ordinal; it must be **last** (a total order — nothing after it can tie).

### 14.3 Per-game order + sport-aware defaults

Store the order in `rules.by_leaf[leaf].tiebreakers` (frozen, alongside §13's `scoring`). `compute_standings` resolves **leaf tiebreakers → tournament `rules.tiebreakers` → DEFAULT**. `points` stays the implicit primary sort (teams are tied on points *first*, then the list breaks it — matches the owner's "same match points → then…"). Sport-aware default menus:
- **set sports** → `["points","head_to_head","set_difference","point_difference","points_for","coin_toss"]` (the owner's hierarchy out of the box);
- **goal sports** → today's `["points","goal_difference","goals_for","head_to_head","name"]`.

The `head_to_head` mini-league must be **stage-scoped** so two stages sharing a `group_label` don't bleed into each other — already covered by §9.2's `compute_standings(stage_no=…)` kwarg.

### 14.4 UI + resolution UX

A **drag-to-reorder** criteria list in each game's Scoring section (the menu is sport-aware; `coin_toss` is pinned last and non-draggable). Writes via **`update_settings`** (frozen-rules path, same as §13). In the control room / standings, when teams remain tied after all computable criteria, a referee **"Resolve by draw"** action records the order (audited); until then the standings show the seeded provisional order with a "decided by draw — pending referee" note.

### 14.5 Test focus

Point-aggregate sums from `set_scores` (incl. voided-set handling); leaf → tournament → default precedence; `head_to_head` correctness under the `stage_no` scope; `coin_toss` determinism in preview (seeded, reproducible) + manual override path + audit row; freeze gate on the tiebreaker edit; multi-tenancy; idempotency.

---

## 15. Increment plan addendum — scoring & tiebreakers (orthogonal to stages)

These two ship **independently of Increments 0-6** (no `draw_config`/stages dependency; pure `rules` + `standings`/`set_scoring`). They're directly useful for the Dimapur TT/Sepak event, so they can land early or interleave. Same mandatory test axes (state-machine where relevant, multi-tenancy, idempotency).

**Increment 7 — Per-game scoring rules.** `rules.by_leaf[leaf].scoring` in `DEFAULT_RULES` + `merge_rules` whitelist + `update_settings` validation; `rules_for_match` leaf precedence; format-card **Scoring** section writing via `update_settings` (frozen-rules amend UX). *Test:* game>sport>profile precedence; deuce/cap unchanged; goals-override; freeze gate; multi-tenancy; idempotency.

**Increment 8 — Per-game tiebreakers + coin toss.** Point aggregates from `set_scores` into standings rows + `point_difference`/`points_for`/`points_against` + `set_difference`/`sets_for` aliases in `_sort_key`; `coin_toss` terminal criterion (seeded preview + audited manual `tiebreak_resolution`); `rules.by_leaf[leaf].tiebreakers` + `compute_standings` precedence + sport-aware defaults; drag-to-reorder UI; "Resolve by draw" control-room action. *Test:* aggregate sums; precedence; h2h under `stage_no`; coin determinism + override + audit; freeze; multi-tenancy.

> **Build-order note (owner chose "everything together after review"):** Increment 0 (hash canonicalizer) is the non-negotiable first merge. Increments 7-8 are the safest (no hash/stage risk) and immediately useful, so they're a sensible *first visible* win; Increments 1-6 (stages + bracket) follow the dependency chain (0 → 1 → 2 → 3 → {4,5} → 6).
