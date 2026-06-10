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


def test_knockout_from_groups_advances_top_two():
    from apps.fixtures.services.generate import (
        generate_knockout_from_groups,
        generate_round_robin,
    )
    from apps.matches.models import Match
    from apps.matches.services.scoring import record_score

    admin = _verified()
    t = create_tournament(user=admin, name="Groups KO")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)],
    )
    generate_round_robin(tournament=t, group_size=4)  # 2 groups of 4
    for i, m in enumerate(Match.objects.filter(tournament=t, stage="group").order_by("match_no")):
        record_score(match=m, home_score=(i % 4) + 1, away_score=i % 3, by=admin)

    ko = generate_knockout_from_groups(tournament=t)
    # 2 groups x top-2 = 4 teams -> single elim = 2 semis + final
    assert len(ko) == 3
    assert all(m.stage == "knockout" for m in ko)
    # round-1 knockout matches have concrete teams drawn from the groups
    r1 = [m for m in ko if m.round_no == 1]
    assert all(m.home_team_id and m.away_team_id for m in r1)


def test_single_elim_non_power_of_two_gets_byes():
    """3 teams → bracket of 4 with one bye: the top seed skips round 1 and
    enters the final as a typed team pointer (spec 2026-06-10 P3)."""
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(3)],
    )
    matches = generate_single_elimination(tournament=t, teams=teams)
    assert len(matches) == 2  # one semifinal + the final
    semi = next(m for m in matches if m.round_no == 1)
    final = next(m for m in matches if m.round_no == 2)
    # seeds 2 and 3 play the semi; seed 1 (bye) is already in the final
    assert {semi.home_team, semi.away_team} == {teams[1], teams[2]}
    assert final.home_team == teams[0]
    assert final.home_source == {"type": "team", "team_id": str(teams[0].id)}
    assert final.away_source == {"type": "winner_of", "match_id": str(semi.id)}

    # the bye team's opponent resolves on semi completion
    record_score(match=semi, home_score=2, away_score=0, by=admin)
    advance_from_match(semi.id)
    final.refresh_from_db()
    assert final.away_team == semi.home_team


def test_single_elim_is_idempotent_per_scope():
    admin = _verified()
    _t, teams, matches = _bracket(admin, 4)
    again = generate_single_elimination(tournament=_t, teams=teams)
    assert {m.id for m in again} == {m.id for m in matches}  # no duplicates
