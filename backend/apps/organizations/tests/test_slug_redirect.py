"""SlugRedirect tests: change_slug writes a redirect; lookup-by-old-slug
returns the canonical org via resolve_slug.
"""
from __future__ import annotations

import pytest
from django.core.exceptions import ValidationError

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import SlugRedirect
from apps.organizations.services import slug as slug_svc
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


def test_change_slug_creates_redirect_row():
    org = OrganizationFactory(slug="oldname")
    actor = UserFactory()
    slug_svc.change_slug(org=org, new_slug="newname", changed_by=actor, request=None)
    org.refresh_from_db()
    assert org.slug == "newname"
    assert SlugRedirect.objects.filter(old_slug="oldname", organization=org).exists()


def test_resolve_slug_returns_canonical_for_redirect():
    org = OrganizationFactory(slug="newname")
    SlugRedirect.objects.create(old_slug="oldname", organization=org)
    current, redirect_target = slug_svc.resolve_slug("oldname")
    assert current is None
    assert redirect_target == org

    current, redirect_target = slug_svc.resolve_slug("newname")
    assert current == org
    assert redirect_target is None


def test_reserved_slug_rejected_at_service_layer():
    org = OrganizationFactory(slug="ok-slug")
    actor = UserFactory()
    with pytest.raises(ValidationError):
        slug_svc.change_slug(
            org=org, new_slug="admin", changed_by=actor, request=None
        )


def test_slug_format_validation():
    org = OrganizationFactory(slug="ok-slug")
    actor = UserFactory()
    for bad in ("-leadinghyphen", "trailing-", "UPPERCASE", "with spaces", ""):
        with pytest.raises(ValidationError):
            slug_svc.change_slug(
                org=org, new_slug=bad, changed_by=actor, request=None
            )


def test_slug_collision_with_existing_redirect_rejected():
    org_a = OrganizationFactory(slug="alpha")
    SlugRedirect.objects.create(old_slug="reused", organization=org_a)
    org_b = OrganizationFactory(slug="beta")
    actor = UserFactory()
    with pytest.raises(ValidationError):
        slug_svc.change_slug(
            org=org_b, new_slug="reused", changed_by=actor, request=None
        )
