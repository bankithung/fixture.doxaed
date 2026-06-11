"""Per-competition draw configuration (fixture-engine redesign spec §2.1).

``Tournament.draw_config`` is a JSONB blob keyed by category-leaf key, with
``"*"`` as the tournament-wide default layer. It holds GENERATION inputs
(format, group size, legs, seeding method, third place) — deliberately
outside ``Tournament.rules``: rules freeze at registration_open (invariant 7,
the participant contract) while draw config is routinely finalized after
registration closes and is governed by invariant 10 (inputs_hash staleness)
instead.

Effective config layering (back-compat — spec §2.1):

    DEFAULT_DRAW_CONFIG < legacy rules keys (format/group_size/
    advance_per_group) < draw_config["*"] < draw_config[leaf] <
    explicit API request params

Explicit request params always win, so every existing caller keeps working.
Stored layers stay SPARSE (only the keys the organizer set) so "*" and
per-leaf precedence keep composing.
"""
from __future__ import annotations

import copy
from typing import Any

from django.utils import timezone

DEFAULT_DRAW_CONFIG: dict[str, Any] = {
    "format": "round_robin",         # round_robin | knockout | groups_knockout
    "group_size": 5,
    "advance_per_group": 2,
    "legs": 1,                       # 1 | 2 (double round-robin, mirrored 2nd cycle)
    "seeding": "registration",       # registration | random | snake | seeded
    "seed": None,                    # RNG seed; persisted on first random draw
    "third_place": False,            # knockout formats only
    "bye_policy": "seeded_byes",     # seeded_byes (preliminary_round deferred)
    "min_entries_action": "prompt",  # prompt | cancel (auto_champion deferred — §9 A6)
    "constraints_reviewed_at": None,  # ISO timestamp ("Mark reviewed" — §9 A10)
    # Global-setup wizard calendar (§5.1 "wizard-saved dates"; only meaningful
    # on the "*" layer): slot-time data, excluded from the draw inputs_hash.
    "calendar": None,
}

_FORMATS = {"round_robin", "knockout", "groups_knockout"}
_SEEDINGS = {"registration", "random", "snake", "seeded"}
_BYE_POLICIES = {"seeded_byes"}
_MIN_ENTRIES_ACTIONS = {"prompt", "cancel"}

# Legacy rules keys that act as a fallback layer below draw_config (§2.1).
_LEGACY_RULES_KEYS = ("format", "group_size", "advance_per_group")


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


_CALENDAR_KEYS = {"date_start", "date_end", "daily_start", "daily_end",
                  "slot_minutes"}


def _validate_calendar(cal: Any) -> None:
    """The wizard-saved calendar: None or a sparse dict of ISO dates ("YYYY-
    MM-DD"), wall-clock times ("HH:MM" — invariant 14 / §9 A4) and a positive
    slot length."""
    from datetime import date, time

    if cal is None:
        return
    if not isinstance(cal, dict):
        raise ValueError("calendar must be an object")
    unknown = set(cal) - _CALENDAR_KEYS
    if unknown:
        raise ValueError(f"unknown calendar keys: {sorted(unknown)}")
    for key, parse, what in (
        ("date_start", date.fromisoformat, "an ISO date"),
        ("date_end", date.fromisoformat, "an ISO date"),
        ("daily_start", time.fromisoformat, "an HH:MM time"),
        ("daily_end", time.fromisoformat, "an HH:MM time"),
    ):
        v = cal.get(key)
        if v is None:
            continue
        try:
            if not isinstance(v, str):
                raise ValueError
            parse(v)
        except ValueError:
            raise ValueError(f"calendar.{key} must be {what} string") from None
    sm = cal.get("slot_minutes")
    if sm is not None and (not _is_int(sm) or sm < 1):
        raise ValueError("calendar.slot_minutes must be a positive integer")


def _validate_layer(layer: dict[str, Any]) -> None:
    """Validate one (sparse) stored layer. Cross-field checks (§9 A8) run
    against the layer's own values falling back to the defaults."""
    if "format" in layer and layer["format"] not in _FORMATS:
        raise ValueError(f"unknown draw format: {layer['format']!r}")
    if "seeding" in layer and layer["seeding"] not in _SEEDINGS:
        raise ValueError(f"unknown seeding method: {layer['seeding']!r}")
    if "bye_policy" in layer and layer["bye_policy"] not in _BYE_POLICIES:
        raise ValueError(f"unsupported bye_policy: {layer['bye_policy']!r}")
    if "min_entries_action" in layer \
            and layer["min_entries_action"] not in _MIN_ENTRIES_ACTIONS:
        raise ValueError(
            f"unsupported min_entries_action: {layer['min_entries_action']!r}"
        )
    if "legs" in layer and layer["legs"] not in (1, 2):
        raise ValueError("legs must be 1 or 2")
    if "third_place" in layer and not isinstance(layer["third_place"], bool):
        raise ValueError("third_place must be a boolean")
    if "seed" in layer and layer["seed"] is not None and not _is_int(layer["seed"]):
        raise ValueError("seed must be an integer")
    if "constraints_reviewed_at" in layer \
            and layer["constraints_reviewed_at"] is not None \
            and not isinstance(layer["constraints_reviewed_at"], str):
        raise ValueError("constraints_reviewed_at must be an ISO timestamp string")
    if "calendar" in layer:
        _validate_calendar(layer["calendar"])

    group_size = layer.get("group_size", DEFAULT_DRAW_CONFIG["group_size"])
    advance = layer.get("advance_per_group", DEFAULT_DRAW_CONFIG["advance_per_group"])
    if "group_size" in layer and (not _is_int(group_size) or group_size < 2):
        raise ValueError("group_size must be an integer >= 2")  # §9 A8
    if "advance_per_group" in layer and (not _is_int(advance) or advance < 1):
        raise ValueError("advance_per_group must be an integer >= 1")
    if advance >= group_size:
        raise ValueError("advance_per_group must be smaller than group_size")  # §9 A8


def merge_draw_config(
    partial: dict[str, Any] | None,
    base: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Whitelist-merge a partial onto a stored layer (NOT onto the defaults —
    layers stay sparse so "*"/leaf precedence keeps working). Raises
    ValueError on unknown keys or invalid values (mirrors ``merge_rules``)."""
    unknown = set(partial or {}) - set(DEFAULT_DRAW_CONFIG)
    if unknown:
        raise ValueError(f"unknown draw_config keys: {sorted(unknown)}")
    out = dict(base or {})
    out.update(partial or {})
    _validate_layer(out)
    return out


def effective_draw_config(
    tournament,
    leaf_key: str | None = None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve the effective draw config for one competition (spec §2.1):
    defaults < legacy rules keys < draw_config["*"] < draw_config[leaf] <
    ``overrides`` (explicit request params — copied verbatim so legacy API
    format values like "by_category" keep winning unchanged)."""
    out = copy.deepcopy(DEFAULT_DRAW_CONFIG)
    rules = tournament.rules or {}
    for key in _LEGACY_RULES_KEYS:
        if key in rules:
            out[key] = rules[key]
    stored = tournament.draw_config or {}
    layers = ["*"]
    if leaf_key and leaf_key != "*":
        layers.append(leaf_key)
    for layer_key in layers:
        layer = stored.get(layer_key)
        if isinstance(layer, dict):
            for k, v in layer.items():
                if k in DEFAULT_DRAW_CONFIG:
                    out[k] = v
    for k, v in (overrides or {}).items():
        if k in DEFAULT_DRAW_CONFIG and v is not None:
            out[k] = v
    return out


def leaf_has_matches(tournament, leaf_key: str | None) -> bool:
    """True once non-deleted matches exist in scope — the per-leaf freeze
    signal (§2.1): edits stay allowed but the UI shows the invariant-10
    regenerate/keep/diff banner."""
    from apps.matches.models import Match

    qs = Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    if leaf_key and leaf_key != "*":
        qs = qs.filter(leaf_key=leaf_key)
    return qs.exists()


def update_draw_config(
    *, tournament, leaf_key: str, partial: dict[str, Any] | None,
    by, event_id=None, request=None,
):
    """Update one layer of ``tournament.draw_config`` (manager/bracket-editor
    verb — the view gates it). Whitelist merge, idempotent on ``event_id``
    (invariant 3, via AuditEvent), audited as ``draw_config_updated``.

    ``leaf_key`` is "*" (tournament-wide defaults) or a configured category
    leaf key. Raises ValueError on unknown leaf/keys/values.
    """
    from django.db import transaction

    from apps.audit.models import ActorRole, AuditEvent
    from apps.audit.services import emit_audit
    from apps.tournaments.services.sports import iter_leaves

    leaf_key = str(leaf_key or "*")
    if leaf_key != "*":
        known = {leaf["leaf_key"] for leaf in iter_leaves(tournament.sports)}
        if leaf_key not in known:
            raise ValueError(f"unknown leaf_key: {leaf_key!r}")

    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="draw_config_updated"
        ).first()
        if prior is not None:
            return tournament  # replay (invariant 3)

    stored = dict(tournament.draw_config or {})
    before = stored.get(leaf_key)
    merged = merge_draw_config(partial, base=before)

    with transaction.atomic():
        stored[leaf_key] = merged
        tournament.draw_config = stored
        tournament.last_manual_edit_at = timezone.now()
        tournament.save(update_fields=["draw_config", "last_manual_edit_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="draw_config_updated",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            tournament_id=tournament.id,
            idempotency_key=event_id,
            payload_before={"leaf_key": leaf_key, "config": before},
            payload_after={"leaf_key": leaf_key, "config": merged},
            request=request,
        )
    return tournament
