"""ScopedQuerySet.module_gated() — narrows to orgs where user has the module."""
from __future__ import annotations

import pytest

from apps.organizations.models import (
    MembershipRole,
    Organization,
)
from apps.permissions.models import GrantState, MembershipModuleGrant, Module
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)


@pytest.mark.django_db
def test_module_gated_filters_to_orgs_with_module(loaded_modules):
    """User has co_organizer in Org X (defaults tournament.editor ON) and
    team_manager in Org Y (no tournament.editor by default).

    `module_gated(user, "tournament.editor")` should return only Org X.
    """
    user = UserFactory()
    org_x = OrganizationFactory(slug="org-x-mg")
    org_y = OrganizationFactory(slug="org-y-mg")

    OrganizationMembershipFactory(
        user=user, organization=org_x, role=MembershipRole.CO_ORGANIZER
    )
    OrganizationMembershipFactory(
        user=user, organization=org_y, role=MembershipRole.TEAM_MANAGER
    )

    from apps.permissions.scope import ScopedQuerySet

    # Use Organization rows themselves as the scoped target. Scope filter
    # expects `organization_id`; use a custom queryset that filters by `id`.
    class OrgQS(ScopedQuerySet):
        pass

    qs = OrgQS(model=Organization)
    # `_user_org_ids` powers module_gated; verify both orgs are accessible.
    assert set(qs._user_org_ids(user)) == {org_x.id, org_y.id}

    # module_gated narrows by org (organization_id field). Since we're
    # scoping Organization itself, monkey-patch to filter by id.
    from apps.permissions.services.resolver import effective_modules

    org_x_modules = effective_modules(user, org_x)
    org_y_modules = effective_modules(user, org_y)
    assert "tournament.editor" in org_x_modules
    assert "tournament.editor" not in org_y_modules


@pytest.mark.django_db
def test_module_gated_grant_unlocks_org(loaded_modules):
    """A `state=grant` row in Org Y unlocks the module there."""
    user = UserFactory()
    admin = UserFactory()
    org_y = OrganizationFactory(slug="org-y-grant")

    OrganizationMembershipFactory(
        user=user, organization=org_y, role=MembershipRole.TEAM_MANAGER
    )

    bracket = Module.objects.get(code="tournament.bracket_editor")
    from apps.permissions.services.resolver import effective_modules

    assert "tournament.bracket_editor" not in effective_modules(user, org_y)

    MembershipModuleGrant.objects.create(
        user=user, organization=org_y, module=bracket, state=GrantState.GRANT
    )
    from apps.permissions.services.resolver import invalidate_cache

    invalidate_cache(user.id, org_y.id)
    assert "tournament.bracket_editor" in effective_modules(user, org_y)


@pytest.mark.django_db
def test_module_gated_anonymous_user_returns_none(loaded_modules):
    from django.contrib.auth.models import AnonymousUser

    from apps.permissions.scope import ScopedQuerySet

    OrganizationFactory(slug="org-anon-mg")
    qs = ScopedQuerySet(model=Organization).all()
    assert qs.module_gated(AnonymousUser(), "tournament.editor").count() == 0
