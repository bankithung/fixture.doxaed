"""TDD — single-elimination bracket + advancement (invariant #9)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.advance import advance_from_match
from apps.fixtures.services.generate import generate_single_elimination
from apps.matches.services.scoring import record_score
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _bracket(admin, n: int = 4):
    t = create_tournament(user=admin, name="KO Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(n)],
    )
    matches = generate_single_elimination(tournament=t, teams=teams)
    return t, teams, matches


def test_single_elim_4_teams_makes_3_matches_with_winner_pointers():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 4)
    assert len(matches) == 3
    final = [m for m in matches if m.round_no == 2][0]
    assert final.home_source["type"] == "winner_of"
    assert final.away_source["type"] == "winner_of"
    assert final.home_team_id is None  # unresolved until semis finish


def test_scoring_semis_advances_winners_into_final():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 4)
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    final = [m for m in matches if m.round_no == 2][0]

    record_score(match=semis[0], home_score=2, away_score=0, by=admin)
    advance_from_match(semis[0].id)  # on_commit doesn't fire inside the test txn
    final.refresh_from_db()
    assert final.home_team_id == semis[0].home_team_id  # semi-0 home won

    record_score(match=semis[1], home_score=0, away_score=3, by=admin)
    advance_from_match(semis[1].id)
    final.refresh_from_db()
    assert final.away_team_id == semis[1].away_team_id  # semi-1 away won


def test_single_elim_requires_power_of_two():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(3)],
    )
    with pytest.raises(ValueError):
        generate_single_elimination(tournament=t, teams=teams)
