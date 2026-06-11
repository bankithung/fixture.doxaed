"""Tournament-scoped authorization helpers (v1Users §4.7 two-layer model)."""
from __future__ import annotations

from apps.organizations.models import MembershipRole, OrganizationMembership
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)

_MANAGE_ROLES = {
    TournamentMembershipRole.ADMIN,
    TournamentMembershipRole.CO_ORGANIZER,
}


def can_manage_tournament(user, tournament) -> bool:
    """True if ``user`` may invite/assign within ``tournament``:
    an active tournament admin/co-organizer, OR an active org admin/owner of
    the workspace the tournament lives in.
    """
    if not getattr(user, "is_authenticated", False):
        return False
    if TournamentMembership.objects.filter(
        user=user,
        tournament=tournament,
        status=TournamentMembershipStatus.ACTIVE,
        role__in=_MANAGE_ROLES,
    ).exists():
        return True
    return OrganizationMembership.objects.filter(
        user=user,
        organization_id=tournament.organization_id,
        is_active=True,
        role=MembershipRole.ADMIN,
    ).exists()


def is_tournament_organizer(user, tournament) -> bool:
    """True only for the person who ORGANISED the tournament: its creator, or
    an active org admin of the workspace it lives in. Invited members — even
    tournament-scoped admins/co-organizers — are NOT organizers: they may
    manage day-to-day, but destructive verbs (delete, deactivate) are the
    organizer's alone (owner decision 2026-06-11).
    """
    if not getattr(user, "is_authenticated", False):
        return False
    if tournament.created_by_id and tournament.created_by_id == user.id:
        return True
    return OrganizationMembership.objects.filter(
        user=user,
        organization_id=tournament.organization_id,
        is_active=True,
        role=MembershipRole.ADMIN,
    ).exists()


def can_access_module(user, tournament, module_code: str) -> bool:
    """Two-layer verb gate (spec 2026-06-10 P5): managers can do everything
    (escape hatch), and everyone else is checked against their effective
    tournament module set (role defaults from the catalog ± per-member
    grants). ADDITIVE relative to the old binary manager gate — it widens
    access for the roles the catalog says should have it (e.g.
    game_coordinator → bracket/schedule editing), never narrows."""
    if not getattr(user, "is_authenticated", False):
        return False
    if can_manage_tournament(user, tournament):
        return True
    from apps.permissions.services.resolver import effective_tournament_modules

    return module_code in effective_tournament_modules(user, tournament)
