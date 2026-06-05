"""Match event log (invariant #4) — append events; scores are DERIVED from them.

Events are the system of record. Corrections are a VOID event referencing the
original (append-only) — never an UPDATE/DELETE. After commit we publish the
event for live delivery (transport lands with apps.live).
"""
from __future__ import annotations

import logging
import uuid as _uuid

from django.db import transaction
from django.db.models import Max

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.matches.models import (
    SCORING_EVENT_TYPES,
    Match,
    MatchEvent,
    MatchEventType,
)

logger = logging.getLogger(__name__)


def publish_match_event(match_id, event_id) -> None:
    """Post-commit delivery (invariant #4/#11: publish AFTER the DB commit) —
    fan out to the match WebSocket room via the channel layer (Redis in prod,
    in-memory in dev). Best-effort: delivery failure never affects the commit."""
    logger.info("match_event committed match=%s event=%s", match_id, event_id)
    try:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer

        layer = get_channel_layer()
        if layer is not None:
            async_to_sync(layer.group_send)(
                f"match_{match_id}",
                {
                    "type": "match.event",
                    "data": {"match_id": str(match_id), "event_id": str(event_id)},
                },
            )
    except Exception:  # pragma: no cover - delivery is best-effort
        logger.exception("publish_match_event fan-out failed")


def recompute_score(match: Match) -> None:
    """Derive home/away score from the non-voided event log; cache on the Match."""
    voided_ids = set(
        MatchEvent.objects.filter(
            match=match, event_type=MatchEventType.VOID, voids__isnull=False
        ).values_list("voids_id", flat=True)
    )
    home = away = 0
    for e in MatchEvent.objects.filter(match=match).only(
        "id", "event_type", "team"
    ):
        if e.id in voided_ids or e.event_type == MatchEventType.VOID:
            continue
        if e.event_type in SCORING_EVENT_TYPES:
            if e.team_id == match.home_team_id:
                home += 1
            elif e.team_id == match.away_team_id:
                away += 1
        elif e.event_type == MatchEventType.OWN_GOAL:
            # An own goal counts for the OPPONENT.
            if e.team_id == match.home_team_id:
                away += 1
            elif e.team_id == match.away_team_id:
                home += 1
    Match.objects.filter(pk=match.pk).update(home_score=home, away_score=away)
    match.home_score, match.away_score = home, away


def record_match_event(
    *, match, event_type, team=None, player=None, related_player=None,
    minute=None, period="", detail=None, voids=None, by=None,
    event_id: _uuid.UUID | None = None, request=None,
) -> MatchEvent:
    """Append an event (gapless sequence_no, idempotent on event_id, derives score)."""
    if event_id is not None:
        prior = MatchEvent.objects.filter(event_id=event_id).first()
        if prior is not None:
            return prior

    with transaction.atomic():
        locked = Match.objects.select_for_update().get(pk=match.pk)
        next_seq = (
            MatchEvent.objects.filter(match=locked).aggregate(m=Max("sequence_no"))["m"]
            or 0
        ) + 1
        ev = MatchEvent.objects.create(
            organization_id=locked.organization_id,
            tournament_id=locked.tournament_id,
            match=locked,
            sequence_no=next_seq,
            event_type=event_type,
            team=team,
            player=player,
            related_player=related_player,
            minute=minute,
            period=period or locked.current_period,
            detail=detail or {},
            voids=voids,
            event_id=event_id,
            created_by=by,
        )
        recompute_score(locked)
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_event_recorded",
            target_type="match",
            target_id=locked.id,
            organization_id=locked.organization_id,
            idempotency_key=event_id,
            payload_after={
                "type": str(event_type),
                "seq": next_seq,
                "team_id": str(team.id) if team else None,
            },
            request=request,
        )
        eid, mid = ev.id, locked.id
        transaction.on_commit(lambda: publish_match_event(mid, eid))
    return ev


def void_match_event(*, match, target_event, by=None, event_id=None, request=None) -> MatchEvent:
    """Reverse a prior event with an append-only VOID referencing it."""
    return record_match_event(
        match=match,
        event_type=MatchEventType.VOID,
        team=target_event.team,
        voids=target_event,
        detail={"voids_seq": target_event.sequence_no},
        by=by,
        event_id=event_id,
        request=request,
    )
