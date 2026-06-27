"""TDD — standings honor the tournament's data-driven points rules."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import generate_round_robin
from apps.matches.models import Match, MatchStatus
from apps.matches.services.scoring import record_score
from apps.matches.services.standings import _sort_key, compute_standings
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.rules import merge_rules

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


# --- per-game tiebreakers: set/point criteria + coin toss (owner ref) --------

def _row(name, **kw):
    base = {
        "name": name, "team_id": name, "Pts": 0, "GD": 0, "GF": 0, "GA": 0,
        "W": 0, "PD_pts": 0, "PF_pts": 0, "PA_pts": 0, "_coin": 0,
    }
    base.update(kw)
    return base


def test_sort_key_point_difference_breaks_set_ties():
    tbs = ["points", "set_difference", "point_difference", "points_for"]
    rows = [_row("A", Pts=3, GD=0, PD_pts=5), _row("B", Pts=3, GD=0, PD_pts=20)]
    rows.sort(key=lambda r: _sort_key(r, tbs))
    assert [r["name"] for r in rows] == ["B", "A"]  # bigger point difference first


def test_sort_key_points_for_and_set_difference_aliases():
    rows = [_row("A", Pts=3, GD=1, GF=4), _row("B", Pts=3, GD=2, GF=2)]
    rows.sort(key=lambda r: _sort_key(r, ["points", "set_difference"]))
    assert [r["name"] for r in rows] == ["B", "A"]  # set_difference == GD
    rows = [_row("A", Pts=3, GD=1, GF=4), _row("B", Pts=3, GD=1, GF=2)]
    rows.sort(key=lambda r: _sort_key(r, ["points", "set_difference", "sets_for"]))
    assert [r["name"] for r in rows] == ["A", "B"]  # sets_for == GF


def _three_teams(t):
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []},
               {"name": "C", "players": []}],
    )
    return {tm.name: tm for tm in Team.objects.filter(tournament=t)}


def _set_match(t, home, away, hs, as_, sets, *, leaf="tt.open", group="G"):
    return Match.objects.create(
        organization=t.organization, tournament=t, sport="table_tennis",
        leaf_key=leaf, group_label=group, home_team=home, away_team=away,
        home_score=hs, away_score=as_, set_scores=sets, status=MatchStatus.COMPLETED,
    )


def test_standings_aggregates_set_points_and_honors_per_game_tiebreakers():
    admin = _user()
    t = create_tournament(user=admin, name="TT")
    tm = _three_teams(t)
    # a 3-team cycle: everyone 1-1, set diff 0 — only raw points separate them
    _set_match(t, tm["A"], tm["B"], 2, 0, [[21, 10], [21, 10]])  # A wins big
    _set_match(t, tm["B"], tm["C"], 2, 0, [[21, 5], [21, 5]])    # B wins huge
    _set_match(t, tm["C"], tm["A"], 2, 0, [[21, 19], [21, 19]])  # C wins narrow
    t.rules = merge_rules({"by_leaf": {"tt.open": {"tiebreakers": [
        "points", "set_difference", "point_difference", "points_for", "coin_toss"]}}})
    t.save(update_fields=["rules"])
    table = compute_standings(t, group_label="G")
    by_name = {r["name"]: r for r in table}
    assert by_name["A"]["PF_pts"] == 42 + 38   # 21+21 vs B, 19+19 vs C
    assert [r["name"] for r in table] == ["A", "B", "C"]  # point_difference order


def test_coin_toss_is_deterministic():
    admin = _user()
    t = create_tournament(user=admin, name="TT")
    tm = _three_teams(t)
    _set_match(t, tm["A"], tm["B"], 2, 0, [[21, 10], [21, 10]])
    _set_match(t, tm["B"], tm["C"], 2, 0, [[21, 10], [21, 10]])
    _set_match(t, tm["C"], tm["A"], 2, 0, [[21, 10], [21, 10]])
    # all tied on points/sets/points → coin toss decides; must be reproducible
    t.rules = merge_rules({"by_leaf": {"tt.open": {"tiebreakers": ["points", "coin_toss"]}}})
    t.save(update_fields=["rules"])
    o1 = [r["name"] for r in compute_standings(t, group_label="G")]
    o2 = [r["name"] for r in compute_standings(t, group_label="G")]
    assert o1 == o2 and set(o1) == {"A", "B", "C"}
