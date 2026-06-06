"""Match-incident reports — a referee files a post-match incident for disputes /
discipline. Org-scoped (invariant #2), append-only, idempotent on event_id
(invariant #3), audited (invariant #4), and notifies tournament admins."""
from __future__ import annotations

import uuid as _uuid

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.matches.models import Match, MatchIncident


def file_incident(
    *, match: Match, kind: str, description: str, by=None,
    minute: int | None = None, player=None,
    event_id: _uuid.UUID | None = None, request=None,
) -> MatchIncident:
    """Record an incident report (idempotent on event_id).

    If ``player`` is given it must belong to one of the two match teams."""
    if event_id is not None:
        prior = MatchIncident.objects.filter(event_id=event_id).first()
        if prior is not None:
            return prior

    if player is not None and player.team_id not in (
        match.home_team_id, match.away_team_id
    ):
        raise ValidationError("Player is not on either match team.")

    with transaction.atomic():
        incident = MatchIncident.objects.create(
            organization_id=match.organization_id,
            match=match,
            reported_by=by,
            kind=kind,
            description=description,
            minute=minute,
            player=player,
            event_id=event_id,
        )
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_incident_filed",
            target_type="match_incident",
            target_id=incident.id,
            organization_id=match.organization_id,
            idempotency_key=event_id,
            payload_after={"kind": kind, "match_id": str(match.id)},
            request=request,
        )
        tournament = match.tournament
        if getattr(tournament, "created_by_id", None):
            from apps.notifications.services.dispatch import create_notification

            create_notification(
                user=tournament.created_by,
                kind="match_incident_filed",
                title="Match incident filed",
                body=description[:200],
                tournament=tournament,
            )
    return incident
