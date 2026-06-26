"""Assign / remove match officials (referee, assistants, fourth, umpire).

Mirrors `services/scoring.py::assign_scorer`: the target is verified to be an
active member of the tournament (no cross-org assignment), the write is atomic
and audited, and assignment is idempotent on `event_id` at the standard audit
path. One role per person per match (unique match+user) — reassigning updates.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import timedelta

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.matches.models import Match, MatchOfficial, MatchOfficialStatus
from apps.matches.services.scoring import _is_tournament_member

# Officials within this window of a match's kick-off count as a clash (durations
# aren't modelled precisely — this is a soft, non-blocking double-book warning).
_CLASH_WINDOW = timedelta(minutes=90)


def assign_official(
    *,
    match: Match,
    user,
    role: str,
    by=None,
    event_id: _uuid.UUID | None = None,
    request=None,
) -> MatchOfficial:
    """Assign ``user`` to ``match`` in ``role``. Idempotent on event_id."""
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="match_official_assigned"
        ).first()
        if prior is not None:  # replay (invariant 3)
            return MatchOfficial.objects.filter(match=match, user=user).first()
    if not _is_tournament_member(user, match):
        raise ValidationError("Official must be an active member of this tournament.")
    with transaction.atomic():
        obj, _created = MatchOfficial.objects.update_or_create(
            match=match,
            user=user,
            defaults={
                "role": role,
                "organization_id": match.organization_id,
                "assigned_by": by,
                "status": MatchOfficialStatus.ASSIGNED,
                "accepted_at": None,
            },
        )
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_official_assigned",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            tournament_id=match.tournament_id,
            match_id=match.id,
            idempotency_key=event_id,
            payload_after={"user_id": str(user.id), "role": role},
            request=request,
        )
    return obj


def remove_official(
    *, match: Match, official_id, by=None, request=None
) -> MatchOfficial | None:
    """Remove an official row from ``match`` (audited). Returns None if absent."""
    with transaction.atomic():
        obj = MatchOfficial.objects.filter(match=match, id=official_id).first()
        if obj is None:
            return None
        before = {"user_id": str(obj.user_id), "role": obj.role}
        obj.delete()
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_official_removed",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            tournament_id=match.tournament_id,
            match_id=match.id,
            payload_before=before,
            request=request,
        )
    return obj


def official_clashes(*, user, match: Match) -> list[Match]:
    """Other matches ``user`` already officiates that kick off within the clash
    window of ``match`` — a soft double-book warning, never a block."""
    if match.scheduled_at is None:
        return []
    lo = match.scheduled_at - _CLASH_WINDOW
    hi = match.scheduled_at + _CLASH_WINDOW
    rows = (
        MatchOfficial.objects.filter(
            user=user,
            match__scheduled_at__gte=lo,
            match__scheduled_at__lte=hi,
            match__deleted_at__isnull=True,
        )
        .exclude(match_id=match.id)
        .select_related("match")
    )
    return [r.match for r in rows]
