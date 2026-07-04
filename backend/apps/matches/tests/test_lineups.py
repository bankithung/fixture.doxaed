"""TDD — Lineup confirmation: set starters/subs, confirm, frozen once live, isolation.

A referee/manager sets a team's lineup before kickoff and confirms it. Lineups are
org-scoped (invariant #2), idempotent on event_id (invariant #3), audited, and
frozen once the match leaves `scheduled` (invariant #7 — match-rule freeze at kickoff).
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Lineup, Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "admin@test.local") -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(status=MatchStatus.SCHEDULED):
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[
            {"name": "A", "players": [
                {"full_name": "Striker", "jersey_no": 9},
                {"full_name": "Keeper", "jersey_no": 1},
            ]},
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


def _entries(team):
    players = list(team.players.all())
    out = []
    for i, p in enumerate(players):
        out.append({
            "player_id": str(p.id),
            "role": "starter" if i == 0 else "substitute",
            "shirt_no": p.jersey_no,
        })
    return out


def test_set_lineup_happy_path():
    admin, _t, a, _b, m = _setup()
    client = _client(admin)
    r = client.post(
        f"/api/matches/{m.id}/lineups/",
        {"team_id": str(a.id), "entries": _entries(a), "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["team"]["id"] == str(a.id)
    assert len(body["entries"]) == 2
    assert body["confirmed_at"] is None
    roles = {e["role"] for e in body["entries"]}
    assert roles == {"starter", "substitute"}


def test_get_lineups_returns_both_teams():
    admin, _t, a, _b, m = _setup()
    client = _client(admin)
    client.post(
        f"/api/matches/{m.id}/lineups/",
        {"team_id": str(a.id), "entries": _entries(a), "event_id": str(uuid.uuid4())},
        format="json",
    )
    r = client.get(f"/api/matches/{m.id}/lineups/")
    assert r.status_code == 200, r.content
    body = r.json()
    assert len(body["lineups"]) == 1
    assert body["lineups"][0]["team"]["id"] == str(a.id)


def test_player_not_on_team_rejected():
    admin, _t, a, b, m = _setup()
    client = _client(admin)
    bad = b.players.first()  # belongs to the AWAY team
    r = client.post(
        f"/api/matches/{m.id}/lineups/",
        {
            "team_id": str(a.id),
            "entries": [{"player_id": str(bad.id), "role": "starter"}],
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 400


def test_set_lineup_idempotent_replay_returns_same():
    admin, _t, a, _b, m = _setup()
    client = _client(admin)
    eid = str(uuid.uuid4())
    payload = {"team_id": str(a.id), "entries": _entries(a), "event_id": eid}
    r1 = client.post(f"/api/matches/{m.id}/lineups/", payload, format="json")
    assert r1.status_code == 201, r1.content
    r2 = client.post(f"/api/matches/{m.id}/lineups/", payload, format="json")
    assert r2.status_code == 200, r2.content
    assert r1.json()["id"] == r2.json()["id"]
    assert Lineup.objects.filter(match=m, team=a).count() == 1


def test_lineup_blocked_once_match_live():
    admin, _t, a, _b, m = _setup(status=MatchStatus.LIVE)
    client = _client(admin)
    r = client.post(
        f"/api/matches/{m.id}/lineups/",
        {"team_id": str(a.id), "entries": _entries(a), "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400


def test_confirm_lineup_sets_confirmed_at():
    admin, _t, a, _b, m = _setup()
    client = _client(admin)
    client.post(
        f"/api/matches/{m.id}/lineups/",
        {"team_id": str(a.id), "entries": _entries(a), "event_id": str(uuid.uuid4())},
        format="json",
    )
    r = client.post(
        f"/api/matches/{m.id}/lineups/confirm/",
        {"team_id": str(a.id), "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["confirmed_at"] is not None
    assert r.json()["confirmed_by"] == str(admin.id)


def test_outsider_cannot_set_lineup():
    _admin, _t, a, _b, m = _setup()
    outsider = _verified("out@test.local")
    r = _client(outsider).post(
        f"/api/matches/{m.id}/lineups/",
        {"team_id": str(a.id), "entries": _entries(a), "event_id": str(uuid.uuid4())},
        format="json",
    )
    # Outsider cannot even see the match -> 404 (tenant isolation).
    assert r.status_code == 404


def test_cross_org_isolation_on_get():
    _admin, _t, _a, _b, m = _setup()
    outsider = _verified("out@test.local")
    assert _client(outsider).get(f"/api/matches/{m.id}/lineups/").status_code == 404
