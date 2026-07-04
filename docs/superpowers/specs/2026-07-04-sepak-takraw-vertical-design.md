# Sepak Takraw Vertical Design

**Date:** 2026-07-04 · **Provenance:** Opus 4.8 design agent (gate-passed; grounded in the fact-checked sport dossiers + code map with file:line anchors). Build blueprint for the sport-first master plan.

## Architectural stance

Ship on the EXISTING set-scoring spine, do not fork the chassis. `set_scoring.py::rules_for_match` (set_scoring.py:121), `Match.set_scores` with sets-won mirrored into `home/away_score` (models.py:93-96), and the write-path fork in `RecordScoreView` (views.py:358-402: `update_set_progress` for live taps, `record_set_result` for completion) already deliver correct sepak scoring and standings today. The sepak work is 90% READ/PRESENTATION plus a rally-annotation event layer; only ONE schema migration (a nullable `positional_role` on `LineupEntry`) is unavoidable.

Critical seam to exploit: `record_match_event` (events.py:114-119) already REJECTS goal-type scoring events for set sports but ALLOWS non-scoring events and SKIPS `recompute_score`. So a full digital-scoresheet vocabulary (serve, fault, ace, kill, block, timeout) can be `MatchEvent` rows that ANNOTATE the match without ever touching the `home/away_score` mirror. The score of record stays `set_scores`; the event log is the scoresheet. This keeps invariant #4 intact for football while giving sepak a federation-grade paper-equivalent scoresheet.

## 1. Rules (two regimes already expressible)

The two-regime problem is largely SOLVED by the current schema: `_validate_scoring` (rules.py:88-112) accepts `{best_of, points, win_by, cap, deciding{points,win_by,cap}}`, and `compute_sets` (set_scoring.py:160) applies the `deciding` block exactly when `home_sets==away_sets==need-1`. The seeded `sepak_takraw` profile (set_scoring.py:53-60) already encodes LEGACY: sets 1-2 to 21/win2/cap25, decider 15/win2/cap17. ISTAF-2024 is a one-line override: `{best_of:3, points:15, win_by:2, cap:17, deciding:{points:15,win_by:2,cap:17}}`. Deliver both as named presets in the settings UI; confirm the Aug 29 regime before generating fixtures.

NEW rule vocabulary (whitelist widening required):
- `serve` sub-block inside `scoring`: `{serves_per_turn: 3|1, alternate_every_point: false|true, change_ends_at:{regular:11, deciding:8}}`. Add `serve` to the accepted-keys set at rules.py:100 with a `_validate_serve`. Rides the invariant-7 freeze gate for free.
- `format` block per leaf: `{players_per_side:3, reserves_max:2, subs_per_set:2, timeouts_per_set:1, event_type:"regu"|"doubles"|"quad"|"team"}`. Widen the `by_leaf` whitelist (rules.py:134, currently only `scoring`/`tiebreakers`) to also accept `format` and `discipline`. This is the largest rules change.
- Team-event composite (a tie = 3 regus, win 2 of 3) is a NEW parent entity above `Match` (models.py:52 is single home-vs-away). This is structural, not config. DEFER past Aug 29: run the Regu event (one match = one tie) first; add the composite in a later increment.

## 2. State machine (sport-gate the football phases)

`ALLOWED_TRANSITIONS` (state.py:28-39) exposes `LIVE->HALF_TIME` for all sports and `transition_match` (state.py:83-101) hardcodes `first_half`/`second_half`/`half_time`. Fixes (no migration):
- In `transition_match`, when `rules_for_match(match) is not None`, reject `to_status==HALF_TIME` (`no_half_time_for_set_sport`) and stamp `current_period="set_1"` on LIVE. The console already hides half-time client-side (MatchConsolePage:372); this closes the API hole.
- `WALKOVER_SCORE=3` (state.py:51) produces an illegal set tally. Parameterize `_stamp_walkover` (state.py:195) by `need = best_of//2+1` so a set-sport walkover stamps `2-0`, not `3-0`.
- `current_period` for display becomes "Set N" derived client-side from `set_scores.length` (`setDisplay.liveSetView` already computes `setNo`, setDisplay.ts:46).

## 3. The regu-aware console (largest deliverable)

Extract the monolith's `setBased` boolean (MatchConsolePage:369) into a `SepakConsole` component dispatched on `match.sport === "sepak_takraw"`. Reuse the debounced tap-save (`recordSetProgress`, MatchConsolePage:317-325) and completion (`recordSetScores`) verbatim. One-handed phone layout, thumb-reachable, `h-11` steppers already present:

- **Scoreboard**: big current-set points (existing `set-scoreboard` testid), set number, "Sets h-a" line. Default step=1 (rally point).
- **Serve indicator**: ball glyph on the serving side + "Serve: HOME (2 of 3)" from `descriptor.serve`. On each point the console auto-advances serve (2024: alternate every point; legacy: pass after 3). Serving side tracked via `SERVE` events + local state.
- **Fault/point palette** (replaces the yellow/red-only `SET_EVENT_BUTTONS`, :58): two big "Point HOME / Point AWAY" buttons each opening a reason chip (`service_fault`, `three_touch`, `net`, `out`). One tap BOTH bumps the running set (set-progress path) AND logs a `MatchEvent` with `detail:{reason, scoring_side}`. Stat buttons: `ACE`, `KILL`, `BLOCK` (scoresheet + leaders).
- **Change-ends banner**: score-triggered, dismissible, fires at `descriptor.serve.change_ends_at.regular` (11) in sets 1-2 and `.deciding` (8) in the decider. Pure client derivation from `set_scores` + descriptor.
- **Timeout**: 1 per regu per set; log `TIMEOUT`, show a `0/1` per-side counter that resets each set. Enforced client + server.
- **Substitution**: up to 2 per regu per set, re-entry allowed same set; `0/2` counter, positional roles.

Transport is unchanged: `recordEvent` takes a free-string `event_type` (views.py:415), `recordSetProgress` carries the points. Adding `MatchEventType` choices (SERVE, ACE, SERVICE_FAULT, FAULT, LET, TIMEOUT, SPIKE, KILL, BLOCK) is a state-only migration (CharField choices, no DB schema change).

## 4. Lineup / regu management

`Lineup`/`LineupEntry` exist with `role` (starter/substitute) + `shirt_no` (models.py:214-238). Add a nullable `positional_role` CharField (`tekong`/`left_inside`/`right_inside`) — the ONLY real migration; gate on prod approval. Validate roster size against `format.players_per_side` (regu=3, doubles=2, quad=4). "One regu per tie" is a configurable constraint validated at lineup submission (default on), deferred with the team composite.

## 5. Standings & leaders

Standings tiebreakers need NO new tokens: the whitelist (rules.py:61-65) already carries `wins`, `set_difference`, `point_difference`, `points_for`, `points_against`. Sepak cascade = `by_leaf[leaf].tiebreakers = ["wins","set_difference","point_difference"]` (match wins → set ratio → point ratio). Net sport cannot draw, so `points.draw` is inert. Standings TABLE columns (OpsStandingsPage hardcodes GF/GA/GD + W/D/L) need a set-sport variant: P, W/L, Sets W-L, Points For-Against, Pt Diff, Pts — branch on `scoring.type`, frontend-only.

Leaders: `top_scorers` (leaders.py:35-56) is goal-only and renders empty for sepak. Add a set-sport branch deriving Best Server (ACE/serve points), Best Spiker (KILL count + kill%), Best Blocker (BLOCK count), and a composite MVP from the new event rows — exactly how `top_scorers` counts GOAL rows. These auto-nominate awards. Fix the badge key mismatch: `catalog.py:28` keys params on `"sepaktakraw"` but `Match.sport` is `"sepak_takraw"`; normalize to `sepak_takraw` (or normalize in the engine's `_sport_of`) so `lockdown_match` thresholds stop silently no-op'ing for the flagship sport.

## 6. Officials

`MatchOfficialRole` (models.py:350) has referee/assistant/fourth/umpire/commissioner. Add `LINESMAN` (choices migration, no schema change) and a sepak crew template pre-filling Court Referee, Match Referee, Assistant Match Referee, 2 Linesmen, Scorer (`Match.scorer` seat).

## Descriptor shape (extend SPORT_PROFILES, ship in snapshot)

`live/views.py:97` already ships resolved `scoring`; extend to ship the full descriptor so the frontend renders data-driven, not hardcoded:
```
sepak_takraw: {
  scoring:{type:"sets",best_of:3,points:21,win_by:2,cap:25,
           deciding:{points:15,win_by:2,cap:17}},
  serve:{serves_per_turn:3,alternate_every_point:false,
         change_ends_at:{regular:11,deciding:8}},
  period_model:"sets",
  roster:{positional_roles:["tekong","left_inside","right_inside"],
          players_per_side:3,reserves_max:2,subs_per_set:2,timeouts_per_set:1},
  crew:["court_referee","match_referee","assistant","linesman","linesman","scorer"],
  duration_minutes:45, venue_type:"indoor_court" }
```
Rally point `MatchEvent.detail`: `{reason:"three_touch"|"net"|"out"|"serve_fault", scoring_side:"home"}`.

## Increment plan (tests-first)

1. Backend, no migration: lock legacy/2024 presets; gate HALF_TIME for set sports; fix walkover set tally; fix badge `sepak_takraw` key. Tests: state-machine (half_time blocked), walkover tally, both-regime + deciding-set compute.
2. Choices migration: MatchEventType additions + LINESMAN; extend descriptor + ship in snapshot. Tests: annotation events never touch the mirror; descriptor payload.
3. Rules: widen `scoring.serve` + `by_leaf.format/discipline` whitelists. Tests: validation accept/reject, freeze gate.
4. Frontend: SepakConsole (serve indicator, fault palette, change-ends, timeout/sub counters). Vitest.
5. Standings columns + sport-aware leaders/awards. Tests.
6. Lineup `positional_role` migration + regu roster validation. (Team composite deferred.)

## Key decisions

- Build on the existing set-scoring spine (set_scoring.py rules_for_match + set_scores mirror + record_set_result/update_set_progress); do NOT fork the Match model or chassis.
- The rally/serve/fault scoresheet is a MatchEvent ANNOTATION layer: set sports already reject goal-scoring events and skip recompute_score (events.py:114-119), so score-of-record stays set_scores and invariant #4 holds for football.
- The two-regime problem (legacy 21/25 with a distinct 15/17 decider vs ISTAF-2024 all-sets 15/17) is already expressible via the existing scoring.deciding block; ship both as named presets, confirm regime before fixture generation.
- Sport-gate the football state machine: reject LIVE->HALF_TIME when rules_for_match is non-null and stamp current_period='set_N'; derive the display set number client-side from set_scores length.
- Fix WALKOVER_SCORE=3 by parameterizing _stamp_walkover with need=best_of//2+1 so set-sport walkovers stamp a legal 2-0 tally.
- Ship a per-sport descriptor (serve rotation, change-ends triggers, roster/positional roles, crew, period model) inside SPORT_PROFILES and on the live snapshot (live/views.py:97 already ships resolved scoring) so the console renders data-driven, not hardcoded.
- Extract the console's setBased boolean into a SepakConsole dispatched on match.sport, reusing the existing debounced tap-save and set-completion mutations; point-winning faults do one tap = bump set-progress + log the reason event.
- Standings need NO new tiebreaker tokens: reuse wins/set_difference/point_difference from the existing whitelist as the per-leaf sepak cascade; only the standings TABLE columns and Leaders board need a set-sport branch.
- Only one real migration is required: a nullable LineupEntry.positional_role (Tekong/Left Inside/Right Inside); MatchEventType and MatchOfficialRole additions are choices-only (no DB schema change).
- Fix the badge sport-key mismatch (catalog.py keys 'sepaktakraw' but Match.sport is 'sepak_takraw') so lockdown_match thresholds stop silently no-op'ing.
- Defer the Team-event composite (a tie = 3 regus, win 2 of 3) and its 'one regu per tie' constraint past Aug 29; run the Regu event (one match = one tie) first since the composite is a structural parent above Match, not config.
- Add sport-aware leaders/awards (Best Server, Best Spiker with kill%, Best Blocker, MVP) derived from the new ACE/KILL/BLOCK event rows exactly as top_scorers derives from GOAL rows.

## Risks

- Team-event composite (3-regu tie) is a genuine structural gap above the single home-vs-away Match model; if the Aug 29 tournament requires Team events, the timeline is at risk and the composite must be scoped in before fixtures generate.
- The point-scoring-fault UX couples two writes (set-progress bump + annotation event) that are not transactional across endpoints; a partial failure could desync the scoresheet from the score. Need idempotent event_ids and a reconcile-on-refetch fallback.
- Serve rotation is stateful (serves_per_turn, alternate-every-point, block-of-3) and easy to get wrong on undo/void; without deriving serving side deterministically from the event log it will drift after corrections.
- current_period is stamped by transition_match but update_set_progress does not advance it; 'Set N' must be derived client-side from set_scores length or the two sources diverge.
- positional_role migration touches the LIVE prod DB and is blocked while any tournament is live; must be sequenced and approved before Aug 29 go-live, not on match day.
- Widening the by_leaf whitelist (format/discipline) and scoring.serve interacts with the invariant-7 freeze gate; a mis-timed edit after registration_open would need the amend+reason path, which organizers may not expect.
- Confirming the actual competition regime (legacy 21/25 vs ISTAF-2024 15/17, and serves_per_turn) is a hard external dependency; generating fixtures under the wrong regime mis-sizes slots and mis-scores sets.
- Leaders/awards depend on umpires actually logging ACE/KILL/BLOCK events courtside; if crews only tap points, the sport-specific awards render empty and the 'federation-grade' bar is missed for stats even though scoring is correct.
