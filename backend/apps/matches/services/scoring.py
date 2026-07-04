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
    """Assign (or, with ``user=None``, clear) the scorer seat. The assignee is
    notified with a console deep link — assignment used to be silent, so crew
    had to hunt for their matches."""
    if user is not None and not _is_tournament_member(user, match):
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
            tournament_id=match.tournament_id,
            match_id=match.id,
            payload_after={"scorer_id": str(user.id) if user else None},
            request=request,
        )
        if user is not None and (by is None or user.id != by.id):
            mid, tid = match.id, match.tournament_id
            uid = user.id
            transaction.on_commit(
                lambda: _notify_assignment(uid, mid, tid, "score")
            )
    return match


def _notify_assignment(user_id, match_id, tournament_id, verb: str) -> None:
    """Post-commit, best-effort: in-app notification + email to the assignee
    (crew are often not online when the roster is drawn up)."""
    try:
        from django.contrib.auth import get_user_model

        from apps.notifications.services.dispatch import create_notification

        user = get_user_model().objects.filter(id=user_id).first()
        match = Match.objects.filter(id=match_id).select_related(
            "home_team", "away_team", "tournament"
        ).first()
        if user is None or match is None:
            return
        home = match.home_team.name if match.home_team else "TBD"
        away = match.away_team.name if match.away_team else "TBD"
        when = ""
        if match.scheduled_at:
            when = f" on {match.scheduled_at.strftime('%d %b %H:%M')} UTC"
        title = f"You are assigned to {verb}: {home} vs {away}"
        url = f"/tournaments/{tournament_id}/matches/{match_id}"
        create_notification(
            user=user, kind="match_assignment", title=title,
            body=f"{match.tournament.name}{when}. Open your console from this link.",
            url=url, tournament=match.tournament,
        )
        if user.email:
            from django.conf import settings
            from django.core.mail import send_mail

            send_mail(
                subject=title,
                message=(
                    f"{match.tournament.name}\n\n"
                    f"{home} vs {away}{when}.\n"
                    f"Open your match console: https://fixture.doxaed.com{url}\n"
                ),
                from_email=getattr(settings, "DEFAULT_FROM_EMAIL", None),
                recipient_list=[user.email],
                fail_silently=True,  # in-app row is the durable record
            )
    except Exception:  # pragma: no cover - notification must never block ops
        import logging

        logging.getLogger(__name__).exception("assignment notification failed")


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
        # Same knockout-draw guard as transition_match: a level knockout
        # recorded through the quick-result path used to complete silently
        # and stall the bracket (winner_id stays None, dependents wait
        # forever). The caller resolves it via the shootout endpoint.
        from apps.matches.services.state import _guard_knockout_draw

        _guard_knockout_draw(locked)
        locked.status = MatchStatus.COMPLETED
        locked.save(update_fields=["home_score", "away_score", "status", "updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_scored",
            target_type="match",
            target_id=locked.id,
            organization_id=locked.organization_id,
            tournament_id=locked.tournament_id,
            match_id=locked.id,
            idempotency_key=event_id,
            payload_before=before,
            payload_after={"home": int(home_score), "away": int(away_score)},
            request=request,
        )
        # Knockout advancement (invariant #9) — resolve dependents after commit.
        from apps.live.publish import publish_tournament_tick
        from apps.matches.services.state import (
            _fire_advancement,
            _fire_badges,
            _fire_lifecycle,
        )

        mid, tid = locked.id, locked.tournament_id
        transaction.on_commit(lambda: _fire_advancement(mid))
        transaction.on_commit(lambda: _fire_badges(mid))
        # Lifecycle spine: the last result completing may finish the
        # tournament (after advancement, so materialized stages are seen).
        transaction.on_commit(lambda: _fire_lifecycle(tid, MatchStatus.COMPLETED))
        # Spec 2026-06-12 §2.c: record_score used to publish nothing — thin
        # post-commit "score" tick for the control room / public stream.
        transaction.on_commit(lambda: publish_tournament_tick(tid, mid, "score"))
    return locked
