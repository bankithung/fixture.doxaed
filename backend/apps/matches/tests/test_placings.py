"""Who came 1st, 2nd and 3rd — derived from the fixture, overridable by hand.

Spec: docs/superpowers/specs/2026-08-25-results-medal-tally-design.md.

The load-bearing choice is that a placing is DERIVED: the bracket already knows
who won, so nothing records it a second time. These tests pin the three ways a
competition ends (final + playoff, final with no playoff, a table) and the two
ways it must refuse to guess.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.matches.models import Match, MatchStatus
from apps.matches.services.placings import competition_placings
from apps.teams.models import Institution, Team
from apps.tournaments.services.awards import merge_awards
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF = "table_tennis.u_14.boys"
SPORTS = [{"name": "Table Tennis", "nodes": [
    {"name": "U-14", "children": [{"name": "Boys"}]},
]}]


def _tournament():
    admin = User.objects.create_user(
        email=f"placings-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Placings Cup")
    t.sports = normalize_sports(SPORTS)
    t.awards = merge_awards({"enabled": True})
    t.save(update_fields=["sports", "awards"])
    return t


def _team(t, name):
    inst, _ = Institution.objects.get_or_create(
        tournament=t, name=name,
        defaults={"organization": t.organization, "slug": name.lower()},
    )
    return Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        name=f"{name} TT-1", slug=f"{name.lower()}-tt-1", school=name,
        leaf_key=LEAF, status="registered",
    )


def _match(t, *, home, away, round_no, no, hs=None, aws=None,
           home_score=None, away_score=None, stage="knockout", group=""):
    return Match.objects.create(
        organization=t.organization, tournament=t, leaf_key=LEAF,
        stage=stage, stage_no=0, round_no=round_no, match_no=no,
        group_label=group, home_team=home, away_team=away,
        home_source=hs or {}, away_source=aws or {},
        status=(MatchStatus.COMPLETED if home_score is not None else "scheduled"),
        home_score=home_score, away_score=away_score,
    )


def _semis(t):
    """Four teams, two semi-finals, both played. A -> beat B, C -> beat D."""
    a, b, c, d = (_team(t, n) for n in ("Alpha", "Bravo", "Cavalry", "Delta"))
    s1 = _match(t, home=a, away=b, round_no=1, no=1, home_score=3, away_score=0)
    s2 = _match(t, home=c, away=d, round_no=1, no=2, home_score=3, away_score=1)
    return (a, b, c, d), (s1, s2)


def test_final_and_playoff_give_gold_silver_and_bronze():
    t = _tournament()
    (a, b, c, d), (s1, s2) = _semis(t)
    _match(t, home=a, away=c, round_no=2, no=3, home_score=3, away_score=2,
           hs={"type": "winner_of", "match_id": str(s1.id)},
           aws={"type": "winner_of", "match_id": str(s2.id)})
    _match(t, home=b, away=d, round_no=2, no=4, home_score=3, away_score=1,
           hs={"type": "loser_of", "match_id": str(s1.id)},
           aws={"type": "loser_of", "match_id": str(s2.id)})

    out = competition_placings(t, LEAF)
    assert out["status"] == "final"
    assert [(p["place"], p["team_id"]) for p in out["places"]] == [
        (1, str(a.id)), (2, str(c.id)), (3, str(b.id)),
    ]
    assert [p["points"] for p in out["places"]] == [5, 3, 2]
    assert [p["label"] for p in out["places"]] == ["Gold", "Silver", "Bronze"]


def test_the_playoff_is_read_from_its_pointers_not_its_label():
    """The final and the third-place match share a round number; only the
    `loser_of` sides tell them apart. A retyped group label must not decide
    which one is the final."""
    t = _tournament()
    (a, b, c, d), (s1, s2) = _semis(t)
    _match(t, home=b, away=d, round_no=2, no=3, home_score=3, away_score=1,
           group="Table Tennis · U-14 · Boys",   # NOT labelled "3rd Place"
           hs={"type": "loser_of", "match_id": str(s1.id)},
           aws={"type": "loser_of", "match_id": str(s2.id)})
    _match(t, home=a, away=c, round_no=2, no=4, home_score=3, away_score=2,
           group="Table Tennis · U-14 · Boys",
           hs={"type": "winner_of", "match_id": str(s1.id)},
           aws={"type": "winner_of", "match_id": str(s2.id)})

    places = {p["place"]: p["team_id"] for p in competition_placings(t, LEAF)["places"]}
    assert places[1] == str(a.id)
    assert places[3] == str(b.id)


def test_no_playoff_shares_bronze_between_both_losing_semifinalists():
    t = _tournament()
    (a, b, c, d), (s1, s2) = _semis(t)
    _match(t, home=a, away=c, round_no=2, no=3, home_score=3, away_score=2,
           hs={"type": "winner_of", "match_id": str(s1.id)},
           aws={"type": "winner_of", "match_id": str(s2.id)})

    third = next(p for p in competition_placings(t, LEAF)["places"] if p["place"] == 3)
    assert {third["team_id"], *third["shared_with"]} == {str(b.id), str(d.id)}


def test_bronze_none_awards_no_third_place():
    t = _tournament()
    t.awards = merge_awards({"bronze": "none"}, base=t.awards)
    t.save(update_fields=["awards"])
    (a, b, c, d), (s1, s2) = _semis(t)  # noqa: RUF059 - the bracket needs all four
    _match(t, home=a, away=c, round_no=2, no=3, home_score=3, away_score=2,
           hs={"type": "winner_of", "match_id": str(s1.id)},
           aws={"type": "winner_of", "match_id": str(s2.id)})

    assert [p["place"] for p in competition_placings(t, LEAF)["places"]] == [1, 2]


def test_an_undecided_final_awards_no_gold_and_reads_provisional():
    """Bronze is settled the moment the semi-finals are (under `shared`) —
    losing a semi IS the bronze — but gold and silver wait for the final, and
    the competition reads provisional until every match is played."""
    t = _tournament()
    (a, b, c, d), (s1, s2) = _semis(t)  # noqa: RUF059 - the bracket needs all four
    _match(t, home=a, away=c, round_no=2, no=3,
           hs={"type": "winner_of", "match_id": str(s1.id)},
           aws={"type": "winner_of", "match_id": str(s2.id)})

    out = competition_placings(t, LEAF)
    assert [p["place"] for p in out["places"]] == [3]
    assert out["status"] == "provisional"


def test_nothing_at_all_is_decided_before_the_semifinals_are_played():
    t = _tournament()
    a, b, c, d = (_team(t, n) for n in ("Alpha", "Bravo", "Cavalry", "Delta"))
    _match(t, home=a, away=b, round_no=1, no=1)
    _match(t, home=c, away=d, round_no=1, no=2)

    out = competition_placings(t, LEAF)
    assert out["places"] == []
    assert out["status"] == "pending"


def test_a_running_group_table_awards_nothing():
    """compute_standings seeds every team at zero before a ball is kicked, so
    reading it early would hand out gold in draw order."""
    t = _tournament()
    a, b, c = (_team(t, n) for n in ("Alpha", "Bravo", "Cavalry"))
    _match(t, home=a, away=b, round_no=1, no=1, home_score=3, away_score=0,
           stage="group", group="Group A")
    _match(t, home=a, away=c, round_no=2, no=2, stage="group", group="Group A")

    assert competition_placings(t, LEAF)["places"] == []


def test_a_finished_single_group_is_placed_by_its_table():
    t = _tournament()
    a, b, c = (_team(t, n) for n in ("Alpha", "Bravo", "Cavalry"))
    _match(t, home=a, away=b, round_no=1, no=1, home_score=3, away_score=0,
           stage="group", group="Group A")
    _match(t, home=a, away=c, round_no=2, no=2, home_score=3, away_score=1,
           stage="group", group="Group A")
    _match(t, home=b, away=c, round_no=3, no=3, home_score=3, away_score=2,
           stage="group", group="Group A")

    out = competition_placings(t, LEAF)
    assert out["status"] == "final"
    assert [(p["place"], p["team_id"]) for p in out["places"]] == [
        (1, str(a.id)), (2, str(b.id)), (3, str(c.id)),
    ]


def test_two_groups_and_no_knockout_refuse_to_invent_a_ranking():
    t = _tournament()
    a, b, c, d = (_team(t, n) for n in ("Alpha", "Bravo", "Cavalry", "Delta"))
    _match(t, home=a, away=b, round_no=1, no=1, home_score=3, away_score=0,
           stage="group", group="Group A")
    _match(t, home=c, away=d, round_no=1, no=2, home_score=3, away_score=0,
           stage="group", group="Group B")

    assert competition_placings(t, LEAF)["places"] == []


def test_a_knockout_in_progress_never_falls_back_to_the_table():
    """A competition that HAS a bracket is decided by it. Reading the group
    table while the final is still to play would award a medal the bracket is
    about to contradict."""
    t = _tournament()
    a, b = _team(t, "Alpha"), _team(t, "Bravo")
    _match(t, home=a, away=b, round_no=1, no=1, stage="knockout",
           group="Table Tennis · U-14 · Boys")

    assert competition_placings(t, LEAF)["places"] == []


def test_a_host_override_replaces_a_derived_placing():
    t = _tournament()
    (a, b, c, d), (s1, s2) = _semis(t)  # noqa: RUF059 - the bracket needs all four
    _match(t, home=a, away=c, round_no=2, no=3, home_score=3, away_score=2,
           hs={"type": "winner_of", "match_id": str(s1.id)},
           aws={"type": "winner_of", "match_id": str(s2.id)})
    t.awards = merge_awards(
        {"overrides": [{"leaf_key": LEAF, "place": 1, "team_id": str(c.id),
                        "note": "final rescored"}]},
        base=t.awards,
    )
    t.save(update_fields=["awards"])

    gold = competition_placings(t, LEAF)["places"][0]
    assert gold["team_id"] == str(c.id)
    assert gold["source"] == "manual"
    assert gold["note"] == "final rescored"


def test_an_event_with_no_fixture_is_placed_entirely_by_hand():
    """The reference sheet is athletics: 100m and Shot Put have no matches at
    all, and a hand-entered event must not sit at 'provisional' forever."""
    t = _tournament()
    t.awards = merge_awards(
        {"overrides": [
            {"leaf_key": "athletics.100m", "place": 1, "label": "Greenwood School"},
            {"leaf_key": "athletics.100m", "place": 2, "label": "Pilgrim Hr. Sec."},
        ]},
        base=t.awards,
    )
    t.save(update_fields=["awards"])

    out = competition_placings(t, "athletics.100m")
    assert out["status"] == "final"
    assert [p["team_label"] for p in out["places"]] == [
        "Greenwood School", "Pilgrim Hr. Sec.",
    ]
