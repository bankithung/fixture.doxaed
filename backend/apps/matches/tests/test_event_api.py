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


def test_event_attributes_to_player():
    from apps.matches.models import MatchEvent

    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[
            {"name": "A", "players": [{"full_name": "Striker", "jersey_no": 9}]},
            {"name": "B", "players": []},
        ],
    )
    a = teams[0]
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=teams[1],
        status=MatchStatus.LIVE,
    )
    player = a.players.first()
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "goal", "side": "home", "player_id": str(player.id)},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["home_score"] == 1
    ev = MatchEvent.objects.get(match=m, event_type="goal")
    assert ev.player_id == player.id


def test_event_player_not_on_team_rejected():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[
            {"name": "A", "players": []},
            {"name": "B", "players": [{"full_name": "Other", "jersey_no": 1}]},
        ],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=teams[0], away_team=teams[1],
        status=MatchStatus.LIVE,
    )
    other = teams[1].players.first()  # player on the AWAY team
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "goal", "side": "home", "player_id": str(other.id)},
        format="json",
    )
    assert r.status_code == 400


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
