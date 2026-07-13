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
from collections.abc import Iterator, Sequence
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
    slot_minutes: int = 90          # default duration + fallback start-grid step
    # Start-grid granularity. When None, build_schedule_inputs derives it as the
    # GCD of slot_minutes and every match's own duration, so per-competition
    # durations pack back-to-back (a 20-min match runs 09:30-09:50, the next
    # starts 09:50 — not snapped up to a coarse slot_minutes boundary). Stays
    # == slot_minutes when all matches share that length (no behaviour change).
    grid_step_minutes: int | None = None
    venues: list[str] = field(default_factory=lambda: ["Main Ground"])
    rest_minutes: int = 60          # min gap between a team's matches
    # True when the payload carried an explicit rest_minutes. A stored hard
    # all-scope min_rest constraint may LOWER the library default (it is the
    # organizer's actual number) but never an explicit payload value.
    rest_minutes_explicit: bool = False
    max_per_team_per_day: int = 1
    excluded_dates: set[date] = field(default_factory=set)
    # Per-venue availability override: {venue: [(start, end)]}. Empty means the
    # venue inherits the tournament daily window every non-excluded day.
    venue_windows: dict[str, list[tuple[time, time]]] = field(default_factory=dict)
    # Per-venue daily BREAKS: {venue: [(start, end)]} — lunch/prayer windows
    # subtracted from THAT venue's grid every day (no match lands there during
    # the break). Composes with the all-venue daily break (a "recurring_blackout_
    # window" scope:"all"). Set from Venue.breaks via config_from_dict.
    venue_breaks: dict[str, list[tuple[time, time]]] = field(default_factory=dict)
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
    # Whole-day off-days per venue ({base_name: {date, ...}}, increment S):
    # removed from THAT venue's grid only; validation reports an assignment
    # on one as the hard ``venue_unavailable`` violation.
    venue_unavailable_dates: dict[str, set[date]] = field(default_factory=dict)
    # Sport allow-list per venue ({base_name: [sport_key, ...]}, owner ask
    # 2026-06-25): a match only lands on a venue whose list is empty (any) or
    # contains the match's sport. Makes "2 courts per sport" enforced rather
    # than convention — separating sports that share a venue_type.
    venue_sports: dict[str, list[str]] = field(default_factory=dict)
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
    # Optimization pass (R12): the greedy result is the SEED; when ``optimize``
    # is on, ``optimizer.optimize_schedule`` searches for a better-soft-scored
    # arrangement (local search, optionally CP-SAT/OR-Tools) and is accepted
    # only when it has zero hard violations AND a soft score >= the seed — so
    # the worst case is exactly today's greedy schedule. Off by default.
    optimize: bool = False
    optimize_engine: str = "local"   # "local" | "cpsat" (cpsat falls back to local)
    optimize_seconds: float = 0.0    # >0 = wall-clock budget; 0 = iteration-bounded


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
    venue_breaks: dict[str, list[tuple[time, time]]] = {}
    venue_types: dict[str, str] = {}
    venue_counts: dict[str, int] = {}
    venue_unavailable: dict[str, set[date]] = {}
    venue_sports: dict[str, list[str]] = {}
    for v in d.get("venues") or []:
        if isinstance(v, dict):
            name = str(v.get("name") or "").strip()
            if not name:
                continue
            venues.append(name)
            if v.get("venue_type"):
                venue_types[name] = str(v["venue_type"]).strip()
            allowed = [
                str(s).strip() for s in (v.get("sports") or [])
                if str(s).strip()
            ]
            if allowed:
                venue_sports[name] = allowed
            try:
                count = int(v.get("count") or 1)
            except (TypeError, ValueError):
                count = 1
            if count > 1:
                venue_counts[name] = count
            off = {
                x for x in (
                    _parse_date(u) for u in v.get("unavailable_dates") or []
                ) if x
            }
            if off:
                venue_unavailable[name] = off
            wins = [
                (_parse_time(w.get("from"), daily_start),
                 _parse_time(w.get("to"), daily_end))
                for w in (v.get("windows") or [])
                if isinstance(w, dict)
            ]
            if wins:
                venue_windows[name] = wins
            brks = [
                (_parse_time(b.get("from"), daily_start),
                 _parse_time(b.get("to"), daily_end))
                for b in (v.get("breaks") or [])
                if isinstance(b, dict) and b.get("from") and b.get("to")
            ]
            if brks:
                venue_breaks[name] = brks
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
        rest_minutes_explicit="rest_minutes" in d,
        max_per_team_per_day=int(d.get("max_per_team_per_day", 1)),
        excluded_dates=excluded,
        venue_windows=venue_windows,
        venue_breaks=venue_breaks,
        venue_types=venue_types,
        venue_counts=venue_counts,
        venue_unavailable_dates=venue_unavailable,
        venue_sports=venue_sports,
        activated_reserve_days=activated,
        optimize=bool(d.get("optimize", False)),
        optimize_engine=str(d.get("optimize_engine") or "local"),
        optimize_seconds=float(d.get("optimize_seconds") or 0.0),
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
            elif minutes < cfg.rest_minutes and not cfg.rest_minutes_explicit:
                # The payload left rest at the library default; the stored hard
                # constraint is the organizer's actual number — honor it even
                # downward. An explicit payload value still wins upward.
                cfg.rest_minutes = minutes
                notes.append(f"Set rest gap to {minutes} minutes (stored constraint).")
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
                # Finals venue pin (increment T): names the ONLY venues the
                # pinned round may land on. None = any venue (legacy).
                "venues": [str(v) for v in p.get("venues") or []] or None,
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
        elif ctype == "no_concurrent_competitions":
            members = [
                str(x).strip() for x in (p.get("members") or [])
                if isinstance(x, str) and str(x).strip()
            ]
            if len({*members}) >= 2:
                gap = max(0, int(p.get("gap_minutes") or 0))
                cfg.constraint_rules.append(ScopedRule(
                    ctype, "all", True, weight,
                    {"members": members, "gap_minutes": gap}, record=c))
                notes.append(
                    f"{len({*members})} competitions kept from running at the "
                    f"same time" + (f" ({gap} min apart)." if gap else ".")
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
# The court-suffix format: ``<base><_COURT_SUFFIX><1-based index>`` → "Hall · T2".
# The separator is U+00B7 MIDDLE DOT (never a hyphen / em-dash / en-dash). Court
# identity is encoded in ``Match.venue`` (no separate column), so this exact
# string is what double-book / court-capacity checks key off and what the
# editor's court picker submits. The frontend mirrors it in
# ``lib/courts.ts::courtLabel`` — keep the two in lockstep.
_COURT_SUFFIX = " · T"


def court_venue_name(base: str, index: int) -> str:
    """The canonical display name of court ``index`` (1-based) at venue ``base``
    ("Hall · T2"). SINGLE source of truth for the court-suffix format."""
    return f"{base}{_COURT_SUFFIX}{index}"


def court_base_of(venue: str, venues: Sequence[str]) -> str:
    """The physical base venue a (possibly court-suffixed) display name belongs
    to. Strips a ``" · T<n>"`` suffix ONLY when the remainder is a configured
    base venue — so a stranded/out-of-range court ("Hall · T3" after ``count``
    dropped to 2) still counts against its hall, while a real base name that
    merely ends in the pattern is left untouched. Callers should prefer an
    authoritative ``expand_venues`` mapping and fall back to this for off-grid
    strings."""
    if venue in venues:
        return venue  # a configured base venue is never stripped, even if it
        # happens to end in the court pattern (e.g. a venue named "Hall · T2")
    for vname in venues:
        prefix = f"{vname}{_COURT_SUFFIX}"
        if venue.startswith(prefix) and venue[len(prefix):].isdigit():
            return vname
    return venue


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
            out.extend((court_venue_name(name, i), name) for i in range(1, n + 1))
    return out


def relaxed_venue_type_sports(
    cfg: ScheduleConfig, matches: list[MatchSlotReq],
) -> set[str]:
    """Sports whose required venue_type (from the sport profile) NO available
    venue can satisfy — almost always because the organiser typed their venues
    differently from the hidden profile value (e.g. an indoor sport like Sepak
    Takraw or Table Tennis on a venue they typed "ground").

    A match requiring a type normally only lands on venues of that type. But
    when not one eligible venue carries the type, that hard filter rejects every
    slot and silently strands the entire competition (0/N placed, with a
    misleading "add venues / widen dates" message). For those sports we drop the
    type requirement and fall back to the explicit per-venue sport allow-list —
    which the organiser set deliberately ("Sepak only on this court"). Correctly
    typed tournaments are unaffected: their venues satisfy the type, nothing is
    relaxed, and sports sharing a venue_type stay separated exactly as before.
    """
    required: dict[str, str] = {}
    for m in matches:
        if m.venue_type and m.sport:
            required.setdefault(m.sport, m.venue_type)
    relax: set[str] = set()
    for sport, vtype in required.items():
        satisfiable = any(
            (not (allowed := cfg.venue_sports.get(v)) or sport in allowed)
            and cfg.venue_types.get(v, "") in ("", vtype)
            for v in cfg.venues
        )
        if not satisfiable:
            relax.add(sport)
    return relax


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
    step = timedelta(minutes=cfg.grid_step_minutes or cfg.slot_minutes)
    while d <= cfg.date_end:
        if d not in cfg.excluded_dates and d not in reserved:
            for venue, base in expand_venues(cfg):
                # Per-venue off-days (increment S): this venue only — every
                # other venue keeps the date.
                if d in cfg.venue_unavailable_dates.get(base, ()):
                    continue
                # A venue window can NARROW the tournament daily window, never
                # extend past it (the docstring's "intersected per-venue" —
                # previously the venue window replaced the daily one, letting
                # matches run past daily_end).
                windows = [
                    (max(ws, cfg.daily_start), min(we, cfg.daily_end))
                    for ws, we in (
                        cfg.venue_windows.get(base)
                        or [(cfg.daily_start, cfg.daily_end)]
                    )
                    if max(ws, cfg.daily_start) < min(we, cfg.daily_end)
                ]
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
                # Per-venue daily breaks (this venue only, every day).
                cuts += cfg.venue_breaks.get(base, [])
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
    stage_no: int = 0                     # multi-stage index: earlier stages time first
    # Bracket precedence (audit 2026-07-13): ids of matches that must END
    # before this one starts — its winner_of/loser_of feeders, or every match
    # of the source group for a group_position side. A feeder that is already
    # committed outside the run contributes a fixed lower bound instead.
    after: tuple[str, ...] = ()
    not_before: datetime | None = None


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
# (venue, start, end, [team_ids]) with an OPTIONAL 5th element
# ``(sport, leaf_key)`` naming the booking's competition — present on real
# runs (``build_schedule_inputs``) so a per-leaf run still honours
# cross-competition rules (official capacity, mutual exclusion); absent on
# legacy/unit-test bookings, which simply match no exclusion member.
Preoccupied = list[
    tuple[str, datetime, datetime, list[str]]
    | tuple[str, datetime, datetime, list[str], tuple[str, str]]
]


def _overlaps(busy: list[tuple[datetime, datetime]], start: datetime,
              end: datetime, gap: timedelta = timedelta(0)) -> bool:
    return any(start < e + gap and s < end + gap for s, e in busy)


def exclusion_member(members: Sequence[str], sport: str, leaf_key: str) -> str | None:
    """Which member of a ``no_concurrent_competitions`` group a match belongs
    to, or None if it's outside the group. A leaf match wins on its exact
    ``leaf_key`` (most specific) before falling back to its ``sport`` key, so a
    group can mix whole-sport and single-leaf members. Two matches clash only
    when both return a member AND the members differ."""
    if leaf_key and leaf_key in members:
        return leaf_key
    if sport and sport in members:
        return sport
    return None


def fairness_order(reqs: list[MatchSlotReq]) -> list[str]:
    """Asynchronous round-robin ordering (R7, owner ask 2026-06-25): emit the
    matches of one round-robin cohort so the next match always goes to the
    teams that have played the FEWEST games and rested the LONGEST — i.e.
    "give the not-yet-played teams the chance" before any team plays again,
    minimising back-to-back play on few courts (Suksompong, *Scheduling
    Asynchronous Round-Robin Tournaments*).

    Deterministic: at each step pick the remaining match minimising
    ``(max games-played of its teams, -rest since either last played,
    round_no, match_no)``. Returns match ids in play order. ``reqs`` is one
    homogeneous cohort of resolved (both-teams-known) matches; multiple groups
    of a leaf may be passed together — they interleave fairly because the key
    is global to the cohort.
    """
    remaining = list(reqs)
    played: dict[str, int] = defaultdict(int)
    last: dict[str, int] = {}
    order: list[str] = []
    pos = 0
    while remaining:
        def _key(m: MatchSlotReq, _pos: int = pos) -> tuple[int, int, int, int]:
            teams = [t for t in (m.home, m.away) if t]
            load = max((played[t] for t in teams), default=0)
            rest = min((_pos - last.get(t, -1 << 30) for t in teams), default=1 << 30)
            return (load, -rest, m.round_no, m.match_no)
        m = min(remaining, key=_key)
        remaining.remove(m)
        for t in (m.home, m.away):
            if t:
                played[t] += 1
                last[t] = pos
        order.append(m.id)
        pos += 1
    return order


def resolve_pinned_rounds(
    matches: list[MatchSlotReq], rules: list[ScopedRule], cfg: ScheduleConfig,
) -> dict[str, ScopedRule]:
    """Map match id -> its ``round_pinned_to_window`` rule (§4.7): "final" =
    the highest knockout round in the rule's scope, "semi_final" = the round
    before it, an int = that literal round. Shared by pinned-first placement
    AND ``validate_schedule`` (the repair verbs judge a manual move of a
    pinned final by the same resolution, increment T)."""
    pin_of: dict[str, ScopedRule] = {}
    for r in rules:
        if r.type != "round_pinned_to_window":
            continue
        in_scope = [
            mm for mm in matches
            if scope_matches(
                r.scope, sport=mm.sport, leaf_key=mm.leaf_key,
                team_ids=tuple(t for t in (mm.home, mm.away) if t),
                team_tags=cfg.team_tags,
            )
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


def _pin_venue_ok(r: ScopedRule, venue: str, base_of: dict[str, str]) -> bool:
    """Finals venue pin (increment T): with ``venues`` named, the pinned
    match may only sit on one of them — a sub-venue counts through its
    physical base ("Hall · T2" satisfies a pin on "Hall")."""
    allowed = r.params.get("venues")
    return (not allowed or venue in allowed
            or base_of.get(venue, venue) in allowed)


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
    unscheduled_ids: set[str] = set()
    # Bracket precedence bookkeeping: end times of placed matches, and the
    # reverse (feeder -> dependents) map so a pinned dependent placed FIRST
    # (finals pin) still caps its feeders' end times.
    end_of: dict[str, datetime] = {}
    req_of = {m.id: m for m in matches}
    succs: dict[str, list[str]] = defaultdict(list)
    for m in matches:
        for fid in m.after:
            if fid in req_of:
                succs[fid].append(m.id)

    # Scoped rule lists (redesign spec §9 A3) resolved per match below.
    rules = cfg.constraint_rules
    # Hard rest + per-day caps now resolve through the shared effective_rest_gap
    # / effective_day_cap helpers (so the greedy and validate_schedule agree).
    soft_rest_rules = [r for r in rules if r.type == "min_rest_minutes" and not r.hard]
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
    exclusion_rules = [r for r in rules if r.type == "no_concurrent_competitions"]
    pinned_rules = [r for r in rules if r.type == "round_pinned_to_window"]
    rotation_rules = [r for r in rules if r.type == "rotation_fairness"]

    # Sub-venue expansion (§2.3): display name -> base name, and the parallel
    # units of each expanded base.
    base_of = dict(expand_venues(cfg))
    subs_by_base: dict[str, list[str]] = defaultdict(list)
    for disp, base in base_of.items():
        subs_by_base[base].append(disp)

    # Sports whose profile venue_type no venue can satisfy → drop the type
    # filter for them (the explicit per-venue sport allow-list still binds), so
    # a venue-type mismatch never silently strands a whole competition.
    relax_vtype = relaxed_venue_type_sports(cfg, matches)
    # Venue-tagged team intervals (shared-player cross-venue gaps, §9 A3) and
    # the in-flight interval list the capacity engine counts against.
    team_busy_v: dict[str, list[tuple[datetime, datetime, str]]] = defaultdict(list)
    inflight: list[tuple[datetime, datetime, str, str]] = []  # start, end, sport, leaf
    # start, end, sport, leaf — sport/leaf carry the booking's competition so a
    # per-leaf run still honours cross-competition rules (capacity, exclusion).
    pre_intervals: list[tuple[datetime, datetime, str, str]] = []

    for booking in preoccupied or []:
        venue, start, end, team_ids = booking[0], booking[1], booking[2], booking[3]
        meta = booking[4] if len(booking) > 4 else None
        bsport = str(meta[0]) if meta else ""
        bleaf = str(meta[1]) if meta else ""
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
        pre_intervals.append((start, end, bsport, bleaf))
        for t in team_ids:
            team_busy[t].append((start, end))
            team_busy_v[t].append((start, end, targets[0]))
            team_day[(t, start.date())] += 1

    def _scope_ok(rule: ScopedRule, m: MatchSlotReq,
                  team_ids: tuple[str, ...]) -> bool:
        return scope_matches(rule.scope, sport=m.sport, leaf_key=m.leaf_key,
                             team_ids=team_ids, team_tags=cfg.team_tags)

    def _rest_for(m: MatchSlotReq, t: str) -> timedelta:
        """Effective hard rest gap for one team in one match — delegates to the
        shared resolver so the greedy and ``validate_schedule`` never diverge."""
        return effective_rest_gap(cfg, m, t)

    def _day_cap(m: MatchSlotReq, t: str) -> int:
        return effective_day_cap(cfg, m, t)

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
        if m.venue_type and m.sport not in relax_vtype:
            vt = cfg.venue_types.get(base_of.get(venue, venue), "")
            if vt and vt != m.venue_type:
                return False
        # Sport allow-list (owner ask 2026-06-25): a venue bound to specific
        # sports rejects matches of any other sport — "TT only on TT courts".
        allowed_sports = cfg.venue_sports.get(base_of.get(venue, venue))
        if allowed_sports and m.sport and m.sport not in allowed_sports:
            return False
        end = dt + dur
        if end > wend:
            return False
        # Bracket precedence: a dependent never starts before its feeders end
        # (+ the advancing side's rest gap — the winner plays both matches),
        # and a feeder never ends into an already-placed dependent's start
        # (the pinned-final case: the dependent was placed first).
        if m.after or m.not_before is not None:
            earliest = m.not_before
            for fid in m.after:
                fe = end_of.get(fid)
                if fe is not None and (earliest is None or fe > earliest):
                    earliest = fe
            if earliest is not None and dt < earliest + _rest_for(m, ""):
                return False
        for did in succs.get(m.id, ()):
            dslot = assignments.get(did)
            if dslot is not None and end > dslot[0] - _rest_for(req_of[did], ""):
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
            # Committed bookings of OTHER leaves count against the cap too —
            # a per-leaf run scoped to one sport must still see its sibling
            # leaves' matches (their (sport, leaf) meta travels on the
            # booking; legacy meta-less bookings only count for scope "all").
            n = sum(
                1 for s, e, sp, lf in (*inflight, *pre_intervals)
                if s < end and dt < e
                and scope_matches(r.scope, sport=sp, leaf_key=lf)
            )
            if n >= cap:
                return False
        # Mutual-exclusion groups (owner ask): a match may not overlap (within
        # the group's transition gap) any already-placed match of a DIFFERENT
        # named member — same-member matches still run in parallel. Scans both
        # this run's placements (inflight) and other competitions' bookings
        # (pre_intervals) so it holds whether the run is whole-tournament or
        # per-leaf.
        for r in exclusion_rules:
            members = r.params["members"]
            mine = exclusion_member(members, m.sport, m.leaf_key)
            if mine is None:
                continue
            g = timedelta(minutes=int(r.params.get("gap_minutes") or 0))
            for s, e, sp, lf in (*inflight, *pre_intervals):
                other = exclusion_member(members, sp, lf)
                if other is not None and other != mine \
                        and dt < e + g and s < end + g:
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
        # rotation fairness (R7): reward slots that give the least-rested team
        # the most rest since its last match — spreads a round-robin team's
        # games rather than clustering them. Teams that have not played yet do
        # not constrain the reward (any slot is fine for a fresh team).
        for r in rotation_rules:
            if not _scope_ok(r, m, tkey):
                continue
            played_gaps = [
                max(0.0, (dt - max(e for _s, e in team_busy[t])).total_seconds() / 60.0)
                for t in teams if team_busy[t]
            ]
            if played_gaps:
                cap = float(max(120, 2 * cfg.rest_minutes))
                score += (r.weight / DEFAULT_WEIGHT) * min(min(played_gaps), cap) / cap
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

    def _pin_ok(r: ScopedRule, dt: datetime, end: datetime,
                venue: str) -> bool:
        if not _pin_venue_ok(r, venue, base_of):  # finals venue pin (T)
            return False
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

    # Pinned-round resolution (§4.7): match id -> its pin rule.
    pin_of = resolve_pinned_rounds(matches, pinned_rules, cfg)

    # Earlier rounds first, then declared order — keeps a bracket chronological.
    # PINNED matches are placed FIRST (their windows are scarce); the greedy
    # pass then back-fills the remaining rounds chronologically. First
    # feasible slot wins (deterministic, chronological packing) unless soft
    # preferences are active — then every feasible slot is scored and the
    # best (earliest on ties) is chosen.
    soft_active = (
        bool(cfg.preferred_windows) or cfg.balance_venues
        or bool(soft_windows) or bool(soft_rest_rules) or bool(balance_rules)
        or bool(rotation_rules)
    )
    window_sat = [0.0, 0.0]  # achieved, achievable (weighted windows)
    violations: list[dict[str, Any]] = []
    pinned_failed: set[str] = set()
    # Placement order. Default: earlier rounds first, then declared order. When
    # a rotation_fairness rule is in scope (R7), the round-robin matches it
    # covers are re-sequenced by fairness_order (least-played/longest-rested
    # next) and placed before knockout/unresolved matches — which keep round
    # order (a bracket round depends on the prior round). Gated on the rule, so
    # tournaments without it schedule exactly as before.
    def _rotation_scoped(m: MatchSlotReq) -> bool:
        tkey = tuple(t for t in (m.home, m.away) if t)
        return any(_scope_ok(r, m, tkey) for r in rotation_rules)

    if rotation_rules:
        fair_pos: dict[str, int] = {}
        cohorts: dict[str, list[MatchSlotReq]] = defaultdict(list)
        for m in matches:
            if m.stage != "knockout" and m.home and m.away and _rotation_scoped(m):
                cohorts[m.leaf_key].append(m)
        for cohort in cohorts.values():
            for i, mid in enumerate(fairness_order(cohort)):
                fair_pos[mid] = i

        def _order_key(m: MatchSlotReq) -> tuple:
            if m.id in fair_pos:
                return (0, m.stage_no, fair_pos[m.id], m.leaf_key, m.match_no)
            return (1, m.stage_no, m.round_no, m.leaf_key, m.match_no)

        by_order = sorted(matches, key=_order_key)
    else:
        # stage_no first: a multi-stage leaf's group rounds all precede its
        # knockout in time (a stage-1 bracket depends on stage-0 results). It is
        # 0 for every single-stage tournament, so this is a no-op there.
        by_order = sorted(matches, key=lambda m: (m.stage_no, m.round_no, m.match_no))
    ordered = [m for m in by_order if m.id in pin_of] + \
              [m for m in by_order if m.id not in pin_of]
    for m in ordered:
        # A dependent whose in-run feeder failed to place can never be timed
        # correctly — propagate the failure instead of parking it anywhere.
        if any(fid in unscheduled_ids for fid in m.after):
            unscheduled.append(m.id)
            unscheduled_ids.add(m.id)
            continue
        teams = [t for t in (m.home, m.away) if t]
        dur = timedelta(minutes=m.duration_minutes or cfg.slot_minutes)
        pin = pin_of.get(m.id)
        chosen: tuple[datetime, str] | None = None
        best_score = float("-inf")
        for dt, venue, wend in slots:
            if pin is not None and not _pin_ok(pin, dt, dt + dur, venue):
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
            unscheduled_ids.add(m.id)
            if pin is not None:
                pinned_failed.add(m.id)
            continue
        dt, venue = chosen
        end = dt + dur
        assignments[m.id] = (dt, venue)
        end_of[m.id] = end
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
    if relax_vtype:
        explanation.append(
            "No venue matched the expected court type for "
            f"{', '.join(sorted(relax_vtype))} — used the venues you assigned "
            "to those sports instead (set each venue's type if you want strict "
            "court separation)."
        )
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


# ----------------------------------------------------------- scoped-rule resolvers
# One source of truth for the per-team HARD rest gap and per-day cap, shared by
# the greedy placer AND ``validate_schedule`` — they used to diverge, letting the
# optimizer adopt a schedule that broke a scoped hard rest/cap the greedy honored
# (review 2026-06-25). Most-specific scope wins; larger minutes break rest ties.
def effective_rest_gap(
    cfg: ScheduleConfig, match: MatchSlotReq | None, team: str
) -> timedelta:
    base = timedelta(minutes=cfg.rest_minutes)
    if match is None:
        return base
    best: tuple[int, int] | None = None
    for r in cfg.constraint_rules:
        if r.type == "min_rest_minutes" and r.hard and scope_matches(
            r.scope, sport=match.sport, leaf_key=match.leaf_key,
            team_ids=(team,), team_tags=cfg.team_tags,
        ):
            cand = (scope_specificity(r.scope), int(r.params.get("minutes") or 0))
            if best is None or cand > best:
                best = cand
    return timedelta(minutes=best[1]) if best else base


def effective_day_cap(
    cfg: ScheduleConfig, match: MatchSlotReq | None, team: str
) -> int:
    if match is None:
        return cfg.max_per_team_per_day
    best: tuple[int, int] | None = None
    for r in cfg.constraint_rules:
        if r.type == "max_matches_per_team_per_day" and r.hard and scope_matches(
            r.scope, sport=match.sport, leaf_key=match.leaf_key,
            team_ids=(team,), team_tags=cfg.team_tags,
        ):
            cand = (scope_specificity(r.scope), int(r.params.get("count") or 0))
            if best is None or cand[0] > best[0]:
                best = cand
    return best[1] if best else cfg.max_per_team_per_day


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
    base_of = dict(expand_venues(cfg))

    def dur_of(mid: str) -> timedelta:
        m = by_id.get(mid)
        return timedelta(
            minutes=(m.duration_minutes if m and m.duration_minutes else cfg.slot_minutes)
        )

    # (start, end, match_id|None) — None marks an immovable fixed booking.
    Interval = tuple[datetime, datetime, "str | None"]
    venue_items: dict[str, list[Interval]] = defaultdict(list)
    team_items: dict[str, list[Interval]] = defaultdict(list)
    # (start, end, sport, leaf, match_id|None) for mutual-exclusion checking.
    ex_items: list[tuple[datetime, datetime, str, str, str | None]] = []
    for mid, (dt, venue) in assignments.items():
        end = dt + dur_of(mid)
        venue_items[venue].append((dt, end, mid))
        m_ex = by_id.get(mid)
        if m_ex:
            ex_items.append((dt, end, m_ex.sport, m_ex.leaf_key, mid))
        # Per-venue off-day (increment S): landing on one is hard, regardless
        # of what else the day holds. Sub-venues resolve to their base.
        if dt.date() in cfg.venue_unavailable_dates.get(
            base_of.get(venue, venue), ()
        ):
            violations.append({
                "code": "venue_unavailable", "hard": True, "match_id": mid,
                "venue": venue, "date": dt.date().isoformat(),
            })
        m = by_id.get(mid)
        if m:
            for t in (m.home, m.away):
                if t:
                    team_items[t].append((dt, end, mid))
                    if dt.date() in cfg.team_blackouts.get(t, ()):
                        violations.append({"code": "team_blackout", "hard": True,
                                           "match_id": mid, "team_id": t})
    for booking in preoccupied or []:
        venue, start, end, team_ids = booking[0], booking[1], booking[2], booking[3]
        venue_items[venue].append((start, end, None))
        for t in team_ids:
            team_items[t].append((start, end, None))
        meta = booking[4] if len(booking) > 4 else None
        if meta:
            ex_items.append((start, end, str(meta[0]), str(meta[1]), None))

    # Finals venue pin (increment T): a pinned-round match parked on a venue
    # outside its ``venues`` list is a hard violation — the repair verbs
    # refuse to move a final off center court unless forced.
    venue_pins = [
        r for r in cfg.constraint_rules
        if r.type == "round_pinned_to_window" and r.params.get("venues")
    ]
    if venue_pins:
        for mid, r in resolve_pinned_rounds(matches, venue_pins, cfg).items():
            slot = assignments.get(mid)
            if slot is None:
                continue
            if not _pin_venue_ok(r, slot[1], base_of):
                violations.append({
                    "code": "pinned_round_venue", "hard": True,
                    "match_id": mid, "venue": slot[1],
                    "round": str(r.params.get("round")),
                    "allowed_venues": list(r.params.get("venues") or []),
                })

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

    # Court capacity: across all courts of one PHYSICAL base, no more than
    # ``count`` matches may run concurrently. The greedy can't break this (it
    # only ever offers the N expanded display-courts, one match each), but a
    # manual edit can — a 3rd overlapping match on a 2-court hall, mixing the
    # bare base name with court strings, or landing on a court that no longer
    # exists after ``count`` was reduced (incl. all the way to 1). We only emit
    # for a CROSS-COURT overflow — the active set spans >=2 distinct venue
    # strings — because a same-string pile-up is already ``venue_double_booked``
    # (so single-court bases are NOT skipped: two matches on "Hall" vs a stale
    # "Hall · T1" still collide on the one physical court and must be caught).
    def capacity_base(venue: str) -> str:
        # Authoritative mapping for legitimate expanded courts; suffix-strip for
        # bare-base / stale / out-of-range strings so they still count against
        # the right hall.
        return base_of.get(venue) or court_base_of(venue, cfg.venues)

    # (start, end, match_id|None, venue_string) — venue carried so the pass can
    # tell a cross-court overflow from a same-court double-book.
    CourtItem = tuple[datetime, datetime, str | None, str]
    base_items: dict[str, list[CourtItem]] = defaultdict(list)
    for venue, items in venue_items.items():
        bse = capacity_base(venue)
        base_items[bse].extend((s, e, mid, venue) for (s, e, mid) in items)
    for base, citems in base_items.items():
        cap = max(1, int(cfg.venue_counts.get(base, 1)))
        citems.sort(key=lambda x: (x[0], x[1]))
        active: list[CourtItem] = []
        for cur in citems:
            s_cur = cur[0]
            active = [a for a in active if a[1] > s_cur]  # drop ended courts
            active.append(cur)
            if len(active) <= cap:
                continue
            if len({a[3] for a in active}) < 2:
                continue  # same court only — venue_double_booked has it covered
            movable = [a for a in active if a[2] is not None]
            if not movable:
                continue  # an all-fixed overflow is not ours to flag
            subject = cur if cur[2] is not None else movable[-1]
            other = next((a for a in active if a is not subject), None)
            violations.append({
                "code": "court_capacity_exceeded", "hard": True,
                "match_id": subject[2],
                "other_match_id": other[2] if other else None,
                "venue": base, "capacity": cap, "at": s_cur.isoformat(),
            })

    for team, items in team_items.items():
        # Per-day cap: the effective limit on a day is the SMALLEST resolved cap
        # among that day's matches (a match with a scoped cap of 1 forbids a 2nd
        # that day) — matches the greedy's place-time _day_cap check.
        per_day: dict[date, int] = defaultdict(int)
        day_caps: dict[date, int] = {}
        for s, _e, mid in items:
            d = s.date()
            per_day[d] += 1
            cap = effective_day_cap(cfg, by_id.get(mid) if mid else None, team)
            day_caps[d] = min(day_caps.get(d, cap), cap)
        for d, count in per_day.items():
            if count > day_caps.get(d, cfg.max_per_team_per_day):
                violations.append({"code": "exceeds_max_per_day", "hard": True,
                                   "team_id": team, "date": d.isoformat()})
        # Rest: each match's own scoped gap governs (the in-scope/later match's
        # rule), so a scoped hard min_rest is enforced exactly as the greedy did.
        items_sorted = sorted(items, key=lambda x: (x[0], x[1]))
        for a in range(len(items_sorted)):
            sa, ea, mid_a = items_sorted[a]
            for b in range(a + 1, len(items_sorted)):
                sb, eb, mid_b = items_sorted[b]
                if mid_a is None and mid_b is None:
                    continue  # two fixed bookings — not ours to flag
                # Subject = the in-scope (reportable) match; its rule sets the gap.
                if mid_b is not None:
                    subject, other = mid_b, mid_a
                else:
                    subject, other = mid_a, mid_b
                gap = effective_rest_gap(cfg, by_id.get(subject), team)
                if sa < eb + gap and sb < ea + gap:
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

    # Mutual-exclusion groups (owner ask): two placed matches of DIFFERENT
    # named members must not overlap (within the group's transition gap). One
    # side may be a fixed preoccupied booking (mid None) — then the in-scope
    # match carries the violation.
    for r in cfg.constraint_rules:
        if r.type != "no_concurrent_competitions":
            continue
        members = r.params["members"]
        g = timedelta(minutes=int(r.params.get("gap_minutes") or 0))
        tagged = [
            (s, e, exclusion_member(members, sp, lf), mid)
            for s, e, sp, lf, mid in ex_items
        ]
        for i in range(len(tagged)):
            s_i, e_i, mem_i, mid_i = tagged[i]
            if mem_i is None:
                continue
            for j in range(i + 1, len(tagged)):
                s_j, e_j, mem_j, mid_j = tagged[j]
                if mem_j is None or mem_j == mem_i:
                    continue
                if mid_i is None and mid_j is None:
                    continue
                if s_i < e_j + g and s_j < e_i + g:
                    subject, other = (
                        (mid_i, mid_j) if mid_i is not None else (mid_j, mid_i)
                    )
                    violations.append({
                        "code": "concurrent_competitions", "hard": True,
                        "match_id": subject, "other_match_id": other,
                        "members": [mem_i, mem_j],
                    })

    # Bracket precedence (audit 2026-07-13): a dependent placed at or before
    # its feeder's end is a hard violation — a manual move must never invert
    # a bracket (final before its semis) or start a knockout mid-group-stage.
    for m in matches:
        slot = assignments.get(m.id)
        if slot is None:
            continue
        for fid in m.after:
            fslot = assignments.get(fid)
            if fslot is not None and slot[0] < fslot[0] + dur_of(fid):
                violations.append({
                    "code": "predecessor_order", "hard": True,
                    "match_id": m.id, "other_match_id": fid,
                })
        if m.not_before is not None and slot[0] < m.not_before:
            violations.append({
                "code": "predecessor_order", "hard": True,
                "match_id": m.id, "other_match_id": None,
            })

    # Grid-subtractive rules are cut from the slot grid at build time, so the
    # greedy can never breach them — but a manual move can land anywhere
    # (audit 2026-07-13): re-check blackout windows and ceremonies here.
    def _rule_scope_ok(r: ScopedRule, m: MatchSlotReq | None) -> bool:
        if m is None:
            return r.scope == "all"
        return scope_matches(
            r.scope, sport=m.sport, leaf_key=m.leaf_key,
            team_ids=tuple(t for t in (m.home, m.away) if t),
            team_tags=cfg.team_tags,
        )

    recurring_hard = [
        r for r in cfg.constraint_rules
        if r.type == "recurring_blackout_window" and r.hard
    ]
    ceremony_rules = [
        r for r in cfg.constraint_rules if r.type == "ceremony_block"
    ]
    for mid, (dt, venue) in assignments.items():
        end = dt + dur_of(mid)
        m = by_id.get(mid)
        for r in recurring_hard:
            days = r.params.get("days")
            if days and dt.weekday() not in days:
                continue
            if not _rule_scope_ok(r, m):
                continue
            ws = datetime.combine(dt.date(), r.params["from"])
            we = datetime.combine(dt.date(), r.params["to"])
            if dt < we and ws < end:
                violations.append({
                    "code": "blackout_window", "hard": True, "match_id": mid,
                    "label": str(r.params.get("label") or ""),
                    "from": r.params["from"].isoformat(),
                    "to": r.params["to"].isoformat(),
                })
        for r in ceremony_rules:
            if r.params.get("date") != dt.date():
                continue
            wanted = r.params.get("venues")
            if wanted and base_of.get(venue, venue) not in wanted \
                    and venue not in wanted:
                continue
            ws = datetime.combine(dt.date(), r.params["from"])
            we = datetime.combine(dt.date(), r.params["to"])
            if dt < we and ws < end:
                violations.append({
                    "code": "ceremony_block", "hard": True, "match_id": mid,
                    "label": str(r.params.get("label") or ""),
                    "date": dt.date().isoformat(),
                })

    # Officials capacity (audit 2026-07-13): concurrent in-scope matches —
    # including committed bookings via their (sport, leaf) meta — must stay
    # within the cap; the tipping (movable) match carries the violation.
    for r in cfg.constraint_rules:
        if r.type != "official_capacity" or not r.hard:
            continue
        cap = int(r.params.get("count") or 0)
        if cap < 1:
            continue
        evs = sorted(
            (
                (s, e, mid)
                for s, e, sp, lf, mid in ex_items
                if scope_matches(r.scope, sport=sp, leaf_key=lf)
            ),
            key=lambda x: (x[0], x[1]),
        )
        active: list[tuple[datetime, datetime, str | None]] = []
        for cur in evs:
            active = [a for a in active if a[1] > cur[0]]
            active.append(cur)
            if len(active) <= cap:
                continue
            movable = [a for a in active if a[2] is not None]
            if not movable:
                continue
            subject = cur if cur[2] is not None else movable[-1]
            violations.append({
                "code": "official_capacity_exceeded", "hard": True,
                "match_id": subject[2], "scope": r.scope, "capacity": cap,
                "at": cur[0].isoformat(),
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

    from apps.fixtures.services.draw_config import effective_draw_config

    def duration_for(sport: str, leaf_key: str = "") -> int | None:
        # Per-competition override (draw_config[leaf].match_duration_minutes,
        # layered over the "*" default) wins; then the per-sport scheduling
        # override; then the sport profile; else None → caller's slot_minutes.
        if leaf_key:
            d = effective_draw_config(tournament, leaf_key).get(
                "match_duration_minutes"
            )
            if d:
                return int(d)
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
                duration_minutes=duration_for(m.sport, m.leaf_key or ""),
                venue_type=venue_type_for(m.sport),
                stage=m.stage,
                stage_no=m.stage_no,
            )
            for m in targets
        ]
        # Bracket precedence: winner_of/loser_of sides depend on their feeder
        # match; a group_position side depends on every match of that group
        # (the advancer is only known when the group finishes). Feeders inside
        # the run go into ``after``; a feeder already committed outside it
        # (live/completed/locked/other status) becomes a fixed ``not_before``.
        req_ids = {r.id for r in reqs}
        by_match_id = {str(m.id): m for m in all_matches}
        group_ids: dict[tuple[str, str], list[str]] = {}
        for m in all_matches:
            if m.group_label:
                group_ids.setdefault(
                    (m.leaf_key, m.group_label), []
                ).append(str(m.id))
        for req, m in zip(reqs, targets, strict=True):
            deps: set[str] = set()
            bound: datetime | None = None
            for src in (m.home_source, m.away_source):
                if not isinstance(src, dict):
                    continue
                kind = src.get("type")
                if kind in ("winner_of", "loser_of") and src.get("match_id"):
                    deps.add(str(src["match_id"]))
                elif kind == "group_position" and src.get("group_label"):
                    deps.update(
                        gid for gid in group_ids.get(
                            (m.leaf_key, str(src["group_label"])), ()
                        )
                        if gid != req.id
                    )
            after: list[str] = []
            for fid in sorted(deps):
                if fid in req_ids:
                    after.append(fid)
                    continue
                feeder = by_match_id.get(fid)
                if feeder is not None and feeder.scheduled_at is not None:
                    fstart = dj_tz.localtime(
                        feeder.scheduled_at, tz
                    ).replace(tzinfo=None)
                    fend = fstart + timedelta(
                        minutes=duration_for(feeder.sport, feeder.leaf_key or "")
                        or cfg.slot_minutes
                    )
                    if bound is None or fend > bound:
                        bound = fend
            req.after = tuple(after)
            req.not_before = bound
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
                duration_minutes=duration_for(p.sport, p.leaf_key or ""),
                venue_type=venue_type_for(p.sport),
                stage=p.stage,
                stage_no=p.stage_no,
            )
            for p in plans
        ]
        # Same precedence wiring for pure plans (preview ≡ commit): pointer
        # sides reference other plans by ``ref``; a group_position side
        # depends on its whole source group.
        plan_group_ids: dict[tuple[str, str], list[str]] = {}
        for p in plans:
            if p.group_label:
                plan_group_ids.setdefault(
                    (p.leaf_key, p.group_label), []
                ).append(f"p{p.ref + 1}")
        for req, p in zip(reqs, plans, strict=True):
            deps: set[str] = set()
            for src in (p.home_source, p.away_source):
                if not isinstance(src, dict):
                    continue
                kind = src.get("type")
                if kind in ("winner_of", "loser_of"):
                    if src.get("ref") is not None:
                        deps.add(f"p{int(src['ref']) + 1}")
                    elif src.get("match_id"):
                        deps.add(str(src["match_id"]))
                elif kind == "group_position" and src.get("group_label"):
                    deps.update(
                        gid for gid in plan_group_ids.get(
                            (p.leaf_key, str(src["group_label"])), ()
                        )
                        if gid != req.id
                    )
            req.after = tuple(sorted(d for d in deps if d != req.id))

    # Other matches' bookings (live, completed, other leaves) block the calendar.
    preoccupied: Preoccupied = []
    for m in all_matches:
        if m.id in excluded_ids or m.scheduled_at is None:
            continue
        start = dj_tz.localtime(m.scheduled_at, tz).replace(tzinfo=None)
        dmin = duration_for(m.sport, m.leaf_key or "") or cfg.slot_minutes
        teams = [str(t) for t in (m.home_team_id, m.away_team_id) if t]
        preoccupied.append((
            m.venue, start, start + timedelta(minutes=dmin), teams,
            (m.sport, m.leaf_key),
        ))

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

    # Derive the start-grid granularity from the actual match lengths so
    # per-competition durations pack tightly (a 20-min and a 15-min sport on the
    # same day → a 5-min grid, not a coarse slot_minutes one). GCD with
    # slot_minutes keeps it == slot_minutes when every match shares that length
    # (no behaviour change); a 5-minute floor avoids a pathologically fine grid.
    if cfg.grid_step_minutes is None:
        from math import gcd

        grid = int(cfg.slot_minutes)
        for r in reqs:
            if r.duration_minutes:
                grid = gcd(grid, int(r.duration_minutes))
        cfg.grid_step_minutes = max(grid, 5)

    return reqs, preoccupied, linked


def stored_activated_reserve_days(tournament) -> set[date]:
    """Reserve days the rain-day shift has activated, as persisted on
    ``tournament.scheduling_config["activated_reserve_days"]`` (increment D).
    Every run path (apply/preview/repair validation) unions these into its
    config so an in-use reserve day never falls back off the calendar."""
    raw = (tournament.scheduling_config or {}).get("activated_reserve_days")
    return {x for x in (_parse_date(v) for v in raw or []) if x}


def resolve_venue_unavailability(cfg: ScheduleConfig, tournament) -> None:
    """Union the CURRENT ``Venue.unavailable_dates`` into the config
    (increment S). Off-days are facts about the venue, not the run payload —
    resolving them fresh means scheduling, preview and the repair-verb
    validation all honor a date added AFTER the original run."""
    from apps.fixtures.models import Venue

    for name, raw in Venue.objects.filter(
        organization=tournament.organization, deleted_at__isnull=True
    ).values_list("name", "unavailable_dates"):
        dates = {x for x in (_parse_date(v) for v in raw or []) if x}
        if dates:
            cfg.venue_unavailable_dates.setdefault(name, set()).update(dates)


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
    resolve_venue_unavailability(cfg, tournament)
    constraint_notes = merge_stored_constraints(cfg, tournament.constraints)

    reqs, preoccupied, linked = build_schedule_inputs(
        tournament, cfg, leaf_key=leaf_key
    )
    result = schedule_matches(reqs, cfg, preoccupied=preoccupied, linked=linked)
    result.explanation[1:1] = constraint_notes
    # Optimization pass (R12): the greedy result is the seed; an improved
    # arrangement is adopted only when it is hard-legal AND soft >= the seed.
    if cfg.optimize:
        from apps.fixtures.services.optimizer import optimize_schedule

        result = optimize_schedule(
            result, reqs, cfg, preoccupied=preoccupied, linked=linked
        )

    by_id = {
        str(m.id): m
        for m in Match.objects.filter(
            tournament=tournament, id__in=[r.id for r in reqs]
        )
    }
    # Per-match before/after for every slot the run actually moved — the
    # schedule-change feed (kind "engine_rerun") and the change notifier
    # both read this off the audit row (trust layer, increments F/G).
    changes: list[dict[str, Any]] = []
    with transaction.atomic():
        for mid, (dt, venue) in result.assignments.items():
            m = by_id[mid]
            new_dt = dj_tz.make_aware(dt, tz)
            new_venue = venue[:120]
            if m.scheduled_at != new_dt or m.venue != new_venue:
                changes.append({
                    "match_id": mid,
                    "old": {
                        "scheduled_at": (
                            m.scheduled_at.isoformat()
                            if m.scheduled_at else None
                        ),
                        "venue": m.venue,
                    },
                    "new": {
                        "scheduled_at": new_dt.isoformat(),
                        "venue": new_venue,
                    },
                })
            m.scheduled_at = new_dt
            m.venue = new_venue
            m.save(update_fields=["scheduled_at", "venue", "updated_at"])
        stored_cfg = dict(config or {})
        if cfg.activated_reserve_days:
            stored_cfg["activated_reserve_days"] = sorted(
                d.isoformat() for d in cfg.activated_reserve_days
            )
        tournament.scheduling_config = stored_cfg
        tournament.save(update_fields=["scheduling_config", "updated_at"])
        audit = emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="fixtures_scheduled",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            tournament_id=tournament.id,
            payload_after={
                "scheduled": len(result.assignments),
                "unscheduled": len(result.unscheduled),
                "soft_score": result.soft_score,
                "leaf_key": leaf_key or "",
                "changes": changes,
            },
            request=request,
        )
        # Trust layer increment G: a re-run that moves an already-slotted
        # match notifies affected parties post-commit (initial scheduling —
        # old scheduled_at null — stays silent inside the queue helper).
        from apps.fixtures.services.schedule_changes import (
            queue_slot_change_notifications,
        )

        queue_slot_change_notifications(
            tournament=tournament, batch_id=audit.id, changes=changes, by=by,
        )
    return result
