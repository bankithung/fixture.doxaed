"""Scheduling-constraint catalog + shape validation (FET-style hard/soft).

This module owns the *catalog* of constraint types (v2 — fixture-engine
redesign spec §3), validates the shape of a tournament's stored
``constraints`` list, and provides the pure scope-grammar helpers
(``parse_scope`` / ``scope_matches`` / ``scope_specificity``) the scheduler
and the pairing layer resolve records with. The data schema is solver-agnostic
so the engine can be swapped without a migration. See
docs/superpowers/specs/2026-06-11-fixture-engine-redesign.md §2.2/§3.

Record shape: ``{type, scope, hard, weight, params}``.

* ``scope`` grammar (spec §2.2): ``"all" | "sport:<sport_id>" |
  "leaf:<leaf_key>" | "team:<team_id>" | "tag:<key>=<value>"``. New writes are
  validated strictly (``parse_scope``); stored legacy records normalize
  leniently to ``"all"`` at read time (``normalize_scope``).
* ``weight`` (soft constraints): integer 1-10, default 5 — a multiplier on the
  soft score. Hard constraints ignore weight.

Adding a scenario = a catalog entry + a handler. Never a migration.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

DEFAULT_WEIGHT = 5

# type -> label, hard-by-default, params schema for the UI builder, and the
# scope kinds the record meaningfully accepts (drives the UI scope Select; the
# grammar itself is validated independently). Layer: S = slot-time
# (scheduler.py), P = pairing-time (generate.py).
CONSTRAINT_TYPES: list[dict[str, Any]] = [
    {"type": "no_double_booking_team", "label": "No team double-booking", "hard": True,
     "params_schema": {}, "scopes": ["all", "sport", "leaf"], "layer": "S"},
    {"type": "min_rest_minutes", "label": "Minimum rest between a team's matches", "hard": True,
     "params_schema": {"minutes": "int"}, "scopes": ["all", "sport", "leaf", "team"], "layer": "S"},
    {"type": "venue_single_use", "label": "One match per venue per slot", "hard": True,
     "params_schema": {}, "scopes": ["all"], "layer": "S"},
    {"type": "max_matches_per_team_per_day", "label": "Max matches per team per day", "hard": True,
     "params_schema": {"count": "int"}, "scopes": ["all", "sport", "leaf"], "layer": "S"},
    {"type": "keep_apart_until_round", "hard": True,
     "label": "Keep matching participants apart until a round",
     "params_schema": {"key": "str", "until_round": "int"},
     "scopes": ["all", "sport", "leaf"], "layer": "P"},
    {"type": "blackout_dates", "label": "Dates no matches may be scheduled", "hard": True,
     "params_schema": {"dates": "list"}, "scopes": ["all", "sport", "leaf"], "layer": "S"},
    {"type": "team_unavailable", "label": "A team is unavailable on dates", "hard": True,
     "params_schema": {"team_id": "str", "dates": "list"}, "scopes": ["team"], "layer": "S"},
    {"type": "preferred_window", "label": "Preferred match window", "hard": False,
     "params_schema": {"days": "list", "from": "time", "to": "time"},
     "scopes": ["all", "sport", "leaf", "team"], "layer": "S"},
    {"type": "avoid_back_to_back", "label": "Avoid back-to-back matches", "hard": False,
     "params_schema": {}, "scopes": ["all", "team"], "layer": "S"},
    {"type": "even_spacing", "label": "Spread each team's matches evenly", "hard": False,
     "params_schema": {}, "scopes": ["all"], "layer": "S"},
    {"type": "balance_venues", "label": "Balance matches across venues", "hard": False,
     "params_schema": {}, "scopes": ["all"], "layer": "S"},
    # ------------------------------------------------------------- catalog v2
    # Subtracted from every matching weekday (days=null => all days): covers
    # Sunday-morning church AND daily lunch/assembly breaks (spec D4).
    {"type": "recurring_blackout_window", "label": "Recurring blocked window", "hard": True,
     "params_schema": {"days": "list", "from": "time", "to": "time"},
     "scopes": ["all", "sport", "leaf"], "layer": "S"},
    # Opening/closing ceremonies: a one-off block removed from the grid,
    # optionally for specific venues only.
    {"type": "ceremony_block", "label": "Ceremony block", "hard": True,
     "params_schema": {"date": "date", "from": "time", "to": "time", "venues": "list"},
     "scopes": ["all"], "layer": "S"},
    # Pinned matches are placed FIRST; earlier rounds back-fill respecting
    # rest ("football final last day 14:00"). Optional ``venues`` (increment
    # T): when present the pinned round lands ONLY on those venues (hard) —
    # "the final plays on Center Court".
    {"type": "round_pinned_to_window", "label": "Pin a round to a window", "hard": True,
     "params_schema": {"round": "str", "date": "date", "from": "time", "to": "time",
                       "venues": "list"},
     "scopes": ["leaf"], "layer": "S"},
    # Soft = per-competition window scoring; the hard toggle = grid filter
    # (U14 mornings, U17 afternoons — §9 A8).
    {"type": "category_session_window", "label": "Competition session window", "hard": False,
     "params_schema": {"days": "list", "from": "time", "to": "time"},
     "scopes": ["sport", "leaf"], "layer": "S"},
    # Resource-capacity engine (§2.4): caps concurrent in-flight matches per
    # sport ("only 2 qualified TT umpires"); scope "all" caps tournament-wide
    # concurrency (scorer/stream/medic capacity — §9 A8).
    {"type": "official_capacity", "label": "Concurrent-match capacity (officials)", "hard": True,
     "params_schema": {"count": "int"}, "scopes": ["sport", "all"], "layer": "S"},
    # Formalizes the linked-team shared-player non-overlap (invariant 8) as a
    # visible record with tunable gaps.
    {"type": "no_person_overlap", "label": "No person plays overlapping matches", "hard": True,
     "params_schema": {"min_gap_minutes": "int", "cross_venue_gap_minutes": "int"},
     "scopes": ["all"], "layer": "S"},
    # Directive: dates excluded at generation, reserved for the postponement
    # repair tool; scope sport: lets indoor sports keep playing.
    {"type": "reserve_days", "label": "Reserve days (kept free for repairs)", "hard": True,
     "params_schema": {"dates": "list"}, "scopes": ["all", "sport"], "layer": "S"},
    # Mutual-exclusion group (owner ask 2026-06-18): the named competitions
    # (sport keys and/or leaf keys) may never be live at the same moment —
    # even on separate courts — because they share athletes, officials, a
    # venue, or one audience. Matches of the SAME member still run in
    # parallel. ``gap_minutes`` (optional) forces a transition buffer between
    # different members. Inherently a relationship across competitions, so it
    # carries its targets in ``params.members`` and scopes only "all".
    {"type": "no_concurrent_competitions", "hard": True,
     "label": "Competitions that can't run at the same time",
     "params_schema": {"members": "list", "gap_minutes": "int"},
     "scopes": ["all"], "layer": "S"},
]

_BY_TYPE = {c["type"]: c for c in CONSTRAINT_TYPES}

# ------------------------------------------------------------------- scope grammar
_SCOPE_PREFIXES = ("sport", "leaf", "team", "tag")
_SCOPE_SPECIFICITY = {"all": 0, "tag": 1, "sport": 2, "leaf": 3, "team": 4}


def parse_scope(scope: Any) -> str:
    """Validate + normalize a scope expression (spec §2.2 grammar). Raises
    ValueError on unknown grammar — applied to NEW records at write time."""
    if scope in (None, ""):
        return "all"
    if not isinstance(scope, str):
        raise ValueError(f"invalid constraint scope: {scope!r}")
    s = scope.strip()
    if s == "all":
        return "all"
    kind, sep, value = s.partition(":")
    kind, value = kind.strip(), value.strip()
    if not sep or kind not in _SCOPE_PREFIXES or not value:
        raise ValueError(f"invalid constraint scope: {scope!r}")
    if kind == "tag":
        key, eq, val = value.partition("=")
        key, val = key.strip(), val.strip()
        if not eq or not key or not val:
            raise ValueError(
                f"invalid tag scope (expected tag:<key>=<value>): {scope!r}"
            )
        return f"tag:{key}={val}"
    return f"{kind}:{value}"


def normalize_scope(scope: Any) -> str:
    """Lenient parse for STORED records: legacy/garbage scopes read as
    ``"all"`` (spec §2.2 — never break an existing tournament)."""
    try:
        return parse_scope(scope)
    except ValueError:
        return "all"


def scope_specificity(scope: Any) -> int:
    """Rank for "most-specific scope wins" resolution (§9 A3):
    team > leaf > sport > tag > all."""
    kind = normalize_scope(scope).partition(":")[0]
    return _SCOPE_SPECIFICITY.get(kind, 0)


def scope_matches(
    scope: Any,
    *,
    sport: str = "",
    leaf_key: str = "",
    team_ids: Sequence[str] = (),
    team_tags: Mapping[str, Mapping[str, str]] | None = None,
) -> bool:
    """Does a record's scope apply to a match/team context? ``team_tags`` maps
    team_id -> {tag_key: value} (resolved against existing data — school /
    district / seed_pot / institution attributes)."""
    s = normalize_scope(scope)
    if s == "all":
        return True
    kind, _, value = s.partition(":")
    if kind == "sport":
        return sport == value
    if kind == "leaf":
        return leaf_key == value
    if kind == "team":
        return value in team_ids
    if kind == "tag":
        key, _, val = value.partition("=")
        for tid in team_ids:
            if str((team_tags or {}).get(tid, {}).get(key, "")) == val:
                return True
    return False


# ------------------------------------------------------------------------ weight
def parse_weight(value: Any) -> int:
    """Soft-constraint weight: integer 1-10, default 5 (spec §2.2). Raises
    ValueError outside the range (hard constraints simply ignore it)."""
    if value is None:
        return DEFAULT_WEIGHT
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("constraint weight must be an integer between 1 and 10")
    if not 1 <= value <= 10:
        raise ValueError("constraint weight must be between 1 and 10")
    return value


def validate_constraints(items: Any) -> list[dict[str, Any]]:
    """Validate + normalize a tournament's constraints list.

    Raises ValueError on a non-list, an unknown constraint type, an invalid
    scope expression, or an out-of-range weight. Each item is normalized to
    {type, scope, hard, weight, params}.
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
                "scope": parse_scope(item.get("scope")),
                "hard": bool(item.get("hard", spec["hard"])),
                "weight": parse_weight(item.get("weight")),
                "params": (
                    item.get("params", {})
                    if isinstance(item.get("params", {}), dict) else {}
                ),
            }
        )
    return out


# ------------------------------------------------------------------- tag resolution
def team_tag_map(tournament) -> dict[str, dict[str, str]]:
    """Resolve every registered team's tag values for ``tag:<k>=<v>`` scopes
    (spec §2.2): ``school`` = institution id, ``district`` = the Stage-1
    institution answer (``Institution.attributes["district"]``, falling back
    to ``region``), ``seed_pot`` = the team's seed quartile within its leaf
    cohort, plus any free-form string ``Institution.attributes`` labels."""
    from apps.teams.models import Institution, Team, TeamStatus

    insts = {
        str(i.id): i
        for i in Institution.objects.filter(
            tournament=tournament, deleted_at__isnull=True
        )
    }
    teams = list(
        Team.objects.filter(
            tournament=tournament, status=TeamStatus.REGISTERED,
            deleted_at__isnull=True,
        )
    )
    # seed quartiles per leaf cohort (1..4, 1 = top seeds)
    pots: dict[str, str] = {}
    by_leaf: dict[str, list] = {}
    for tm in teams:
        by_leaf.setdefault(tm.leaf_key or "", []).append(tm)
    for cohort in by_leaf.values():
        seeded = sorted(
            (tm for tm in cohort if tm.seed is not None),
            key=lambda tm: (tm.seed, tm.name),
        )
        for idx, tm in enumerate(seeded):
            pots[str(tm.id)] = str(1 + (4 * idx) // len(seeded))

    out: dict[str, dict[str, str]] = {}
    for tm in teams:
        tags: dict[str, str] = {}
        inst = insts.get(str(tm.institution_id)) if tm.institution_id else None
        if inst is not None:
            tags["school"] = str(inst.id)
            for k, v in (inst.attributes or {}).items():
                if isinstance(v, (str, int)) and not isinstance(v, bool):
                    tags.setdefault(str(k), str(v))
            district = (inst.attributes or {}).get("district") or inst.region
            if district:
                tags["district"] = str(district)
        if str(tm.id) in pots:
            tags["seed_pot"] = pots[str(tm.id)]
        out[str(tm.id)] = tags
    return out
