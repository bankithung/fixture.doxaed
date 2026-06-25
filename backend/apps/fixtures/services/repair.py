"""Match-day repair primitives — the control-room seam (redesign spec §7).

Manual edits (reslot one match, swap two slots) are validated against the
SAME constraint machinery the scheduler runs: inputs built by the shared
``build_schedule_inputs`` (other leaves' bookings and shared-player links
included) and checked by ``validate_schedule``, scoped to the moved matches'
day/teams/venue. Hard conflicts raise ``RepairConflict`` carrying the
structured violations payload unless the caller forces — a forced apply
returns the violations as warnings. Every apply is audited and idempotent on
``event_id`` (invariant 3).
"""
from __future__ import annotations

import uuid as _uuid
from datetime import date, datetime
from typing import Any

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone as dj_tz

from apps.fixtures.services.schedule_changes import (
    queue_slot_change_notifications,
)
from apps.fixtures.services.scheduler import (
    ScheduleConfig,
    _parse_date,
    _tournament_tz,
    build_schedule_inputs,
    config_from_dict,
    merge_stored_constraints,
    resolve_team_tags,
    resolve_venue_unavailability,
    stored_activated_reserve_days,
    validate_schedule,
)


class RepairConflict(Exception):
    """Hard constraint violations block a manual edit (no ``force``)."""

    def __init__(self, violations: list[dict[str, Any]]):
        super().__init__("schedule_conflicts")
        self.violations = violations


def _movable_statuses() -> tuple[str, str]:
    from apps.matches.models import MatchStatus

    return (MatchStatus.SCHEDULED, MatchStatus.POSTPONED)


#: Past this many moved matches a cascade collapses to ONE batch tick
#: (match_id=None) — clients refetch the whole day instead of N refetches.
_TICK_BATCH_CAP = 10


def _publish_schedule_ticks(tournament_id, match_ids: list) -> None:
    """Queue post-commit ``schedule`` ticks (control room spec 2026-06-12
    §2.c) — one per affected match, collapsed to a single batch tick when a
    cascade moves more than ``_TICK_BATCH_CAP``. Call INSIDE the atomic
    block so on_commit binds to the repair transaction."""
    from apps.live.publish import publish_tournament_tick

    ids = list(match_ids)
    if not ids:
        return
    if len(ids) > _TICK_BATCH_CAP:
        transaction.on_commit(
            lambda: publish_tournament_tick(tournament_id, None, "schedule")
        )
        return

    def _send() -> None:
        for mid in ids:
            publish_tournament_tick(tournament_id, mid, "schedule")

    transaction.on_commit(_send)


def _local(dt: datetime, tz) -> datetime:
    """Aware → naive tournament-local wall clock (the engine's time model)."""
    return dj_tz.localtime(dt, tz).replace(tzinfo=None)


def _validation_config(tournament) -> ScheduleConfig:
    """The stored scheduling run's config (rest gaps, per-day caps, stored
    constraint records) — manual edits are judged by the same rules the
    engine scheduled under. Sane defaults when no run ever happened."""
    try:
        cfg = config_from_dict(dict(tournament.scheduling_config or {}))
    except (TypeError, ValueError):
        today = dj_tz.localdate()
        cfg = ScheduleConfig(date_start=today, date_end=today)
    resolve_team_tags(cfg, tournament)
    # Venue off-days resolve FRESH from the model (increment S) — a date
    # added after the scheduling run still blocks a repair onto it.
    resolve_venue_unavailability(cfg, tournament)
    merge_stored_constraints(cfg, tournament.constraints)
    return cfg


def validate_slot_changes(
    tournament, changes: dict[Any, tuple[datetime, str]],
) -> list[dict[str, Any]]:
    """HARD violations a set of manual moves would create, scoped to the
    moved matches' day/teams/venue (a pre-existing conflict elsewhere never
    blocks an unrelated repair). ``changes``: match id → (naive
    tournament-local start, venue)."""
    cfg = _validation_config(tournament)
    tz = _tournament_tz(tournament)
    reqs, preoccupied, linked = build_schedule_inputs(
        tournament, cfg, include_ids=set(changes),
    )

    from apps.matches.models import Match

    current = {
        str(m.id): (m.scheduled_at, m.venue)
        for m in Match.objects.filter(
            tournament=tournament, id__in=[r.id for r in reqs]
        )
    }
    assignments: dict[str, tuple[datetime, str]] = {}
    for r in reqs:
        dt, venue = current.get(r.id, (None, ""))
        if dt is not None:
            assignments[r.id] = (_local(dt, tz), venue)
    changed = {str(mid): slot for mid, slot in changes.items()}
    assignments.update(changed)

    violations = validate_schedule(
        assignments, reqs, cfg, preoccupied=preoccupied, linked=linked,
    )

    by_id = {r.id: r for r in reqs}
    teams: set[str] = set()
    venues: set[str] = set()
    days: set[str] = set()
    for mid, (dt, venue) in changed.items():
        req = by_id.get(mid)
        if req:
            teams.update(t for t in (req.home, req.away) if t)
        venues.add(venue)
        days.add(dt.date().isoformat())

    def relevant(v: dict[str, Any]) -> bool:
        if v.get("match_id") in changed or v.get("other_match_id") in changed:
            return True
        if v.get("team_id") in teams or v.get("linked_team_id") in teams:
            return True
        at = str(v.get("at") or v.get("date") or "")
        return v.get("venue") in venues and at[:10] in days

    return [v for v in violations if relevant(v)]


def reschedule_match(
    *,
    match,
    by,
    scheduled_at: datetime | None = None,
    venue: str | None = None,
    force: bool = False,
    event_id: _uuid.UUID | None = None,
    request=None,
) -> list[dict[str, Any]]:
    """Move ONE match (time and/or venue — increment A of the repair seam).

    Only ``scheduled``/``postponed`` matches are movable (in-flight or
    finished results never move). Naive ``scheduled_at`` is tournament-local
    wall clock (invariant 14). Hard violations raise ``RepairConflict``
    unless ``force``; the returned list rides along as warnings either way.
    Audited (``match_rescheduled``, before/after slot)."""
    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit

    if match.status not in _movable_statuses():
        raise ValidationError("match_not_movable")
    tournament = match.tournament
    tz = _tournament_tz(tournament)

    new_dt = scheduled_at if scheduled_at is not None else match.scheduled_at
    if new_dt is None:
        raise ValidationError("scheduled_at_required")
    if dj_tz.is_naive(new_dt):
        new_dt = new_dt.replace(tzinfo=tz)
    new_venue = (match.venue if venue is None else str(venue))[:120]

    violations = validate_slot_changes(
        tournament, {match.id: (_local(new_dt, tz), new_venue)},
    )
    hard = [v for v in violations if v.get("hard", True)]
    if hard and not force:
        raise RepairConflict(violations)

    before = {
        "scheduled_at": (
            match.scheduled_at.isoformat() if match.scheduled_at else None
        ),
        "venue": match.venue,
    }
    with transaction.atomic():
        match.scheduled_at = new_dt
        match.venue = new_venue
        match.save(update_fields=["scheduled_at", "venue", "updated_at"])
        audit = emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_rescheduled",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            tournament_id=match.tournament_id,
            match_id=match.id,
            idempotency_key=event_id,
            payload_before=before,
            payload_after={
                "scheduled_at": match.scheduled_at.isoformat(),
                "venue": match.venue,
                "forced": bool(hard),
                "violations": violations,
            },
            request=request,
        )
        queue_slot_change_notifications(
            tournament=tournament,
            batch_id=audit.id,
            by=by,
            changes=[{
                "match_id": str(match.id),
                "old": before,
                "new": {
                    "scheduled_at": match.scheduled_at.isoformat(),
                    "venue": match.venue,
                },
            }],
        )
        _publish_schedule_ticks(match.tournament_id, [match.id])
    return violations


def _duration_minutes(tournament, sport: str, default: int) -> int:
    """Per-sport match duration (tournament override → sport profile →
    the run's slot length) — the same resolution ``build_schedule_inputs``
    applies, so the cascade sees the intervals validation will see."""
    from apps.matches.services.set_scoring import sport_profile

    override = next(
        (
            (s.get("scheduling") or {})
            for s in tournament.sports or []
            if s.get("key") == sport
        ),
        {},
    )
    if override.get("duration_minutes"):
        return int(override["duration_minutes"])
    prof = sport_profile(sport)
    return int(prof["duration_minutes"]) if prof else default


def delay_match(
    *,
    match,
    by,
    minutes: int,
    cascade: bool = True,
    force: bool = False,
    event_id: _uuid.UUID | None = None,
    request=None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Delay one match by ``minutes`` and cascade (increment C).

    The target shifts rigidly by +minutes. With ``cascade`` (default) later
    same-venue MOVABLE matches are pushed just enough — in scheduled_at
    order — to restore venue non-overlap and team rest gaps against
    everything already moved AND the fixed obstacles (live/completed/locked
    matches never move; the cascade routes around them). Whatever moved is
    re-validated through ``validate_slot_changes`` — a fixed obstacle the
    rigid target now overlaps (a locked slot included) surfaces as a hard
    violation: ``RepairConflict`` unless ``force``. ONE audit row
    (``match_delay_cascade``) carries the full ``{match_id, old, new}``
    list; idempotent on ``event_id``. Returns ``(moved, violations)``."""
    from datetime import timedelta

    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit
    from apps.matches.models import Match

    if match.status not in _movable_statuses():
        raise ValidationError("match_not_movable")
    if match.locked_at is not None:
        raise ValidationError("match_locked")
    if match.scheduled_at is None:
        raise ValidationError("match_not_scheduled")
    minutes = int(minutes)
    if not 1 <= minutes <= 480:
        raise ValidationError("invalid_minutes")

    tournament = match.tournament
    tz = _tournament_tz(tournament)
    cfg = _validation_config(tournament)
    rest = timedelta(minutes=cfg.rest_minutes)

    def dur(m) -> timedelta:
        return timedelta(
            minutes=_duration_minutes(tournament, m.sport, cfg.slot_minutes)
        )

    def teams_of(m) -> set[str]:
        return {str(x) for x in (m.home_team_id, m.away_team_id) if x}

    old_start = _local(match.scheduled_at, tz)
    new_start = old_start + timedelta(minutes=minutes)
    venue = match.venue

    # (start, end, venue, team_ids) — the moving front the sweep packs behind.
    new_starts: dict[Any, datetime] = {match.id: new_start}
    moved_rows = [match]
    moving = [(new_start, new_start + dur(match), venue, teams_of(match))]

    if cascade:
        others = list(
            Match.objects.filter(
                tournament=tournament,
                deleted_at__isnull=True,
                scheduled_at__isnull=False,
            ).exclude(id=match.id)
        )

        def lstart(m) -> datetime:
            assert m.scheduled_at is not None  # filtered scheduled_at__isnull=False
            return _local(m.scheduled_at, tz)

        def is_movable(m) -> bool:
            return m.status in _movable_statuses() and m.locked_at is None

        # Live/completed/locked matches are fixed obstacles — the cascade
        # pushes movable matches PAST them, never onto them.
        obstacles = [
            (lstart(m), lstart(m) + dur(m), m.venue, teams_of(m))
            for m in others
            if not is_movable(m)
        ]
        queue = sorted(
            (
                m for m in others
                if is_movable(m) and m.venue == venue
                and lstart(m) >= old_start
            ),
            key=lambda m: (lstart(m), m.match_no),
        )
        for m in queue:
            start = lstart(m)
            d = dur(m)
            mteams = teams_of(m)
            required = start
            for _ in range(100):  # settle past chained blockers
                bumped = required
                for s, e, v, ts in moving + obstacles:
                    if v == m.venue and s < bumped + d and bumped < e:
                        bumped = max(bumped, e)
                    if ts & mteams and s < bumped + d + rest \
                            and bumped < e + rest:
                        bumped = max(bumped, e + rest)
                if bumped == required:
                    break
                required = bumped
            if required > start:
                new_starts[m.id] = required
                moved_rows.append(m)
                moving.append((required, required + d, m.venue, mteams))

    by_id = {m.id: m for m in moved_rows}
    violations = validate_slot_changes(
        tournament,
        {mid: (st, by_id[mid].venue) for mid, st in new_starts.items()},
    )
    hard = [v for v in violations if v.get("hard", True)]
    if hard and not force:
        raise RepairConflict(violations)

    moved: list[dict[str, Any]] = []
    with transaction.atomic():
        for m in moved_rows:
            old_iso = m.scheduled_at.isoformat()
            m.scheduled_at = new_starts[m.id].replace(tzinfo=tz)
            m.save(update_fields=["scheduled_at", "updated_at"])
            moved.append({
                "match_id": str(m.id),
                "old": old_iso,
                "new": m.scheduled_at.isoformat(),
                "venue": m.venue,
            })
        audit = emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_delay_cascade",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            tournament_id=match.tournament_id,
            match_id=match.id,
            idempotency_key=event_id,
            payload_before={"minutes": minutes, "cascade": bool(cascade)},
            payload_after={
                "minutes": minutes,
                "cascade": bool(cascade),
                "moved": moved,
                "forced": bool(hard),
                "violations": violations,
            },
            request=request,
        )
        queue_slot_change_notifications(
            tournament=tournament,
            batch_id=audit.id,
            by=by,
            changes=[
                {
                    "match_id": e["match_id"],
                    "old": {"scheduled_at": e["old"], "venue": e["venue"]},
                    "new": {"scheduled_at": e["new"], "venue": e["venue"]},
                }
                for e in moved
            ],
        )
        _publish_schedule_ticks(
            match.tournament_id, [e["match_id"] for e in moved]
        )
    return moved, violations


#: Drift (minutes) below which an actual-end reflow is a no-op — avoids
#: churning the calendar for trivial over/under-runs (stability gate, R11).
_REFLOW_MIN_DRIFT = 5
#: Drift above which the reflow is NOT trusted — a stale "complete" click hours
#: after play ended (ended_at is wall-clock at the click) would otherwise shift
#: the whole queue by that much; leave it for manual repair (matches the 8h cap
#: delay_match enforces). Review 2026-06-25.
_REFLOW_MAX_DRIFT = 480


def reflow_from_actual(
    match_id, *, by=None, request=None,
) -> list[dict[str, Any]]:
    """Elastic live re-timing (R11, owner ask 2026-06-25). After a match
    actually ENDS, move the later MOVABLE matches on the SAME court to follow
    its real end time: a match that ran long pushes the rest back, an early
    finish pulls them up — the court's remaining queue is re-packed from
    ``ended_at`` (respecting venue occupancy + team rest, routing past fixed
    live/locked obstacles). Auto-applies ONLY when no hard constraint is
    violated; otherwise the plan is left untouched for manual repair.

    Opt-in per tournament (``scheduling_config["auto_reflow"]``) and skipped for
    drift under ``_REFLOW_MIN_DRIFT``. Fired from ``transition_match`` on commit
    when a match completes; safe to call directly. Returns the moved rows."""
    from datetime import timedelta

    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit
    from apps.matches.models import Match

    match = Match.objects.filter(id=match_id, deleted_at__isnull=True).first()
    if (match is None or match.scheduled_at is None or match.ended_at is None
            or not match.venue):
        return []
    tournament = match.tournament
    if not (tournament.scheduling_config or {}).get("auto_reflow"):
        return []

    tz = _tournament_tz(tournament)
    cfg = _validation_config(tournament)
    rest = timedelta(minutes=cfg.rest_minutes)

    def dur(m) -> timedelta:
        return timedelta(
            minutes=_duration_minutes(tournament, m.sport, cfg.slot_minutes)
        )

    def teams_of(m) -> set[str]:
        return {str(x) for x in (m.home_team_id, m.away_team_id) if x}

    def lstart(m) -> datetime:
        assert m.scheduled_at is not None
        return _local(m.scheduled_at, tz)

    def is_movable(m) -> bool:
        return m.status in _movable_statuses() and m.locked_at is None

    sched_start = _local(match.scheduled_at, tz)
    actual_end = _local(match.ended_at, tz)
    planned_end = sched_start + dur(match)
    drift = (actual_end - planned_end).total_seconds() / 60.0
    if abs(drift) < _REFLOW_MIN_DRIFT or abs(drift) > _REFLOW_MAX_DRIFT:
        return []
    delta = timedelta(minutes=drift)
    # The court is free no earlier than the LATER of the real end and the
    # planned end of this slot: a late finish pushes the queue back, while an
    # early finish lets a LATE-running queue recover toward plan — but never
    # starts a match before its slot would have freed on schedule (no surprise
    # early kickoffs; also keeps clear of the finished match's planned slot,
    # which the validator still treats as occupied).
    court_free = max(actual_end, planned_end)

    others = list(
        Match.objects.filter(
            tournament=tournament, deleted_at__isnull=True,
            scheduled_at__isnull=False,
        ).exclude(id=match.id)
    )
    # Fixed obstacles the re-pack routes around: live/completed/locked matches
    # (venue + team rest), PLUS the just-finished match itself by its ACTUAL
    # interval so a shared-team next match still gets its rest after real end.
    obstacles = [
        (lstart(m), lstart(m) + dur(m), m.venue, teams_of(m))
        for m in others if not is_movable(m)
    ]
    obstacles.append((sched_start, actual_end, match.venue, teams_of(match)))

    # Same court, same DAY, later than the finished match. Scoping to the day is
    # essential: without it, a later day's matches at this venue would be shifted
    # by today's drift (lstart+delta lands a day out and dominates court_free),
    # spilling wrong-time notifications across every subsequent day (review).
    queue = sorted(
        (
            m for m in others
            if is_movable(m) and m.venue == match.venue
            and lstart(m) >= sched_start
            and lstart(m).date() == sched_start.date()
        ),
        key=lambda m: (lstart(m), m.match_no),
    )

    moving: list[tuple[datetime, datetime, str, set[str]]] = []
    new_starts: dict[Any, datetime] = {}
    moved_rows = []
    for m in queue:
        d = dur(m)
        mteams = teams_of(m)
        # Original plan shifted by the drift, never before the court is free.
        required = max(lstart(m) + delta, court_free)
        for _ in range(100):  # settle past chained blockers
            bumped = required
            for s, e, v, ts in moving + obstacles:
                if v == m.venue and s < bumped + d and bumped < e:
                    bumped = max(bumped, e)
                if ts & mteams and s < bumped + d + rest and bumped < e + rest:
                    bumped = max(bumped, e + rest)
            if bumped == required:
                break
            required = bumped
        if required != lstart(m):
            new_starts[m.id] = required
            moved_rows.append(m)
        moving.append((required, required + d, m.venue, mteams))

    if not new_starts:
        return []

    by_id = {m.id: m for m in moved_rows}
    violations = validate_slot_changes(
        tournament,
        {mid: (st, by_id[mid].venue) for mid, st in new_starts.items()},
    )
    if [v for v in violations if v.get("hard", True)]:
        # Never auto-break the plan; leave it for the control room to repair.
        return []

    moved: list[dict[str, Any]] = []
    with transaction.atomic():
        for m in moved_rows:
            old_iso = m.scheduled_at.isoformat()
            m.scheduled_at = new_starts[m.id].replace(tzinfo=tz)
            m.save(update_fields=["scheduled_at", "updated_at"])
            moved.append({
                "match_id": str(m.id), "old": old_iso,
                "new": m.scheduled_at.isoformat(), "venue": m.venue,
            })
        audit = emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_reflow",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            tournament_id=match.tournament_id,
            match_id=match.id,
            payload_before={"drift_minutes": round(drift, 1)},
            payload_after={"drift_minutes": round(drift, 1), "moved": moved},
            request=request,
        )
        queue_slot_change_notifications(
            tournament=tournament,
            batch_id=audit.id,
            by=by,
            changes=[
                {
                    "match_id": e["match_id"],
                    "old": {"scheduled_at": e["old"], "venue": e["venue"]},
                    "new": {"scheduled_at": e["new"], "venue": e["venue"]},
                }
                for e in moved
            ],
        )
        _publish_schedule_ticks(match.tournament_id, [e["match_id"] for e in moved])
    return moved


def _reserve_day_records(tournament) -> list[tuple[set[date], str]]:
    """``(dates, scope)`` per stored ``reserve_days`` constraint record."""
    from apps.fixtures.services.constraints import normalize_scope

    out: list[tuple[set[date], str]] = []
    for c in tournament.constraints or []:
        if not isinstance(c, dict) or c.get("type") != "reserve_days":
            continue
        dates = {
            x for x in (
                _parse_date(v)
                for v in (c.get("params") or {}).get("dates", [])
            ) if x
        }
        if dates:
            out.append((dates, normalize_scope(c.get("scope"))))
    return out


def shift_day(
    *,
    tournament,
    by,
    from_date: date,
    to_date: date | None = None,
    leaf_key: str | None = None,
    force: bool = False,
    event_id: _uuid.UUID | None = None,
    request=None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], date]:
    """Rain-day shift (increment D): move every movable (scheduled/postponed,
    not locked) match on ``from_date`` to ``to_date``, keeping each match's
    time-of-day and venue. ``to_date`` omitted ⇒ the first stored reserve day
    (constraint ``reserve_days``) on/after ``from_date`` that isn't already
    in use — none ⇒ ``reserve_day_unavailable``. Landing on a reserve day
    ACTIVATES it: persisted on ``scheduling_config["activated_reserve_days"]``
    so the slot grid / validation / scheduler re-runs treat it as available.
    The result set is validated against everything else on the calendar —
    hard violations raise ``RepairConflict`` unless ``force``. ONE audit row
    (``shift_day``) with per-match before/after; idempotent on ``event_id``.
    Returns ``(moved, violations, to_date)``."""
    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit
    from apps.fixtures.services.constraints import scope_matches
    from apps.matches.models import Match

    tz = _tournament_tz(tournament)
    candidates = list(
        Match.objects.filter(
            tournament=tournament,
            deleted_at__isnull=True,
            scheduled_at__isnull=False,
        )
    )
    if leaf_key:
        candidates = [m for m in candidates if m.leaf_key == leaf_key]
    movable = sorted(
        (
            m for m in candidates
            if m.status in _movable_statuses() and m.locked_at is None
            and _local(m.scheduled_at, tz).date() == from_date
        ),
        key=lambda m: (m.scheduled_at, m.match_no),
    )
    if not movable:
        raise ValidationError("no_matches_to_move")

    records = _reserve_day_records(tournament)
    all_reserve: set[date] = set()
    for dates, _scope in records:
        all_reserve |= dates
    if to_date is None:
        activated = stored_activated_reserve_days(tournament)
        eligible: set[date] = set()
        for dates, scope in records:
            if scope != "all" and not all(
                scope_matches(
                    scope, sport=m.sport, leaf_key=m.leaf_key,
                    team_ids=tuple(
                        str(x) for x in (m.home_team_id, m.away_team_id) if x
                    ),
                )
                for m in movable
            ):
                continue  # a scoped reserve must cover every moved match
            eligible |= dates
        options = sorted(
            d for d in eligible
            if d >= from_date and d != from_date and d not in activated
        )
        if not options:
            raise ValidationError("reserve_day_unavailable")
        to_date = options[0]
    if to_date == from_date:
        raise ValidationError("invalid_to_date")

    # CRITICAL pre-step: a reserve to_date re-joins the calendar BEFORE the
    # move is validated/applied. Mutate the in-memory config now (validation
    # reads it); persist only when the move actually applies.
    activated_new = False
    if to_date in all_reserve:
        stored = dict(tournament.scheduling_config or {})
        current = {str(v) for v in stored.get("activated_reserve_days") or []}
        iso = to_date.isoformat()
        if iso not in current:
            stored["activated_reserve_days"] = sorted({*current, iso})
            tournament.scheduling_config = stored
            activated_new = True

    changes = {
        m.id: (
            datetime.combine(to_date, _local(m.scheduled_at, tz).time()),
            m.venue,
        )
        for m in movable
    }
    violations = validate_slot_changes(tournament, changes)
    hard = [v for v in violations if v.get("hard", True)]
    if hard and not force:
        raise RepairConflict(violations)

    moved: list[dict[str, Any]] = []
    with transaction.atomic():
        for m in movable:
            old_iso = m.scheduled_at.isoformat()
            m.scheduled_at = changes[m.id][0].replace(tzinfo=tz)
            m.save(update_fields=["scheduled_at", "updated_at"])
            moved.append({
                "match_id": str(m.id),
                "old": old_iso,
                "new": m.scheduled_at.isoformat(),
                "venue": m.venue,
            })
        if activated_new:
            tournament.save(update_fields=["scheduling_config", "updated_at"])
        audit = emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="shift_day",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            tournament_id=tournament.id,
            idempotency_key=event_id,
            payload_before={
                "from_date": from_date.isoformat(),
                "leaf_key": leaf_key or "",
            },
            payload_after={
                "from_date": from_date.isoformat(),
                "to_date": to_date.isoformat(),
                "leaf_key": leaf_key or "",
                "moved": moved,
                "forced": bool(hard),
                "violations": violations,
                "activated_reserve_day": activated_new,
            },
            request=request,
        )
        queue_slot_change_notifications(
            tournament=tournament,
            batch_id=audit.id,
            by=by,
            changes=[
                {
                    "match_id": e["match_id"],
                    "old": {"scheduled_at": e["old"], "venue": e["venue"]},
                    "new": {"scheduled_at": e["new"], "venue": e["venue"]},
                }
                for e in moved
            ],
        )
        _publish_schedule_ticks(tournament.id, [e["match_id"] for e in moved])
    return moved, violations, to_date


def _slot_payload(match) -> dict[str, Any]:
    return {
        "match_id": str(match.id),
        "scheduled_at": (
            match.scheduled_at.isoformat() if match.scheduled_at else None
        ),
        "venue": match.venue,
    }


def swap_slots(
    *,
    tournament,
    match_a: _uuid.UUID,
    match_b: _uuid.UUID,
    by,
    force: bool = False,
    event_id: _uuid.UUID | None = None,
    request=None,
) -> tuple[Any, Any, list[dict[str, Any]]]:
    """Exchange scheduled_at+venue between two matches of the same tournament
    (increment B). Both must be in a movable status and slotted. Conflict
    semantics are identical to ``reschedule_match`` (hard → RepairConflict
    unless ``force``). ONE audit row (``match_slots_swapped``) covers both
    sides; idempotent on ``event_id``. Returns ``(a, b, violations)``."""
    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit
    from apps.matches.models import Match

    a = Match.objects.filter(
        id=match_a, tournament=tournament, deleted_at__isnull=True
    ).first()
    b = Match.objects.filter(
        id=match_b, tournament=tournament, deleted_at__isnull=True
    ).first()
    if a is None or b is None:
        raise ValidationError("match_not_found")
    if a.id == b.id:
        raise ValidationError("matches_must_differ")
    for m in (a, b):
        if m.status not in _movable_statuses():
            raise ValidationError("match_not_movable")
        if m.scheduled_at is None:
            raise ValidationError("match_not_scheduled")

    tz = _tournament_tz(tournament)
    violations = validate_slot_changes(tournament, {
        a.id: (_local(b.scheduled_at, tz), b.venue),
        b.id: (_local(a.scheduled_at, tz), a.venue),
    })
    hard = [v for v in violations if v.get("hard", True)]
    if hard and not force:
        raise RepairConflict(violations)

    before = [_slot_payload(a), _slot_payload(b)]
    with transaction.atomic():
        a.scheduled_at, b.scheduled_at = b.scheduled_at, a.scheduled_at
        a.venue, b.venue = b.venue, a.venue
        a.save(update_fields=["scheduled_at", "venue", "updated_at"])
        b.save(update_fields=["scheduled_at", "venue", "updated_at"])
        after = [_slot_payload(a), _slot_payload(b)]
        audit = emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_slots_swapped",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            tournament_id=tournament.id,
            idempotency_key=event_id,
            payload_before={"slots": before},
            payload_after={
                "matches": [str(a.id), str(b.id)],
                "slots": after,
                "forced": bool(hard),
                "violations": violations,
            },
            request=request,
        )
        after_by = {p["match_id"]: p for p in after}
        queue_slot_change_notifications(
            tournament=tournament,
            batch_id=audit.id,
            by=by,
            changes=[
                {
                    "match_id": p["match_id"],
                    "old": {
                        "scheduled_at": p["scheduled_at"], "venue": p["venue"]
                    },
                    "new": {
                        "scheduled_at": after_by[p["match_id"]]["scheduled_at"],
                        "venue": after_by[p["match_id"]]["venue"],
                    },
                }
                for p in before
            ],
        )
        _publish_schedule_ticks(tournament.id, [a.id, b.id])
    return a, b, violations
