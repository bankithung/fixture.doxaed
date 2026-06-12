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
from datetime import datetime
from typing import Any

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone as dj_tz

from apps.fixtures.services.scheduler import (
    ScheduleConfig,
    _tournament_tz,
    build_schedule_inputs,
    config_from_dict,
    merge_stored_constraints,
    resolve_team_tags,
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
        emit_audit(
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
    return violations
