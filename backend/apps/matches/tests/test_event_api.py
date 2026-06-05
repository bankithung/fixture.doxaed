"""TDD — live event + transition API (scorer console backend)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "admin@test.local") -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _match(admin, status=MatchStatus.LIVE):
    t = create_tournament(user=admin, name="Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    return t, Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b, status=status,
    )


def test_record_goal_event_updates_score():
    admin = _verified()
    _t, m = _match(admin)
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "goal", "side": "home", "minute": 12},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["home_score"] == 1


def test_transition_match_state():
    admin = _verified()
    _t, m = _match(admin, status=MatchStatus.SCHEDULED)
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    )
    assert r.status_code == 200
    assert r.json()["status"] == "live"


def test_illegal_transition_rejected():
    admin = _verified()
    _t, m = _match(admin, status=MatchStatus.SCHEDULED)
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "completed"}, format="json"
    )
    assert r.status_code == 400
