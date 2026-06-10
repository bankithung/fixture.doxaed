"""Set/game-based scoring (Table Tennis, Sepak Takraw) — compute + API path,
without disturbing football's goal scoring."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.matches.services.set_scoring import compute_sets
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

TT = {"type": "sets", "points": 11, "win_by": 2, "cap": None, "best_of": 3}
SEPAK = {"type": "sets", "points": 21, "win_by": 2, "cap": 25, "best_of": 3}


def _admin(email="s@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _two_teams(t):
    register_school(
        tournament=t, school_name="MH",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    return list(Team.objects.filter(tournament=t).order_by("name"))


def _match(t, sport=""):
    teams = _two_teams(t)
    return Match.objects.create(
        organization=t.organization, tournament=t, sport=sport,
        home_team=teams[0], away_team=teams[1], status=MatchStatus.SCHEDULED,
    )


def test_compute_sets_table_tennis():
    assert compute_sets([[11, 8], [11, 9]], TT) == (2, 0)
    assert compute_sets([[11, 8], [7, 11], [11, 9]], TT) == (2, 1)


def test_compute_sets_rejects_illegal():
    for bad in (
        [[11, 8], [11, 8], [11, 8]],  # 3-0 impossible in best-of-3
        [[5, 3], [11, 9]],            # set below target (11)
        [[11, 10], [11, 9]],          # win-by < 2 with no cap
        [[11, 8]],                    # match not decided (1-0)
        [[11, 11]],                   # tied set
    ):
        with pytest.raises(Exception):
            compute_sets(bad, TT)


def test_sepak_cap_rules():
    assert compute_sets([[25, 24], [21, 18]], SEPAK) == (2, 0)  # 25-24 wins at cap
    with pytest.raises(Exception):
        compute_sets([[26, 24], [21, 18]], SEPAK)               # above the cap


def test_api_records_set_scores_for_tt_match():
    admin = _admin()
    t = create_tournament(user=admin, name="TT Cup")
    m = _match(t, sport="table_tennis")
    c = APIClient()
    c.force_authenticate(user=admin)

    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[11, 8], [9, 11], [11, 6]], "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED
    assert (m.home_score, m.away_score) == (2, 1)  # sets won
    assert m.set_scores == [[11, 8], [9, 11], [11, 6]]


def test_goal_sport_rejects_sets_but_goals_still_work():
    admin = _admin()
    t = create_tournament(user=admin, name="FB")
    m = _match(t, sport="")  # no sport -> goal-based
    c = APIClient()
    c.force_authenticate(user=admin)

    # set_scores rejected for a non-set sport
    assert c.post(
        f"/api/matches/{m.id}/score/",
        {"set_scores": [[11, 8], [11, 9]]}, format="json",
    ).status_code == 400

    # goal scoring still works
    r = c.post(
        f"/api/matches/{m.id}/score/",
        {"home_score": 3, "away_score": 1, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (3, 1)
    assert m.status == MatchStatus.COMPLETED
