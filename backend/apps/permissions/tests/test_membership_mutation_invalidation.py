"""Membership mutations must drop the resolver cache (H9).

A removed member kept module access for up to the 300s cache TTL because
OrgMemberRemoveView never invalidated; ownership transfer had the same gap.
These tests prime the cache, mutate the membership, and assert the entry is
gone the moment the transaction commits.
"""
from __future__ import annotations

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.organizations.models import MembershipRole, OrganizationMembership
from apps.organizations.services.ownership import transfer_ownership
from apps.permissions.services.resolver import cache_key, effective_modules
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)

pytestmark = pytest.mark.django_db


def _api(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_member_removal_invalidates_resolver_cache(
    loaded_modules, django_capture_on_commit_callbacks
):
    org = OrganizationFactory()
    owner = UserFactory()
    OrganizationMembershipFactory(
        user=owner, organization=org, role=MembershipRole.ADMIN, is_org_owner=True
    )
    member = UserFactory()
    membership = OrganizationMembershipFactory(
        user=member, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    # Prime the member's resolver cache.
    assert effective_modules(member, org)
    key = cache_key(member.id, org.id)
    assert cache.get(key) is not None

    with django_capture_on_commit_callbacks(execute=True):
        resp = _api(owner).delete(f"/api/orgs/{org.id}/members/{membership.id}/")
    assert resp.status_code == 204

    membership.refresh_from_db()
    assert membership.is_active is False
    # The stale frozenset must be gone NOW, not at TTL.
    assert cache.get(key) is None


def test_ownership_transfer_invalidates_both_sides(
    loaded_modules, django_capture_on_commit_callbacks
):
    org = OrganizationFactory()
    old_owner = UserFactory()
    new_owner = UserFactory()
    OrganizationMembershipFactory(
        user=old_owner, organization=org, role=MembershipRole.ADMIN, is_org_owner=True
    )
    OrganizationMembershipFactory(
        user=new_owner, organization=org, role=MembershipRole.ADMIN
    )

    effective_modules(old_owner, org)
    effective_modules(new_owner, org)
    k_old = cache_key(old_owner.id, org.id)
    k_new = cache_key(new_owner.id, org.id)
    assert cache.get(k_old) is not None and cache.get(k_new) is not None

    with django_capture_on_commit_callbacks(execute=True):
        transfer_ownership(
            org=org,
            current_owner_user=old_owner,
            new_owner_user=new_owner,
            requested_by=old_owner,
        )

    assert cache.get(k_old) is None
    assert cache.get(k_new) is None
    assert OrganizationMembership.objects.get(
        user=new_owner, organization=org, is_active=True
    ).is_org_owner
