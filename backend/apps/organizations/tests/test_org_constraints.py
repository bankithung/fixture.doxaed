"""DB-level constraint tests for Organization & OrganizationMembership.

Each constraint is asserted to raise IntegrityError when violated:

  1. unique_active_role_per_user_per_org
  2. one_owner_per_org (deferrable; checked at COMMIT)
  3. single_org_per_admin_user
  4. owner_flag_only_on_admin_role (CheckConstraint)
"""
from __future__ import annotations

import pytest
from django.db import IntegrityError, transaction

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import (
    MembershipRole,
    OrganizationMembership,
)
from apps.organizations.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
)


pytestmark = pytest.mark.django_db


def test_unique_active_role_per_user_per_org():
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(user=user, organization=org, role=MembershipRole.TEAM_MANAGER)
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            OrganizationMembershipFactory(
                user=user, organization=org, role=MembershipRole.TEAM_MANAGER
            )


def test_multi_role_per_user_per_org_allowed():
    """Multi-role per (user, org) is allowed because role is part of the
    unique tuple.
    """
    user = UserFactory()
    org = OrganizationFactory()
    m1 = OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.CO_ORGANIZER
    )
    m2 = OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER
    )
    assert m1.pk != m2.pk
    assert OrganizationMembership.objects.filter(user=user, organization=org).count() == 2


def test_one_owner_per_org_constraint():
    org = OrganizationFactory()
    u1, u2 = UserFactory(), UserFactory()
    OrganizationMembershipFactory(
        user=u1, organization=org, role=MembershipRole.ADMIN, is_org_owner=True
    )
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            # Try to create a second is_org_owner=True row for the same org.
            OrganizationMembershipFactory(
                user=u2,
                organization=org,
                role=MembershipRole.ADMIN,
                is_org_owner=True,
            )


def test_single_org_per_admin_user_constraint():
    user = UserFactory()
    org_a = OrganizationFactory(slug="org-a")
    org_b = OrganizationFactory(slug="org-b")
    OrganizationMembershipFactory(
        user=user, organization=org_a, role=MembershipRole.ADMIN, is_org_owner=True
    )
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            OrganizationMembershipFactory(
                user=user, organization=org_b, role=MembershipRole.ADMIN
            )


def test_owner_flag_only_on_admin_role_check():
    """is_org_owner=True is illegal when role != admin."""
    user = UserFactory()
    org = OrganizationFactory()
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            OrganizationMembershipFactory(
                user=user,
                organization=org,
                role=MembershipRole.CO_ORGANIZER,
                is_org_owner=True,
            )


def test_owner_uniqueness_skips_inactive_rows():
    """An inactive owner row does NOT block a new active owner — the
    partial constraint condition is `is_org_owner=True AND is_active=True`.
    """
    org = OrganizationFactory()
    u1, u2 = UserFactory(), UserFactory()
    m1 = OrganizationMembershipFactory(
        user=u1,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=True,
        is_active=False,  # historic / soft-removed
    )
    m2 = OrganizationMembershipFactory(
        user=u2,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=True,
        is_active=True,
    )
    assert m1.is_active is False
    assert m2.is_active is True
