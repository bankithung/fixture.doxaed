"""Structured tournament rules: canonical defaults, whitelist merge, freeze gate.

Rules are stored as data (Tournament.rules JSONB) so the platform interprets them
rather than hardcoding scoring/format logic (FET-style). See
docs/superpowers/specs/2026-06-06-tournament-rules-constraints-design.md.
"""
from __future__ import annotations

import copy
from typing import Any

from django.utils import timezone

from apps.tournaments.models import TournamentStatus

# Canonical football v1 defaults. Every key here is the whitelist — unknown keys
# in a partial are rejected so the schema can't silently drift.
DEFAULT_RULES: dict[str, Any] = {
    "format": "round_robin",  # round_robin | knockout | groups_knockout
    "group_size": 5,
    "advance_per_group": 2,
    "points": {"win": 3, "draw": 1, "loss": 0},
    "tiebreakers": ["points", "goal_difference", "goals_for", "head_to_head", "name"],
    "match": {"halves": 2, "half_minutes": 45, "extra_time": False, "penalties": True},
    "squad": {"min_players": 7, "max_players": 23, "max_subs": 5},
    "discipline": {"yellow_suspension_threshold": 2, "red_matches_banned": 1},
}

# Keys whose value is a dict and may be partially overridden (per-key merge).
_NESTED = {"points", "match", "squad", "discipline"}


def merge_rules(partial: dict[str, Any] | None) -> dict[str, Any]:
    """Merge a partial rules dict onto the canonical defaults.

    Raises ValueError on any unknown top-level or nested key (whitelist).
    """
    partial = partial or {}
    unknown = set(partial) - set(DEFAULT_RULES)
    if unknown:
        raise ValueError(f"unknown rule keys: {sorted(unknown)}")

    out = copy.deepcopy(DEFAULT_RULES)
    for key, value in partial.items():
        if key in _NESTED and isinstance(value, dict):
            sub_unknown = set(value) - set(DEFAULT_RULES[key])
            if sub_unknown:
                raise ValueError(f"unknown {key} keys: {sorted(sub_unknown)}")
            out[key].update(value)
        else:
            out[key] = value
    return out


def can_edit_rules(tournament) -> bool:
    """Rules are editable only while the tournament is draft or published (invariant 7)."""
    return tournament.status in {TournamentStatus.DRAFT, TournamentStatus.PUBLISHED}


def freeze_rules(tournament) -> None:
    """Stamp the freeze time (called on transition to registration_open). Idempotent."""
    if tournament.rules_frozen_at is None:
        tournament.rules_frozen_at = timezone.now()
        tournament.save(update_fields=["rules_frozen_at"])
