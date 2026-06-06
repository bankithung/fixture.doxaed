"""TDD — standings honor the tournament's data-driven points rules."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import generate_round_robin
from apps.matches.services.scoring import record_score
from apps.matches.services.standings import compute_standings
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user():
    u = User.objects.create_user(email="s@test.local", password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def test_standings_uses_configured_win_points():
    admin = _user()
    t = create_tournament(user=admin, name="Pts Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    matches = generate_round_robin(tournament=t, group_size=2)
    record_score(match=matches[0], home_score=2, away_score=0, by=admin)

    # default rules -> 3 points for a win
    assert compute_standings(t)[0]["Pts"] == 3

    # custom rules -> 2 points for a win
    t.rules = {"points": {"win": 2, "draw": 1, "loss": 0}}
    t.save(update_fields=["rules"])
    top = compute_standings(t)[0]
    assert top["Pts"] == 2
    assert top["W"] == 1
