"""Scheduling-constraint catalog + shape validation (FET-style hard/soft).

This module owns the *catalog* of constraint types and validates the shape of a
tournament's stored ``constraints`` list. The schedule-level enforcement
(``validate_schedule`` / ``score_schedule``) is added in a later increment; the
data schema here is solver-agnostic so the engine can be swapped without a
migration. See docs/superpowers/specs/2026-06-06-tournament-rules-constraints-design.md.
"""
from __future__ import annotations

from typing import Any

# type -> (label, hard-by-default, params schema for the UI builder)
CONSTRAINT_TYPES: list[dict[str, Any]] = [
    {"type": "no_double_booking_team", "label": "No team double-booking", "hard": True, "params_schema": {}},
    {"type": "min_rest_minutes", "label": "Minimum rest between a team's matches", "hard": True, "params_schema": {"minutes": "int"}},
    {"type": "venue_single_use", "label": "One match per venue per slot", "hard": True, "params_schema": {}},
    {"type": "preferred_window", "label": "Preferred match window", "hard": False, "params_schema": {"days": "list", "from": "time", "to": "time"}},
    {"type": "avoid_back_to_back", "label": "Avoid back-to-back matches", "hard": False, "params_schema": {}},
]

_BY_TYPE = {c["type"]: c for c in CONSTRAINT_TYPES}


def validate_constraints(items: Any) -> list[dict[str, Any]]:
    """Validate + normalize a tournament's constraints list.

    Raises ValueError on a non-list or an unknown constraint type. Each item is
    normalized to {type, scope, hard, weight, params}.
    """
    if not isinstance(items, list):
        raise ValueError("constraints must be a list")
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or item.get("type") not in _BY_TYPE:
            bad = item.get("type") if isinstance(item, dict) else item
            raise ValueError(f"unknown constraint type: {bad}")
        spec = _BY_TYPE[item["type"]]
        out.append(
            {
                "type": item["type"],
                "scope": item.get("scope", "all"),
                "hard": bool(item.get("hard", spec["hard"])),
                "weight": item.get("weight"),
                "params": item.get("params", {}) if isinstance(item.get("params", {}), dict) else {},
            }
        )
    return out
