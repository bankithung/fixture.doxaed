"""`GET /api/public/tournaments/{slug}/{id}/entries/` — who is in what.

The public match centre answers "what is being played" and Standings answers
"who is winning". This is the third question, and the one a parent or a
visiting school asks first: which schools entered which competition (owner
2026-08-22).

The load-bearing choice is that it reads ENTRIES (Team rows), never Match rows:
a school is listed the moment it registers, before any draw exists, and an
entry that never produced a match — a bye, a single-entry category — cannot go
missing from the grid.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams.models import Institution, Team
from apps.teams.services.registration import register_school
from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

SPORTS = [
    {
        "name": "Table Tennis",
        "nodes": [
            {
                "name": "U-14",
                "children": [{"name": "Boys"}, {"name": "Girls"}],
            },
        ],
    },
    {"name": "Sepak Takraw", "nodes": [{"name": "U-14"}]},
]

TT_BOYS = "table_tennis.u_14.boys"
TT_GIRLS = "table_tennis.u_14.girls"
SEPAK = "sepak_takraw.u_14"


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(status: str = TournamentStatus.SCHEDULED):
    admin = _verified(f"entries-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Entries Cup")
    t.sports = normalize_sports(SPORTS)
    t.save(update_fields=["sports"])
    register_school(
        tournament=t,
        school_name="Holy Cross",
        teams=[
            {"name": "Holy Cross TT-1", "leaf_key": TT_BOYS},
            {"name": "Holy Cross TT-2", "leaf_key": TT_BOYS},
            {"name": "Holy Cross ST-1", "leaf_key": SEPAK},
        ],
    )
    register_school(
        tournament=t,
        school_name="Riverbelt School",
        teams=[{"name": "Riverbelt ST-1", "leaf_key": SEPAK}],
    )
    t.status = status
    t.save(update_fields=["status"])
    return admin, t


def _get(t, slug=None):
    return APIClient().get(
        f"/api/public/tournaments/{slug or t.slug}/{t.id}/entries/"
    )


def _row(body, name):
    return next(r for r in body["institutions"] if r["name"] == name)


def _col(body, leaf_key):
    return next(c for c in body["competitions"] if c["leaf_key"] == leaf_key)


def test_matrix_has_a_row_per_school_and_a_cell_count_per_competition():
    _admin, t = _setup()
    r = _get(t)
    assert r.status_code == 200, r.content
    body = r.json()

    hc = _row(body, "Holy Cross")
    # Two entries in one competition is not the same fact as one: the cell
    # carries the COUNT, which is exactly the number a coach is checking.
    assert hc["entries"][TT_BOYS]["teams"] == 2
    assert sorted(hc["entries"][TT_BOYS]["names"]) == [
        "Holy Cross TT-1",
        "Holy Cross TT-2",
    ]
    assert hc["entries"][SEPAK]["teams"] == 1
    # An unentered competition is ABSENT, never a zero row — the client reads
    # "not entered" from the missing key.
    assert TT_GIRLS not in hc["entries"]
    assert hc["team_count"] == 3
    assert hc["competition_count"] == 2

    assert body["totals"] == {"schools": 2, "competitions": 3, "teams": 4}


def test_columns_come_from_the_category_tree_not_from_the_entries():
    """A competition nobody entered is still a real column — its empty column
    IS the answer to "is anyone playing it"."""
    _admin, t = _setup()
    body = _get(t).json()
    assert [c["leaf_key"] for c in body["competitions"]] == [
        TT_BOYS,
        TT_GIRLS,
        SEPAK,
    ]
    girls = _col(body, TT_GIRLS)
    assert girls["teams"] == 0
    assert girls["schools"] == 0
    # The path is the segments BELOW the sport, so the client can build both a
    # full label and a short code without knowing this tournament's naming.
    assert girls["path"] == ["U-14", "Girls"]
    assert girls["sport_name"] == "Table Tennis"


def test_column_totals_count_schools_once_however_many_teams_it_entered():
    _admin, t = _setup()
    body = _get(t).json()
    boys = _col(body, TT_BOYS)
    assert boys["teams"] == 2  # both Holy Cross entries
    assert boys["schools"] == 1  # but ONE school


def test_a_withdrawn_team_is_not_a_participant():
    _admin, t = _setup()
    Team.objects.filter(tournament=t, name="Holy Cross TT-2").update(
        status="withdrawn"
    )
    body = _get(t).json()
    hc = _row(body, "Holy Cross")
    assert hc["entries"][TT_BOYS]["teams"] == 1
    assert _col(body, TT_BOYS)["teams"] == 1


def test_the_crest_rides_the_row_so_a_school_is_recognisable():
    _admin, t = _setup()
    inst = Institution.objects.get(tournament=t, name="Holy Cross")
    assert _row(_get(t).json(), "Holy Cross")["crest"] == ""
    inst.logo_ref = uuid.uuid4()
    inst.save(update_fields=["logo_ref"])
    assert _row(_get(t).json(), "Holy Cross")["crest"].startswith(
        f"/api/forms/uploads/{inst.logo_ref}/"
    )


def test_a_school_with_no_entry_is_dropped_once_anyone_has_entered():
    """A registered school that entered nothing is not participating, and a row
    of empty cells reads as a data error rather than as an answer."""
    _admin, t = _setup()
    Institution.objects.create(
        organization=t.organization, tournament=t, slug="empty", name="Empty School"
    )
    body = _get(t).json()
    assert [r["name"] for r in body["institutions"]] == [
        "Holy Cross",
        "Riverbelt School",
    ]


def test_before_any_team_exists_the_matrix_is_the_registered_schools():
    """During registration there are no entries at all; listing nobody would
    make the tab look broken on exactly the days it is most looked at."""
    admin = _verified(f"entries-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Early Cup")
    t.sports = normalize_sports(SPORTS)
    t.save(update_fields=["sports"])
    Institution.objects.create(
        organization=t.organization, tournament=t, slug="early", name="Early School"
    )
    t.status = TournamentStatus.REGISTRATION_OPEN
    t.save(update_fields=["status"])
    body = _get(t).json()
    assert [r["name"] for r in body["institutions"]] == ["Early School"]
    assert body["institutions"][0]["team_count"] == 0
    assert len(body["competitions"]) == 3


def test_an_entry_whose_category_was_renamed_still_gets_a_column():
    """Nothing may be invisible: an entry pointing at a leaf that no longer
    resolves is appended as its own column rather than silently dropped."""
    _admin, t = _setup()
    Team.objects.filter(tournament=t, name="Riverbelt ST-1").update(
        leaf_key="sepak_takraw.retired"
    )
    body = _get(t).json()
    keys = [c["leaf_key"] for c in body["competitions"]]
    assert "sepak_takraw.retired" in keys
    assert _row(body, "Riverbelt School")["entries"]["sepak_takraw.retired"][
        "teams"
    ] == 1


def test_a_team_with_no_category_is_counted_but_placed_in_no_column():
    _admin, t = _setup()
    Team.objects.filter(tournament=t, name="Riverbelt ST-1").update(leaf_key="")
    rb = _row(_get(t).json(), "Riverbelt School")
    assert rb["uncategorized"] == 1
    assert rb["entries"] == {}
    # Counted in the total, so the numbers on the row still reconcile.
    assert rb["team_count"] == 1


def test_wrong_slug_404s_and_a_draft_tournament_is_not_public():
    _admin, t = _setup()
    assert _get(t, slug="not-the-slug").status_code == 404
    t.status = TournamentStatus.DRAFT
    t.save(update_fields=["status"])
    assert _get(t).status_code == 404


def test_another_tournaments_schools_never_appear():
    _admin, t = _setup()
    _other_admin, other = _setup()
    names = {r["name"] for r in _get(t).json()["institutions"]}
    other_ids = set(
        Institution.objects.filter(tournament=other).values_list("id", flat=True)
    )
    assert names == {"Holy Cross", "Riverbelt School"}
    assert not {r["id"] for r in _get(t).json()["institutions"]} & {
        str(i) for i in other_ids
    }
