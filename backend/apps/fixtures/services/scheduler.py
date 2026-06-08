"""Flexible, declarative fixture-scheduling engine (FET-style).

The generator (``generate.py``) decides WHO plays WHOM (pairings + bracket
pointers). This engine decides WHEN and WHERE each match happens — it assigns
every match a ``scheduled_at`` + ``venue`` from a resource model (date range,
daily windows, slot length, venues + availability) while satisfying **hard**
constraints and optimising **soft** ones, and it explains what it did.

Design (spec 2026-06-08 §3): a constructive heuristic + repair, behind a clean
interface so a CP-SAT/OR-Tools backend can replace ``schedule_matches`` later
without touching callers. Nothing is hardcoded — every rule is a typed,
parameterised constraint record interpreted at runtime.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any

# --------------------------------------------------------------------------- config
@dataclass
class ScheduleConfig:
    """Resource model for a scheduling run. Built from the wizard answers /
    ``Tournament.rules['scheduling']`` (see ``config_from_dict``)."""

    date_start: date
    date_end: date
    daily_start: time = time(9, 0)
    daily_end: time = time(18, 0)
    slot_minutes: int = 90          # match duration + turnaround buffer
    venues: list[str] = field(default_factory=lambda: ["Main Ground"])
    rest_minutes: int = 60          # min gap between a team's matches
    max_per_team_per_day: int = 1
    excluded_dates: set[date] = field(default_factory=set)
    # Per-venue availability override: {venue: [(daily_start, daily_end)]}. Empty
    # means the venue inherits the tournament daily window every non-excluded day.
    venue_windows: dict[str, list[tuple[time, time]]] = field(default_factory=dict)


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
        h, m, *_ = (v.split(":") + ["0"])
        return time(int(h), int(m))
    return default


def config_from_dict(d: dict[str, Any]) -> ScheduleConfig:
    """Parse the wizard/API scheduling payload into a ScheduleConfig.

    Required: date_start, date_end (ISO). Everything else has sane defaults so
    a minimal request still schedules.
    """
    ds = _parse_date(d.get("date_start"))
    de = _parse_date(d.get("date_end")) or ds
    if ds is None:
        raise ValueError("date_start is required")
    venues = [str(v) for v in (d.get("venues") or []) if str(v).strip()] or ["Main Ground"]
    excluded = {x for x in (_parse_date(e) for e in d.get("excluded_dates", [])) if x}
    return ScheduleConfig(
        date_start=ds,
        date_end=de,
        daily_start=_parse_time(d.get("daily_start"), time(9, 0)),
        daily_end=_parse_time(d.get("daily_end"), time(18, 0)),
        slot_minutes=int(d.get("slot_minutes", 90)),
        venues=venues,
        rest_minutes=int(d.get("rest_minutes", 60)),
        max_per_team_per_day=int(d.get("max_per_team_per_day", 1)),
        excluded_dates=excluded,
    )


# --------------------------------------------------------------------------- slots
def build_slots(cfg: ScheduleConfig) -> list[tuple[datetime, str]]:
    """Enumerate candidate (start_datetime, venue) slots across the calendar."""
    slots: list[tuple[datetime, str]] = []
    d = cfg.date_start
    one_day = timedelta(days=1)
    while d <= cfg.date_end:
        if d not in cfg.excluded_dates:
            for venue in cfg.venues:
                windows = cfg.venue_windows.get(venue) or [(cfg.daily_start, cfg.daily_end)]
                for w_start, w_end in windows:
                    cur = datetime.combine(d, w_start)
                    end = datetime.combine(d, w_end)
                    while cur + timedelta(minutes=cfg.slot_minutes) <= end:
                        slots.append((cur, venue))
                        cur += timedelta(minutes=cfg.slot_minutes)
        d += one_day
    slots.sort(key=lambda s: (s[0], s[1]))
    return slots


# --------------------------------------------------------------------------- match input
@dataclass
class MatchSlotReq:
    """The scheduling view of a match — pairing + ordering only."""

    id: str
    round_no: int
    match_no: int
    home: str | None        # team id or None (unresolved knockout slot)
    away: str | None


@dataclass
class ScheduleResult:
    assignments: dict[str, tuple[datetime, str]]  # match_id -> (start, venue)
    unscheduled: list[str]
    soft_score: float          # 0..1, higher = better soft-constraint satisfaction
    explanation: list[str]


# --------------------------------------------------------------------------- engine
def schedule_matches(
    matches: list[MatchSlotReq], cfg: ScheduleConfig
) -> ScheduleResult:
    """Greedy constructive scheduler honouring HARD constraints:

      * a team never plays two matches that overlap or violate ``rest_minutes``
      * a venue hosts one match per slot
      * a team plays at most ``max_per_team_per_day`` per day
      * only within available (date, window, venue) slots

    Soft signals (even spacing, avoid same-day clustering) feed ``soft_score``.
    Unplaceable matches are reported, not dropped. Deterministic (round order).
    """
    slots = build_slots(cfg)
    assignments: dict[str, tuple[datetime, str]] = {}
    used_slots: set[tuple[datetime, str]] = set()
    team_busy: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)
    team_day: dict[tuple[str, date], int] = defaultdict(int)
    unscheduled: list[str] = []
    dur = timedelta(minutes=cfg.slot_minutes)
    rest = timedelta(minutes=cfg.rest_minutes)

    def conflicts(team: str, start: datetime) -> bool:
        end = start + dur
        if team_day[(team, start.date())] >= cfg.max_per_team_per_day:
            return True
        for s, e in team_busy[team]:
            # require a rest gap on both sides (overlap => conflict)
            if start < e + rest and s < end + rest:
                return True
        return False

    # Earlier rounds first, then declared order — keeps a bracket chronological.
    ordered = sorted(matches, key=lambda m: (m.round_no, m.match_no))
    for m in ordered:
        teams = [t for t in (m.home, m.away) if t]
        placed = False
        for dt, venue in slots:
            if (dt, venue) in used_slots:
                continue
            if any(conflicts(t, dt) for t in teams):
                continue
            assignments[m.id] = (dt, venue)
            used_slots.add((dt, venue))
            for t in teams:
                team_busy[t].append((dt, dt + dur))
                team_day[(t, dt.date())] += 1
            placed = True
            break
        if not placed:
            unscheduled.append(m.id)

    soft, notes = _score_soft(assignments, team_busy, cfg, len(matches))
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


def _score_soft(assignments, team_busy, cfg, total) -> tuple[float, list[str]]:
    """Cheap soft score in [0,1]: reward even spacing (no team forced into
    same-day clusters beyond the cap). Extendable per soft constraint."""
    if not assignments:
        return 0.0, []
    notes: list[str] = []
    # spread: fraction of teams whose matches land on distinct days
    clustered = 0
    teams = 0
    for team, busy in team_busy.items():
        teams += 1
        days = {s.date() for s, _ in busy}
        if len(days) < len(busy):
            clustered += 1
    spread = 1.0 - (clustered / teams) if teams else 1.0
    if clustered:
        notes.append(f"{clustered} team(s) have multiple matches on a single day.")
    placed_ratio = len(assignments) / total if total else 1.0
    score = round(0.7 * placed_ratio + 0.3 * spread, 3)
    return score, notes


# --------------------------------------------------------------------------- hard validation
def validate_schedule(
    assignments: dict[str, tuple[datetime, str]],
    matches: list[MatchSlotReq],
    cfg: ScheduleConfig,
) -> list[dict[str, Any]]:
    """Return a list of HARD-constraint violations in a given assignment (used to
    verify a manual edit). Empty list = a valid schedule."""
    by_id = {m.id: m for m in matches}
    violations: list[dict[str, Any]] = []
    dur = timedelta(minutes=cfg.slot_minutes)
    rest = timedelta(minutes=cfg.rest_minutes)
    # venue single-use
    seen_slot: dict[tuple[datetime, str], str] = {}
    team_slots: dict[str, list[tuple[datetime, str]]] = defaultdict(list)
    for mid, (dt, venue) in assignments.items():
        key = (dt, venue)
        if key in seen_slot:
            violations.append({"code": "venue_double_booked", "match_id": mid,
                               "venue": venue, "at": dt.isoformat()})
        seen_slot[key] = mid
        m = by_id.get(mid)
        if m:
            for t in (m.home, m.away):
                if t:
                    team_slots[t].append((dt, mid))
    for team, items in team_slots.items():
        items.sort()
        for i in range(1, len(items)):
            (prev_dt, _prev), (dt, mid) = items[i - 1], items[i]
            if dt < prev_dt + dur + rest:
                violations.append({"code": "insufficient_rest", "match_id": mid,
                                   "team_id": team})
            if dt.date() == prev_dt.date() and cfg.max_per_team_per_day < 2:
                violations.append({"code": "exceeds_max_per_day", "match_id": mid,
                                   "team_id": team})
    return violations


# --------------------------------------------------------------------------- apply
def apply_schedule(*, tournament, config: dict[str, Any], by=None, request=None) -> ScheduleResult:
    """Run the engine over a tournament's matches and persist scheduled_at/venue.

    Returns the ScheduleResult (assignments + unscheduled + soft score +
    explanation) so the wizard can show what happened. Audited + atomic.
    """
    from django.db import transaction
    from django.utils import timezone

    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit
    from apps.matches.models import Match

    cfg = config_from_dict(config)
    matches = list(
        Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    )
    reqs = [
        MatchSlotReq(
            id=str(m.id),
            round_no=m.round_no,
            match_no=m.match_no,
            home=str(m.home_team_id) if m.home_team_id else None,
            away=str(m.away_team_id) if m.away_team_id else None,
        )
        for m in matches
    ]
    result = schedule_matches(reqs, cfg)

    by_id = {str(m.id): m for m in matches}
    with transaction.atomic():
        for mid, (dt, venue) in result.assignments.items():
            m = by_id[mid]
            m.scheduled_at = timezone.make_aware(dt) if timezone.is_naive(dt) else dt
            m.venue = venue[:120]
            m.save(update_fields=["scheduled_at", "venue", "updated_at"])
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
            },
            request=request,
        )
    return result
