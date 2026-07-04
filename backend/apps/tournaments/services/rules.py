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
    # ``walkover_loss`` = points for LOSING BY WALKOVER; None means "same as
    # a played loss". ITTF group scoring is win 2 / played loss 1 / walkover
    # loss 0 (Reg 3.7.5) — set it per TT leaf via by_leaf or a preset.
    "points": {"win": 3, "draw": 1, "loss": 0, "walkover_loss": None},
    "tiebreakers": ["points", "goal_difference", "goals_for", "head_to_head", "name"],
    "match": {"halves": 2, "half_minutes": 45, "extra_time": False, "penalties": True},
    "squad": {"min_players": 7, "max_players": 23, "max_subs": 5},
    "discipline": {
        "yellow_suspension_threshold": 2,
        "red_matches_banned": 1,
        # FIFA-style: wipe accumulated yellows entering the last N knockout
        # rounds (0 = never wipe; 2 = semis + final).
        "yellow_wipe_final_rounds": 0,
    },
    # Fixture-engine redesign §2.6: groups at/under max_size auto-play double
    # round-robin (0 = off). Participant-facing (changes competitive
    # outcomes), so it correctly lives under the invariant-7 freeze; consumed
    # by apps.fixtures.services.generate (ships with its consumer — §9 A7).
    "small_group_double_rr": {"max_size": 0},
    # Fixture-engine redesign §2.6 + §9 A7: what happens when a team
    # withdraws. `fixtures` is consumed by apps.teams.services.withdrawal
    # (v1 executes "walkover" only); `rr_results` by
    # apps.matches.services.standings (a withdrawn team's results are voided
    # while it has played under half its matches, kept once at least half).
    "withdrawal_policy": {
        "fixtures": "walkover",
        "rr_results": "void_if_under_half_played",
    },
    # H5: age reckoned as of a cutoff date in the event year (SGFI/CBSE
    # convention: 31 Dec). Enforcement is on by default and opt-out-able —
    # presets, never prisons. Consumed by apps.teams.services.eligibility.
    "eligibility": {"enforce_age": True, "age_cutoff": "12-31"},
    # Per-GAME (category leaf) overrides — the owner's "everything is per game"
    # rule. `{leaf_key: {"scoring": {...}, "tiebreakers": [...]}}`. Scoring and
    # ranking are participant-facing, so they correctly live under the
    # invariant-7 freeze (here in `rules`), NOT in draw_config. Resolved by
    # apps.matches.services.set_scoring.rules_for_match (scoring) and
    # apps.matches.services.standings.compute_standings (tiebreakers), each with
    # precedence: per-game override -> tournament default -> sport/profile.
    "by_leaf": {},
}

# Keys whose value is a dict and may be partially overridden (per-key merge).
_NESTED = {
    "points", "match", "squad", "discipline", "small_group_double_rr",
    "withdrawal_policy", "eligibility",
}

# Tiebreaker criteria the standings engine understands (validation whitelist).
# Goal-sport tokens + set/point tokens for racket/net sports + the terminal
# coin_toss. set_difference/sets_for are aliases of goal_difference/goals_for
# for set sports (set wins mirror into the score).
# P5: named, SOURCED tiebreaker orders — one click in Settings, editable
# after (presets, never prisons). Keys are _TIEBREAKERS members only.
TIEBREAKER_PRESETS: list[dict] = [
    {
        "key": "fifa_group",
        "label": "FIFA group stage",
        "note": "Points, goal difference, goals scored, head to head, "
                "drawing of lots (World Cup Art. 13).",
        "tiebreakers": [
            "points", "goal_difference", "goals_for", "head_to_head",
            "coin_toss",
        ],
    },
    {
        "key": "premier_league",
        "label": "League season",
        "note": "Points, goal difference, goals scored, head to head, "
                "then alphabetical.",
        "tiebreakers": [
            "points", "goal_difference", "goals_for", "head_to_head", "name",
        ],
    },
    {
        "key": "ittf_group",
        "label": "ITTF group (ratio based)",
        "note": "Match points, then games won:lost ratio, then points "
                "won:lost ratio among the tied (Reg 3.7.6).",
        "tiebreakers": ["points", "ratio_games", "ratio_points", "name"],
    },
    {
        "key": "sets_group",
        "label": "Set sports (difference based)",
        "note": "Points, set difference, point difference, head to head.",
        "tiebreakers": [
            "points", "set_difference", "point_difference", "head_to_head",
            "name",
        ],
    },
]

_TIEBREAKERS = {
    "points", "goal_difference", "goals_for", "goals_against", "wins",
    "head_to_head", "name", "set_difference", "sets_for",
    "point_difference", "points_for", "points_against", "coin_toss",
    # ITTF-family RATIO comparators (won:lost quotients, Reg 3.7.6) — a
    # different beast from subtractive goal/point difference.
    "ratio_games", "ratio_points",
}


def _validate_set_params(d: dict, where: str) -> None:
    """Validate a {points, win_by, cap} block (a regular or deciding set)."""
    if not isinstance(d, dict):
        raise ValueError(f"{where} must be an object")
    unknown = set(d) - {"points", "win_by", "cap"}
    if unknown:
        raise ValueError(f"unknown {where} keys: {sorted(unknown)}")
    points = d.get("points", 11)
    if not (isinstance(points, int) and not isinstance(points, bool) and points >= 1):
        raise ValueError(f"{where}.points must be a positive integer")
    win_by = d.get("win_by", 2)
    if not (isinstance(win_by, int) and not isinstance(win_by, bool) and win_by >= 1):
        raise ValueError(f"{where}.win_by must be a positive integer")
    cap = d.get("cap")
    if cap is not None and not (
        isinstance(cap, int) and not isinstance(cap, bool) and cap >= points
    ):
        raise ValueError(f"{where}.cap must be an integer >= points")


def _validate_scoring(d: dict) -> None:
    """Validate a per-game scoring block (sets or goals/timed)."""
    if not isinstance(d, dict):
        raise ValueError("scoring must be an object")
    typ = d.get("type")
    if typ not in {"sets", "goals"}:
        raise ValueError("scoring.type must be 'sets' or 'goals'")
    if typ == "goals":
        extra = set(d) - {"type"}
        if extra:
            raise ValueError(f"unknown goals scoring keys: {sorted(extra)}")
        return
    unknown = set(d) - {
        "type", "best_of", "points", "win_by", "cap", "deciding", "serve",
    }
    if unknown:
        raise ValueError(f"unknown scoring keys: {sorted(unknown)}")
    serve = d.get("serve")
    if serve is not None:
        _validate_serve(serve)
    best_of = d.get("best_of", 3)
    if not (isinstance(best_of, int) and not isinstance(best_of, bool) and best_of >= 1):
        raise ValueError("scoring.best_of must be a positive integer")
    _validate_set_params(
        {k: d[k] for k in ("points", "win_by", "cap") if k in d}, "scoring"
    )
    deciding = d.get("deciding")
    if deciding is not None:
        _validate_set_params(deciding, "scoring.deciding")


def _validate_serve(d) -> None:
    """Service mechanics for set sports (P2 groundwork): how many serves one
    side takes per turn (sepak legacy = 3, ISTAF-2024 = 1), whether serving
    alternates every point at deuce, and the score-triggered change-of-ends
    points (sepak: 11 regular / 8 deciding)."""
    if not isinstance(d, dict):
        raise ValueError("scoring.serve must be an object")
    unknown = set(d) - {"serves_per_turn", "alternate_every_point", "change_ends_at"}
    if unknown:
        raise ValueError(f"unknown scoring.serve keys: {sorted(unknown)}")
    spt = d.get("serves_per_turn", 1)
    if not (isinstance(spt, int) and not isinstance(spt, bool) and 1 <= spt <= 9):
        raise ValueError("scoring.serve.serves_per_turn must be an integer 1-9")
    aep = d.get("alternate_every_point", True)
    if not isinstance(aep, bool):
        raise ValueError("scoring.serve.alternate_every_point must be a boolean")
    cea = d.get("change_ends_at")
    if cea is not None:
        if not isinstance(cea, dict):
            raise ValueError("scoring.serve.change_ends_at must be an object")
        bad = set(cea) - {"regular", "deciding"}
        if bad:
            raise ValueError(f"unknown change_ends_at keys: {sorted(bad)}")
        for k, v in cea.items():
            if not (isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 99):
                raise ValueError(f"change_ends_at.{k} must be an integer 0-99")


_FORMAT_EVENT_TYPES = {"regu", "doubles", "quad", "team", "singles", "pairs"}


def _validate_format(d) -> None:
    """Per-game competition format (P2 groundwork): roster shape + in-match
    allowances (sepak regu = 3 a side, 2 subs and 1 timeout per set...).
    Any NvN is legal — presets, never prisons."""
    if not isinstance(d, dict):
        raise ValueError("format must be an object")
    unknown = set(d) - {
        "players_per_side", "reserves_max", "subs_per_set",
        "timeouts_per_set", "event_type",
    }
    if unknown:
        raise ValueError(f"unknown format keys: {sorted(unknown)}")
    for key, hi in (
        ("players_per_side", 22), ("reserves_max", 22),
        ("subs_per_set", 22), ("timeouts_per_set", 9),
    ):
        v = d.get(key)
        if v is not None and not (
            isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= hi
        ):
            raise ValueError(f"format.{key} must be an integer 0-{hi}")
    pps = d.get("players_per_side")
    if pps is not None and pps < 1:
        raise ValueError("format.players_per_side must be at least 1")
    et = d.get("event_type")
    if et is not None and et not in _FORMAT_EVENT_TYPES:
        raise ValueError(
            f"format.event_type must be one of {sorted(_FORMAT_EVENT_TYPES)}"
        )


def _validate_leaf_discipline(d) -> None:
    if not isinstance(d, dict):
        raise ValueError("discipline must be an object")
    unknown = set(d) - {"yellow_suspension_threshold", "red_matches_banned"}
    if unknown:
        raise ValueError(f"unknown discipline keys: {sorted(unknown)}")
    for k, v in d.items():
        if not (isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 99):
            raise ValueError(f"discipline.{k} must be an integer 0-99")


def _validate_tiebreakers(tbs) -> None:
    if not isinstance(tbs, list) or not all(isinstance(x, str) for x in tbs):
        raise ValueError("tiebreakers must be a list of strings")
    unknown = sorted({x for x in tbs if x not in _TIEBREAKERS})
    if unknown:
        raise ValueError(f"unknown tiebreakers: {unknown}")


def _validate_points(p) -> None:
    """A per-leaf points ladder: same keys as the top-level block."""
    if not isinstance(p, dict):
        raise ValueError("points must be an object")
    unknown = set(p) - set(DEFAULT_RULES["points"])
    if unknown:
        raise ValueError(f"unknown points keys: {sorted(unknown)}")
    for k, v in p.items():
        if v is not None and not isinstance(v, int):
            raise ValueError(f"points.{k} must be an integer")


def _merge_by_leaf(out: dict, partial) -> None:
    """Merge per-game overrides into `out` in place. A leaf set to None clears
    it; a leaf's `scoring`/`tiebreakers` set to None clears just that override.
    Each surviving block is validated."""
    if not isinstance(partial, dict):
        raise ValueError("by_leaf must be an object")
    for leaf, entry in partial.items():
        if entry is None:
            out.pop(leaf, None)
            continue
        if not isinstance(entry, dict):
            raise ValueError(f"by_leaf[{leaf}] must be an object")
        unknown = set(entry) - {
            "scoring", "tiebreakers", "format", "discipline", "points",
        }
        if unknown:
            raise ValueError(f"unknown by_leaf keys: {sorted(unknown)}")
        cur = dict(out.get(leaf) or {})
        if "scoring" in entry:
            if entry["scoring"] is None:
                cur.pop("scoring", None)
            else:
                _validate_scoring(entry["scoring"])
                cur["scoring"] = entry["scoring"]
        if "tiebreakers" in entry:
            if entry["tiebreakers"] is None:
                cur.pop("tiebreakers", None)
            else:
                _validate_tiebreakers(entry["tiebreakers"])
                cur["tiebreakers"] = entry["tiebreakers"]
        if "points" in entry:
            # Per-GAME points ladder (ITTF 2/1/0 on the TT leaves of a mixed
            # tournament while football keeps 3/1/0).
            if entry["points"] is None:
                cur.pop("points", None)
            else:
                _validate_points(entry["points"])
                cur["points"] = entry["points"]
        for key, validate in (
            ("format", _validate_format),
            ("discipline", _validate_leaf_discipline),
        ):
            if key in entry:
                if entry[key] is None:
                    cur.pop(key, None)
                else:
                    validate(entry[key])
                    cur[key] = entry[key]
        if cur:
            out[leaf] = cur
        else:
            out.pop(leaf, None)


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
            if key == "by_leaf":
                _merge_by_leaf(out["by_leaf"], value)
            elif key in _NESTED and isinstance(value, dict):
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
