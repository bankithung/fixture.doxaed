"""Named scoring presets per sport (P2) — presets, never prisons.

Each preset is a complete, sourced scoring block an organizer picks in
Settings and may then freely edit (per tournament or per game via
rules.by_leaf). The DEFAULT preset per sport matches the SportDefinition's
scoring defaults. Sources: ISTAF Law of the Game 2013 + the ISTAF 2024
15-point mandate (effective 1 Feb 2024); ITTF Statutes 2025 Law 2.11
(11 points, win by 2, deuce UNCAPPED); BWF Laws (21, cap 30).
"""
from __future__ import annotations

SCORING_PRESETS: dict[str, list[dict]] = {
    "sepak_takraw": [
        {
            "key": "istaf_legacy",
            "label": "ISTAF legacy (21-point sets, 15-point decider)",
            "note": "The pre-2024 school convention: sets to 21 cap 25, deciding set 15 cap 17, three serves per turn.",
            "scoring": {
                "type": "sets", "best_of": 3, "points": 21, "win_by": 2,
                "cap": 25,
                "deciding": {"points": 15, "win_by": 2, "cap": 17},
                "serve": {
                    "serves_per_turn": 3,
                    "alternate_every_point": False,
                    "change_ends_at": {"regular": 11, "deciding": 8},
                },
            },
        },
        {
            "key": "istaf_2024",
            "label": "ISTAF 2024 (15-point sets, single service)",
            "note": "Mandatory for ISTAF competitions since 1 Feb 2024: every set to 15 cap 17, one service per turn alternating every point.",
            "scoring": {
                "type": "sets", "best_of": 3, "points": 15, "win_by": 2,
                "cap": 17,
                "deciding": {"points": 15, "win_by": 2, "cap": 17},
                "serve": {
                    "serves_per_turn": 1,
                    "alternate_every_point": True,
                    "change_ends_at": {"deciding": 8},
                },
            },
        },
    ],
    "table_tennis": [
        {
            "key": "ittf_bo3",
            "label": "ITTF best of 3 (11 points)",
            "note": "School pools and tight schedules. Deuce is uncapped (Law 2.11.1).",
            "scoring": {"type": "sets", "best_of": 3, "points": 11,
                        "win_by": 2, "cap": None},
        },
        {
            "key": "ittf_bo5",
            "label": "ITTF best of 5 (11 points)",
            "note": "The common knockout format; team-event rubbers.",
            "scoring": {"type": "sets", "best_of": 5, "points": 11,
                        "win_by": 2, "cap": None},
        },
        {
            "key": "ittf_bo7",
            "label": "ITTF best of 7 (11 points)",
            "note": "World-title individual format (first to 4 games).",
            "scoring": {"type": "sets", "best_of": 7, "points": 11,
                        "win_by": 2, "cap": None},
        },
    ],
    "badminton": [
        {
            "key": "bwf_21",
            "label": "BWF (21 points, cap 30)",
            "note": "Every game to 21 win-by-2; 29-all decides at 30.",
            "scoring": {"type": "sets", "best_of": 3, "points": 21,
                        "win_by": 2, "cap": 30,
                        "deciding": {"points": 21, "win_by": 2, "cap": 30}},
        },
    ],
    "volleyball": [
        {
            "key": "fivb",
            "label": "FIVB (25-point sets, 15-point decider)",
            "note": "Best of 5, deciding set to 15, win by 2 uncapped.",
            "scoring": {"type": "sets", "best_of": 5, "points": 25,
                        "win_by": 2, "cap": None,
                        "deciding": {"points": 15, "win_by": 2, "cap": None}},
        },
    ],
}
