# Table Tennis Vertical Design

**Date:** 2026-07-04 · **Provenance:** Opus 4.8 design agent (gate-passed; grounded in the fact-checked sport dossiers + code map with file:line anchors). Build blueprint for the sport-first master plan.

## 1. Chassis vs TT module

Today the only sport fork is the boolean `setBased = match.scoring?.type === "sets"` (MatchConsolePage.tsx:369) and the binary `isSetSport` (setDisplay.ts:21-23). The TT vertical promotes that fork into a **sport-module registry** keyed on `match.sport`. The shared chassis keeps: `MatchEvent` log + gapless `sequence_no` (models.py:288-347), idempotent writes (event_id), `Match.set_scores` + `home_score/away_score` = games won (models.py:86-96), the `rules_for_match` resolver (set_scoring.py:121), the serializer `scoring` field (serializers.py:33-40), and SSE/WS fan-out. TT supplies four things through the registry: {Scoreboard, ActionPalette, PeriodModel, score-derivation strategy}. Backend home: extend `SPORT_PROFILES` (set_scoring.py:33) with a `descriptor` block (period_model, event_palette, allowed_transitions, leaders_strategy); frontend home: a `sportModules[match.sport]` map that `setDisplay.liveSetView` generalizes into.

## 2. Point-by-point events + score derivation

TT ships a **rally-point event family** (the structural gap the dossier flags). New `MatchEventType` values (state-only migration, column unchanged): `POINT`, `LET`, `TIMEOUT`, `EXPEDITE_ON`, `PENALTY_POINT`, plus reuse `YELLOW_CARD` (warning, no point) and `PERIOD_START/PERIOD_END` for game boundaries. `RecordMatchEventView` already accepts a free event_type (views.py:405-419).

- `POINT`: `{team, player?, detail:{reason:"rally"|"penalty"|"forfeit", rally_returns?:int}}`. A **penalty point** (Law 3.5) is a `POINT` for the opponent with `reason="penalty"` — it affects the score exactly like a rally, no special path.
- `LET`: replayed rally, scores nobody (Law 2.9).
- A per-sport **score-derivation strategy** replaces `SCORING_EVENT_TYPES` (models.py:47) goal-counting: TT counts non-voided `POINT` events, segments them into games by the running rules (first to `points`, win by `win_by`, **cap MUST be null** — uncapped deuce, Law 2.11.1), and produces the `set_scores` projection `[[11,8],[9,11],...]` + games won. On every point `transaction.on_commit` writes that projection into `Match.set_scores`/`home_score`/`away_score` (mirroring `update_set_progress`, set_scoring.py:218) and publishes a `score` tick, so standings/public/advancement stay untouched. Undo = a `VOID` of the last `POINT` (existing undo path).

## 3. Live derivation (serve, ends, expedite, breaks) + scoresheet

Serve-turn is **event-derived, not stored** (dossier). A pure `tt_live_state(events, rules, scoresheet)` returns: current game index, `(home_pts, away_pts)`, games won, **who serves next** (alternate every 2 until 10-10, then every 1; every 1 under expedite — Law 2.13.3), **ends orientation** (swap every game; in the deciding game swap when a side first reaches 5, and in doubles the receiving order also switches at 5 — Laws 2.13.6/2.13.7), doubles striking order (S, R, S-partner, R-partner — Law 2.8.2, previous receiver becomes next server), and affordance flags: `toweling_break_due` (points 6/12/18…), `expedite_eligible` (game clock ≥ 10 min AND < 18 points scored, Law 2.15.2), `expedite_return_count` (13, Law 2.15.4).

Expedite needs a **per-game 10-minute clock** and a 13-return counter — genuinely new state that cannot reuse the football stopwatch (`useElapsedSeconds`, MatchConsolePage.tsx:129). The clock is derived from the first-point-of-game timestamp; the return counter is a transient console counter, optionally persisted as `POINT.detail.rally_returns`.

The **scoresheet artifact** (toss winner, first server, doubles first receiver, starting ends) lives in the log — the `PERIOD_START` event opening game 1 carries `detail:{toss_won_by, first_server:"home"|"away", first_receiver_player, ends:{home:"near"}, doubles_order:[...]}`. No schema migration.

## 4. Console UI (two modes, one-handed)

The TT console renders inside `AppShell` with existing tokens, Inter/semibold, tabular numerals, no dashes. **Umpire mode (point-by-point)**: two full-height tap zones (home left, away right), each a huge `h-16+` button that scores a rally to that side; between them a dominant `(server_pts - receiver_pts)` readout with **server's score called first** and a serve indicator dot on the serving side (a TT umpire must feel this was built for TT). A slim bottom action bar holds Let, Timeout (disabled once that side's 1 timeout is spent), Expedite (highlighted when `expedite_eligible`), Yellow, Penalty point, and Undo. A thin games strip shows finished game chips + "Game N". Change-ends and deciding-game 5-point switch fire a full-width prompt banner. **Set-total mode** reuses today's stepper editor (MatchConsolePage.tsx:654-823) for fast school scoring. Default mode = tournament `stat_tier` flag (federation → umpire; school → set-total); the umpire can switch. Both modes converge on the same `set_scores`. States: scheduled (scoresheet/toss form) → live (scoring) → completed (TT scoresheet print). No half-time.

## 5. Rules editor + data shapes

Per-leaf/per-stage scoring already flows through `rules.by_leaf[leaf].scoring` (rules.py:41-48) validated by `_validate_scoring` (rules.py:88). TT editor writes `{type:"sets", best_of:<odd>, points:11, win_by:2, cap:null, deciding:null}` and **must hide the cap field** (null enforced). Best-of selector defaults: individual best-of-7 (first to 4), team-rubber best-of-5, school best-of-5/3, pool best-of-1; per stage via the multi-stage `stages` map. TT-specific config needs the rules whitelist to become **sport-scoped** (today `DEFAULT_RULES` is football-only, rules.py:18-49, and `merge_rules` rejects unknown keys): a `match` block for TT = `{doubles, timeouts_per_side:1, timeout_seconds:60, warmup_seconds:120, expedite_minutes:10, expedite_min_points:18, expedite_returns:13}`, `discipline:{warning_then_penalty_points:[1,2]}`, `third_place:bool`, and **no `draw`/`halves`/`extra_time`/`penalties`**. The editor is sport-conditional so a TT organiser never sees football halves/ET/draw fields (SettingsTab.tsx hardcodes them today).

## 6. Standings + ITTF ratio tiebreakers

Group points differ from football: **2 for a win, 1 for a played loss, 0 for a walkover/unfinished loss** (Reg 3.7.5), no draw. `compute_standings` (standings.py:165) must award loss points only to `COMPLETED` losses and 0 to `WALKOVER` losses — a real change to the loss branch (standings.py:223-228). New **ratio** tiebreaker tokens added to `_TIEBREAKERS` (rules.py:61) and `_sort_key` (standings.py:16): `ratio_matches`, `ratio_games`, `ratio_points` — each a won/lost RATIO (not the subtractive `goal_difference`/`point_difference` used today). They compute over the **mini-table among the currently-tied subset only** (extend `_apply_head_to_head`, standings.py:52, which already builds a tied mini-table but ranks by GD), applied successively and re-examined on residual sub-ties, final fallback `coin_toss`. TT default tiebreakers = `["points","ratio_matches","ratio_games","ratio_points","coin_toss"]`. Games won already mirror to `home_score/away_score`; raw point aggregation (`PF_pts/PA_pts`, standings.py:218-222) feeds `ratio_points`.

## 7. Leaders / awards

`compute_leaders` (leaders.py:15) is goal-only (top_scorers empty for TT). A **TT leaders strategy** builds: best win %, most games won, and (federation tier, from `POINT` events) points-on-serve vs receive, winners/errors, deuce/game-point conversion, longest rally. School tier stays minimal (W/L, games ratio). Badges: the `sports` tag already gates by family (catalog.py:8-12); add TT badges (e.g. "Clean sweep", "Deuce specialist") and retire Golden Boot for TT. Public `PublicLeaders` reads the sport descriptor instead of hardcoding "Top scorers".

## 8. Team ties (phased, first-class)

A team tie is an ordered list of rubber slots — a new grouping above `Match`. Model `MatchTie` {tournament, org, leaf_key, home_team, away_team, format, home_rubbers_won, away_rubbers_won, status}; each rubber is a `Match` with `sport=table_tennis`, a `tie` FK, `rubber_no`, `rubber_kind` (singles|doubles), its own best_of. `format = {rubbers:[{no,kind,best_of,nominate}], stop_at_wins, max_matches_per_player}`. Four presets are data instances: Olympic (3 players, 5 rubbers incl. doubles), 2026 Worlds (5 singles no doubles), Swaythling, Corbillon. When a side reaches `stop_at_wins`, remaining rubbers are marked **dead (not played)** — a `DEAD_RUBBER` terminal flag, never scored. This is the one true schema migration; individual TT ships first (Aug 29), team ties are phase 2.

## 9. State machine + walkover

TT needs a **per-sport transition table** (state.py:28) without `HALF_TIME`: scheduled→{live,walkover,postponed,cancelled}, live→{completed,walkover,abandoned,postponed,cancelled}. `transition_match` period stamping (state.py:83-101) is parameterized by the period model → stamps `game_1…game_n`, never `first_half`. `_guard_knockout_draw` (state.py:157) is sport-aware: a legally completed TT match always has a winner (best-of odd), so there is no shootout path. `WALKOVER_SCORE=3` (state.py:51) becomes sport-aware: a TT walkover mirrors games-won = `best_of//2+1` and writes legal `set_scores` (e.g. `[[11,0],[11,0],[11,0]]`).

## 10. Exactly what changes vs today's generic set console + rollout

Changed: replace the `setBased` fork (MatchConsolePage.tsx:369) with the sport-module registry; replace `SET_EVENT_BUTTONS` (only yellow/red/foul, :58-60) with the TT palette; delete client `setsWon` (:165-193) in favour of server-resolved games; make HALF_TIME rejection backend-driven (not the client filter :372-374); render `current_period` as "Game N" (:549-555); TT scoresheet print (:482-525); extend the live snapshot (live/views.py:95-97) with a `sport_view` descriptor (serve, ends, expedite, break-due, mode) so LiveViewer/VenueDisplay render TT with no hardcoding. Added: point event family + derivation strategy, expedite clock, ratio tiebreakers, TT leaders/badges, MatchTie. Incremental: (1) sport descriptor + registry + backend transition/period/walkover fixes (no migration); (2) point-by-point events + derivation + umpire console; (3) ratio tiebreakers + TT points; (4) leaders/awards; (5) team ties (migration). Tests-first per increment: point→game→match derivation table, serve/ends/deciding-game rotation table, expedite eligibility (10-min AND <18-point) edge, ratio-tiebreaker mini-table, walkover set tally, and the multi-tenancy isolation + freeze-gate suites the chassis already mandates.

## Key decisions

- Promote the setBased boolean (MatchConsolePage.tsx:369) into a sport-module registry keyed on match.sport; extend SPORT_PROFILES (set_scoring.py:33) with a descriptor block (period_model, event_palette, transitions, leaders/derivation strategy)
- Add a rally-point event family (POINT/LET/TIMEOUT/EXPEDITE_ON/PENALTY_POINT + PERIOD_START/END) to the MatchEvent log; RecordMatchEventView already accepts free event_type (views.py:405-419); state-only enum migration, no column change
- Score derivation becomes per-sport: TT counts non-voided POINT events into games and writes the set_scores projection + games-won on commit (mirroring update_set_progress, set_scoring.py:218) so standings/public/advancement are untouched
- cap MUST be null for TT (uncapped deuce, Law 2.11.1); the rules editor hides the cap field; best_of is a configurable odd integer per leaf/stage via rules.by_leaf[leaf].scoring (rules.py:41-48)
- Serve turn, ends swap, deciding-game 5-point switch, and doubles rotation are all derived by a pure tt_live_state(events, rules, scoresheet); serve-turn is never stored
- Scoresheet (toss, first server, doubles first receiver, starting ends) lives in the game-1 PERIOD_START event detail — no schema migration
- Two console modes: point-by-point umpire mode (each rally = a POINT event) and set-total mode (existing stepper editor); default by tournament stat_tier; both converge on set_scores
- One-handed courtside layout: two huge home/away tap zones, server-first score with serve indicator, slim bottom bar for let/timeout/expedite/card/undo
- TT group points = 2 win / 1 played-loss / 0 walkover-loss (no draw); standings.py loss branch must distinguish COMPLETED vs WALKOVER losses
- Add ratio tiebreaker tokens (ratio_matches/ratio_games/ratio_points) to _TIEBREAKERS (rules.py:61) and _sort_key (standings.py:16), computed over the tied mini-subset (extend _apply_head_to_head), not the subtractive GD used today
- Per-sport state machine: TT transition table without HALF_TIME; parameterize transition_match period stamping to game_N (state.py:83-101); sport-aware walkover replacing WALKOVER_SCORE=3 (state.py:51) with legal game tally
- Team ties are a first-class MatchTie grouping above Match (rubber slots + stop_at_wins + max_matches_per_player, dead-rubber flag) — the one real migration, phased after individual TT ships Aug 29

## Risks

- Rules whitelist is football-only (DEFAULT_RULES rules.py:18-49) and merge_rules rejects unknown keys — TT match/discipline/third_place config is blocked until DEFAULT_RULES becomes sport-scoped; highest-risk backend change
- Dead rubbers and MatchTie require a schema migration; migrations are blocked while any tournament is live (PRD S5) and run as fixture_owner on prod — must land before Aug 29 setup, not during
- Two-source-of-truth divergence: point-by-point derivation vs the set-total tap editor can disagree if an umpire switches modes mid-game; the point log must be authoritative and reconcile on switch
- Expedite needs a per-game 10-minute clock plus 18-point short-circuit and 13-return counter — new live state that cannot reuse the football stopwatch; clock derived from first-point timestamp is sensitive to clock skew and reconnect
- Ratio tiebreakers change competitive outcomes and are participant-facing, so they fall under the invariant-7 freeze gate; getting the successive mini-subset re-examination wrong silently mis-ranks qualifiers (same class of bug as the old head_to_head no-op)
- The badge sport-key mismatch (sepaktakraw vs sepak_takraw, catalog.py) shows the fragility of string sport keys; TT keys must be verified end to end or tuned params silently no-op
- Public/live surfaces (LiveViewer, VenueDisplay, PublicLeaders) hardcode football labels; without a sport descriptor on the snapshot they will show wrong period/leader vocabulary for TT
- Federation-tier stats (winners/errors, serve/receive, rally length) depend on the umpire tagging each POINT — realistic courtside one-handed input may only capture the rally winner, so stat richness must degrade gracefully by stat_tier
