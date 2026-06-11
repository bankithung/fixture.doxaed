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
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

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
    for v in d.get("venues") or []:
        if isinstance(v, dict):
            name = str(v.get("name") or "").strip()
            if not name:
                continue
            venues.append(name)
            if v.get("venue_type"):
                venue_types[name] = str(v["venue_type"]).strip()
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
                    "blackout_dates", scope, hard, weight, {"dates": dates}))
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
                    {"minutes": minutes}))
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
                    {"count": count}))
                notes.append(f"Max matches per team per day for {scope}: {count}.")
            else:
                cfg.max_per_team_per_day = count
                notes.append(f"Max matches per team per day: {count} (stored constraint).")
        elif ctype in ("preferred_window", "category_session_window"):
            cfg.constraint_rules.append(ScopedRule(ctype, scope, hard, weight, {
                "days": _parse_weekdays(p.get("days")),
                "from": _parse_time(p.get("from"), cfg.daily_start),
                "to": _parse_time(p.get("to"), cfg.daily_end),
            }))
            notes.append(
                "Preferring matches inside the stored preferred window."
                if ctype == "preferred_window" and not hard
                else f"'{ctype}' window for {scope} "
                     f"({'hard grid filter' if hard else 'soft, weighted'})."
            )
        elif ctype == "balance_venues":
            cfg.balance_venues = True
            cfg.constraint_rules.append(ScopedRule(
                "balance_venues", scope, False, weight, {}))
            notes.append("Balancing matches across venues (soft).")
        elif ctype in ("even_spacing", "avoid_back_to_back"):
            notes.append(f"'{ctype}' is optimised by the built-in day-spread scoring.")
        elif ctype == "keep_apart_until_round":
            notes.append(
                "'keep_apart_until_round' applies at pairing generation, not "
                "slot assignment — it does not alter this schedule."
            )
        # no_double_booking_team / venue_single_use are always-on hard rules.
    return notes


# --------------------------------------------------------------------------- slots
def build_slots(cfg: ScheduleConfig) -> list[tuple[datetime, str, datetime]]:
    """Enumerate candidate (start, venue, window_end) slots across the
    calendar. Starts step by ``slot_minutes``; whether a given match FITS a
    slot depends on its own duration (checked against window_end)."""
    slots: list[tuple[datetime, str, datetime]] = []
    d = cfg.date_start
    one_day = timedelta(days=1)
    step = timedelta(minutes=cfg.slot_minutes)
    while d <= cfg.date_end:
        if d not in cfg.excluded_dates:
            for venue in cfg.venues:
                windows = cfg.venue_windows.get(venue) or [(cfg.daily_start, cfg.daily_end)]
                for w_start, w_end in windows:
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


@dataclass
class ScheduleResult:
    assignments: dict[str, tuple[datetime, str]]  # match_id -> (start, venue)
    unscheduled: list[str]
    soft_score: float          # 0..1, higher = better soft-constraint satisfaction
    explanation: list[str]


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

    for venue, start, end, team_ids in preoccupied or []:
        venue_busy[venue].append((start, end))
        for t in team_ids:
            team_busy[t].append((start, end))
            team_day[(t, start.date())] += 1

    def _scope_ok(rule: ScopedRule, m: MatchSlotReq, team_ids: tuple) -> bool:
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
        return r.params["from"] <= dt.time() < r.params["to"]

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
            vt = cfg.venue_types.get(venue, "")
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
        # Every matching hard window must contain the match (intersection
        # semantics — two windows that jointly starve a leaf surface as a
        # violation, §9 A8).
        for r in hard_windows:
            if _scope_ok(r, m, tkey) and not _fits_window(r, dt, end):
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
            # is busy whenever its partner team is (W2-D).
            for lt in (linked or {}).get(t, ()):
                if _overlaps(team_busy[lt], dt, end, gap=gap):
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

    # Earlier rounds first, then declared order — keeps a bracket chronological.
    # First feasible slot wins (deterministic, chronological packing) unless
    # soft preferences are active — then every feasible slot is scored and the
    # best (earliest on ties) is chosen.
    soft_active = (
        bool(cfg.preferred_windows) or cfg.balance_venues
        or bool(soft_windows) or bool(soft_rest_rules) or bool(balance_rules)
    )
    window_sat = [0.0, 0.0]  # achieved, achievable (weighted windows)
    ordered = sorted(matches, key=lambda m: (m.round_no, m.match_no))
    for m in ordered:
        teams = [t for t in (m.home, m.away) if t]
        dur = timedelta(minutes=m.duration_minutes or cfg.slot_minutes)
        chosen: tuple[datetime, str] | None = None
        best_score = float("-inf")
        for dt, venue, wend in slots:
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
        for t in teams:
            team_busy[t].append((dt, end))
            team_day[(t, dt.date())] += 1

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
    return ScheduleResult(assignments, unscheduled, soft, explanation)


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
) -> list[dict[str, Any]]:
    """Return a list of HARD-constraint violations in a given assignment (used
    to verify a manual edit). Empty list = a valid schedule. Durations are
    per-match; venue conflicts are interval overlaps; the per-day check counts
    against the configured cap (it used to be hardcoded to 2)."""
    by_id = {m.id: m for m in matches}
    violations: list[dict[str, Any]] = []
    rest = timedelta(minutes=cfg.rest_minutes)

    def dur_of(mid: str) -> timedelta:
        m = by_id.get(mid)
        return timedelta(
            minutes=(m.duration_minutes if m and m.duration_minutes else cfg.slot_minutes)
        )

    venue_items: dict[str, list[tuple[datetime, str]]] = defaultdict(list)
    team_items: dict[str, list[tuple[datetime, str]]] = defaultdict(list)
    for mid, (dt, venue) in assignments.items():
        venue_items[venue].append((dt, mid))
        m = by_id.get(mid)
        if m:
            for t in (m.home, m.away):
                if t:
                    team_items[t].append((dt, mid))
                    if dt.date() in cfg.team_blackouts.get(t, ()):
                        violations.append({"code": "team_blackout", "match_id": mid,
                                           "team_id": t})

    # Pairwise interval checks (a long match can overlap beyond its immediate
    # neighbour, so consecutive-pair checks are not enough).
    for venue, items in venue_items.items():
        items.sort()
        for i in range(len(items)):
            dt_i, mid_i = items[i]
            end_i = dt_i + dur_of(mid_i)
            for j in range(i + 1, len(items)):
                dt_j, mid_j = items[j]
                if dt_j >= end_i:
                    break  # sorted: no later item can overlap i either
                violations.append({"code": "venue_double_booked", "match_id": mid_j,
                                   "venue": venue, "at": dt_j.isoformat()})

    for team, items in team_items.items():
        items.sort()
        per_day: dict[date, int] = defaultdict(int)
        for dt, _mid in items:
            per_day[dt.date()] += 1
        for d, count in per_day.items():
            if count > cfg.max_per_team_per_day:
                violations.append({"code": "exceeds_max_per_day", "team_id": team,
                                   "date": d.isoformat()})
        for i in range(len(items)):
            dt_i, mid_i = items[i]
            until = dt_i + dur_of(mid_i) + rest
            for j in range(i + 1, len(items)):
                dt_j, mid_j = items[j]
                if dt_j >= until:
                    break
                violations.append({"code": "insufficient_rest", "match_id": mid_j,
                                   "team_id": team})
    return violations


# --------------------------------------------------------------------------- apply
def apply_schedule(
    *, tournament, config: dict[str, Any], by=None, request=None,
    leaf_key: str | None = None,
) -> ScheduleResult:
    """Run the engine over a tournament's UNPLAYED matches and persist
    scheduled_at/venue.

    Guards + scoping (spec 2026-06-10 P3): only ``status=scheduled`` matches
    are (re)assigned — live/completed results are never moved; with
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
    from apps.matches.models import Match, MatchStatus
    from apps.matches.services.set_scoring import sport_profile

    try:
        tz = ZoneInfo(tournament.time_zone or "UTC")
    except Exception:
        tz = ZoneInfo("UTC")

    cfg = config_from_dict(config)
    # tag:<k>=<v> scopes resolve against institution/seed data — only hit the
    # DB when a stored record actually uses one.
    if any(
        str(c.get("scope") or "").startswith("tag:")
        for c in tournament.constraints or [] if isinstance(c, dict)
    ):
        from apps.fixtures.services.constraints import team_tag_map

        cfg.team_tags = team_tag_map(tournament)
    constraint_notes = merge_stored_constraints(cfg, tournament.constraints)

    all_matches = list(
        Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    )
    targets = [
        m for m in all_matches
        if m.status == MatchStatus.SCHEDULED
        and (not leaf_key or m.leaf_key == leaf_key)
    ]
    target_ids = {m.id for m in targets}

    sched_overrides = {
        s.get("key"): (s.get("scheduling") or {}) for s in tournament.sports or []
    }

    def duration_for(m) -> int | None:
        o = sched_overrides.get(m.sport) or {}
        if o.get("duration_minutes"):
            return int(o["duration_minutes"])
        prof = sport_profile(m.sport)
        return int(prof["duration_minutes"]) if prof else None

    def venue_type_for(m) -> str:
        o = sched_overrides.get(m.sport) or {}
        if o.get("venue_type"):
            return str(o["venue_type"])
        prof = sport_profile(m.sport)
        return str(prof["venue_type"]) if prof else ""

    reqs = [
        MatchSlotReq(
            id=str(m.id),
            round_no=m.round_no,
            match_no=m.match_no,
            home=str(m.home_team_id) if m.home_team_id else None,
            away=str(m.away_team_id) if m.away_team_id else None,
            leaf_key=m.leaf_key,
            sport=m.sport,
            duration_minutes=duration_for(m),
            venue_type=venue_type_for(m),
        )
        for m in targets
    ]

    # Other matches' bookings (live, completed, other leaves) block the calendar.
    preoccupied: Preoccupied = []
    for m in all_matches:
        if m.id in target_ids or m.scheduled_at is None:
            continue
        start = dj_tz.localtime(m.scheduled_at, tz).replace(tzinfo=None)
        dmin = duration_for(m) or cfg.slot_minutes
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

    result = schedule_matches(reqs, cfg, preoccupied=preoccupied, linked=linked)
    result.explanation[1:1] = constraint_notes

    by_id = {str(m.id): m for m in targets}
    with transaction.atomic():
        for mid, (dt, venue) in result.assignments.items():
            m = by_id[mid]
            m.scheduled_at = dj_tz.make_aware(dt, tz)
            m.venue = venue[:120]
            m.save(update_fields=["scheduled_at", "venue", "updated_at"])
        tournament.scheduling_config = config or {}
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
