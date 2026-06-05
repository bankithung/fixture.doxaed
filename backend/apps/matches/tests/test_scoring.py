"""TDD — record scores, complete matches, compute standings (idempotent)."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.matches.models import Match, MatchStatus
from apps.matches.services.scoring import record_score
from apps.matches.services.standings import compute_standings
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _two_teams(t):
    teams = register_school(
        tournament=t,
        school_name="Demo School",
        teams=[{"name": "Alpha", "players": []}, {"name": "Beta", "players": []}],
    )
    return teams[0], teams[1]


def test_record_score_completes_match_and_sets_winner():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = _two_teams(t)
    m = Match.objects.create(organization=t.organization, tournament=t, home_team=a, away_team=b)

    record_score(match=m, home_score=2, away_score=1, by=admin)

    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED
    assert (m.home_score, m.away_score) == (2, 1)
    assert m.winner_id == a.id


def test_standings_from_completed_matches():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = _two_teams(t)
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        group_label="Group A",
    )
    record_score(match=m, home_score=3, away_score=1, by=admin)

    rows = compute_standings(t, group_label="Group A")
    assert rows[0]["team_id"] == str(a.id)
    assert rows[0]["Pts"] == 3 and rows[0]["GD"] == 2
    assert rows[1]["team_id"] == str(b.id)
    assert rows[1]["Pts"] == 0


def test_record_score_idempotent_on_event_id():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = _two_teams(t)
    m = Match.objects.create(organization=t.organization, tournament=t, home_team=a, away_team=b)
    eid = uuid.uuid4()

    record_score(match=m, home_score=2, away_score=2, by=admin, event_id=eid)
    record_score(match=m, home_score=5, away_score=0, by=admin, event_id=eid)  # replay ignored

    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (2, 2)
