"""TDD — Match-incident reports: file, list, idempotent, validation, isolation.

A referee files a post-match incident (foul play / misconduct / injury / ...).
Org-scoped (invariant #2), append-only, idempotent on event_id (invariant #3),
audited (invariant #4).
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchIncident, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "admin@test.local") -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(status=MatchStatus.COMPLETED):
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[
            {"name": "A", "players": [{"full_name": "Striker", "jersey_no": 9}]},
            {"name": "B", "players": [{"full_name": "Wing", "jersey_no": 7}]},
        ],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=status,
    )
    return admin, t, a, b, m


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_file_incident_happy_path():
    admin, _t, _a, _b, m = _setup()
    r = _client(admin).post(
        f"/api/matches/{m.id}/incidents/",
        {
            "kind": "misconduct",
            "description": "Player dissent toward the referee.",
            "minute": 67,
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["kind"] == "misconduct"
    assert body["minute"] == 67
    assert body["reported_by"] == str(admin.id)
    assert MatchIncident.objects.filter(match=m).count() == 1


def test_file_incident_attributes_player():
    admin, _t, a, _b, m = _setup()
    player = a.players.first()
    r = _client(admin).post(
        f"/api/matches/{m.id}/incidents/",
        {
            "kind": "foul_play",
            "description": "Dangerous tackle.",
            "player_id": str(player.id),
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["player_id"] == str(player.id)


def test_list_incidents():
    admin, _t, _a, _b, m = _setup()
    _client(admin).post(
        f"/api/matches/{m.id}/incidents/",
        {"kind": "injury", "description": "Knock to the head, taken off."},
        format="json",
    )
    r = _client(admin).get(f"/api/matches/{m.id}/incidents/")
    assert r.status_code == 200, r.content
    assert len(r.json()) == 1
    assert r.json()[0]["kind"] == "injury"


def test_incident_idempotent_replay():
    admin, _t, _a, _b, m = _setup()
    eid = str(uuid.uuid4())
    payload = {"kind": "other", "description": "Crowd entered the pitch.", "event_id": eid}
    r1 = _client(admin).post(f"/api/matches/{m.id}/incidents/", payload, format="json")
    r2 = _client(admin).post(f"/api/matches/{m.id}/incidents/", payload, format="json")
    assert r1.status_code == 201
    assert r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"]
    assert MatchIncident.objects.filter(match=m).count() == 1


def test_player_not_on_team_rejected():
    admin, _t, _a, _b, m = _setup()
    # Make a player on a DIFFERENT tournament/match.
    other_admin = _verified("other@test.local")
    t2 = create_tournament(user=other_admin, name="Other")
    (c,) = register_school(
        tournament=t2, school_name="X",
        teams=[{"name": "C", "players": [{"full_name": "Alien", "jersey_no": 5}]}],
    )
    alien = c.players.first()
    r = _client(admin).post(
        f"/api/matches/{m.id}/incidents/",
        {
            "kind": "foul_play",
            "description": "Phantom player.",
            "player_id": str(alien.id),
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 400


def test_outsider_cannot_file_incident():
    _admin, _t, _a, _b, m = _setup()
    outsider = _verified("out@test.local")
    r = _client(outsider).post(
        f"/api/matches/{m.id}/incidents/",
        {"kind": "other", "description": "Should be blocked."},
        format="json",
    )
    assert r.status_code == 404  # cannot see the match (tenant isolation)


def test_cross_org_isolation_on_list():
    _admin, _t, _a, _b, m = _setup()
    outsider = _verified("out@test.local")
    assert _client(outsider).get(f"/api/matches/{m.id}/incidents/").status_code == 404
