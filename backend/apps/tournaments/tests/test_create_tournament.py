"""TDD — self-serve tournament creation (design-selfserve-flow.md §3 + §9).

A verified user creating a tournament auto-provisions their hidden personal
workspace (Organization, ACTIVE) + an active admin/owner OrganizationMembership
+ the Tournament (DRAFT) + an active admin TournamentMembership — atomically,
with no super-admin approval. A user can start MANY tournaments (regression for
the dropped `single_org_per_admin_user` constraint). Creates are idempotent on
a client `event_id` (invariant 3).
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.organizations.models import (
    MembershipRole,
    OrganizationMembership,
    OrgStatus,
)
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
    TournamentStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified_user(email: str = "founder@test.local") -> User:
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def test_create_first_tournament_provisions_active_workspace_and_admin():
    user = _verified_user()

    t = create_tournament(user=user, name="Kohima Cup", sport_code=None)

    assert t.status == TournamentStatus.DRAFT
    org = t.organization
    assert org.status == OrgStatus.ACTIVE
    om = OrganizationMembership.objects.get(user=user, organization=org)
    assert om.role == MembershipRole.ADMIN
    assert om.is_org_owner is True
    assert om.is_active is True
    tm = TournamentMembership.objects.get(user=user, tournament=t)
    assert tm.role == TournamentMembershipRole.ADMIN
    assert tm.status == TournamentMembershipStatus.ACTIVE


def test_same_user_creates_second_tournament_gets_second_workspace():
    user = _verified_user()

    t1 = create_tournament(user=user, name="Cup One")
    t2 = create_tournament(user=user, name="Cup Two")

    assert t1.organization_id != t2.organization_id
    # Regression: single_org_per_admin_user is dropped — two active admin memberships allowed.
    assert (
        OrganizationMembership.objects.filter(
            user=user, role=MembershipRole.ADMIN, is_active=True
        ).count()
        == 2
    )


def test_create_tournament_is_idempotent_on_event_id():
    user = _verified_user()
    eid = uuid.uuid4()

    a = create_tournament(user=user, name="Idem Cup", event_id=eid)
    b = create_tournament(user=user, name="Idem Cup", event_id=eid)

    assert a.id == b.id
    assert Tournament.objects.count() == 1
