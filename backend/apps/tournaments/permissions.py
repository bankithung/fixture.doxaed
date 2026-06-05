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
