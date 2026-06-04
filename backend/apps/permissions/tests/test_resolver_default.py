"""Single-role user without any grants → effective set = role defaults."""
from __future__ import annotations

import pytest

from apps.organizations.models import MembershipRole
from apps.permissions.models import Module
from apps.permissions.services.resolver import effective_modules
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)


@pytest.mark.django_db
def test_single_role_co_organizer_default(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    expected = set(
        Module.objects.filter(
            default_for_roles__contains=[MembershipRole.CO_ORGANIZER.value]
        ).values_list("code", flat=True)
    )

    actual = effective_modules(user, org)
    assert actual == expected
    # Sanity — co_organizer gets a healthy default set.
    assert "tournament.editor" in actual
    assert "personal.profile" in actual


@pytest.mark.django_db
def test_no_active_membership_returns_empty(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    # No membership row at all.
    assert effective_modules(user, org) == frozenset()


@pytest.mark.django_db
def test_inactive_membership_returns_empty(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user,
        organization=org,
        role=MembershipRole.CO_ORGANIZER,
        is_active=False,
    )
    assert effective_modules(user, org) == frozenset()


@pytest.mark.django_db
def test_team_manager_has_lineup_submission(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER
    )
    modules = effective_modules(user, org)
    assert "match.lineup_submission" in modules
    assert "personal.profile" in modules
    # team_manager should NOT have the bracket editor by default
    assert "tournament.bracket_editor" not in modules
