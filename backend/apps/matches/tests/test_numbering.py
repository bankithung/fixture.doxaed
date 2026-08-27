"""ONE number per match, everywhere it is printed.

Owner 2026-08-27: "all the fixtures used in all pages should use only one
source of truth, not different in different pages". The bug that forced it: the
printed court grid tie-broke inside a round on a uuid, so it numbered the sepak
takraw quarter-finals in a different order than the public sheet did — and its
own "Winner of Match 18" then named the game the board called M16.

These pin the rule (`services/numbering.py`) and pin that the payloads every
page reads actually carry it.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.matches.models import Match
from apps.matches.serializers import MatchSerializer
from apps.matches.services.numbering import fixture_numbers, number_rows
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

BOYS = "table_tennis.u_14.boys"
GIRLS = "table_tennis.u_14.girls"
SPORTS = [{"name": "Table Tennis", "nodes": [
    {"name": "U-14", "children": [{"name": "Boys"}, {"name": "Girls"}]},
]}]


def _tournament():
    admin = User.objects.create_user(
        email=f"numbering-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Numbering Cup")
    t.sports = normalize_sports(SPORTS)
    t.save(update_fields=["sports"])
    return t


def _match(t, *, leaf=BOYS, stage="knockout", round_no=1, no=1, stage_no=0):
    return Match.objects.create(
        organization=t.organization, tournament=t, leaf_key=leaf,
        stage=stage, stage_no=stage_no, round_no=round_no, match_no=no,
        group_label="", home_source={}, away_source={}, status="scheduled",
    )


def test_each_competition_counts_from_one():
    t = _tournament()
    b1 = _match(t, no=1)
    b2 = _match(t, no=2)
    g1 = _match(t, leaf=GIRLS, no=3)

    nos = fixture_numbers(t.id)
    assert nos[str(b1.id)] == 1
    assert nos[str(b2.id)] == 2
    # The girls' first match is M1, not M3 — a pointer names a match in its
    # own competition, and per category the last number IS the category size.
    assert nos[str(g1.id)] == 1


def test_order_is_the_draw_not_the_row_order():
    t = _tournament()
    # Handed over out of order, exactly as a REST list can arrive.
    later = _match(t, round_no=2, no=9)
    earlier = _match(t, round_no=1, no=4)
    mid = _match(t, round_no=1, no=7)

    nos = fixture_numbers(t.id)
    assert [nos[str(m.id)] for m in (earlier, mid, later)] == [1, 2, 3]


def test_group_stage_precedes_the_knockout_of_the_same_competition():
    t = _tournament()
    ko = _match(t, stage="knockout", round_no=1, no=20)
    grp = _match(t, stage="group", round_no=1, no=1)

    nos = fixture_numbers(t.id)
    assert nos[str(grp.id)] < nos[str(ko.id)]


def test_a_deleted_match_holds_no_number():
    t = _tournament()
    gone = _match(t, no=1)
    live = _match(t, no=2)
    gone.deleted_at = timezone.now()
    gone.save(update_fields=["deleted_at"])

    nos = fixture_numbers(t.id)
    assert str(gone.id) not in nos
    # And the survivor moves up rather than keeping a gap.
    assert nos[str(live.id)] == 1


def test_number_rows_reads_dicts_and_instances_alike():
    t = _tournament()
    a = _match(t, no=1)
    b = _match(t, no=2)
    rows = [a, b]
    dicts = [
        {"id": m.id, "leaf_key": m.leaf_key, "stage": m.stage,
         "stage_no": m.stage_no, "round_no": m.round_no, "match_no": m.match_no}
        for m in rows
    ]
    assert number_rows(rows) == number_rows(dicts) == fixture_numbers(t.id)


def test_the_serializer_carries_the_fixture_number():
    t = _tournament()
    _match(t, no=1)
    second = _match(t, no=2)
    girls = _match(t, leaf=GIRLS, no=3)

    data = MatchSerializer(
        Match.objects.filter(tournament=t).select_related("tournament"), many=True
    ).data
    by_id = {row["id"]: row for row in data}
    assert by_id[str(second.id)]["fixture_no"] == 2
    assert by_id[str(girls.id)]["fixture_no"] == 1
    # `match_no` is untouched — it is still the draw's own emission sequence,
    # and the repair verbs and clone path key on it.
    assert by_id[str(girls.id)]["match_no"] == 3
