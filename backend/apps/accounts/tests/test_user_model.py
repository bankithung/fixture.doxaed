"""Tests for the User model (v1Users.md §1.4, B.1, B.12)."""
from __future__ import annotations

import uuid

import pytest

from apps.accounts.models import User, uuid7
from apps.accounts.tests.factories import UserFactory

pytestmark = pytest.mark.django_db


def test_email_lowercased_on_save():
    """B.12: email is the canonical identifier; case-insensitive."""
    user = UserFactory(email="MIXED.Case@Example.Com")
    assert user.email == "mixed.case@example.com"


def test_email_lowercased_on_subsequent_save():
    user = UserFactory()
    user.email = "Re-CASED@example.com"
    user.save()
    user.refresh_from_db()
    assert user.email == "re-cased@example.com"


def test_create_user_lowercases():
    u = User.objects.create_user(email="UPPER@Example.com", password="pw12345678901!")
    assert u.email == "upper@example.com"


def test_soft_delete_anonymizes_pii():
    user = UserFactory(email="real@example.com", name="Real Person")
    pk = user.id
    user.soft_delete()
    user.refresh_from_db()
    assert user.deleted_at is not None
    assert user.email == f"deleted-{pk}@invalid"
    assert user.name == "[Deleted]"
    assert user.is_active is False
    assert user.is_deleted is True


def test_uuid7_is_time_ordered():
    """B.1: UUID v7 PKs must be monotonically time-ordered."""
    a = uuid7()
    b = uuid7()
    c = uuid7()
    assert a < b < c
    # Sanity: it's a valid UUID
    assert isinstance(a, uuid.UUID)
    # v7 has version=7 in the version nibble
    assert a.version == 7
