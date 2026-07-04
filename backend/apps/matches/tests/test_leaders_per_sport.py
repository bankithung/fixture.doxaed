"""P1.b — leaders are computed PER SPORT (fixes verified finding N7).

A mixed sepak + football tournament used to pool both into one
football-shaped table (21-point sets summed against goals). Now each sport
gets its own boards from definition.leaderboards, and set sports rank by
wins / set ratio / point difference — never by goals.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.matches.models import Match, MatchStatus
from apps.matches.services.leaders import compute_leaders
from apps.matches.services.set_scoring import record_set_result
from apps.matches.services.scoring import record_score
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SEPAK = {"type": "sets", "points": 21, "win_by": 2, "cap": 25, "best_of": 3,
         "deciding": {"points": 15, "win_by": 2, "cap": 17}}


def _setup():
    u = User.objects.create_user(
        email="leaders-p1b@test.local", password="FixtureDemo2026!",
        is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    t = create_tournament(user=u, name="Mixed Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []},
               {"name": "C", "players": []}, {"name": "D", "players": []}],
    )
    a, b, c, d = list(Team.objects.filter(tournament=t).order_by("name"))
    return u, t, a, b, c, d


def test_sports_never_pool_and_set_boards_rank_by_sets():
    admin, t, a, b, c, d = _setup()

    # One completed sepak match: A beats B 2-0 (21-10, 21-12).
    st = Match.objects.create(
        organization=t.organization, tournament=t, sport="sepak_takraw",
        home_team=a, away_team=b, status=MatchStatus.SCHEDULED,
    )
    record_set_result(
        match=st, set_scores=[[21, 10], [21, 12]], rules=SEPAK, by=admin,
        event_id=uuid.uuid4(),
    )

    # One completed football match: C beats D 1-0.
    fb = Match.objects.create(
        organization=t.organization, tournament=t, sport="",
        home_team=c, away_team=d, status=MatchStatus.SCHEDULED,
    )
    record_score(match=fb, home_score=1, away_score=0, by=admin,
                 event_id=uuid.uuid4())

    out = compute_leaders(t)
    assert out["played"] == 2
    by_sport = {s["sport"]: s for s in out["sports"]}
    assert set(by_sport) == {"football", "sepak_takraw"}

    # Sepak boards: wins / set ratio / point diff — NO goal boards.
    sepak_boards = {b["key"]: b for b in by_sport["sepak_takraw"]["boards"]}
    assert set(sepak_boards) == {"match_wins", "set_ratio", "point_diff"}
    assert sepak_boards["match_wins"]["rows"][0]["team_name"] == "A"
    assert sepak_boards["match_wins"]["rows"][0]["value"] == 1
    assert sepak_boards["set_ratio"]["rows"][0]["value"] == "2-0"
    assert sepak_boards["point_diff"]["rows"][0]["value"] == 42 - 22

    # Football boards contain ONLY football teams (C, D) — never A or B.
    fb_boards = {b["key"]: b for b in by_sport["football"]["boards"]}
    assert set(fb_boards) == {
        "top_scorers", "best_attack", "best_defence", "clean_sheets"
    }
    fb_teams = {
        r["team_name"]
        for board in fb_boards.values()
        for r in board["rows"]
        if "team_name" in r
    }
    assert fb_teams <= {"C", "D"}
    assert fb_boards["clean_sheets"]["rows"][0]["team_name"] == "C"


def test_day_zero_shows_each_sports_empty_boards():
    admin, t, a, b, c, d = _setup()
    Match.objects.create(
        organization=t.organization, tournament=t, sport="table_tennis",
        home_team=a, away_team=b,
    )
    out = compute_leaders(t)
    tt = next(s for s in out["sports"] if s["sport"] == "table_tennis")
    assert tt["played"] == 0
    assert [b["key"] for b in tt["boards"]] == [
        "match_wins", "set_ratio", "point_diff"
    ]
    assert all(b["rows"] == [] for b in tt["boards"])
