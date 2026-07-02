"""The badge catalog — every badge from the owner's 2026-06-29 list, mapped to
precise criteria with tunable params (nothing hardcoded in the evaluators).

Scopes:
- ``match``       awarded the moment a qualifying result lands
- ``streak``      awarded when N consecutive qualifying results land
- ``group``       awarded when a group's matches are all final
- ``competition`` awarded when every match of the leaf is final

``sports``: "sets" = set-scored matches only (TT, sepaktakraw, badminton,
volleyball), "goals" = goal-scored only (football), "any" = both.
"""
from __future__ import annotations

BADGE_TEMPLATES: dict[str, dict] = {
    # ------------------------------------------------ owner list, set sports
    "straight_set_win": {
        "name": "Straight Set Winner",
        "description": "Won the match without dropping a set.",
        "scope": "match", "subject": "team", "sports": "sets",
    },
    "lockdown_match": {
        "name": "Lockdown Match",
        "description": "Won while conceding very few points.",
        "scope": "match", "subject": "team", "sports": "sets",
        # Total points conceded across sets, per sport (owner's examples:
        # sepaktakraw 15-4/15-5 = 9; TT 11-3/11-5/11-4 = 12).
        "params": {"max_conceded": {"sepaktakraw": 10, "table_tennis": 13, "default": 12}},
    },
    "comeback_win": {
        "name": "Comeback Kings",
        "description": "Lost the opening set, then won the match.",
        "scope": "match", "subject": "team", "sports": "any",
    },
    "clean_sweep_streak": {
        "name": "Clean Sweep Streak",
        "description": "Consecutive wins without dropping a set.",
        "scope": "streak", "subject": "team", "sports": "sets",
        "params": {"streak": 2},
    },
    "perfect_run": {
        "name": "Perfect Run",
        "description": "Finished the group stage without losing a set.",
        "scope": "group", "subject": "team", "sports": "sets",
    },
    "group_dominator": {
        "name": "Group Stage Dominator",
        "description": "Won the group without losing a match, with the best point difference.",
        "scope": "group", "subject": "team", "sports": "any",
    },
    # ---------------------------------------------- owner list, any scoring
    "best_defence": {
        "name": "Best Defence",
        "description": "Least points conceded in the competition.",
        "scope": "competition", "subject": "team", "sports": "any",
        "params": {"min_matches": 2},
    },
    "point_difference": {
        "name": "Highest Point Difference",
        "description": "Best scored-minus-conceded in the competition.",
        "scope": "competition", "subject": "team", "sports": "any",
        "params": {"min_matches": 2},
    },
    # ------------------------------------------------- football analogues
    "golden_boot": {
        "name": "Golden Boot",
        "description": "Top scorer of the competition.",
        "scope": "competition", "subject": "player", "sports": "goals",
        "params": {"min_goals": 2},
    },
    "clean_sheet_streak": {
        "name": "Clean Sheet Streak",
        "description": "Consecutive matches without conceding.",
        "scope": "streak", "subject": "team", "sports": "goals",
        "params": {"streak": 2},
    },
}
