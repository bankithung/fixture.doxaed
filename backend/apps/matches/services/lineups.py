"""Lineup set + confirm — referee/manager declares the XI before kickoff.

Org-scoped (invariant #2), idempotent on event_id (invariant #3), audited
(invariant #4), and frozen once the match leaves `scheduled` (invariant #7 —
match rules freeze at kickoff; a lineup cannot change once the match is live).
"""
from __future__ import annotations

import uuid as _uuid

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.matches.models import (
    Lineup,
    LineupEntry,
    LineupRole,
    Match,
    MatchStatus,
)

_SET_LINEUP_EVENT = "lineup_set"


def _validate_team(match: Match, team) -> None:
    if team.id not in (match.home_team_id, match.away_team_id):
        raise ValidationError("Team does not play in this match.")


def set_lineup(
    *, match: Match, team, entries, by=None,
    event_id: _uuid.UUID | None = None, request=None,
) -> Lineup:
    """Replace a team's lineup for a match atomically.

    Validates every player belongs to ``team`` and that ``team`` plays in
    ``match``. Blocks once the match is no longer ``scheduled`` (lineups freeze
    at kickoff). Idempotent on ``event_id`` — a replay returns the existing
    lineup unchanged.
    """
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type=_SET_LINEUP_EVENT
        ).first()
        if prior is not None:
            existing = (
                Lineup.objects.filter(pk=prior.target_id, deleted_at__isnull=True)
                .first()
            )
            if existing is not None:
                return existing

    _validate_team(match, team)

    from apps.teams.models import Player

    entries = list(entries or [])
    resolved: list[tuple[Player, str, int | None]] = []
    for entry in entries:
        player_id = entry.get("player_id")
        player = Player.objects.filter(
            id=player_id, deleted_at__isnull=True
        ).first()
        if player is None:
            raise ValidationError("Player not found.")
        if player.team_id != team.id:
            raise ValidationError("Player is not on this team.")
        role = entry.get("role") or LineupRole.STARTER
        if role not in LineupRole.values:
            raise ValidationError(f"Invalid lineup role: {role}")
        resolved.append((player, role, entry.get("shirt_no")))

    # PRD §5.4 hard check: a player serving a card ban cannot be named.
    if resolved:
        from apps.matches.services.discipline import suspended_player_ids

        banned = suspended_player_ids(match.tournament)
        for player, _role, _shirt in resolved:
            if str(player.id) in banned:
                name = player.person.full_name if player.person_id else str(player.id)
                raise ValidationError(f"player_suspended:{name}")

    with transaction.atomic():
        locked = Match.objects.select_for_update().get(pk=match.pk)
        if locked.status != MatchStatus.SCHEDULED:
            raise ValidationError(
                f"Lineups are frozen once the match is '{locked.status}'."
            )
        lineup, _created = Lineup.objects.get_or_create(
            match=locked, team=team, deleted_at__isnull=True,
            defaults={"organization_id": locked.organization_id},
        )
        LineupEntry.objects.filter(lineup=lineup).delete()
        LineupEntry.objects.bulk_create(
            [
                LineupEntry(
                    lineup=lineup, player=player, role=role, shirt_no=shirt_no
                )
                for (player, role, shirt_no) in resolved
            ]
        )
        lineup.save(update_fields=["updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type=_SET_LINEUP_EVENT,
            target_type="lineup",
            target_id=lineup.id,
            organization_id=locked.organization_id,
            idempotency_key=event_id,
            payload_after={
                "team_id": str(team.id),
                "entries": len(resolved),
            },
            request=request,
        )
    return lineup


def confirm_lineup(
    *, match: Match, team, by=None,
    event_id: _uuid.UUID | None = None, request=None,
) -> Lineup:
    """Mark a team's lineup confirmed (sets confirmed_at/confirmed_by + audit).

    Idempotent on ``event_id``."""
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="lineup_confirmed"
        ).first()
        if prior is not None:
            existing = (
                Lineup.objects.filter(pk=prior.target_id, deleted_at__isnull=True)
                .first()
            )
            if existing is not None:
                return existing

    _validate_team(match, team)

    with transaction.atomic():
        lineup = (
            Lineup.objects.select_for_update()
            .filter(match=match, team=team, deleted_at__isnull=True)
            .first()
        )
        if lineup is None:
            raise ValidationError("No lineup to confirm for this team.")
        if lineup.confirmed_at is None:
            lineup.confirmed_at = timezone.now()
            lineup.confirmed_by = by
            lineup.save(update_fields=["confirmed_at", "confirmed_by", "updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="lineup_confirmed",
            target_type="lineup",
            target_id=lineup.id,
            organization_id=lineup.organization_id,
            idempotency_key=event_id,
            payload_after={"team_id": str(team.id)},
            request=request,
        )
    return lineup
