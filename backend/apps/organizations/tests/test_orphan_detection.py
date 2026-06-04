"""Orphan detection: when last admin's membership flips to is_active=False,
detect_orphaned() flips org status to orphaned.
"""
from __future__ import annotations

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import (
    MembershipRole,
    OrgStatus,
)
from apps.organizations.services.lifecycle import detect_orphaned
from apps.organizations.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
)


pytestmark = pytest.mark.django_db


def test_org_with_active_admin_not_marked_orphaned():
    org = OrganizationFactory(status=OrgStatus.ACTIVE)
    OrganizationMembershipFactory(
        user=UserFactory(),
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=True,
    )
    flipped = detect_orphaned()
    assert flipped == 0
    org.refresh_from_db()
    assert org.status == OrgStatus.ACTIVE


def test_org_without_active_admin_is_marked_orphaned():
    org = OrganizationFactory(status=OrgStatus.ACTIVE)
    admin_membership = OrganizationMembershipFactory(
        user=UserFactory(),
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=True,
    )
    # Admin membership goes inactive — simulate user removed.
    admin_membership.is_active = False
    admin_membership.is_org_owner = False  # has to clear before setting inactive in real flow
    admin_membership.save()

    flipped = detect_orphaned()
    assert flipped == 1
    org.refresh_from_db()
    assert org.status == OrgStatus.ORPHANED


def test_orphaned_org_with_only_co_organizers():
    """Co-organizers don't keep an org un-orphaned — only admins do."""
    org = OrganizationFactory(status=OrgStatus.ACTIVE)
    OrganizationMembershipFactory(
        user=UserFactory(), organization=org, role=MembershipRole.CO_ORGANIZER
    )
    flipped = detect_orphaned()
    assert flipped == 1
    org.refresh_from_db()
    assert org.status == OrgStatus.ORPHANED
