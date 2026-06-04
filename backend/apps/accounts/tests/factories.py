"""factory_boy factories for accounts models (v1Users.md B.15)."""
from __future__ import annotations

import secrets
from datetime import timedelta

import factory
from argon2 import PasswordHasher
from django.utils import timezone
from factory.django import DjangoModelFactory

from apps.accounts.models import (
    EmailVerificationToken,
    PasswordResetToken,
    RecoveryCode,
    TwoFactorDevice,
    User,
)
from apps.accounts.services._crypto import encrypt_secret

_HASHER = PasswordHasher()


class UserFactory(DjangoModelFactory):
    class Meta:
        model = User
        django_get_or_create = ("email",)

    email = factory.Sequence(lambda n: f"user{n}@example.test")
    name = factory.Faker("name")
    is_active = True

    @factory.post_generation
    def password(self, create: bool, extracted, **kwargs):
        if not create:
            return
        self.set_password(extracted or "TestPass123!@#")
        self.save(update_fields=["password"])


class TwoFactorDeviceFactory(DjangoModelFactory):
    class Meta:
        model = TwoFactorDevice

    user = factory.SubFactory(UserFactory)
    secret_b32 = factory.LazyFunction(
        lambda: encrypt_secret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")
    )
    confirmed_at = factory.LazyFunction(timezone.now)


class RecoveryCodeFactory(DjangoModelFactory):
    class Meta:
        model = RecoveryCode

    user = factory.SubFactory(UserFactory)
    code_hash = factory.LazyFunction(lambda: _HASHER.hash("XXXXX-YYYYY"))


class PasswordResetTokenFactory(DjangoModelFactory):
    class Meta:
        model = PasswordResetToken

    user = factory.SubFactory(UserFactory)
    token_hash = factory.LazyFunction(lambda: secrets.token_hex(32))
    expires_at = factory.LazyFunction(lambda: timezone.now() + timedelta(hours=1))


class EmailVerificationTokenFactory(DjangoModelFactory):
    class Meta:
        model = EmailVerificationToken

    user = factory.SubFactory(UserFactory)
    token_hash = factory.LazyFunction(lambda: secrets.token_hex(32))
    expires_at = factory.LazyFunction(lambda: timezone.now() + timedelta(hours=48))
