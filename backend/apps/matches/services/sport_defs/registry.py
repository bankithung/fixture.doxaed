"""SPORT_DEFINITIONS — the single authoritative sport registry (P1).

`get_definition("")` and any unknown key resolve to FOOTBALL (goal-based
default), matching the platform's historic behavior for `Match.sport == ""`.
`SPORT_PROFILES` in set_scoring.py is DERIVED from this registry, so every
existing consumer (rules resolution, scheduler durations, venue types) reads
the same source of truth unchanged.
"""
from __future__ import annotations

from apps.matches.services.sport_defs.base import (
    TARGET,
    TIMED,
    LeaderboardSpec,
    SportDefinition,
)

# Boards ship per the 2026-07-04 leaders catalog: school-tier defaults are the
# "computable today" set only, so a set sport never renders football boards.
_GOAL_BOARDS = (
    LeaderboardSpec(key="top_scorers", label="Top scorers", subject="player",
                    metric="goals"),
    LeaderboardSpec(key="best_attack", label="Best attack", subject="team",
                    metric="scored"),
    LeaderboardSpec(key="best_defence", label="Best defence", subject="team",
                    metric="conceded", sort="asc"),
    LeaderboardSpec(key="clean_sheets", label="Clean sheets", subject="team",
                    metric="clean_sheets"),
)
_SET_BOARDS = (
    LeaderboardSpec(key="match_wins", label="Match wins", subject="team",
                    metric="wins"),
    LeaderboardSpec(key="set_ratio", label="Sets won-lost", subject="team",
                    metric="set_ratio", fmt="ratio"),
    LeaderboardSpec(key="point_diff", label="Point difference", subject="team",
                    metric="point_diff"),
)

FOOTBALL = SportDefinition(
    code="football", version=1, display_name="Football",
    period_model=TIMED, score_reducer="goal_sum", scoring=None,
    duration_minutes=100,  # 2x45 + interval/turnaround (youth: override)
    venue_type="ground",
    has_half_time=True, opening_period="first_half",
    terms={"score_unit": "Goals", "period": "Half"},
    leaderboards=_GOAL_BOARDS,
    console_blueprint={"family": TIMED},
    officials_roles=("referee", "assistant", "assistant", "fourth"),
)

VOLLEYBALL = SportDefinition(
    code="volleyball", version=1, display_name="Volleyball",
    period_model=TARGET, score_reducer="sets",
    scoring={"type": "sets", "best_of": 5, "points": 25, "win_by": 2,
             "cap": None, "deciding": {"points": 15, "win_by": 2, "cap": None}},
    duration_minutes=90, venue_type="indoor_court",
    has_half_time=False, opening_period="set_1",
    terms={"score_unit": "Points", "period": "Set"},
    leaderboards=_SET_BOARDS,
    console_blueprint={"family": TARGET},
    officials_roles=("umpire", "assistant"),
)

TABLE_TENNIS = SportDefinition(
    code="table_tennis", version=1, display_name="Table Tennis",
    period_model=TARGET, score_reducer="sets",
    # ITTF Law 2.11.1: 11 points, win by 2, deuce UNCAPPED (cap must be None).
    scoring={"type": "sets", "best_of": 3, "points": 11, "win_by": 2,
             "cap": None,
             # ITTF Law 2.13.3: service alternates every 2 points, then every
             # point from 10-10 (alternate_every_point = the deuce switch).
             "serve": {"serves_per_turn": 2, "alternate_every_point": True}},
    duration_minutes=30, venue_type="indoor_court",
    has_half_time=False, opening_period="game_1",
    terms={"score_unit": "Points", "period": "Game"},
    leaderboards=_SET_BOARDS,
    console_blueprint={"family": TARGET},
    officials_roles=("umpire", "assistant"),
)

SEPAK_TAKRAW = SportDefinition(
    code="sepak_takraw", version=1, display_name="Sepak Takraw",
    period_model=TARGET, score_reducer="sets",
    # LEGACY ISTAF regime (school convention): sets to 21 cap 25, deciding set
    # 15 cap 17. The ISTAF-2024 regime (all sets 15/17, single service) ships
    # as a named preset in P2 — the tournament picks (owner decision D1).
    scoring={"type": "sets", "best_of": 3, "points": 21, "win_by": 2,
             "cap": 25, "deciding": {"points": 15, "win_by": 2, "cap": 17},
             # Legacy service mechanics (ISTAF pre-2024): 3-serve blocks,
             # ends change at 11 (regular) / 8 (deciding). The ISTAF-2024
             # preset overrides all of this per tournament (D1).
             "serve": {"serves_per_turn": 3, "alternate_every_point": False,
                       "change_ends_at": {"regular": 11, "deciding": 8}}},
    duration_minutes=45, venue_type="indoor_court",
    has_half_time=False, opening_period="set_1",
    terms={"score_unit": "Points", "period": "Set"},
    leaderboards=_SET_BOARDS,
    console_blueprint={"family": TARGET},
    officials_roles=("referee", "assistant", "linesman", "linesman"),
)

BADMINTON = SportDefinition(
    code="badminton", version=1, display_name="Badminton",
    period_model=TARGET, score_reducer="sets",
    # BWF: every game to 21, win by 2, hard cap 30 (29-all -> next point wins).
    scoring={"type": "sets", "best_of": 3, "points": 21, "win_by": 2,
             "cap": 30, "deciding": {"points": 21, "win_by": 2, "cap": 30}},
    duration_minutes=45, venue_type="indoor_court",
    has_half_time=False, opening_period="game_1",
    terms={"score_unit": "Points", "period": "Game"},
    leaderboards=_SET_BOARDS,
    console_blueprint={"family": TARGET},
    officials_roles=("umpire", "assistant"),
)

SPORT_DEFINITIONS: dict[str, SportDefinition] = {
    d.code: d
    for d in (FOOTBALL, VOLLEYBALL, TABLE_TENNIS, SEPAK_TAKRAW, BADMINTON)
}


def _norm(key: str | None) -> str:
    return (key or "").replace("-", "_").strip().lower()


def get_definition(sport_key: str | None) -> SportDefinition:
    """The definition governing a sport key; ''/unknown = football (the
    platform's historic goal-based default for Match.sport == '')."""
    return SPORT_DEFINITIONS.get(_norm(sport_key), FOOTBALL)
