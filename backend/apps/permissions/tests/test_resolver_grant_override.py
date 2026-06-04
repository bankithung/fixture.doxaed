"""Override grants — `state=grant` adds, `state=deny` removes."""
from __future__ import annotations

import pytest

from apps.organizations.models import MembershipRole
from apps.permissions.models import GrantState, MembershipModuleGrant, Module
from apps.permissions.services.resolver import effective_modules
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)


@pytest.mark.django_db
def test_grant_state_adds_module_not_in_role_default(loaded_modules):
    """A team_manager doesn't get tournament.bracket_editor by default. A
    `state=grant` row should ADD it.
    """
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER
    )

    bracket = Module.objects.get(code="tournament.bracket_editor")
    assert "tournament.bracket_editor" not in effective_modules(user, org)

    MembershipModuleGrant.objects.create(
        user=user, organization=org, module=bracket, state=GrantState.GRANT
    )

    # Cache might be stale → invalidate.
    from apps.permissions.services.resolver import invalidate_cache

    invalidate_cache(user.id, org.id)

    assert "tournament.bracket_editor" in effective_modules(user, org)


@pytest.mark.django_db
def test_deny_state_removes_module_in_role_default(loaded_modules):
    """A co_organizer DOES get tournament.editor by default. `state=deny`
    must remove it from the effective set.
    """
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    editor = Module.objects.get(code="tournament.editor")
    assert "tournament.editor" in effective_modules(user, org)

    MembershipModuleGrant.objects.create(
        user=user, organization=org, module=editor, state=GrantState.DENY
    )

    from apps.permissions.services.resolver import invalidate_cache

    invalidate_cache(user.id, org.id)

    assert "tournament.editor" not in effective_modules(user, org)


@pytest.mark.django_db
def test_default_state_no_op(loaded_modules):
    """A `state=default` row is treated as no override (resolver falls
    through to role defaults).
    """
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    editor = Module.objects.get(code="tournament.editor")
    MembershipModuleGrant.objects.create(
        user=user,
        organization=org,
        module=editor,
        state=GrantState.DEFAULT,
    )

    from apps.permissions.services.resolver import invalidate_cache

    invalidate_cache(user.id, org.id)
    # Still in set — default = role-default.
    assert "tournament.editor" in effective_modules(user, org)
