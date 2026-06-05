"""TDD — the public registration endpoint is rate-limited (anti-abuse)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams import throttling
from apps.teams.services.registration import create_registration_link
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def test_public_registration_is_rate_limited(monkeypatch):
    cache.clear()
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    _link, token = create_registration_link(tournament=t, created_by=admin)
    monkeypatch.setattr(
        throttling.RegistrationRateThrottle, "get_rate", lambda self: "1/hour"
    )
    client = APIClient()

    first = client.post(
        f"/api/register/{token}/",
        {"school_name": "S1", "teams": [{"name": "S1 A"}]},
        format="json",
    )
    assert first.status_code == 201, first.content

    second = client.post(
        f"/api/register/{token}/",
        {"school_name": "S2", "teams": [{"name": "S2 A"}]},
        format="json",
    )
    assert second.status_code == 429
    cache.clear()
