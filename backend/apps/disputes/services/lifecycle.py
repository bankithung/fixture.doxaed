"""Dispute lifecycle — raise + guarded, audited transitions; notifies parties."""
from __future__ import annotations

import uuid as _uuid

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.disputes.models import Dispute, DisputeStatus

S = DisputeStatus

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    S.OPEN: {S.UNDER_REVIEW, S.RESOLVED, S.REJECTED, S.WITHDRAWN},
    S.UNDER_REVIEW: {S.RESOLVED, S.REJECTED},
    S.RESOLVED: set(),
    S.REJECTED: set(),
    S.WITHDRAWN: set(),
}


def raise_dispute(
    *, tournament, raised_by, kind: str, description: str, match=None,
    event_id: _uuid.UUID | None = None, request=None,
) -> Dispute:
    if event_id is not None:
        prior = Dispute.objects.filter(event_id=event_id).first()
        if prior is not None:
            return prior
    with transaction.atomic():
        dispute = Dispute.objects.create(
            organization=tournament.organization,
            tournament=tournament,
            match=match,
            raised_by=raised_by,
            kind=(kind or "")[:64],
            description=description,
            status=S.OPEN,
            event_id=event_id,
        )
        emit_audit(
            actor_user=raised_by, actor_role=ActorRole.ADMIN,
            event_type="dispute_raised", target_type="dispute", target_id=dispute.id,
            organization_id=tournament.organization_id, idempotency_key=event_id,
            payload_after={"kind": dispute.kind}, request=request,
        )
        # Notify the whole organizing team (delegated co-organizers used to
        # miss disputes entirely — only created_by heard about them).
        from apps.notifications.services.dispatch import notify_many
        from apps.tournaments.models import (
            TournamentMembership,
            TournamentMembershipRole,
            TournamentMembershipStatus,
        )

        managers = {
            m.user
            for m in TournamentMembership.objects.filter(
                tournament=tournament,
                status=TournamentMembershipStatus.ACTIVE,
                role__in=(
                    TournamentMembershipRole.ADMIN,
                    TournamentMembershipRole.CO_ORGANIZER,
                ),
            ).select_related("user")
        }
        if tournament.created_by_id:
            managers.add(tournament.created_by)
        managers.discard(raised_by)
        url = f"/tournaments/{tournament.id}/settings"
        notify_many(
            users=managers, kind="dispute_raised", title="New dispute raised",
            body=description[:200], url=url, tournament=tournament,
        )
    return dispute


def transition_dispute(
    *, dispute, to_status, by=None, resolution: str = "", request=None
) -> Dispute:
    with transaction.atomic():
        locked = Dispute.objects.select_for_update().get(pk=dispute.pk)
        frm = locked.status
        if to_status not in ALLOWED_TRANSITIONS.get(frm, set()):
            raise ValidationError(f"Illegal dispute transition: {frm} -> {to_status}")
        if to_status in (S.RESOLVED, S.REJECTED) and len(resolution.strip()) < 5:
            raise ValidationError("A resolution note (>=5 chars) is required.")

        locked.status = to_status
        if resolution:
            locked.resolution = resolution
        if to_status in (S.UNDER_REVIEW, S.RESOLVED, S.REJECTED):
            locked.reviewed_by = by
            locked.reviewed_at = timezone.now()
        locked.save(
            update_fields=["status", "resolution", "reviewed_by", "reviewed_at", "updated_at"]
        )
        emit_audit(
            actor_user=by, actor_role=ActorRole.ADMIN,
            event_type="dispute_status_changed", target_type="dispute",
            target_id=locked.id, organization_id=locked.organization_id,
            payload_before={"status": frm}, payload_after={"status": to_status},
            reason=resolution, request=request,
        )
        if to_status in (S.RESOLVED, S.REJECTED) and locked.raised_by_id:
            from apps.notifications.services.dispatch import create_notification

            create_notification(
                user=locked.raised_by, kind="dispute_resolved",
                title=f"Your dispute was {to_status}",
                body=resolution[:200], tournament=locked.tournament,
            )
    return locked
