# Sport Leaders Catalog — per-sport leaderboards, stats, and awards

**Date:** 2026-07-04 · **Provenance:** Opus 4.8 research agent (sources: Opta stat definitions, Premier League boards, FIFA World Cup awards, ITTF Handbook group-ranking 3.7.5/3.7.6, ISTAF LotG + Best Tekong/MVP award conventions; all code claims anchored file:line and verified against `leaders.py`, `models.py`, `events.py`, `standings.py`, `set_scoring.py`). Commissioned on the owner's direction: "even the leaderboard will be different for different matches... all types of individual stats, scorers, winners, leaderboards — not just individual but even the team." Fills `SportDefinition.leaderboards` + `award_templates` (master plan P1) and fixes confirmed finding N7 (goal-only boards, cross-sport pooling — `leaders.py:20-81`).

## The generic LeaderboardSpec

```python
@dataclass(frozen=True)
class LeaderboardSpec:
    key: str                       # "top_scorers"
    label: str                     # i18n key
    subject: Literal["player", "team", "regu", "pair"]
    metric: str                    # named-reducer DSL, registry-resolved (never eval)
    source: Literal["events", "standings", "matches", "lineups", "mixed"]
    sort: Literal["desc", "asc"]
    fmt: Literal["int", "pct", "ratio", "per_match", "decimal"]
    min_qualifier: dict | None     # {"matches_played": 3}
    tier: frozenset                # {"federation", "school"}
    feasibility: Literal["today", "annotation", "new_tracking"]
    default_on: frozenset          # tiers shipping it enabled
```

Reducers: `count(GOAL|PENALTY_SCORED, per=player)`, `count(related_player on GOAL)`, `sum(standings.GF)`, `ratio(GF, GA)`, `count(ACE, per=player)`… `compute_leaders` iterates `definition.leaderboards` **scoped per sport + leaf** (the N7 fix). Subject nuance: TT singles/doubles entrant Team IS the player/pair (`subject="team"`, display hint `pair`); regu = a team with a 3-player roster; true per-athlete boards need player-tagged annotation events.

Feasibility: `today` = current events/standings suffice · `annotation` = needs the planned point/action annotation events (point-by-point scoring) · `new_tracking` = new field/entity/vote.

## Football

**Individual:** top_scorers (GOAL+PENALTY_SCORED, today, both tiers) · top_assists (GOAL.related_player or ASSIST, annotation) · goal_contributions (annotation, fed) · discipline (3·red+yellow asc, today) · top_saves (SAVE exists unwired — annotation) · save_pct (new_tracking: needs GK identity on LineupEntry) · minutes (annotation via SUBSTITUTION + lineup) · MOTM (judged, needs vote entity).
**Team:** best_attack (GF) · best_defence (GA asc) · clean_sheets (GA=0 matches) · fair_play (FIFA points: -1/-3/-4/-5, most-severe-per-player) · form (last 5) · goal_diff — all `today`.
**Awards:** Golden Boot computed (goals → assists → fewer minutes → shared); Golden Glove judged (proxy: clean sheets + save%); Golden Ball judged; Fair Play computed.
**Default ON:** federation = scorers, assists, discipline, attack, defence, clean_sheets, fair_play · school = scorers, attack, defence, clean_sheets, fair_play.

## Table tennis (subject = entrant team/pair)

**Boards:** match_wins (today) · win_pct (today) · game_ratio ratio(GF,GA) (today) · point_ratio ratio(PF_pts,PA_pts) (today, fed) · deuce_record (from set_scores, today, fed) · pts_on_serve (POINT.served_by, annotation, fed) · aces (ACE, annotation, fed).
**Team ties:** tie_wins · rubber_ratio · game/point ratios (today).
**Standings change required:** ITTF group scoring = 2 win / 1 played loss / 0 walkover; ties over the tied-members mini-table by ratio of wins:losses in matches → games → points (Handbook 3.7.5/3.7.6) — the `ratio_games`/`ratio_points` comparator family standings lacks (`standings.py:19-34`).
**Awards:** event winners computed; MVP judged; fair play computed.
**Default ON:** federation = match_wins, win_pct, game_ratio, point_ratio · school = match_wins, win_pct, game_ratio.

## Sepak takraw

**Individual (annotation + positional_role):** service_aces (ACE) · kills (KILL) · blocks (BLOCK, fed) · kill_pct (fed) · feeds (KILL.related_player or FEED, fed).
**Team/regu:** wins · set_ratio · set_difference · point_ratio (all today) · service_points (annotation) · discipline (today).
**Awards (ISTAF/STL conventions):** MVP, Best Tekong, Best Feeder, Best Killer/Striker, Best Blocker — all judged with computed proxies (aces / feeds / kills / blocks); best regu place-based.
**Default ON:** federation = wins, set_ratio, point_ratio, aces, kills, blocks · school = wins, set_ratio, point_difference ONLY (ace/kill/block boards hidden unless the leaf opts into detailed scoring).

## School-tier pragmatics

Volunteer tap-scoring yields only results + set scores, so school defaults are the `today` boards; every `annotation` board gates behind a per-leaf "detailed scoring" toggle and hides when off — a sepak match must never show "No goal scorers yet." Judged awards surface as operator-filled entries with a computed-proxy suggestion.

## Event-vocabulary verdict

Planned set (SERVE, ACE, SERVICE_FAULT, KILL, BLOCK, POINT) + `related_player` reuse + existing SAVE covers the whole catalog. Optional additions only: `ASSIST` (cleaner than GOAL.related_player), `FEED` (only if Best Feeder must be computed). Non-event work: (a) ratio comparators + ITTF 2/1/0 group points; (b) GK/position flag on LineupEntry (per-keeper boards); (c) the judged-award/vote entity (already deferred in the master plan).

Key anchors: `leaders.py:20-81` (N7), `models.py:27-43,144-160,214-238`, `events.py:95,114-119,162,165-166` (annotation seam), `standings.py:19-34,216-234`, `set_scoring.py:33-71`.
