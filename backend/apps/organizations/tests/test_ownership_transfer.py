"""Atomic ownership-transfer test.

Asserts the DEFERRED constraint allows the swap inside one transaction
and that transfers to non-admins fail.
"""
from __future__ import annotations

import pytest
from django.core.exceptions import ValidationError

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import (
    MembershipRole,
    OrganizationMembership,
)
from apps.organizations.services import ownership as ownership_svc
from apps.organizations.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
)


pytestmark = pytest.mark.django_db


def test_atomic_ownership_swap(rf):
    org = OrganizationFactory()
    owner_user = UserFactory()
    successor_user = UserFactory()
    OrganizationMembershipFactory(
        user=owner_user,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=True,
    )
    OrganizationMembershipFactory(
        user=successor_user,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=False,
    )
    requester = owner_user

    ownership_svc.transfer_ownership(
        org=org,
        current_owner_user=owner_user,
        new_owner_user=successor_user,
        requested_by=requester,
        request=None,
    )

    owner_row = OrganizationMembership.objects.get(user=owner_user, organization=org)
    succ_row = OrganizationMembership.objects.get(user=successor_user, organization=org)
    assert owner_row.is_org_owner is False
    assert succ_row.is_org_owner is True


def test_transfer_to_non_admin_fails():
    org = OrganizationFactory()
    owner_user = UserFactory()
    co_user = UserFactory()
    OrganizationMembershipFactory(
        user=owner_user, organization=org, role=MembershipRole.ADMIN, is_org_owner=True
    )
    OrganizationMembershipFactory(
        user=co_user, organization=org, role=MembershipRole.CO_ORGANIZER
    )
    with pytest.raises(ValidationError):
        ownership_svc.transfer_ownership(
            org=org,
            current_owner_user=owner_user,
            new_owner_user=co_user,
            requested_by=owner_user,
            request=None,
        )


def test_transfer_to_self_fails():
    org = OrganizationFactory()
    owner_user = UserFactory()
    OrganizationMembershipFactory(
        user=owner_user, organization=org, role=MembershipRole.ADMIN, is_org_owner=True
    )
    with pytest.raises(ValidationError):
        ownership_svc.transfer_ownership(
            org=org,
            current_owner_user=owner_user,
            new_owner_user=owner_user,
            requested_by=owner_user,
            request=None,
        )
