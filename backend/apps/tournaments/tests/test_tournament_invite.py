"""TDD — tournament-scoped invitations (design-selfserve-flow.md §5).

Invite anyone by email to a specific tournament with a tournament role; on
accept, the invitee gets an active TournamentMembership for that tournament.
A user who already owns their own workspace can accept an admin-role tournament
invite without error (regression for the dropped single_org_per_admin_user,
blocker 2). The same email can hold separate pending invites to different
tournaments in the same workspace.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.organizations.models import AdminInvitation, InviteStatus
from apps.organizations.services.invitation import accept_invitation, create_invitation
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def test_invite_to_tournament_and_accept_creates_tournament_membership():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    invitee = _verified("scorer@test.local")

    inv, token = create_invitation(
        org=t.organization,
        email="scorer@test.local",
        role="match_scorer",
        invited_by=admin,
        tournament=t,
    )
    assert inv.tournament_id == t.id

    membership = accept_invitation(token_plaintext=token, accepting_user=invitee)

    assert isinstance(membership, TournamentMembership)
    assert membership.tournament_id == t.id
    assert membership.role == TournamentMembershipRole.MATCH_SCORER
    assert membership.status == TournamentMembershipStatus.ACTIVE


def test_accept_admin_tournament_invite_for_user_with_own_workspace_no_error():
    owner_a = _verified("a@test.local")
    ta = create_tournament(user=owner_a, name="A Cup")
    owner_b = _verified("b@test.local")
    create_tournament(user=owner_b, name="B Cup")  # b already owns a workspace

    inv, token = create_invitation(
        org=ta.organization, email="b@test.local", role="admin", invited_by=owner_a, tournament=ta
    )
    membership = accept_invitation(token_plaintext=token, accepting_user=owner_b)

    assert membership.role == TournamentMembershipRole.ADMIN
    assert membership.tournament_id == ta.id


def test_same_email_two_tournaments_same_org_both_invites_allowed():
    admin = _verified("admin@test.local")
    t1 = create_tournament(user=admin, name="Cup One")
    t2 = create_tournament(user=admin, name="Cup Two", workspace_org=t1.organization)

    create_invitation(
        org=t1.organization, email="ref@test.local", role="referee", invited_by=admin, tournament=t1
    )
    create_invitation(
        org=t1.organization, email="ref@test.local", role="referee", invited_by=admin, tournament=t2
    )

    assert (
        AdminInvitation.objects.filter(
            email="ref@test.local", status=InviteStatus.PENDING
        ).count()
        == 2
    )
