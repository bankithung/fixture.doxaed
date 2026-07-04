"""TDD — shareable public registration link (organizer mints; schools self-submit)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams.models import RegistrationLink, Team
from apps.teams.services.registration import create_registration_link
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> User:
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def test_manager_creates_registration_link():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(f"/api/tournaments/{t.id}/registration-link/", {}, format="json")

    assert r.status_code == 201
    assert r.json()["token"]
    assert RegistrationLink.objects.filter(tournament=t).count() == 1


def test_public_get_and_submit_via_link():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    _link, token = create_registration_link(tournament=t, created_by=admin)
    client = APIClient()  # logged out / public

    g = client.get(f"/api/register/{token}/")
    assert g.status_code == 200
    assert g.json()["tournament_name"] == "Kohima Cup"

    payload = {
        "school_name": "Mount Hermon",
        "teams": [
            {"name": "Mount Hermon A", "players": [
                {"full_name": "Keeper", "jersey_no": 1, "position": "GK", "is_goalkeeper": True},
                {"full_name": "Striker", "jersey_no": 9, "position": "ST", "captain": True},
            ]},
            {"name": "Mount Hermon B", "players": []},
        ],
    }
    p = client.post(f"/api/register/{token}/", payload, format="json")
    assert p.status_code == 201, p.content
    assert p.json()["registered"] == 2
    assert Team.objects.filter(tournament=t, school="Mount Hermon").count() == 2


def test_invalid_token_is_404():
    client = APIClient()
    assert client.get("/api/register/not-a-real-token/").status_code == 404


def test_non_manager_cannot_create_link():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    outsider = _verified("outsider@test.local")
    client = APIClient()
    client.force_authenticate(user=outsider)

    r = client.post(f"/api/tournaments/{t.id}/registration-link/", {}, format="json")
    assert r.status_code in (403, 404)
