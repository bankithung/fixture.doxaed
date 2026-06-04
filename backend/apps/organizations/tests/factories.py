"""factory_boy factories for the organizations app (v1Users.md B.15)."""
from __future__ import annotations

import factory
from factory.django import DjangoModelFactory

from apps.accounts.tests.factories import UserFactory

from apps.organizations.models import (
    AdminInvitation,
    InviteStatus,
    MembershipRole,
    Organization,
    OrganizationMembership,
    OrgStatus,
    SlugRedirect,
)


class OrganizationFactory(DjangoModelFactory):
    class Meta:
        model = Organization
        django_get_or_create = ("slug",)

    slug = factory.Sequence(lambda n: f"org-{n}")
    name = factory.Faker("company")
    status = OrgStatus.ACTIVE
    time_zone = "Asia/Kolkata"


class OrganizationMembershipFactory(DjangoModelFactory):
    class Meta:
        model = OrganizationMembership

    user = factory.SubFactory(UserFactory)
    organization = factory.SubFactory(OrganizationFactory)
    role = MembershipRole.CO_ORGANIZER
    is_org_owner = False
    is_active = True


class AdminInvitationFactory(DjangoModelFactory):
    class Meta:
        model = AdminInvitation

    organization = factory.SubFactory(OrganizationFactory)
    email = factory.Sequence(lambda n: f"invitee{n}@example.test")
    role = MembershipRole.CO_ORGANIZER
    status = InviteStatus.PENDING
    token_hash = factory.Sequence(lambda n: f"hash-{n:0>64}")


class SlugRedirectFactory(DjangoModelFactory):
    class Meta:
        model = SlugRedirect

    organization = factory.SubFactory(OrganizationFactory)
    old_slug = factory.Sequence(lambda n: f"old-slug-{n}")
