"""Resolver caching — second call hits cache; cache-invalidation on grant write."""
from __future__ import annotations

import pytest
from django.core.cache import cache

from apps.organizations.models import MembershipRole
from apps.permissions.services.grants import set_grant
from apps.permissions.services.resolver import (
    cache_key,
    effective_modules,
    invalidate_cache,
)
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)


@pytest.mark.django_db
def test_resolver_caches_result(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    key = cache_key(user.id, org.id)
    assert cache.get(key) is None

    first = effective_modules(user, org)
    cached = cache.get(key)
    assert cached is not None
    assert cached == first

    # Second call returns the cached value (same instance).
    second = effective_modules(user, org)
    assert second == first


@pytest.mark.django_db
def test_set_grant_invalidates_cache(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    admin = UserFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER
    )

    # Prime cache.
    initial = effective_modules(user, org)
    assert "tournament.bracket_editor" not in initial

    key = cache_key(user.id, org.id)
    assert cache.get(key) is not None

    # Service call must invalidate.
    set_grant(
        user=user,
        organization=org,
        module="tournament.bracket_editor",
        state="grant",
        granted_by=admin,
        reason="QA needs bracket access for testing rounds.",
    )
    assert cache.get(key) is None

    # Next read picks up the new state.
    after = effective_modules(user, org)
    assert "tournament.bracket_editor" in after


@pytest.mark.django_db
def test_explicit_invalidate(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    effective_modules(user, org)
    key = cache_key(user.id, org.id)
    assert cache.get(key) is not None
    invalidate_cache(user.id, org.id)
    assert cache.get(key) is None
