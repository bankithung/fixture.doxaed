"""TDD — POST/GET /api/tournaments/ (design-selfserve-flow.md §3.3, §6).

Covers: self-serve create over HTTP (201), auth required, and the mandatory
cross-org isolation guarantee on list (invariant 2 — user only sees tournaments
they can access).
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.models import Tournament
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def test_post_tournaments_creates_and_returns_201():
    user = _verified("api-founder@test.local")
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.post("/api/tournaments/", {"name": "Kohima Cup"}, format="json")

    assert resp.status_code == 201, resp.content
    data = resp.json()
    assert data["name"] == "Kohima Cup"
    assert data["status"] == "draft"
    assert data["organization_slug"]
    assert Tournament.objects.filter(id=data["id"]).exists()


def test_post_tournaments_requires_authentication():
    resp = APIClient().post("/api/tournaments/", {"name": "Nope"}, format="json")
    assert resp.status_code in (401, 403)


def test_get_tournaments_lists_only_accessible_ones():
    """Cross-org isolation (invariant 2): user A must not see user B's tournament."""
    a = _verified("owner-a@test.local")
    b = _verified("owner-b@test.local")
    ta = create_tournament(user=a, name="A Cup")
    tb = create_tournament(user=b, name="B Cup")

    client = APIClient()
    client.force_authenticate(user=a)
    resp = client.get("/api/tournaments/")

    assert resp.status_code == 200
    ids = [t["id"] for t in resp.json()]
    assert str(ta.id) in ids
    assert str(tb.id) not in ids
