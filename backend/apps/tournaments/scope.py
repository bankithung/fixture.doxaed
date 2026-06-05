"""Tenant-isolation-aware tournament querysets (invariant 2).

A user may see a tournament only if they hold an active TournamentMembership in
it OR are an active org admin/owner of the workspace it lives in. Every list/
detail view must filter through here so no cross-org leak is possible.
"""
from __future__ import annotations

from django.db.models import Q

from apps.organizations.models import MembershipRole, OrganizationMembership
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipStatus,
)


def accessible_tournaments(user):
    if not getattr(user, "is_authenticated", False):
        return Tournament.objects.none()
    admin_org_ids = OrganizationMembership.objects.filter(
        user=user, is_active=True, role=MembershipRole.ADMIN
    ).values_list("organization_id", flat=True)
    member_tournament_ids = TournamentMembership.objects.filter(
        user=user, status=TournamentMembershipStatus.ACTIVE
    ).values_list("tournament_id", flat=True)
    return (
        Tournament.objects.filter(deleted_at__isnull=True)
        .filter(Q(organization_id__in=admin_org_ids) | Q(id__in=member_tournament_ids))
        .distinct()
    )
