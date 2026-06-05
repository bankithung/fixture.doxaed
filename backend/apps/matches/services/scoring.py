"""Assign a scorer and record a match result (state machine + audit + idempotency).

Hardened per commit security review: record_score guards the state transition
(only scheduled/live -> completed), locks the row (no TOCTOU between scorers),
and captures a before-image; assign_scorer verifies the scorer is actually a
member of the tournament (no cross-org assignment) and is atomic.
"""
from __future__ import annotations

import uuid as _uuid

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.matches.models import Match, MatchStatus


def _is_tournament_member(user, match: Match) -> bool:
    from apps.organizations.models import MembershipRole, OrganizationMembership
    from apps.tournaments.models import TournamentMembership, TournamentMembershipStatus

    if TournamentMembership.objects.filter(
        user=user, tournament=match.tournament, status=TournamentMembershipStatus.ACTIVE
    ).exists():
        return True
    return OrganizationMembership.objects.filter(
        user=user, organization=match.organization, is_active=True,
        role=MembershipRole.ADMIN,
    ).exists()


def assign_scorer(*, match: Match, user, by=None, request=None) -> Match:
    if not _is_tournament_member(user, match):
        raise ValidationError("Scorer must be an active member of this tournament.")
    with transaction.atomic():
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
    """Record the final result and complete the match.

    Idempotent on event_id (replay returns the match unchanged). Guards the
    transition: only a scheduled/live match can be scored — re-scoring a
    completed/cancelled match raises (corrections go through a separate audited
    amend verb, not this one).
    """
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="match_scored"
        ).first()
        if prior is not None:
            return Match.objects.get(pk=match.pk)

    with transaction.atomic():
        locked = Match.objects.select_for_update().get(pk=match.pk)
        if locked.status not in (MatchStatus.SCHEDULED, MatchStatus.LIVE):
            raise ValidationError(
                f"Cannot score a match in status '{locked.status}'."
            )
        before = {
            "home": locked.home_score,
            "away": locked.away_score,
            "status": locked.status,
        }
        locked.home_score = int(home_score)
        locked.away_score = int(away_score)
        locked.status = MatchStatus.COMPLETED
        locked.save(update_fields=["home_score", "away_score", "status", "updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_scored",
            target_type="match",
            target_id=locked.id,
            organization_id=locked.organization_id,
            idempotency_key=event_id,
            payload_before=before,
            payload_after={"home": int(home_score), "away": int(away_score)},
            request=request,
        )
        # Knockout advancement (invariant #9) — resolve dependents after commit.
        from apps.matches.services.state import _fire_advancement

        mid = locked.id
        transaction.on_commit(lambda: _fire_advancement(mid))
    return locked
