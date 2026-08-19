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
# The finish phases a host can sequence with ``phased_finish``, in the order a
# bracket reaches them. The vocabulary is fixed (the engine has to recognise
# each one from the draw); WHICH of them are barriers, and in what order, is
# entirely authored.
FINISH_PHASES: tuple[str, ...] = ("earlier", "semi_final", "third_place", "final")

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
    # Round-wise rotation fairness (owner ask 2026-06-25, R7): within a
    # round-robin competition, the next match should go to the teams that have
    # played the FEWEST games and rested the LONGEST — "give not-yet-played
    # teams the chance" before any team plays again. Drives both the asynchronous
    # match-ordering (scheduler.fairness_order, Suksompong) and a soft slot
    # reward; only round-robin (non-knockout, resolved) matches in scope are
    # affected. Per-category by scope, like the rest buffer.
    {"type": "rotation_fairness", "label": "Round-wise rotation fairness", "hard": False,
     "params_schema": {}, "scopes": ["all", "sport", "leaf"], "layer": "S"},
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
     "params_schema": {"round": "str", "date": "date_or_last_day",
                       "from": "time", "to": "time", "venues": "list"},
     # Scoped to a sport or the whole tournament, ONE record puts every
     # competition's final on the show court (owner 2026-08-17). "final" is
     # resolved per competition, so a 3-round bracket and a 5-round bracket
     # each pin their own last round.
     "scopes": ["all", "sport", "leaf"], "layer": "S"},
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
    # The opening-round separation, promoted from an always-on code path to a
    # record an organiser can see and change (owner 2026-08-17). Absent, it
    # behaves exactly as it always has: keep the same institution apart.
    # ``key``: "institution" | "group" (house) | "none".
    {"type": "opening_round_separation", "hard": False,
     "label": "Keep the same competitor apart in round one",
     "params_schema": {"key": "str"}, "scopes": ["all"], "layer": "P"},
    # Two teams sent by the SAME SCHOOL can't play at once when one adult
    # travels with both (owner 2026-08-15: "the teacher in-charges of the
    # school cannot be in two courts"). Keyed on the declared teacher, not on
    # the school, so a school that sends two teachers can legitimately use two
    # courts — a blanket school rule would have forbidden that. Enabling it
    # with no roster declared is a no-op, never a silent block.
    {"type": "no_staff_overlap", "hard": True,
     "label": "A teacher in charge is only in one place",
     "params_schema": {"min_gap_minutes": "int", "cross_venue_gap_minutes": "int"},
     "scopes": ["all"], "layer": "S"},
    # The blunter form of the rule above, for tournaments with no roster: no
    # two teams of one institution play at the same moment. Off by default —
    # it costs real schedule room, and the staff rule is the precise version.
    # Same-school keep-apart (owner 2026-08-18): "if one school is playing
    # under-14 sepak the same school should not be scheduled on the other court
    # for girls … if they are different sports it's fine". So `within` decides
    # how far the rule reaches — sport (the default, and the owner's rule),
    # leaf (one exact competition), or any (the blunt original). Scope narrows
    # it further, e.g. `sport:sepak_takraw` to bind sepak and nothing else.
    {"type": "no_institution_overlap", "hard": True,
     "label": "A school never plays two matches at once",
     "params_schema": {"within": "str", "min_gap_minutes": "int",
                       "cross_venue_gap_minutes": "int"},
     "param_options": {"within": ["sport", "leaf", "any"]},
     "scopes": ["all", "sport", "leaf"], "layer": "S"},
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
    # Which competition gets the early slots (owner 2026-08-17: "the host can
    # set up which category should be scheduled first and which is the next
    # priority"). Without it the placement order is (stage, round, match) with
    # NO competition term, so every category's round 1 interleaves in whatever
    # order the draw emitted — which reads as random.
    #
    # It is an ORDERING directive, never a filter: it changes which match asks
    # for a slot first, so it can reshape a day but can never make one
    # infeasible, and it reports no violations. ``order`` is the host's own
    # list, most important first — a leaf key, a leaf-key PREFIX
    # ("table_tennis.u_14" = both genders) or a whole sport key, matched
    # segment-aligned like a court reservation. Anything unlisted simply
    # sorts last, so a host can name only the two categories they care about.
    #
    # ``mode`` decides how hard the order bites: "sequential" drains a
    # competition before the next one is attempted (finish U-14 boys, then
    # start the opens); "within_round" keeps every competition progressing
    # together and only decides who goes first inside each round.
    {"type": "competition_priority", "hard": False,
     "label": "Which competition is scheduled first",
     "params_schema": {"order": "order", "mode": "str"},
     "param_options": {"mode": ["sequential", "within_round"]},
     "scopes": ["all", "sport"], "layer": "S"},
    # Keep the closing rounds for the closing days (owner 2026-08-17: "for the
    # finals or semi finals we can have an option to be held on the next day,
    # so the first few days all categories play and on the end days we play
    # only the finals and semis").
    #
    # ``rounds_from_end`` counts back from each competition's OWN last round,
    # resolved per competition — 1 = the final, 2 = final + semi-finals. So one
    # record covers a tournament whose categories have different bracket
    # depths, which naming literal round numbers could never do.
    # ``from_date`` is the first day those rounds may play ("last_day" resolves
    # to the schedule's last date). ``exclusive`` closes the other direction:
    # from that day on, ONLY closing rounds may play.
    {"type": "closing_rounds_window", "hard": True,
     "label": "Finals and semi-finals play on the closing days",
     "params_schema": {"rounds_from_end": "int",
                       "from_date": "date_or_last_day",
                       "exclusive": "bool"},
     "scopes": ["all", "sport", "leaf"], "layer": "S"},
    # Finish the whole tournament in phases (owner 2026-08-19: "all categories
    # play up to their semi final, and only after all categories have played
    # their semi do the third places play, and all finals at the very end —
    # girls' final first, boys' last").
    #
    # ``closing_rounds_window`` can clear the last DAYS for the closing rounds;
    # it cannot sequence what happens inside them, and the third-place match
    # shares its round number with the final, so no count of rounds can put one
    # after the other. This rule names the phases themselves.
    #
    # ``order`` is the sequence of phases, each one a barrier: no match of a
    # phase may start until every match of the phase before it has finished.
    # A phase left out of the list is not part of the rule. ``final_order``
    # orders the LAST listed phase among itself, through the same competition
    # grammar the priority order uses — so "girls" then "boys" is two entries,
    # not one per category.
    #
    # ``one_at_a_time`` makes the last phase a solo act: with "sport", two
    # finals of the SAME sport never overlap (one table tennis final at a
    # time), while a sepak final may still run alongside one in the hall next
    # door — which is the point of having two halls. "all" allows exactly one
    # final anywhere; "none" (the default) leaves them free to share a slot.
    {"type": "phased_finish", "hard": True,
     "label": "Finish in phases: semi-finals, then third places, then finals",
     "params_schema": {"order": "phase_order", "final_order": "order",
                       "one_at_a_time": "str"},
     "param_options": {"order": list(FINISH_PHASES),
                       "one_at_a_time": ["none", "sport", "all"]},
     "scopes": ["all", "sport", "leaf"], "layer": "S"},
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
