"""Self-serve tournament creation (design-selfserve-flow.md §3.3).

One atomic operation: resolve/provision the creator's hidden personal workspace,
create the Tournament (DRAFT), make the creator its ACTIVE admin, and audit. No
super-admin approval. Idempotent on a client ``event_id`` (invariant 3).
"""
from __future__ import annotations

from django.db import transaction

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.organizations.services.workspace import (
    provision_personal_workspace,
    slugify_for_org,
)
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
    TournamentStatus,
)


def _pick_unique_tournament_slug(org, name: str) -> str:
    """Tournament slug is unique per-org (public URL is (org_slug, tournament_slug))."""
    base = slugify_for_org(name) or "tournament"
    slug, n = base[:63], 2
    while Tournament.objects.filter(
        organization=org, slug=slug, deleted_at__isnull=True
    ).exists():
        slug = f"{base}-{n}"[:63]
        n += 1
    return slug


def create_tournament(
    *, user, name, sport_code=None, workspace_org=None, event_id=None, request=None
) -> Tournament:
    """Create a tournament, auto-provisioning the creator's workspace if needed.

    Returns the existing Tournament unchanged on an ``event_id`` replay.
    """
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="tournament_created"
        ).first()
        if prior is not None:
            existing = Tournament.objects.filter(pk=prior.target_id).first()
            if existing is not None:
                return existing

    sport = None
    if sport_code:
        from apps.sports.models import Sport

        sport = Sport.objects.filter(code=sport_code).first()

    with transaction.atomic():
        org = workspace_org or provision_personal_workspace(
            user=user, name=name, request=request
        )
        tournament = Tournament.objects.create(
            organization=org,
            sport=sport,
            slug=_pick_unique_tournament_slug(org, name),
            name=(name or "Tournament")[:200],
            status=TournamentStatus.DRAFT,
            time_zone=org.time_zone,
            created_by=user,
        )
        TournamentMembership.objects.create(
            user=user,
            tournament=tournament,
            role=TournamentMembershipRole.ADMIN,
            status=TournamentMembershipStatus.ACTIVE,
            assigned_by=user,
        )
        emit_audit(
            actor_user=user,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_created",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=org.id,
            idempotency_key=event_id,
            payload_after={"slug": tournament.slug, "name": tournament.name},
            request=request,
        )
    return tournament
