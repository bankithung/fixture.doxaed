"""Explicit deny on a role-default module wins over multi-role union.

This is the bug the audit fix addressed: if user has BOTH co_organizer
(which defaults `tournament.editor` ON) AND match_scorer (which doesn't),
a `state=deny` on tournament.editor must STILL win — the deny applies
regardless of how many roles in the union would have included it.
"""
from __future__ import annotations

import pytest

from apps.organizations.models import MembershipRole
from apps.permissions.models import GrantState, MembershipModuleGrant, Module
from apps.permissions.services.resolver import (
    effective_modules,
    invalidate_cache,
)
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)


@pytest.mark.django_db
def test_deny_wins_over_multi_role_union(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()

    # Two roles, both contribute tournament.editor (admin and co_organizer).
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.ADMIN, is_org_owner=True
    )
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    editor = Module.objects.get(code="tournament.editor")
    assert "tournament.editor" in effective_modules(user, org)

    # Single deny row keyed on (user, org, module) — must remove from set.
    MembershipModuleGrant.objects.create(
        user=user, organization=org, module=editor, state=GrantState.DENY
    )
    invalidate_cache(user.id, org.id)

    modules = effective_modules(user, org)
    assert "tournament.editor" not in modules

    # Other shared modules still present.
    assert "personal.profile" in modules
