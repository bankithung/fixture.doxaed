"""Factories for sadmin tests."""
from __future__ import annotations

import factory
from factory.django import DjangoModelFactory

from apps.accounts.models import User
from apps.sadmin.models import (
    Feedback,
    FeedbackCategory,
    FeedbackStatus,
    KPISnapshot,
    UsageEvent,
)


class UserFactory(DjangoModelFactory):
    class Meta:
        model = User
        django_get_or_create = ("email",)

    email = factory.Sequence(lambda n: f"user{n}@example.com")
    is_active = True
    is_superuser = False
    is_staff = False
    name = factory.Faker("name")

    @classmethod
    def _create(cls, model_class, *args, **kwargs):
        password = kwargs.pop("password", "Testpass1234!")
        user = model_class.objects.create_user(password=password, **kwargs)
        return user


class SuperAdminFactory(UserFactory):
    is_active = True
    is_superuser = True
    is_staff = True


class FeedbackFactory(DjangoModelFactory):
    class Meta:
        model = Feedback

    submitted_by = factory.SubFactory(UserFactory)
    category = FeedbackCategory.BUG
    subject = factory.Faker("sentence", nb_words=4)
    body = factory.Faker("paragraph")
    status = FeedbackStatus.PENDING


class UsageEventFactory(DjangoModelFactory):
    class Meta:
        model = UsageEvent

    user = factory.SubFactory(UserFactory)
    event_type = "test_event"
    payload = factory.LazyFunction(lambda: {"hello": "world"})


class KPISnapshotFactory(DjangoModelFactory):
    class Meta:
        model = KPISnapshot
        django_get_or_create = ("snapshot_date",)

    snapshot_date = factory.LazyFunction(
        lambda: __import__("datetime").date.today()
    )
    metrics = factory.LazyFunction(lambda: {"total_users": 1})
