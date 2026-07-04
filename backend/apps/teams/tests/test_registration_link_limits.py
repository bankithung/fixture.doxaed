"""TDD — registration link expiry + usage cap (anti-abuse, P0)."""
from __future__ import annotations

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams.services.registration import create_registration_link
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> User:
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def test_expired_link_is_invalid():
    cache.clear()
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    _link, token = create_registration_link(
        tournament=t, created_by=admin, expires_at=timezone.now() - timedelta(hours=1)
    )
    client = APIClient()
    assert client.get(f"/api/register/{token}/").status_code == 404
    cache.clear()


def test_usage_cap_blocks_after_max():
    cache.clear()
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    _link, token = create_registration_link(
        tournament=t, created_by=admin, max_submissions=1
    )
    client = APIClient()

    p1 = client.post(
        f"/api/register/{token}/",
        {"school_name": "S1", "teams": [{"name": "S1 A"}]},
        format="json",
    )
    assert p1.status_code == 201, p1.content

    p2 = client.post(
        f"/api/register/{token}/",
        {"school_name": "S2", "teams": [{"name": "S2 A"}]},
        format="json",
    )
    assert p2.status_code == 404  # over cap -> link no longer resolves
    cache.clear()
