"""Self-serve tournament creation (design-selfserve-flow.md §3.3).

One atomic operation: resolve/provision the creator's hidden personal workspace,
create the Tournament (DRAFT), make the creator its ACTIVE admin, and audit. No
super-admin approval. Idempotent on a client ``event_id`` (invariant 3).
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.organizations.services.workspace import (
    provision_personal_workspace,
    slugify_for_org,
)
from apps.teams.models import TeamGroupKind
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
    TournamentScope,
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


def _ensure_season(org):
    """The academic year a within-school event's houses hang off.

    Houses are season-scoped by design (``teams.TeamGroup``): they belong to the
    school year, not to one event, which is what lets a year's sports day,
    inter-house league and march-past sum into a single house table. So an
    intra-school tournament must have a season — the org's current one, else one
    minted from today's academic year (April-March, matching the Indian school
    calendar this platform serves).
    """
    from apps.teams.models import Season

    current = Season.objects.filter(organization=org, is_current=True).first()
    if current is not None:
        return current
    today = timezone.localdate()
    start = today.year if today.month >= 4 else today.year - 1
    label = f"{start}-{str(start + 1)[-2:]}"
    season, _ = Season.objects.get_or_create(
        organization=org,
        label=label,
        defaults={"is_current": True},
    )
    return season


def _ensure_host_institution(tournament):
    """The ONE school a within-school event runs inside.

    ``Team.institution`` is a PROTECT FK that ~40 readers key off — standings,
    keep-apart, emails, records, the album. Rather than fork all of them for a
    sports day, the host school is a real, already-registered Institution row
    and the competing HOUSE rides on ``Team.group``. Named after the workspace,
    which for an operator org is the school itself.
    """
    from apps.teams.models import Institution, InstitutionKind, InstitutionStatus

    org = tournament.organization
    existing = Institution.objects.filter(tournament=tournament).first()
    if existing is not None:
        return existing
    name = (getattr(org, "name", "") or tournament.name or "School")[:200]
    return Institution.objects.create(
        organization=org,
        tournament=tournament,
        slug=slugify_for_org(name)[:80] or "host",
        name=name,
        kind=InstitutionKind.SCHOOL,
        status=InstitutionStatus.REGISTERED,
        school_profile=getattr(org, "school_profile", None),
        attributes={"host": True},
    )


def create_tournament(
    *, user, name, sport_code=None, workspace_org=None, event_id=None, request=None,
    scope=None, group_kind=None,
) -> Tournament:
    """Create a tournament, auto-provisioning the creator's workspace if needed.

    ``scope`` (spec 2026-08-16) decides who competes. Omitted or
    ``inter_school`` is the original behaviour, unchanged. ``intra_school``
    additionally provisions the two things a within-school event cannot start
    without — the season its houses hang off, and the one host school every
    team's ``institution`` FK resolves to — so the funnel can go straight from
    setup to house setup with nothing to register.

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

    scope = scope or TournamentScope.INTER_SCHOOL
    if scope not in TournamentScope.values:
        raise ValidationError(f"Unknown tournament scope: {scope}")
    intra = scope == TournamentScope.INTRA_SCHOOL
    if intra:
        kind = group_kind or TeamGroupKind.HOUSE
        if kind not in TeamGroupKind.values:
            raise ValidationError(f"Unknown group kind: {group_kind}")
    else:
        # The noun is meaningless without houses; don't store a stale one.
        kind = ""

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
            scope=scope,
            group_kind=kind,
            created_by=user,
        )
        if intra:
            tournament.season_ref = _ensure_season(org)
            tournament.save(update_fields=["season_ref"])
            _ensure_host_institution(tournament)
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
