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
    # Fixture-engine redesign §2.6: groups at/under max_size auto-play double
    # round-robin (0 = off). Participant-facing (changes competitive
    # outcomes), so it correctly lives under the invariant-7 freeze; consumed
    # by apps.fixtures.services.generate (ships with its consumer — §9 A7).
    "small_group_double_rr": {"max_size": 0},
}

# Keys whose value is a dict and may be partially overridden (per-key merge).
_NESTED = {"points", "match", "squad", "discipline", "small_group_double_rr"}


def merge_rules(
    partial: dict[str, Any] | None,
    base: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge layers onto the canonical defaults: defaults < base < partial.

    `base` is the tournament's currently-stored rules (so a PATCH of just
    `{"points": {"win": 2}}` keeps the rest of the existing ruleset, not the
    bare defaults). Raises ValueError on any unknown top-level/nested key.
    """
    out = copy.deepcopy(DEFAULT_RULES)
    for layer in (base, partial):
        if not layer:
            continue
        unknown = set(layer) - set(DEFAULT_RULES)
        if unknown:
            raise ValueError(f"unknown rule keys: {sorted(unknown)}")
        for key, value in layer.items():
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


def update_settings(
    *, tournament, rules=None, constraints=None, by, amend=False, reason="",
    event_id=None, request=None,
):
    """Update a tournament's rules and/or constraints (manager only).

    Enforces the freeze gate (invariant 7): blocked once rules aren't editable
    unless ``amend=True`` + a reason. Idempotent on ``event_id`` (invariant 3).
    Raises PermissionError("rules_frozen") or ValueError on invalid input.
    """
    from django.db import transaction

    from apps.audit.models import ActorRole, AuditEvent
    from apps.audit.services import emit_audit
    from apps.fixtures.services.constraints import validate_constraints

    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="tournament_settings_updated"
        ).first()
        if prior is not None:
            return tournament  # replay

    if not can_edit_rules(tournament) and not amend:
        raise PermissionError("rules_frozen")
    if amend and not (reason or "").strip():
        raise ValueError("amend_reason_required")

    with transaction.atomic():
        if rules is not None:
            tournament.rules = merge_rules(rules, base=tournament.rules)
        if constraints is not None:
            tournament.constraints = validate_constraints(constraints)
        tournament.last_manual_edit_at = timezone.now()
        tournament.save(update_fields=["rules", "constraints", "last_manual_edit_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_settings_updated",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            idempotency_key=event_id,
            payload_after={
                "rules": tournament.rules,
                "constraints": tournament.constraints,
                "amend": amend,
                "reason": reason,
            },
            request=request,
        )
    return tournament
