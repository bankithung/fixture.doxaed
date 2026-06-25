# Fixture engine — "best possible" upgrade (design)

**Date:** 2026-06-25 · **Status:** **P1–P6 shipped & live; P7 (adversarial review + hardening) done.** All of R1–R14 are now ✅. · **Branch:** `restructure-foundation`

Driver: make the engine able to model **and optimally schedule** the *Dimapur District
Catch Them Young U-14 Sepak Takraw + Table Tennis Tournament* (and generalise to 10–20+
sports), then make it the best-possible FET-style generator. Produced from a 24-agent
verify+research workflow (see decisions log at bottom).

## Target tournament (the concrete acceptance case)

- **Table Tennis** — single-elimination knockout. Tree 4 levels deep:
  `sport > category > gender > discipline`. 8 leaves
  (`table_tennis.u_14.boys.singles` … `table_tennis.open_category.girls.doubles`).
- **Sepak Takraw** — group stage → knockout (FIFA-style). 2 leaves
  (`sepak_takraw.u_14.boys`, `sepak_takraw.u_14.girls`).
- 2 courts per sport; up to 2 concurrent matches per sport. N teams per Sepak leaf
  (11, 12, any N) → groups. Two match days. Per-category breaks. Cross-sport gender
  clash (TT-Girls ⇎ Sepak-Girls). Round-wise rotation fairness. Elastic live re-timing.
  Reserve days for rain. Live public scores + group tables + brackets.

## Baseline (2026-06-25, this Linux box)

`backend/.venv/bin/python -m pytest -c backend/pyproject.toml backend/apps -q` →
**1192 passed, 14 failed.** The 14 are pre-existing and NOT regressions:
- 13 `sadmin` failures — known Django/Py3.14 env bug (see memory `sadmin-py314-test-failures`).
- 1 `test_sports_registry::test_generated_team_form_pins_roster_bounds_and_validator_enforces`
  — pre-existing product bug (`KeyError: 'min_items'` in roster-bounds form generation),
  unrelated to the fixture engine. Out of scope unless owner asks.

**Contract for this work:** every increment keeps the failing set at exactly these 14
(no new failures), `type-check` clean, committed per verified increment. Dev DB only — no
prod data, prod migrations, or deploy without explicit owner go-ahead.

## Gap matrix (R1–R14)

| # | Requirement | Status today | Action |
|---|---|---|---|
| R1 | Arbitrary-depth tree (TT 4-deep, Singles/Doubles) | ✅ full (`MAX_DEPTH=6`) | — |
| R2 | Per-leaf format coexistence | ✅ full (`views.py` dispatch) | — |
| R3 | Group stage for arbitrary N (sizing, pots, best-thirds) | ✅ **SHIPPED P4** (`balanced_group_sizes`, snake pots, balance_groups) | done |
| R4 | 2 courts/sport, K-court concurrency | ✅ full (`venue_counts`, `official_capacity`) | doc convention (P6) |
| R5 | Cross-competition clash | ✅ full (`no_concurrent_competitions`) | gender auto-gen (P6) |
| R6 | Per-category break/rest | 🟡 team-rest yes; no court changeover | **P6** |
| R7 | Round-wise rotation fairness | ✅ **SHIPPED P1** (`fairness_order`, `rotation_fairness` soft rule) | done |
| R8 | Multi-day packing, min idle | ✅ **SHIPPED P3** (optimizer soft-score: spread + placement) | done |
| R9 | Per-category constraint config | 🟡 constraints full; draw-config has no sport layer | **P6** |
| R10 | Scale 10–20+ sports, no per-sport code | 🟡 no-per-sport-code ✅; scale unproven | **P7** |
| R11 | Elastic live re-timing | ✅ **SHIPPED P2** (`started_at`/`ended_at`, `reflow_from_actual`, wizard opt-in) | done |
| R12 | "Best fixture possible" optimisation | ✅ **SHIPPED P3** (`optimizer.py`: local + CP-SAT, validator-gated) | done |
| R13 | Live scores + charts (bracket) | ✅ **SHIPPED P5** (public live scoreboard + per-leaf bracket, SSE-live) | done |
| R14 | Reserve days + rain repair | ✅ full (`shift_day`) | test (P7) |

## Build tracks

### P1 — R7 rotation fairness (scheduler.py, constraints.py)
- New pure `fairness_order(matches)`: for round-robin-eligible matches (`stage != "knockout"`
  and both teams resolved), produce a sequence that prioritises **least-played** teams, then
  **longest-rested** (avoid back-to-back), then `(round_no, match_no)` for determinism —
  Suksompong asynchronous round-robin. Knockout/unresolved matches keep round order and are
  sequenced after group matches (knockout depends on group completion).
- Replace the `sorted(matches, key=(round_no, match_no))` placement key (`scheduler.py:919`)
  with the fairness rank. Default-on (the generator's round order is arbitrary; fairness
  strictly improves rest).
- Add soft catalog type `rotation_fairness` (scopes all/sport/leaf) → extra `preference()`
  term rewarding rest-since-last-match, so it's tunable per category.
- Test: guaranteed-minimum-rest assertion for an odd group on limited courts vs naive order.

### P2 — R11 elastic live re-timing (matches/models.py, state.py, repair.py)
- Add `started_at`, `ended_at` to `Match` (**migration must land before any tournament goes
  live** — PRD §5 blocks migrations while live). Stamp in `transition_match` on SCHEDULED→LIVE
  and terminal COMPLETED/WALKOVER/ABANDONED.
- Generalise `delay_match` → signed/bidirectional **elastic re-timer**: pull-earlier on early
  finish (clamped so a match never starts before its advertised time), push-later on overrun;
  cascade widened beyond same-venue to matches coupled by clash groups + the concurrency cap
  (reuse `validate_schedule`). Frozen-zone/time-fence (don't move LIVE/locked or imminent
  matches). Stability gate (ignore drift < the per-category break). Auto-trigger on commit;
  speculative apply only on zero hard violations, else a control-room "suggested re-time" card.
- Tests: early pull-up + late push-back incl. cross-court clash.

### P3 — R12/R8 CP-SAT optimiser (scheduler.py, pyproject.toml)
- OR-Tools CP-SAT backend behind the existing `schedule_matches(matches, cfg, preoccupied,
  linked) -> ScheduleResult` signature; greedy kept as the fast default/fallback. Intervals per
  expanded sub-venue → `AddNoOverlap`; team rest → spacing; per-day + concurrency caps →
  `AddCumulative`; clash groups → shared resource. Objective = idle/makespan + soft-window +
  day-spread + R7 guaranteed-rest + rest-difference fairness. Interim wins independent of CP-SAT:
  idle/makespan term in `_score_soft` + most-constrained-first greedy ordering.

### P4 — R3 auto group-sizing + pots (generate.py, draw_config.py)
- `select_group_plan(N)` → balanced partition (sizes differ ≤1, prefer 4>3>5; N=11→4,4,3).
  Pots model before snake distribution; surface `group_count`/`pots` in `DEFAULT_DRAW_CONFIG` +
  `_validate_layer`. "No two same-institution teams in one group" draw constraint (reuse
  `_separate_by_key`). Pin group-of-3 final round simultaneous (anti-collusion) + UI warning.

### P5 — R13 public live bracket + scoreboard (fixtures/views.py, BracketView.tsx, …)
- Public `AllowAny` bracket endpoint + resolved source labels ("Winner of QF1", "Group A #2")
  on the public schedule payload. Public bracket route on `useEventStream`. Replace BracketView's
  hardcoded football `computeStandings` with server `StandingsGroup`; advance/eliminated banding +
  best-third markers + tiebreaker tooltip; FLIP rank animation (prefers-reduced-motion). Wire
  `LiveViewerPage` to WS/SSE instead of 5s poll. a11y (aria-live, semantic bracket) + `t()`.
  Throttle/connection-limit on the AllowAny SSE.

### P6 — R9/R5/R6 ergonomics (draw_config.py, constraints.py, ClashesSection.tsx, …)
- Sport-level `draw_config` layer between `*` and leaf (one write → all 8 TT leaves knockout).
  Gender-aware auto-clash proposal grouping leaves by shared gender token. Per-leaf "break between
  matches" field → `min_rest_minutes` scope:leaf + optional `match_buffer_minutes` court-changeover
  constraint applied as an extra gap in `feasible()`. Document "one venue per sport (count=2)".

### P7 — cross-cutting hardening + final review + verify
- Freeze-gate decision for `update_draw_config` (invariant 7 vs 10). `apply_schedule` idempotency
  check. Multi-tenancy isolation tests for public SSE/schedule/standings/bracket (404 not 403).
  Scale/perf check of greedy `build_slots` at 20-sport scale. i18n/a11y sweep of new surfaces.
  Full adversarial code-review of the branch; full suite + type-check green; browser verify on dev
  with the `kikonbankithung@gmail.com` test account. Prod deploy gated on explicit owner go-ahead.

## Decisions log
- 2026-06-25: Plan accepted (owner: full end-to-end, all tracks, production-grade, proper tests +
  review, **no prod data touched**). Engine already models the target tournament; the work is
  fairness (P1), elastic re-timing (P2), optimisation (P3), and the FIFA/UX/ergonomics polish.
- P1 fairness ordering is **default-on** (the generator's round order is arbitrary; fairness is a
  strict improvement) and additionally **tunable** via the `rotation_fairness` soft constraint —
  satisfies "data-driven, per-category, no per-sport code".
- P2 `Match` migration is the one schema change; it must be applied while the target tournament is
  still `registration_open` (not yet live). **Shipped**: migration `0010`, `reflow_from_actual`
  opt-in via `scheduling_config.auto_reflow`; `apply_schedule` reflects the actual end time on
  same-court downstream matches only when zero hard violations (else no-op).
- P3 optimiser is **validator-gated, not a CP-SAT rewrite**: greedy stays the seed; a proposal
  (local hill-climb default, or CP-SAT via `optimize_engine="cpsat"`) is adopted only when
  `validate_schedule` (+ an `official_capacity` peak-concurrency check) finds zero hard violations
  AND soft ≥ the seed. Worst case == today's greedy. Single-match constraints are enforced at
  candidate generation; pinned matches are frozen (validator doesn't re-check pin *times*).
  OR-Tools `9.15.6755` imports + solves CP-SAT on Python 3.14; `ortools>=9.12` is a declared dep,
  lazy-imported so absence silently falls back to local search. Off by default (`optimize=false`).
- P4 balanced grouping is **opt-in** (`balance_groups`, default off for back-compat) but the format
  board turns it ON by default for a fresh `groups_knockout` pick. `group_size` becomes the TARGET;
  `ceil(n/target)` even groups (snake seeding already did pots + balance).
- P5 public live scoreboard + bracket reuse the EXISTING public schedule endpoint + SSE tick stream
  (zero new backend); the bracket reuses the admin `BracketView` (set-sport winners fall out of
  `home/away_score` = sets-won). New routes `/t/:slug/:id/{live,bracket}`.
- P7 ran a 5-reviewer + per-finding-verifier adversarial review of the session's code; it found
  **9 real defects** (2 HIGH in the optimizer, 1 HIGH + 1 MED in reflow, 1 MED preview, 4 low/i18n/a11y),
  all fixed + regression-tested. The keystone fix: `validate_schedule` (the optimizer's safety gate)
  was blind to **scoped** hard `min_rest_minutes`/`max_matches_per_team_per_day` — it now shares ONE
  resolver (`effective_rest_gap`/`effective_day_cap`) with the greedy, so the "worst case == greedy"
  guarantee actually holds. Reflow is now day-scoped + drift-capped (`_REFLOW_MAX_DRIFT=480`).
