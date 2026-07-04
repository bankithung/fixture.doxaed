"""Event presets (P4, institutions-as-users): one-click setup trees for the
events schools actually run. Code-defined like BADGE_TEMPLATES — structure
in code, everything editable after applying (presets, never prisons).

Applying a preset replaces the sports tree through the SAME guarded path as
the sports editor (H4: leaves with registered teams or fixtures can never be
orphaned), so a preset is always safe to apply and re-apply.
"""
from __future__ import annotations

_AGE_GENDER = [
    {"name": "U-14", "children": [{"name": "Boys"}, {"name": "Girls"}]},
    {"name": "U-17", "children": [{"name": "Boys"}, {"name": "Girls"}]},
]

TOURNAMENT_PRESETS: dict[str, dict] = {
    "annual_sports_day": {
        "label": "Annual sports day",
        "note": "Athletics meet categories by age and gender. Scoring runs "
                "through meet results (place points, 7-5-4-3-2-1, relays "
                "doubled) into the season house table.",
        "sports": [{"name": "Athletics", "nodes": _AGE_GENDER}],
    },
    "inter_house_league": {
        "label": "Inter-house league",
        "note": "Year-round house competition: football and volleyball by "
                "age and gender, round robin by default.",
        "sports": [
            {"name": "Football", "nodes": _AGE_GENDER},
            {"name": "Volleyball", "nodes": _AGE_GENDER},
        ],
    },
    "inter_class_knockout": {
        "label": "Inter-class knockout",
        "note": "A fast single-sport knockout between classes.",
        "sports": [{"name": "Football", "nodes": [{"name": "Open"}]}],
    },
    "nagaland_school_games": {
        "label": "School games (sepak takraw + table tennis)",
        "note": "The Dimapur-style two-sport meet: sepak takraw regu and "
                "table tennis singles and doubles, U-14 and open.",
        "sports": [
            {"name": "Sepak Takraw", "nodes": [
                {"name": "U-14", "children": [
                    {"name": "Boys", "children": [{"name": "3v3"}]},
                    {"name": "Girls", "children": [{"name": "3v3"}]},
                ]},
            ]},
            {"name": "Table Tennis", "nodes": [
                {"name": "U-14", "children": [
                    {"name": "Boys", "children": [{"name": "1v1"}, {"name": "2v2"}]},
                    {"name": "Girls", "children": [{"name": "1v1"}, {"name": "2v2"}]},
                ]},
                {"name": "Open category", "children": [
                    {"name": "Boys", "children": [{"name": "1v1"}, {"name": "2v2"}]},
                    {"name": "Girls", "children": [{"name": "1v1"}, {"name": "2v2"}]},
                ]},
            ]},
        ],
    },
}
