"""Flexible, declarative fixture-scheduling engine (FET-style).

The generator (``generate.py``) decides WHO plays WHOM (pairings + bracket
pointers). This engine decides WHEN and WHERE each match happens — it assigns
every match a ``scheduled_at`` + ``venue`` from a resource model (date range,
daily windows, venues with their own windows/types, per-sport durations) while
satisfying **hard** constraints and optimising **soft** ones, and it explains
what it did.

Hard constraints: venue interval-overlap occupancy, team rest gaps, max
matches per team per day, team blackout dates, venue-type compatibility,
calendar windows. The records stored on ``Tournament.constraints`` are
interpreted at run time by ``merge_stored_constraints`` (spec 2026-06-10 B5 —
they used to be validated but never read). Soft: preferred windows, venue
balancing, day spread — scored, never blocking.

Per-sport durations come from the SPORT_PROFILES registry / per-tournament
``sports[].scheduling`` overrides, so a 100-minute football match and a
30-minute table-tennis match coexist on one calendar. Matches in flight are
never rescheduled (status guard), and runs can target a single category leaf
while respecting every other competition's bookings.

Design (spec 2026-06-08 §3): a constructive heuristic behind a clean
interface so a CP-SAT/OR-Tools backend can replace ``schedule_matches`` later
without touching callers.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.utils.translation import gettext as _

from apps.fixtures.services.constraints import (
    DEFAULT_WEIGHT,
    normalize_scope,
    parse_weight,
    scope_matches,
    scope_specificity,
)


# --------------------------------------------------------------------------- config
@dataclass
class ScopedRule:
    """One stored constraint record resolved into the engine's runtime model
    (redesign spec §2.2/§9 A3): scope filters WHICH ``MatchSlotReq`` it
    applies to; ``weight`` multiplies soft scores; params are pre-parsed
    (dates as ``date`` sets, times as ``time``, weekdays as ints)."""

    type: str
    scope: str = "all"
    hard: bool = True
    weight: int = DEFAULT_WEIGHT
    params: dict[str, Any] = field(default_factory=dict)
    # The original stored record (JSON-safe) — echoed back inside structured
    # violations so the UI can point at the exact constraint to relax.
    record: dict[str, Any] | None = None


@dataclass
class ScheduleConfig:
    """Resource model for a scheduling run (wizard payload + stored
    constraints; see ``config_from_dict`` / ``merge_stored_constraints``)."""

    date_start: date
    date_end: date
    daily_start: time = time(9, 0)
    daily_end: time = time(18, 0)
    slot_minutes: int = 90          # default duration + start-grid step
    venues: list[str] = field(default_factory=lambda: ["Main Ground"])
    rest_minutes: int = 60          # min gap between a team's matches
    max_per_team_per_day: int = 1
    excluded_dates: set[date] = field(default_factory=set)
    # Per-venue availability override: {venue: [(start, end)]}. Empty means the
    # venue inherits the tournament daily window every non-excluded day.
    venue_windows: dict[str, list[tuple[time, time]]] = field(default_factory=dict)
    # Venue typing ({venue: "ground"|"indoor_court"|...}); a match requiring a
    # type only lands on venues of that type (untyped venues accept anything).
    venue_types: dict[str, str] = field(default_factory=dict)
    # Hard per-team blackout dates ({team_id: {date, ...}}).
    team_blackouts: dict[str, set[date]] = field(default_factory=dict)
    # Soft: prefer starts inside these windows; balance load across venues.
    preferred_windows: list[tuple[time, time]] = field(default_factory=list)
    balance_venues: bool = False
    # Scoped/weighted records resolved per MatchSlotReq (redesign spec §9 A3):
    # the scalars above stay as the global ("all"-scope) defaults; records
    # with a narrower scope land here and win by specificity.
    constraint_rules: list[ScopedRule] = field(default_factory=list)
    # team_id -> {tag_key: value} for tag:<k>=<v> scopes (resolved from
    # institution data by the caller; empty = tag scopes match nothing).
    team_tags: dict[str, dict[str, str]] = field(default_factory=dict)
    # Courts/tables per venue (redesign §2.3): count=N expands into N parallel
    # sub-venues ("Hall · T1"… — see ``expand_venues``); 1/absent = as-is.
    venue_counts: dict[str, int] = field(default_factory=dict)
    # no_person_overlap gaps in minutes (§2.4/§9 A3): None = legacy behavior
    # (linked teams use the team rest gap, venue-agnostic).
    person_min_gap: int | None = None
    person_cross_venue_gap: int | None = None
    # Reserve days the rain-day shift has put into use (repair seam,
    # increment D): persisted on ``tournament.scheduling_config`` as
    # ``activated_reserve_days`` and subtracted from every stored
    # ``reserve_days`` record at merge time, so the grid/validation/re-runs
    # treat the day as available once matches actually live on it.
    activated_reserve_days: set[date] = field(default_factory=set)


def _parse_date(v: Any) -> date | None:
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, str) and v:
        return date.fromisoformat(v[:10])
    return None


def _parse_time(v: Any, default: time) -> time:
    if isinstance(v, time):
        return v
    if isinstance(v, str) and v:
        h, m, *_ = [*v.split(":"), "0"]
        return time(int(h), int(m))
    return default


_WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def _parse_weekdays(v: Any) -> set[int] | None:
    """Weekday list params ("days") → Python weekday ints (Mon=0). Accepts
    ints 0-6 or names ("sun", "Sunday"). None/empty ⇒ all days (None)."""
    if not v:
        return None
    out: set[int] = set()
    for item in v if isinstance(v, list) else [v]:
        if isinstance(item, int) and 0 <= item <= 6:
            out.add(item)
        elif isinstance(item, str) and item.strip()[:3].lower() in _WEEKDAYS:
            out.add(_WEEKDAYS[item.strip()[:3].lower()])
    return out or None


def config_from_dict(d: dict[str, Any]) -> ScheduleConfig:
    """Parse the wizard/API scheduling payload into a ScheduleConfig.

    Required: date_start, date_end (ISO). Venues may be plain names or rich
    records ``{name, venue_type?, windows?: [{from, to}, ...]}``. Everything
    else has sane defaults so a minimal request still schedules.
    """
    ds = _parse_date(d.get("date_start"))
    de = _parse_date(d.get("date_end")) or ds
    if ds is None:
        raise ValueError("date_start is required")
    daily_start = _parse_time(d.get("daily_start"), time(9, 0))
    daily_end = _parse_time(d.get("daily_end"), time(18, 0))

    venues: list[str] = []
    venue_windows: dict[str, list[tuple[time, time]]] = {}
    venue_types: dict[str, str] = {}
    venue_counts: dict[str, int] = {}
    for v in d.get("venues") or []:
        if isinstance(v, dict):
            name = str(v.get("name") or "").strip()
            if not name:
                continue
            venues.append(name)
            if v.get("venue_type"):
                venue_types[name] = str(v["venue_type"]).strip()
            try:
                count = int(v.get("count") or 1)
            except (TypeError, ValueError):
                count = 1
            if count > 1:
                venue_counts[name] = count
            wins = [
                (_parse_time(w.get("from"), daily_start),
                 _parse_time(w.get("to"), daily_end))
                for w in (v.get("windows") or [])
                if isinstance(w, dict)
            ]
            if wins:
                venue_windows[name] = wins
        elif str(v).strip():
            venues.append(str(v).strip())
    if not venues:
        venues = ["Main Ground"]

    excluded = {x for x in (_parse_date(e) for e in d.get("excluded_dates", [])) if x}
    activated = {
        x for x in (
            _parse_date(e) for e in d.get("activated_reserve_days", [])
        ) if x
    }
    return ScheduleConfig(
        date_start=ds,
        date_end=de,
        daily_start=daily_start,
        daily_end=daily_end,
        slot_minutes=int(d.get("slot_minutes", 90)),
        venues=venues,
        rest_minutes=int(d.get("rest_minutes", 60)),
        max_per_team_per_day=int(d.get("max_per_team_per_day", 1)),
        excluded_dates=excluded,
        venue_windows=venue_windows,
        venue_types=venue_types,
        venue_counts=venue_counts,
        activated_reserve_days=activated,
    )


def merge_stored_constraints(cfg: ScheduleConfig, constraints: list | None) -> list[str]:
    """Interpret the tournament's stored constraint records into the engine's
    resource model (the catalog in ``constraints.py`` defines the shapes).
    Returns explanation lines for the run report.

    Scope + weight are REAL here (redesign spec §2.2/§9 A3): an "all"-scope
    hard record keeps mutating the matching config scalar (legacy behavior);
    a scoped (sport:/leaf:/team:/tag:) or soft record becomes a ``ScopedRule``
    resolved per match inside ``schedule_matches``."""
    notes: list[str] = []
    for c in constraints or []:
        ctype = c.get("type")
        p = c.get("params") or {}
        scope = normalize_scope(c.get("scope"))
        hard = bool(c.get("hard", True))
        try:
            weight = parse_weight(c.get("weight"))
        except ValueError:
            weight = DEFAULT_WEIGHT
        scoped = scope != "all"

        if ctype == "blackout_dates":
            dates = {x for x in (_parse_date(v) for v in p.get("dates", [])) if x}
            if not dates:
                continue
            if scoped:
                cfg.constraint_rules.append(ScopedRule(
                    "blackout_dates", scope, hard, weight, {"dates": dates},
                    record=c))
                notes.append(
                    f"Applied blackout dates ({scope}): {len(dates)} day(s)."
                )
            else:
                cfg.excluded_dates |= dates
                notes.append(f"Applied blackout dates: {len(dates)} day(s).")
        elif ctype == "team_unavailable":
            tid = str(p.get("team_id") or "")
            dates = {x for x in (_parse_date(v) for v in p.get("dates", [])) if x}
            if tid and dates:
                cfg.team_blackouts.setdefault(tid, set()).update(dates)
                notes.append(f"Team {tid[:8]}… unavailable on {len(dates)} day(s).")
        elif ctype == "min_rest_minutes":
            minutes = int(p.get("minutes") or 0)
            if minutes <= 0:
                continue
            if scoped or not hard:
                cfg.constraint_rules.append(ScopedRule(
                    "min_rest_minutes", scope, hard, weight,
                    {"minutes": minutes}, record=c))
                notes.append(
                    f"Rest gap of {minutes} minutes for {scope} "
                    f"({'hard' if hard else 'soft'})."
                )
            elif minutes > cfg.rest_minutes:
                cfg.rest_minutes = minutes
                notes.append(f"Raised rest gap to {minutes} minutes (stored constraint).")
        elif ctype == "max_matches_per_team_per_day":
            count = int(p.get("count") or 0)
            if count < 1:
                continue
            if scoped:
                cfg.constraint_rules.append(ScopedRule(
                    "max_matches_per_team_per_day", scope, hard, weight,
                    {"count": count}, record=c))
                notes.append(f"Max matches per team per day for {scope}: {count}.")
            else:
                cfg.max_per_team_per_day = count
                notes.append(f"Max matches per team per day: {count} (stored constraint).")
        elif ctype in ("preferred_window", "category_session_window"):
            cfg.constraint_rules.append(ScopedRule(ctype, scope, hard, weight, {
                "days": _parse_weekdays(p.get("days")),
                "from": _parse_time(p.get("from"), cfg.daily_start),
                "to": _parse_time(p.get("to"), cfg.daily_end),
            }, record=c))
            notes.append(
                "Preferring matches inside the stored preferred window."
                if ctype == "preferred_window" and not hard
                else f"'{ctype}' window for {scope} "
                     f"({'hard grid filter' if hard else 'soft, weighted'})."
            )
        elif ctype == "balance_venues":
            cfg.balance_venues = True
            cfg.constraint_rules.append(ScopedRule(
                "balance_venues", scope, False, weight, {}, record=c))
            notes.append("Balancing matches across venues (soft).")
        elif ctype == "recurring_blackout_window":
            cfg.constraint_rules.append(ScopedRule(ctype, scope, hard, weight, {
                "days": _parse_weekdays(p.get("days")),
                "from": _parse_time(p.get("from"), cfg.daily_start),
                "to": _parse_time(p.get("to"), cfg.daily_end),
            }, record=c))
            notes.append(
                f"Recurring blocked window applied"
                f"{'' if scope == 'all' else f' ({scope})'}."
            )
        elif ctype == "ceremony_block":
            day = _parse_date(p.get("date"))
            if day is None:
                continue
            venues = [str(v) for v in p.get("venues") or []] or None
            cfg.constraint_rules.append(ScopedRule(ctype, "all", True, weight, {
                "date": day,
                "from": _parse_time(p.get("from"), cfg.daily_start),
                "to": _parse_time(p.get("to"), cfg.daily_end),
                "venues": venues,
            }, record=c))
            notes.append(f"Ceremony block on {day} removed from the grid.")
        elif ctype == "reserve_days":
            # Activated reserve days (rain-day shift, increment D) are in
            # use — they re-join the calendar instead of being excluded.
            dates = {
                x for x in (_parse_date(v) for v in p.get("dates", [])) if x
            } - cfg.activated_reserve_days
            if not dates:
                continue
            if scoped:
                cfg.constraint_rules.append(ScopedRule(
                    ctype, scope, True, weight, {"dates": dates}, record=c))
                notes.append(
                    f"{len(dates)} reserve day(s) kept free for {scope}."
                )
            else:
                cfg.excluded_dates |= dates
                notes.append(
                    f"{len(dates)} reserve day(s) kept free for postponements."
                )
        elif ctype == "round_pinned_to_window":
            raw_date = p.get("date")
            pin_date: Any = "last_day" if raw_date == "last_day" \
                else _parse_date(raw_date)
            cfg.constraint_rules.append(ScopedRule(ctype, scope, True, weight, {
                "round": p.get("round"),
                "date": pin_date,
                "from": _parse_time(p["from"], cfg.daily_start)
                if p.get("from") else None,
                "to": _parse_time(p["to"], cfg.daily_end)
                if p.get("to") else None,
            }, record=c))
            notes.append(
                f"Round '{p.get('round')}' pinned to its window ({scope})."
            )
        elif ctype == "official_capacity":
            count = int(p.get("count") or 0)
            if count >= 1:
                cfg.constraint_rules.append(ScopedRule(
                    ctype, scope, True, weight, {"count": count}, record=c))
                notes.append(
                    f"At most {count} concurrent match(es) for {scope} "
                    f"(official capacity)."
                )
        elif ctype == "no_person_overlap":
            cfg.person_min_gap = int(p.get("min_gap_minutes") or 30)
            cfg.person_cross_venue_gap = int(p.get("cross_venue_gap_minutes") or 60)
            notes.append(
                f"Shared-player gaps: {cfg.person_min_gap}' same venue, "
                f"{cfg.person_cross_venue_gap}' across venues."
            )
        elif ctype in ("even_spacing", "avoid_back_to_back"):
            notes.append(f"'{ctype}' is optimised by the built-in day-spread scoring.")
        # keep_apart_until_round is a PAIRING-layer record — generate.py
        # enforces it when forming groups/brackets (redesign §4.6), so it is
        # silently out of scope for slot assignment.
        # no_double_booking_team / venue_single_use are always-on hard rules.
    return notes


# --------------------------------------------------------------------------- slots
def expand_venues(cfg: ScheduleConfig) -> list[tuple[str, str]]:
    """``(display_name, base_name)`` pairs: a venue with ``count=N`` becomes N
    parallel sub-venues ("Hall · T1"…) sharing the base venue's windows and
    type (redesign §2.3). ``count<=1`` venues pass through unchanged."""
    out: list[tuple[str, str]] = []
    for name in cfg.venues:
        n = max(1, int(cfg.venue_counts.get(name, 1)))
        if n == 1:
            out.append((name, name))
        else:
            out.extend((f"{name} · T{i}", name) for i in range(1, n + 1))
    return out


def _subtract_windows(
    windows: list[tuple[time, time]], cuts: list[tuple[time, time]],
) -> list[tuple[time, time]]:
    """Remove the ``cuts`` intervals from the availability ``windows`` —
    a window containing a cut splits around it (the grid re-opens exactly at
    the cut's end, no re-alignment to the slot step)."""
    out = list(windows)
    for c_start, c_end in cuts:
        nxt: list[tuple[time, time]] = []
        for w_start, w_end in out:
            if c_end <= w_start or c_start >= w_end:
                nxt.append((w_start, w_end))
                continue
            if w_start < c_start:
                nxt.append((w_start, c_start))
            if c_end < w_end:
                nxt.append((c_end, w_end))
        out = nxt
    return out


def build_slots(cfg: ScheduleConfig) -> list[tuple[datetime, str, datetime]]:
    """Enumerate candidate (start, venue, window_end) slots across the
    calendar. Starts step by ``slot_minutes``; whether a given match FITS a
    slot depends on its own duration (checked against window_end).

    The grid is built SUBTRACTIVELY (redesign §3): daily window minus
    "all"-scope recurring blackout windows, blackout/reserve dates, ceremonies,
    intersected per-venue with the venue's own windows; ``count`` expands a
    venue into parallel sub-venues. Sport-/leaf-scoped cuts can't live on the
    shared grid — ``schedule_matches`` enforces those per match."""
    slots: list[tuple[datetime, str, datetime]] = []
    recurring = [
        r for r in cfg.constraint_rules
        if r.type == "recurring_blackout_window" and r.hard and r.scope == "all"
    ]
    ceremonies = [
        r for r in cfg.constraint_rules if r.type == "ceremony_block"
    ]
    reserved: set[date] = set()
    for r in cfg.constraint_rules:
        if r.type == "reserve_days" and r.scope == "all":
            reserved |= r.params.get("dates") or set()
    d = cfg.date_start
    one_day = timedelta(days=1)
    step = timedelta(minutes=cfg.slot_minutes)
    while d <= cfg.date_end:
        if d not in cfg.excluded_dates and d not in reserved:
            for venue, base in expand_venues(cfg):
                windows = cfg.venue_windows.get(base) or [(cfg.daily_start, cfg.daily_end)]
                cuts = [
                    (r.params["from"], r.params["to"]) for r in recurring
                    if not r.params.get("days") or d.weekday() in r.params["days"]
                ]
                cuts += [
                    (r.params["from"], r.params["to"]) for r in ceremonies
                    if r.params.get("date") == d and (
                        not r.params.get("venues")
                        or base in r.params["venues"] or venue in r.params["venues"]
                    )
                ]
                for w_start, w_end in _subtract_windows(windows, cuts):
                    cur = datetime.combine(d, w_start)
                    end = datetime.combine(d, w_end)
                    while cur < end:
                        slots.append((cur, venue, end))
                        cur += step
        d += one_day
    slots.sort(key=lambda s: (s[0], s[1]))
    return slots


# --------------------------------------------------------------------------- match input
@dataclass
class MatchSlotReq:
    """The scheduling view of a match — pairing, ordering + resource needs."""

    id: str
    round_no: int
    match_no: int
    home: str | None        # team id or None (unresolved knockout slot)
    away: str | None
    leaf_key: str = ""
    sport: str = ""
    duration_minutes: int | None = None   # None → cfg.slot_minutes
    venue_type: str = ""                  # "" → any venue
    stage: str = ""                       # "group"|"knockout" — pinned-round resolution


@dataclass
class ScheduleResult:
    assignments: dict[str, tuple[datetime, str]]  # match_id -> (start, venue)
    unscheduled: list[str]
    soft_score: float          # 0..1, higher = better soft-constraint satisfaction
    explanation: list[str]
    # Structured hard-constraint failures (redesign §3 infeasibility contract,
    # §9 A5): JSON-safe records {code, params, message, hard, constraint,
    # matches, relaxations:[{action, code, params}]} — the FE localizes from
    # the stable code, never string-matches the message.
    violations: list[dict[str, Any]] = field(default_factory=list)


# Pre-existing bookings the run must respect (other leaves / live matches):
# (venue, start, end, [team_ids]).
Preoccupied = list[tuple[str, datetime, datetime, list[str]]]


def _overlaps(busy: list[tuple[datetime, datetime]], start: datetime,
              end: datetime, gap: timedelta = timedelta(0)) -> bool:
    return any(start < e + gap and s < end + gap for s, e in busy)


# --------------------------------------------------------------------------- engine
def schedule_matches(
    matches: list[MatchSlotReq], cfg: ScheduleConfig,
    preoccupied: Preoccupied | None = None,
    linked: dict[str, set[str]] | None = None,
) -> ScheduleResult:
    """Greedy constructive scheduler honouring HARD constraints:

      * a venue hosts one match at a time (interval overlap, not slot equality
        — durations differ per sport)
      * a team never plays two matches that overlap or violate ``rest_minutes``
      * a team plays at most ``max_per_team_per_day`` per day
      * a team never plays on its blackout dates
      * a match requiring a venue type only lands on venues of that type
      * only within available (date, window, venue) slots — a match must FIT
        its window given its own duration
      * ``linked`` teams (sharing a rostered player — one student in U15
        football AND badminton singles, W2-D) never play overlapping
        matches; the rest gap applies across the link too

    Soft signals (preferred windows, venue balance, day spread) pick among
    feasible slots and feed ``soft_score``. ``preoccupied`` bookings (other
    competitions, live matches) are respected but never moved. Unplaceable
    matches are reported, not dropped. Deterministic.
    """
    slots = build_slots(cfg)
    assignments: dict[str, tuple[datetime, str]] = {}
    venue_busy: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)
    team_busy: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)
    team_day: dict[tuple[str, date], int] = defaultdict(int)
    venue_load: dict[str, int] = defaultdict(int)
    unscheduled: list[str] = []
    rest = timedelta(minutes=cfg.rest_minutes)

    # Scoped rule lists (redesign spec §9 A3) resolved per match below.
    rules = cfg.constraint_rules
    hard_rest_rules = [r for r in rules if r.type == "min_rest_minutes" and r.hard]
    soft_rest_rules = [r for r in rules if r.type == "min_rest_minutes" and not r.hard]
    day_rules = [r for r in rules
                 if r.type == "max_matches_per_team_per_day" and r.hard]
    blackout_rules = [r for r in rules if r.type == "blackout_dates" and r.hard]
    window_types = ("preferred_window", "category_session_window")
    hard_windows = [r for r in rules if r.type in window_types and r.hard]
    soft_windows = [r for r in rules if r.type in window_types and not r.hard]
    balance_rules = [r for r in rules if r.type == "balance_venues"]
    recurring_scoped = [
        r for r in rules
        if r.type == "recurring_blackout_window" and r.hard and r.scope != "all"
    ]
    reserve_scoped = [
        r for r in rules if r.type == "reserve_days" and r.scope != "all"
    ]
    capacity_rules = [r for r in rules if r.type == "official_capacity"]
    pinned_rules = [r for r in rules if r.type == "round_pinned_to_window"]

    # Sub-venue expansion (§2.3): display name -> base name, and the parallel
    # units of each expanded base.
    base_of = dict(expand_venues(cfg))
    subs_by_base: dict[str, list[str]] = defaultdict(list)
    for disp, base in base_of.items():
        subs_by_base[base].append(disp)
    # Venue-tagged team intervals (shared-player cross-venue gaps, §9 A3) and
    # the in-flight interval list the capacity engine counts against.
    team_busy_v: dict[str, list[tuple[datetime, datetime, str]]] = defaultdict(list)
    inflight: list[tuple[datetime, datetime, str, str]] = []  # start, end, sport, leaf
    pre_intervals: list[tuple[datetime, datetime]] = []

    for venue, start, end, team_ids in preoccupied or []:
        # Absorption rule (§9 A2): a legacy booking under an expanded venue's
        # BARE name consumes one unit of its capacity — the lowest-numbered
        # free sub-venue; at/over capacity it blocks every unit.
        subs = subs_by_base.get(venue) or [venue]
        if subs == [venue]:
            targets = [venue]
        else:
            free = [s for s in subs if not _overlaps(venue_busy[s], start, end)]
            targets = [free[0]] if free else subs
        for tv in targets:
            venue_busy[tv].append((start, end))
        pre_intervals.append((start, end))
        for t in team_ids:
            team_busy[t].append((start, end))
            team_busy_v[t].append((start, end, targets[0]))
            team_day[(t, start.date())] += 1

    def _scope_ok(rule: ScopedRule, m: MatchSlotReq,
                  team_ids: tuple[str, ...]) -> bool:
        return scope_matches(rule.scope, sport=m.sport, leaf_key=m.leaf_key,
                             team_ids=team_ids, team_tags=cfg.team_tags)

    def _rest_for(m: MatchSlotReq, t: str) -> timedelta:
        """Effective hard rest gap for one team in one match: the
        most-specific matching scoped rule wins (larger minutes break ties);
        no match falls back to the global scalar."""
        best: tuple[int, int] | None = None
        for r in hard_rest_rules:
            if _scope_ok(r, m, (t,)):
                cand = (scope_specificity(r.scope),
                        int(r.params.get("minutes") or 0))
                if best is None or cand > best:
                    best = cand
        return timedelta(minutes=best[1]) if best else rest

    def _day_cap(m: MatchSlotReq, t: str) -> int:
        best: tuple[int, int] | None = None
        for r in day_rules:
            if _scope_ok(r, m, (t,)):
                cand = (scope_specificity(r.scope), int(r.params.get("count") or 0))
                if best is None or cand[0] > best[0]:
                    best = cand
        return best[1] if best else cfg.max_per_team_per_day

    def _in_window(r: ScopedRule, dt: datetime) -> bool:
        days = r.params.get("days")
        if days and dt.weekday() not in days:
            return False
        return bool(r.params["from"] <= dt.time() < r.params["to"])

    def _fits_window(r: ScopedRule, dt: datetime, end: datetime) -> bool:
        """Hard window: the whole match must sit inside the window on a
        matching day (days listed ⇒ other days are out entirely)."""
        days = r.params.get("days")
        if days and dt.weekday() not in days:
            return False
        return (dt.time() >= r.params["from"]
                and end <= datetime.combine(dt.date(), r.params["to"]))

    def feasible(m: MatchSlotReq, dt: datetime, venue: str, wend: datetime,
                 dur: timedelta, teams: list[str]) -> bool:
        if m.venue_type:
            vt = cfg.venue_types.get(base_of.get(venue, venue), "")
            if vt and vt != m.venue_type:
                return False
        end = dt + dur
        if end > wend:
            return False
        if _overlaps(venue_busy[venue], dt, end):
            return False
        tkey = tuple(teams)
        for r in blackout_rules:
            if dt.date() in r.params["dates"] and _scope_ok(r, m, tkey):
                return False
        # Sport-/leaf-scoped recurring blackouts and reserve days can't be cut
        # from the shared grid (build_slots) — enforce them per match here.
        for r in recurring_scoped:
            if _scope_ok(r, m, tkey):
                days = r.params.get("days")
                if days is None or dt.weekday() in days:
                    ws = datetime.combine(dt.date(), r.params["from"])
                    we = datetime.combine(dt.date(), r.params["to"])
                    if dt < we and ws < end:
                        return False
        for r in reserve_scoped:
            if dt.date() in r.params["dates"] and _scope_ok(r, m, tkey):
                return False
        # Every matching hard window must contain the match (intersection
        # semantics — two windows that jointly starve a leaf surface as a
        # violation, §9 A8).
        for r in hard_windows:
            if _scope_ok(r, m, tkey) and not _fits_window(r, dt, end):
                return False
        # Resource capacities (§2.4): officials/scorers cap concurrent
        # in-flight matches per sport (or tournament-wide for scope "all").
        for r in capacity_rules:
            if not _scope_ok(r, m, tkey):
                continue
            cap = int(r.params.get("count") or 0)
            if cap < 1:
                continue
            n = sum(
                1 for s, e, sp, lf in inflight
                if s < end and dt < e
                and scope_matches(r.scope, sport=sp, leaf_key=lf)
            )
            if r.scope == "all":
                n += sum(1 for s, e in pre_intervals if s < end and dt < e)
            if n >= cap:
                return False
        for t in teams:
            if dt.date() in cfg.team_blackouts.get(t, ()):  # blackout day
                return False
            if team_day[(t, dt.date())] >= _day_cap(m, t):
                return False
            gap = _rest_for(m, t)
            if _overlaps(team_busy[t], dt, end, gap=gap):
                return False
            # Shared-player conflict: a team linked through a common player
            # is busy whenever its partner team is (W2-D). With a stored
            # no_person_overlap record the gaps are tunable and venue-aware
            # (changing venues costs travel time); otherwise the legacy
            # rest-gap behavior applies.
            for lt in (linked or {}).get(t, ()):
                if cfg.person_min_gap is None:
                    if _overlaps(team_busy[lt], dt, end, gap=gap):
                        return False
                else:
                    for s, e, v in team_busy_v.get(lt, ()):
                        same = base_of.get(v, v) == base_of.get(venue, venue)
                        g = timedelta(minutes=(
                            cfg.person_min_gap if same
                            else cfg.person_cross_venue_gap or cfg.person_min_gap
                        ))
                        if dt < e + g and s < end + g:
                            return False
        return True

    def preference(m: MatchSlotReq, dt: datetime, venue: str,
                   dur: timedelta, teams: list[str]) -> float:
        score = 0.0
        tkey = tuple(teams)
        if cfg.preferred_windows and any(
            w_start <= dt.time() and dt.time() < w_end
            for w_start, w_end in cfg.preferred_windows
        ):
            score += 2.0
        for r in soft_windows:
            if _scope_ok(r, m, tkey) and _in_window(r, dt):
                score += 2.0 * r.weight / DEFAULT_WEIGHT
        balance_w = sum(
            r.weight / DEFAULT_WEIGHT
            for r in balance_rules if _scope_ok(r, m, tkey)
        )
        if not balance_rules and cfg.balance_venues:
            balance_w = 1.0
        if balance_w:
            score += balance_w / (1.0 + venue_load[venue])
        end = dt + dur
        for r in soft_rest_rules:
            gap = timedelta(minutes=int(r.params.get("minutes") or 0))
            for t in teams:
                if _scope_ok(r, m, (t,)) and not _overlaps(
                    team_busy[t], dt, end, gap=gap
                ):
                    score += 0.5 * r.weight / DEFAULT_WEIGHT
        # day spread: prefer a day the teams aren't already playing
        if teams and all(team_day[(t, dt.date())] == 0 for t in teams):
            score += 0.5
        return score

    def _max_preference(m: MatchSlotReq, teams: list[str]) -> float:
        """Best achievable soft-window score for a match — normalizes the
        weighted satisfaction term in ``_score_soft``."""
        tkey = tuple(teams)
        mx = 2.0 if cfg.preferred_windows else 0.0
        mx += sum(
            2.0 * r.weight / DEFAULT_WEIGHT
            for r in soft_windows if _scope_ok(r, m, tkey)
        )
        return mx

    # Pinned-round resolution (§4.7): map match id -> its pin rule. "final" =
    # the highest knockout round in the rule's scope, "semi_final" = the round
    # before it, an int = that literal round.
    def _pin_targets() -> dict[str, ScopedRule]:
        pin_of: dict[str, ScopedRule] = {}
        for r in pinned_rules:
            in_scope = [
                mm for mm in matches
                if _scope_ok(r, mm, tuple(t for t in (mm.home, mm.away) if t))
            ]
            ko = [mm for mm in in_scope if mm.stage == "knockout"] or in_scope
            if not ko:
                continue
            rounds = sorted({mm.round_no for mm in ko})
            rnd = r.params.get("round")
            if rnd == "final":
                target = rounds[-1]
            elif rnd == "semi_final":
                if len(rounds) < 2:
                    continue
                target = rounds[-2]
            else:
                try:
                    target = int(str(rnd))
                except (TypeError, ValueError):
                    continue
            for mm in ko:
                if mm.round_no == target:
                    pin_of[mm.id] = r
        return pin_of

    def _pin_ok(r: ScopedRule, dt: datetime, end: datetime) -> bool:
        pd = r.params.get("date")
        if pd == "last_day":
            pd = cfg.date_end
        if isinstance(pd, date) and dt.date() != pd:
            return False
        if r.params.get("from") and dt.time() < r.params["from"]:
            return False
        if r.params.get("to") and end > datetime.combine(dt.date(), r.params["to"]):
            return False
        return True

    pin_of = _pin_targets()

    # Earlier rounds first, then declared order — keeps a bracket chronological.
    # PINNED matches are placed FIRST (their windows are scarce); the greedy
    # pass then back-fills the remaining rounds chronologically. First
    # feasible slot wins (deterministic, chronological packing) unless soft
    # preferences are active — then every feasible slot is scored and the
    # best (earliest on ties) is chosen.
    soft_active = (
        bool(cfg.preferred_windows) or cfg.balance_venues
        or bool(soft_windows) or bool(soft_rest_rules) or bool(balance_rules)
    )
    window_sat = [0.0, 0.0]  # achieved, achievable (weighted windows)
    violations: list[dict[str, Any]] = []
    pinned_failed: set[str] = set()
    by_order = sorted(matches, key=lambda m: (m.round_no, m.match_no))
    ordered = [m for m in by_order if m.id in pin_of] + \
              [m for m in by_order if m.id not in pin_of]
    for m in ordered:
        teams = [t for t in (m.home, m.away) if t]
        dur = timedelta(minutes=m.duration_minutes or cfg.slot_minutes)
        pin = pin_of.get(m.id)
        chosen: tuple[datetime, str] | None = None
        best_score = float("-inf")
        for dt, venue, wend in slots:
            if pin is not None and not _pin_ok(pin, dt, dt + dur):
                continue
            if not feasible(m, dt, venue, wend, dur, teams):
                continue
            if not soft_active:
                chosen = (dt, venue)
                break
            score = preference(m, dt, venue, dur, teams)
            if score > best_score:
                best_score, chosen = score, (dt, venue)
        if chosen is None:
            unscheduled.append(m.id)
            if pin is not None:
                pinned_failed.add(m.id)
            continue
        dt, venue = chosen
        end = dt + dur
        assignments[m.id] = (dt, venue)
        mx = _max_preference(m, teams)
        if mx > 0:
            window_sat[1] += mx
            achieved = 2.0 if cfg.preferred_windows and any(
                ws <= dt.time() < we for ws, we in cfg.preferred_windows
            ) else 0.0
            achieved += sum(
                2.0 * r.weight / DEFAULT_WEIGHT
                for r in soft_windows
                if _scope_ok(r, m, tuple(teams)) and _in_window(r, dt)
            )
            window_sat[0] += achieved
        venue_busy[venue].append((dt, end))
        venue_load[venue] += 1
        inflight.append((dt, end, m.sport, m.leaf_key))
        for t in teams:
            team_busy[t].append((dt, end))
            team_busy_v[t].append((dt, end, venue))
            team_day[(t, dt.date())] += 1

    violations.extend(
        _build_violations(matches, unscheduled, pinned_failed, pin_of,
                          hard_windows, cfg, _scope_ok)
    )

    soft, notes = _score_soft(assignments, team_busy, cfg, len(matches),
                              window_sat=window_sat)
    explanation = [
        f"{len(assignments)}/{len(matches)} matches scheduled across "
        f"{len(cfg.venues)} venue(s), {cfg.date_start}..{cfg.date_end}.",
        *notes,
    ]
    if unscheduled:
        explanation.append(
            f"{len(unscheduled)} match(es) could not be placed — widen the date "
            f"range, add venues, shorten slots, or relax rest/max-per-day."
        )
    return ScheduleResult(assignments, unscheduled, soft, explanation,
                          violations=violations)


def _build_violations(
    matches: list[MatchSlotReq], unscheduled: list[str],
    pinned_failed: set[str], pin_of: dict[str, ScopedRule],
    hard_windows: list[ScopedRule], cfg: ScheduleConfig, scope_ok: Any,
) -> list[dict[str, Any]]:
    """Structured hard-constraint failures (redesign §3 infeasibility
    contract): each violation carries a stable ``code`` + ``params`` for FE
    localization (§9 A5), the offending stored constraint record, the match
    ids hit, and CONCRETE relaxation suggestions — never a generic error."""
    if not unscheduled:
        return []
    out: list[dict[str, Any]] = []
    by_id = {m.id: m for m in matches}

    # Pinned rounds that missed their window — one violation per pin rule.
    by_rule: dict[int, list[str]] = defaultdict(list)
    rule_at: dict[int, Any] = {}
    for mid in sorted(pinned_failed):
        r = pin_of[mid]
        by_rule[id(r)].append(mid)
        rule_at[id(r)] = r
    for key, mids in by_rule.items():
        r = rule_at[key]
        out.append({
            "code": "pinned_round_unplaced",
            "hard": True,
            "constraint": r.record or {"type": r.type, "scope": r.scope},
            "matches": mids,
            "params": {"round": str(r.params.get("round")), "scope": r.scope},
            "message": _(
                "The pinned round does not fit inside its window — no slot "
                "satisfies the pin and every other constraint."
            ),
            "relaxations": [
                {"action": "add_day", "code": "add_day",
                 "params": {"after": cfg.date_end.isoformat()}},
                {"action": "add_venue", "code": "add_venue", "params": {}},
            ],
        })

    # Hard session windows that (jointly) starve a competition (§9 A8): the
    # fix is demoting the window to soft, not silently dropping matches.
    for r in hard_windows:
        if r.type != "category_session_window":
            continue
        hit = [
            mid for mid in unscheduled
            if mid not in pinned_failed and mid in by_id and scope_ok(
                r, by_id[mid],
                tuple(t for t in (by_id[mid].home, by_id[mid].away) if t),
            )
        ]
        if not hit:
            continue
        out.append({
            "code": "session_window_starved",
            "hard": True,
            "constraint": r.record or {"type": r.type, "scope": r.scope},
            "matches": hit,
            "params": {"scope": r.scope},
            "message": _(
                "A hard session window leaves no feasible slot for these "
                "matches — demote it to soft or widen the window."
            ),
            "relaxations": [
                {"action": "demote_to_soft", "code": "demote_to_soft",
                 "params": {"type": r.type, "scope": r.scope}},
                {"action": "add_day", "code": "add_day",
                 "params": {"after": cfg.date_end.isoformat()}},
            ],
        })

    # Everything else unplaced: the generic capacity relaxations.
    covered = set(pinned_failed)
    for v in out:
        covered.update(v["matches"])
    rest_ids = [mid for mid in unscheduled if mid not in covered]
    if rest_ids:
        out.append({
            "code": "matches_unplaced",
            "hard": True,
            "constraint": None,
            "matches": rest_ids,
            "params": {"count": len(rest_ids)},
            "message": _(
                "%(count)d match(es) could not be placed — widen the date "
                "range, add venues, shorten slots, or relax rest/max-per-day."
            ) % {"count": len(rest_ids)},
            "relaxations": [
                {"action": "add_day", "code": "add_day",
                 "params": {"after": cfg.date_end.isoformat()}},
                {"action": "add_venue", "code": "add_venue", "params": {}},
                {"action": "raise_cap", "code": "raise_max_per_day",
                 "params": {"current": cfg.max_per_team_per_day}},
            ],
        })
    return out


def _score_soft(assignments, team_busy, cfg, total,
                window_sat: list[float] | None = None) -> tuple[float, list[str]]:
    """Cheap soft score in [0,1]: reward even spacing (no team forced into
    same-day clusters beyond the cap). When weighted soft windows are active
    (``window_sat`` = [achieved, achievable]) their satisfaction ratio joins
    the blend — constraint ``weight`` is the multiplier (spec §2.2)."""
    if not assignments:
        return 0.0, []
    notes: list[str] = []
    # spread: fraction of teams whose matches land on distinct days
    clustered = 0
    teams = 0
    for _team, busy in team_busy.items():
        teams += 1
        days = {s.date() for s, _ in busy}
        if len(days) < len(busy):
            clustered += 1
    spread = 1.0 - (clustered / teams) if teams else 1.0
    if clustered:
        notes.append(f"{clustered} team(s) have multiple matches on a single day.")
    placed_ratio = len(assignments) / total if total else 1.0
    if window_sat and window_sat[1] > 0:
        satisfaction = window_sat[0] / window_sat[1]
        score = round(0.6 * placed_ratio + 0.2 * spread + 0.2 * satisfaction, 3)
    else:
        score = round(0.7 * placed_ratio + 0.3 * spread, 3)
    return score, notes


# --------------------------------------------------------------------------- hard validation
def validate_schedule(
    assignments: dict[str, tuple[datetime, str]],
    matches: list[MatchSlotReq],
    cfg: ScheduleConfig,
    *,
    preoccupied: Preoccupied | None = None,
    linked: dict[str, set[str]] | None = None,
) -> list[dict[str, Any]]:
    """Return a list of HARD-constraint violations in a given assignment (used
    to verify a manual edit — the repair APIs' conflict check). Empty list = a
    valid schedule. Durations are per-match; venue conflicts are interval
    overlaps; the per-day check counts against the configured cap (it used to
    be hardcoded to 2).

    ``preoccupied`` bookings (live matches, other competitions) join the
    venue/team interval sets but are never themselves reported — conflicts
    against them land on the in-scope match. ``linked`` teams (shared rostered
    player, W2-D) must not play overlapping matches; the rest gap applies
    across the link, exactly as in ``schedule_matches``. Violations are
    JSON-safe records with stable codes (FE localizes, §9 A5)."""
    by_id = {m.id: m for m in matches}
    violations: list[dict[str, Any]] = []
    rest = timedelta(minutes=cfg.rest_minutes)

    def dur_of(mid: str) -> timedelta:
        m = by_id.get(mid)
        return timedelta(
            minutes=(m.duration_minutes if m and m.duration_minutes else cfg.slot_minutes)
        )

    # (start, end, match_id|None) — None marks an immovable fixed booking.
    Interval = tuple[datetime, datetime, "str | None"]
    venue_items: dict[str, list[Interval]] = defaultdict(list)
    team_items: dict[str, list[Interval]] = defaultdict(list)
    for mid, (dt, venue) in assignments.items():
        end = dt + dur_of(mid)
        venue_items[venue].append((dt, end, mid))
        m = by_id.get(mid)
        if m:
            for t in (m.home, m.away):
                if t:
                    team_items[t].append((dt, end, mid))
                    if dt.date() in cfg.team_blackouts.get(t, ()):
                        violations.append({"code": "team_blackout", "hard": True,
                                           "match_id": mid, "team_id": t})
    for venue, start, end, team_ids in preoccupied or []:
        venue_items[venue].append((start, end, None))
        for t in team_ids:
            team_items[t].append((start, end, None))

    def overlap_pairs(
        items: list[Interval], gap: timedelta = timedelta(0),
    ) -> Iterator[tuple[str, str | None, datetime]]:
        """Pairwise interval checks (a long match can overlap beyond its
        immediate neighbour, so consecutive-pair checks are not enough).
        Yields (subject, other, at) with the reportable match as subject."""
        items.sort(key=lambda x: (x[0], x[1]))
        for i in range(len(items)):
            s_i, e_i, mid_i = items[i]
            until = e_i + gap
            for j in range(i + 1, len(items)):
                s_j, _e_j, mid_j = items[j]
                if s_j >= until:
                    break  # sorted: no later item can overlap i either
                if mid_i is None and mid_j is None:
                    continue  # two fixed bookings — not ours to flag
                if mid_j is not None:
                    yield mid_j, mid_i, s_j
                else:
                    yield mid_i, mid_j, s_i

    for venue, items in venue_items.items():
        for subject, other, at in overlap_pairs(items):
            violations.append({"code": "venue_double_booked", "hard": True,
                               "match_id": subject, "other_match_id": other,
                               "venue": venue, "at": at.isoformat()})

    for team, items in team_items.items():
        per_day: dict[date, int] = defaultdict(int)
        for s, _e, _mid in items:
            per_day[s.date()] += 1
        for d, count in per_day.items():
            if count > cfg.max_per_team_per_day:
                violations.append({"code": "exceeds_max_per_day", "hard": True,
                                   "team_id": team, "date": d.isoformat()})
        for subject, other, _at in overlap_pairs(items, gap=rest):
            violations.append({"code": "insufficient_rest", "hard": True,
                               "match_id": subject, "other_match_id": other,
                               "team_id": team})

    # Shared-player links (W2-D): linked teams never play overlapping
    # matches; the rest gap applies across the link too.
    for team, partners in (linked or {}).items():
        for lt in partners:
            if not team < lt:  # visit each unordered pair once
                continue
            for s_i, e_i, mid_i in team_items.get(team, ()):
                for s_j, e_j, mid_j in team_items.get(lt, ()):
                    if mid_i is None and mid_j is None:
                        continue
                    if mid_i is not None and mid_i == mid_j:
                        continue  # one match fielding both linked teams
                    if s_i < e_j + rest and s_j < e_i + rest:
                        subject, other = (
                            (mid_i, mid_j) if mid_i is not None else (mid_j, mid_i)
                        )
                        violations.append({
                            "code": "shared_player_conflict", "hard": True,
                            "match_id": subject, "other_match_id": other,
                            "team_id": team, "linked_team_id": lt,
                        })
    return violations


# --------------------------------------------------------------------------- inputs
def _tournament_tz(tournament) -> ZoneInfo:
    try:
        return ZoneInfo(tournament.time_zone or "UTC")
    except Exception:
        return ZoneInfo("UTC")


def build_schedule_inputs(
    tournament, cfg: ScheduleConfig, *, leaf_key: str | None = None,
    plans: list | None = None, include_ids: set | None = None,
) -> tuple[list[MatchSlotReq], Preoccupied, dict[str, set[str]]]:
    """``(reqs, preoccupied, linked)`` — ONE input builder shared by
    ``apply_schedule`` (commit), the preview endpoint (redesign §9 A1) and
    the manual repair APIs, so every path sees exactly the bookings and
    shared-player links a commit would (tenet 3: preview ≡ commit).

    Without ``plans``, reqs come from the scope's persisted ``scheduled``/
    ``postponed`` matches (the commit path — live/completed are never
    moved, and postponed slots are exactly what a re-run must refill). With
    ``plans`` (pure ``MatchPlan``s from the plan_* core), reqs are synthetic
    ("p1"…) and the scope's own still-``scheduled`` rows are excluded from
    ``preoccupied`` (an accepted re-draw replaces them); anything in flight
    or in another competition still blocks the calendar. ``include_ids``
    forces specific matches into the reqs (and out of ``preoccupied``)
    regardless of status/scope — the repair APIs validate moving e.g. a
    ``postponed`` match through the same inputs.
    """
    from django.utils import timezone as dj_tz

    from apps.matches.models import Match, MatchStatus
    from apps.matches.services.set_scoring import sport_profile

    tz = _tournament_tz(tournament)
    sched_overrides = {
        s.get("key"): (s.get("scheduling") or {}) for s in tournament.sports or []
    }

    def duration_for(sport: str) -> int | None:
        o = sched_overrides.get(sport) or {}
        if o.get("duration_minutes"):
            return int(o["duration_minutes"])
        prof = sport_profile(sport)
        return int(prof["duration_minutes"]) if prof else None

    def venue_type_for(sport: str) -> str:
        o = sched_overrides.get(sport) or {}
        if o.get("venue_type"):
            return str(o["venue_type"])
        prof = sport_profile(sport)
        return str(prof["venue_type"]) if prof else ""

    all_matches = list(
        Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    )
    if plans is None:
        include = include_ids or set()
        # Locked matches (repair seam) are never reassigned — they fall
        # through to ``preoccupied`` below, so their (venue, time, teams)
        # stays on the calendar as a fixed busy booking across any re-run.
        # POSTPONED matches ARE reassigned (increment E — they need new
        # slots most); their status stays untouched (the state machine owns
        # the postponed → scheduled flip).
        reassignable = (MatchStatus.SCHEDULED, MatchStatus.POSTPONED)
        targets = [
            m for m in all_matches
            if m.id in include
            or (
                m.status in reassignable
                and m.locked_at is None
                and (not leaf_key or m.leaf_key == leaf_key)
            )
        ]
        excluded_ids = {m.id for m in targets}
        reqs = [
            MatchSlotReq(
                id=str(m.id),
                round_no=m.round_no,
                match_no=m.match_no,
                home=str(m.home_team_id) if m.home_team_id else None,
                away=str(m.away_team_id) if m.away_team_id else None,
                leaf_key=m.leaf_key,
                sport=m.sport,
                duration_minutes=duration_for(m.sport),
                venue_type=venue_type_for(m.sport),
                stage=m.stage,
            )
            for m in targets
        ]
    else:
        plan_leafs = {p.leaf_key for p in plans}
        excluded_ids = {
            m.id for m in all_matches
            if m.status == MatchStatus.SCHEDULED
            and m.leaf_key in plan_leafs
            and (not leaf_key or m.leaf_key == leaf_key)
        }
        reqs = [
            MatchSlotReq(
                id=f"p{p.ref + 1}",
                round_no=p.round_no,
                match_no=p.ref + 1,
                home=str(p.home_team_id) if p.home_team_id else None,
                away=str(p.away_team_id) if p.away_team_id else None,
                leaf_key=p.leaf_key,
                sport=p.sport,
                duration_minutes=duration_for(p.sport),
                venue_type=venue_type_for(p.sport),
                stage=p.stage,
            )
            for p in plans
        ]

    # Other matches' bookings (live, completed, other leaves) block the calendar.
    preoccupied: Preoccupied = []
    for m in all_matches:
        if m.id in excluded_ids or m.scheduled_at is None:
            continue
        start = dj_tz.localtime(m.scheduled_at, tz).replace(tzinfo=None)
        dmin = duration_for(m.sport) or cfg.slot_minutes
        teams = [str(t) for t in (m.home_team_id, m.away_team_id) if t]
        preoccupied.append((m.venue, start, start + timedelta(minutes=dmin), teams))

    # Teams sharing a rostered person (one student in two competitions) are
    # linked: their matches must never overlap (W2-D).
    from apps.teams.models import Player

    by_person: dict[str, set[str]] = {}
    for pid, tid in Player.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).values_list("person_id", "team_id"):
        by_person.setdefault(str(pid), set()).add(str(tid))
    linked: dict[str, set[str]] = {}
    for tids in by_person.values():
        if len(tids) > 1:
            for a in tids:
                linked.setdefault(a, set()).update(tids - {a})

    return reqs, preoccupied, linked


def stored_activated_reserve_days(tournament) -> set[date]:
    """Reserve days the rain-day shift has activated, as persisted on
    ``tournament.scheduling_config["activated_reserve_days"]`` (increment D).
    Every run path (apply/preview/repair validation) unions these into its
    config so an in-use reserve day never falls back off the calendar."""
    raw = (tournament.scheduling_config or {}).get("activated_reserve_days")
    return {x for x in (_parse_date(v) for v in raw or []) if x}


def resolve_team_tags(cfg: ScheduleConfig, tournament) -> None:
    """tag:<k>=<v> scopes resolve against institution/seed data — only hit
    the DB when a stored record actually uses one."""
    if any(
        str(c.get("scope") or "").startswith("tag:")
        for c in tournament.constraints or [] if isinstance(c, dict)
    ):
        from apps.fixtures.services.constraints import team_tag_map

        cfg.team_tags = team_tag_map(tournament)


# --------------------------------------------------------------------------- apply
def apply_schedule(
    *, tournament, config: dict[str, Any], by=None, request=None,
    leaf_key: str | None = None,
) -> ScheduleResult:
    """Run the engine over a tournament's UNPLAYED matches and persist
    scheduled_at/venue.

    Guards + scoping (spec 2026-06-10 P3): only ``scheduled``/``postponed``
    matches are (re)assigned — live/completed results are never moved; with
    ``leaf_key`` only that competition is scheduled, treating every other
    match's existing booking as occupied. Stored Tournament.constraints are
    interpreted into the run. Times persist in the TOURNAMENT's timezone
    (invariant 14 — they used to be saved naive-as-UTC). The submitted config
    is stored on ``tournament.scheduling_config`` so re-runs prefill.
    Audited + atomic.
    """
    from django.db import transaction
    from django.utils import timezone as dj_tz

    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit
    from apps.matches.models import Match

    tz = _tournament_tz(tournament)
    cfg = config_from_dict(config)
    # The submitted payload rarely repeats the activated reserve days — the
    # persisted set must survive any re-run (increment D), so union it in
    # BEFORE the stored constraints are merged.
    cfg.activated_reserve_days |= stored_activated_reserve_days(tournament)
    resolve_team_tags(cfg, tournament)
    constraint_notes = merge_stored_constraints(cfg, tournament.constraints)

    reqs, preoccupied, linked = build_schedule_inputs(
        tournament, cfg, leaf_key=leaf_key
    )
    result = schedule_matches(reqs, cfg, preoccupied=preoccupied, linked=linked)
    result.explanation[1:1] = constraint_notes

    by_id = {
        str(m.id): m
        for m in Match.objects.filter(
            tournament=tournament, id__in=[r.id for r in reqs]
        )
    }
    with transaction.atomic():
        for mid, (dt, venue) in result.assignments.items():
            m = by_id[mid]
            m.scheduled_at = dj_tz.make_aware(dt, tz)
            m.venue = venue[:120]
            m.save(update_fields=["scheduled_at", "venue", "updated_at"])
        stored_cfg = dict(config or {})
        if cfg.activated_reserve_days:
            stored_cfg["activated_reserve_days"] = sorted(
                d.isoformat() for d in cfg.activated_reserve_days
            )
        tournament.scheduling_config = stored_cfg
        tournament.save(update_fields=["scheduling_config", "updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="fixtures_scheduled",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            payload_after={
                "scheduled": len(result.assignments),
                "unscheduled": len(result.unscheduled),
                "soft_score": result.soft_score,
                "leaf_key": leaf_key or "",
            },
            request=request,
        )
    return result
