"""Assign a scorer and record a match result (state machine + audit + idempotency)."""
from __future__ import annotations

import uuid as _uuid

from django.db import transaction

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.matches.models import Match, MatchStatus


def assign_scorer(*, match: Match, user, by=None, request=None) -> Match:
    match.scorer = user
    match.save(update_fields=["scorer", "updated_at"])
    emit_audit(
        actor_user=by,
        actor_role=ActorRole.ADMIN,
        event_type="match_scorer_assigned",
        target_type="match",
        target_id=match.id,
        organization_id=match.organization_id,
        payload_after={"scorer_id": str(user.id)},
        request=request,
    )
    return match


def record_score(
    *, match: Match, home_score: int, away_score: int, by=None,
    event_id: _uuid.UUID | None = None, request=None,
) -> Match:
    """Record the final result and complete the match. Idempotent on event_id."""
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="match_scored"
        ).first()
        if prior is not None:
            return Match.objects.get(pk=match.pk)

    with transaction.atomic():
        match.home_score = int(home_score)
        match.away_score = int(away_score)
        match.status = MatchStatus.COMPLETED
        match.save(update_fields=["home_score", "away_score", "status", "updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_scored",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            idempotency_key=event_id,
            payload_after={"home": int(home_score), "away": int(away_score)},
            request=request,
        )
    return match
