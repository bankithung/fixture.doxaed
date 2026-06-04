"""Factories for permissions tests.

Includes minimal local UserFactory + OrganizationFactory + Membership
factory that don't reach into siblings, so these tests can run even
if the organizations agent's app is mid-flight. We DO use the real
organizations.Organization / OrganizationMembership models when they
import successfully — fall back to skipping noisily if they don't.
"""
from __future__ import annotations

import factory
from django.contrib.auth import get_user_model
from factory.django import DjangoModelFactory

from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
    OrgStatus,
)
from apps.permissions.models import (
    GrantState,
    MembershipModuleGrant,
    Module,
)

User = get_user_model()


class UserFactory(DjangoModelFactory):
    class Meta:
        model = User

    email = factory.Sequence(lambda n: f"user{n}@example.com")
    name = factory.Faker("name")
    is_active = True


class OrganizationFactory(DjangoModelFactory):
    class Meta:
        model = Organization

    name = factory.Sequence(lambda n: f"Org {n}")
    slug = factory.Sequence(lambda n: f"org-{n}")
    status = OrgStatus.ACTIVE


class OrganizationMembershipFactory(DjangoModelFactory):
    class Meta:
        model = OrganizationMembership

    user = factory.SubFactory(UserFactory)
    organization = factory.SubFactory(OrganizationFactory)
    role = MembershipRole.CO_ORGANIZER
    is_active = True


class ModuleFactory(DjangoModelFactory):
    class Meta:
        model = Module
        django_get_or_create = ("code",)

    code = factory.Sequence(lambda n: f"test.module_{n}")
    name = factory.LazyAttribute(lambda o: o.code.replace(".", " ").title())
    description = ""
    category = "test"
    default_for_roles = []


class MembershipModuleGrantFactory(DjangoModelFactory):
    class Meta:
        model = MembershipModuleGrant

    user = factory.SubFactory(UserFactory)
    organization = factory.SubFactory(OrganizationFactory)
    module = factory.SubFactory(ModuleFactory)
    state = GrantState.GRANT
    reason = "Test grant — minimum twenty chars satisfied here."
