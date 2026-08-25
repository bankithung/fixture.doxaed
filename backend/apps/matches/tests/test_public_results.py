"""`GET /api/public/tournaments/{slug}/{id}/results/` — the medal tally.

Spec: docs/superpowers/specs/2026-08-25-results-medal-tally-design.md.

The reference is the ANPSA Dimapur medal sheet: schools down, one column per
event, the cell holding the placing. What the paper sheet cannot do, and these
tests pin, is the points ladder the host owns, the champion of an authored
category group, and the students behind the medals.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.awards import merge_awards
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

SINGLES = "table_tennis.u_14.boys.singles"
DOUBLES = "table_tennis.u_14.boys.doubles"
GIRLS = "table_tennis.u_14.girls.singles"
SPORTS = [{"name": "Table Tennis", "nodes": [{
    "name": "U-14",
    "children": [
        {"name": "Boys", "children": [{"name": "Singles"}, {"name": "Doubles"}]},
        {"name": "Girls", "children": [{"name": "Singles"}]},
    ],
}]}]

GROUPS = [
    {"key": "u14_boys", "label": "U-14 Boys",
     "include": ["table_tennis.u_14.boys"], "decide": "points"},
    {"key": "overall", "label": "Overall", "include": [], "decide": "points"},
]


def _verified(email: str):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _tournament(admin=None):
    admin = admin or _verified(f"results-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Results Cup")
    t.sports = normalize_sports(SPORTS)
    t.awards = merge_awards({"enabled": True, "groups": GROUPS})
    t.status = TournamentStatus.SCHEDULED
    t.save(update_fields=["sports", "awards", "status"])
    return t, admin


def _school(t, name, teams):
    return register_school(tournament=t, school_name=name, teams=teams)


def _played(t, leaf, home, away, *, round_no, no, hs=None, aws=None, hscore=3, ascore=1):
    return Match.objects.create(
        organization=t.organization, tournament=t, leaf_key=leaf,
        stage="knockout", stage_no=0, round_no=round_no, match_no=no,
        home_team=home, away_team=away, home_source=hs or {}, away_source=aws or {},
        status=MatchStatus.COMPLETED, home_score=hscore, away_score=ascore,
    )


def _bracket(t, leaf, four):
    """Semis, final and third-place playoff. Returns (gold, silver, bronze)."""
    a, b, c, d = four
    s1 = _played(t, leaf, a, b, round_no=1, no=1)
    s2 = _played(t, leaf, c, d, round_no=1, no=2)
    _played(t, leaf, a, c, round_no=2, no=3,
            hs={"type": "winner_of", "match_id": str(s1.id)},
            aws={"type": "winner_of", "match_id": str(s2.id)})
    _played(t, leaf, b, d, round_no=2, no=4,
            hs={"type": "loser_of", "match_id": str(s1.id)},
            aws={"type": "loser_of", "match_id": str(s2.id)})
    return a, c, b


def _four_schools(t, leaf, suffix=""):
    out = []
    for name in ("Greenwood", "Pilgrim", "Holy Cross", "Eden"):
        teams = _school(t, name, [{
            "name": f"{name} {leaf[-3:]}{suffix}", "leaf_key": leaf,
            "players": [{"full_name": f"{name} Player{suffix}"}],
        }])
        out.append(teams[0])
    return out


def _results(t):
    r = APIClient().get(f"/api/public/tournaments/{t.slug}/{t.id}/results/")
    assert r.status_code == 200, r.data
    return r.data


def test_the_tally_ranks_schools_by_points_from_the_ladder():
    t, _ = _tournament()
    gold, silver, bronze = _bracket(t, SINGLES, _four_schools(t, SINGLES))

    data = _results(t)
    by_name = {r["name"]: r for r in data["schools"]}
    assert by_name[gold.institution.name]["points"] == 5
    assert by_name[silver.institution.name]["points"] == 3
    assert by_name[bronze.institution.name]["points"] == 2
    assert by_name[gold.institution.name]["medals"]["1"] == 1
    assert data["schools"][0]["name"] == gold.institution.name
    assert data["schools"][0]["rank"] == 1
    assert data["totals"]["points"] == 10


def test_the_host_owns_the_ladder():
    t, _ = _tournament()
    gold, silver, _ = _bracket(t, SINGLES, _four_schools(t, SINGLES))
    t.awards = merge_awards(
        {"ladder": [{"place": 1, "points": 10, "label": "Gold"},
                    {"place": 2, "points": 6, "label": "Silver"}]},
        base=t.awards,
    )
    t.save(update_fields=["awards"])

    by_name = {r["name"]: r for r in _results(t)["schools"]}
    assert by_name[gold.institution.name]["points"] == 10
    assert by_name[silver.institution.name]["points"] == 6
    # The ladder no longer scores third, so no bronze is awarded at all.
    assert sum(r["medals"].get("3", 0) for r in _results(t)["schools"]) == 0


def test_one_competition_can_be_worth_more_than_another():
    t, _ = _tournament()
    gold, _, _ = _bracket(t, SINGLES, _four_schools(t, SINGLES))
    t.awards = merge_awards(
        {"by_competition": [{
            "match": "table_tennis.u_14.boys.singles",
            "ladder": [{"place": 1, "points": 20, "label": "Gold"}],
        }]},
        base=t.awards,
    )
    t.save(update_fields=["awards"])

    by_name = {r["name"]: r for r in _results(t)["schools"]}
    assert by_name[gold.institution.name]["points"] == 20


def test_a_school_that_wins_twice_in_one_competition_counts_twice():
    """Two entries from one school can both medal — the paper sheet has one
    cell per school per event and cannot say that."""
    t, _ = _tournament()
    a, b, _c, d = _four_schools(t, SINGLES)
    second = Team.objects.create(
        organization=t.organization, tournament=t, institution=a.institution,
        name="Greenwood TT-2", slug="greenwood-tt-2", school=a.institution.name,
        leaf_key=SINGLES, status="registered",
    )
    s1 = _played(t, SINGLES, a, b, round_no=1, no=1)
    s2 = _played(t, SINGLES, second, d, round_no=1, no=2)
    _played(t, SINGLES, a, second, round_no=2, no=3,
            hs={"type": "winner_of", "match_id": str(s1.id)},
            aws={"type": "winner_of", "match_id": str(s2.id)})
    _played(t, SINGLES, b, d, round_no=2, no=4,
            hs={"type": "loser_of", "match_id": str(s1.id)},
            aws={"type": "loser_of", "match_id": str(s2.id)})

    row = next(r for r in _results(t)["schools"] if r["name"] == a.institution.name)
    assert row["medals"]["1"] == 1 and row["medals"]["2"] == 1
    assert row["points"] == 8
    assert len(row["results"][SINGLES]) == 2


def test_a_group_names_a_champion_over_the_competitions_it_includes():
    t, _ = _tournament()
    boys_gold, _, _ = _bracket(t, SINGLES, _four_schools(t, SINGLES))
    _bracket(t, GIRLS, _four_schools(t, GIRLS, suffix="-g"))

    groups = {g["key"]: g for g in _results(t)["groups"]}
    assert groups["u14_boys"]["leaf_keys"] == [SINGLES, DOUBLES]
    assert [c["name"] for c in groups["u14_boys"]["champions"]] == [
        boys_gold.institution.name
    ]
    # An empty `include` is EVERY competition — that is what Overall means.
    assert set(groups["overall"]["leaf_keys"]) == {SINGLES, DOUBLES, GIRLS}
    # A group table is a podium, not a register: it lists the schools that won
    # something. The same school topping two brackets carries both golds.
    assert groups["overall"]["table"][0]["medals"]["1"] == 2
    assert all(r["points"] > 0 for r in groups["overall"]["table"])


def test_a_group_can_be_decided_by_golds_instead_of_points():
    t, _ = _tournament()
    a, b, c, d = _four_schools(t, SINGLES)
    # a takes gold in singles; b takes silver AND the girls' gold is c's.
    _bracket(t, SINGLES, (a, b, c, d))
    t.awards = merge_awards(
        {"groups": [{"key": "overall", "label": "Overall", "include": [],
                     "decide": "golds"}]},
        base=t.awards,
    )
    t.save(update_fields=["awards"])

    table = _results(t)["groups"][0]["table"]
    assert table[0]["name"] == a.institution.name
    assert table[0]["medals"]["1"] == 1


def test_a_student_is_one_row_across_every_event_they_play():
    """The participants layer's whole point: a child in two events is one
    child, and the tally is where that finally shows."""
    t, _ = _tournament()
    a, b, c, d = _four_schools(t, SINGLES)
    # The same person also plays doubles for the same school.
    register_school(
        tournament=t, school_name=a.institution.name, institution=a.institution,
        teams=[{"name": "Greenwood DBL", "leaf_key": DOUBLES,
                "players": [{"full_name": "Greenwood Player"},
                            {"full_name": "Greenwood Partner"}]}],
    )
    _bracket(t, SINGLES, (a, b, c, d))

    students = {s["name"]: s for s in _results(t)["students"]}
    star = students["Greenwood Player"]
    assert star["event_count"] == 2
    assert {e["leaf_key"] for e in star["events"]} == {SINGLES, DOUBLES}
    assert star["points"] == 5          # the singles gold; the doubles is undecided
    assert star["medals"]["1"] == 1


def test_both_partners_of_a_winning_pair_carry_the_full_points():
    """Owner 2026-08-25. The school counts the medal once; the student view
    answers what a child was part of, not how to divide a medal."""
    t, _ = _tournament()
    pairs = []
    for name in ("Greenwood", "Pilgrim", "Holy Cross", "Eden"):
        teams = register_school(tournament=t, school_name=name, teams=[{
            "name": f"{name} DBL", "leaf_key": DOUBLES,
            "players": [{"full_name": f"{name} One"}, {"full_name": f"{name} Two"}],
        }])
        pairs.append(teams[0])
    _bracket(t, DOUBLES, pairs)

    data = _results(t)
    students = {s["name"]: s for s in data["students"]}
    assert students["Greenwood One"]["points"] == 5
    assert students["Greenwood Two"]["points"] == 5
    school = next(r for r in data["schools"] if r["name"] == "Greenwood")
    assert school["points"] == 5


def test_every_registered_school_holds_a_row_even_with_no_medal():
    t, _ = _tournament()
    _four_schools(t, SINGLES)
    _school(t, "Lampstand", [{"name": "Lampstand TT-1", "leaf_key": SINGLES}])

    names = [r["name"] for r in _results(t)["schools"]]
    assert "Lampstand" in names
    row = next(r for r in _results(t)["schools"] if r["name"] == "Lampstand")
    assert row["points"] == 0 and row["results"] == {}


def test_a_competition_still_running_is_reported_provisional():
    t, _ = _tournament()
    a, b, c, d = _four_schools(t, SINGLES)
    s1 = _played(t, SINGLES, a, b, round_no=1, no=1)
    _played(t, SINGLES, c, d, round_no=1, no=2)
    Match.objects.create(
        organization=t.organization, tournament=t, leaf_key=SINGLES,
        stage="knockout", round_no=2, match_no=3, home_team=a, away_team=c,
        home_source={"type": "winner_of", "match_id": str(s1.id)},
        status="scheduled",
    )

    comp = next(c for c in _results(t)["competitions"] if c["leaf_key"] == SINGLES)
    assert comp["status"] == "provisional"
    assert _results(t)["totals"]["decided"] == 0


def test_the_public_read_needs_no_login_and_names_every_competition():
    t, _ = _tournament()
    data = _results(t)
    assert [c["leaf_key"] for c in data["competitions"]] == [SINGLES, DOUBLES, GIRLS]
    assert data["totals"]["competitions"] == 3
    assert data["awards"]["ladder"][0]["points"] == 5
