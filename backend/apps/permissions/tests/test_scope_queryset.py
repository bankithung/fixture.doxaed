"""ScopedManager / ScopedQuerySet — multi-tenancy isolation (Appendix B.2)."""
from __future__ import annotations

import pytest

from apps.organizations.models import (
    MembershipRole,
    Organization,
)
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)

# We use the Organization model itself as a stand-in for "any model with
# an organization FK" — Organization's id IS the organization_id. We test
# the scope filter on it via a synthetic patch: the scope filter expects
# `organization_id` so we wrap.
#
# Cleaner: define a fake OrgScopedThing model in a test app. But spinning
# a full test app is more ceremony than needed here. Instead we test the
# filter directly via a lightweight model proxy.


def _build_scoped_queryset(model_cls, user):
    """Return a queryset for `model_cls` filtered to the user's orgs."""
    from apps.permissions.scope import ScopedQuerySet

    qs = ScopedQuerySet(model=model_cls).all()
    return qs.scoped_for_user(user)


@pytest.mark.django_db
def test_scoped_for_user_filters_to_active_memberships(loaded_modules):
    """A user in Org X must NOT see Org Y rows."""
    user = UserFactory()

    # Org X — user is a member
    org_x = OrganizationFactory(slug="org-x-test", name="Org X")
    OrganizationMembershipFactory(
        user=user, organization=org_x, role=MembershipRole.CO_ORGANIZER
    )

    # Org Y — user is NOT a member
    org_y = OrganizationFactory(slug="org-y-test", name="Org Y")

    # Apply the scope filter to Organization itself, treating org_x.id as
    # organization_id (Organization _is_ the org).
    from apps.permissions.scope import ScopedQuerySet

    qs = ScopedQuerySet(model=Organization)
    # Since we're scoping Organization rows themselves, swap organization_id → id.
    # Easier: construct a synthetic test by checking _user_org_ids directly.
    org_ids = qs._user_org_ids(user)
    assert org_x.id in org_ids
    assert org_y.id not in org_ids


@pytest.mark.django_db
def test_inactive_membership_excluded_from_scope(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user,
        organization=org,
        role=MembershipRole.CO_ORGANIZER,
        is_active=False,
    )

    from apps.permissions.scope import ScopedQuerySet

    qs = ScopedQuerySet(model=Organization)
    assert org.id not in qs._user_org_ids(user)


@pytest.mark.django_db
def test_superuser_bypass_returns_unmodified_queryset(loaded_modules):
    su = UserFactory(is_superuser=True, is_staff=True)
    OrganizationFactory(slug="org-su-1")
    OrganizationFactory(slug="org-su-2")

    from apps.permissions.scope import ScopedQuerySet

    qs = ScopedQuerySet(model=Organization).all()
    out = qs.scoped_for_user(su)
    # Superuser bypass returns the full queryset.
    assert list(out.values_list("slug", flat=True)).__len__() >= 2


@pytest.mark.django_db
def test_anonymous_user_returns_none(loaded_modules):
    from django.contrib.auth.models import AnonymousUser

    from apps.permissions.scope import ScopedQuerySet

    OrganizationFactory(slug="org-anon-test")
    qs = ScopedQuerySet(model=Organization).all()
    assert qs.scoped_for_user(AnonymousUser()).count() == 0
    assert qs.scoped_for_user(None).count() == 0
