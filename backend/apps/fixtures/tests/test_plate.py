"""TDD · consolation plate (deferred-formats increment M): a second-chance
single-elimination drawn over the main bracket's round-1 LOSERS via the
``loser_of`` pointers advance.py already resolves (invariant 9). Round-1 byes
in the main bracket leave no loser to source, so the plate draws only over
round-1 matches pairing two concrete teams; under 2 sources it is skipped
with a named warning. Idempotent per (stage="plate", leaf)."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.advance import advance_from_match
from apps.fixtures.services.generate import generate_single_elimination
from apps.matches.models import Match
from apps.matches.services.scoring import record_score
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _bracket(admin, n: int = 4, **kwargs):
    t = create_tournament(user=admin, name="KO Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(n)],
    )
    matches = generate_single_elimination(tournament=t, teams=teams, **kwargs)
    return t, teams, matches


def test_plate_bracket_drawn_over_round1_losers():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 8, plate=True)
    main = [m for m in matches if m.stage == "knockout"]
    plate = sorted(
        (m for m in matches if m.stage == "plate"), key=lambda m: m.match_no
    )
    assert len(main) == 7  # 4 QF + 2 SF + final — main bracket unchanged
    assert len(plate) == 3  # 4 losers → 2 plate semis + plate final
    assert all(m.group_label == "Plate" for m in plate)

    r1_ids = {
        str(m.id) for m in main
        if m.round_no == 1 and m.home_team_id and m.away_team_id
    }
    plate_r1 = [m for m in plate if m.round_no == 1]
    assert len(plate_r1) == 2
    sources = [m.home_source for m in plate_r1] + [m.away_source for m in plate_r1]
    assert all(s["type"] == "loser_of" for s in sources)
    assert {s["match_id"] for s in sources} == r1_ids  # every loser, once

    plate_final = next(m for m in plate if m.round_no == 2)
    assert plate_final.home_source == {
        "type": "winner_of", "match_id": str(plate_r1[0].id)
    }
    assert plate_final.away_source == {
        "type": "winner_of", "match_id": str(plate_r1[1].id)
    }


def test_round1_losers_advance_into_plate():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 4, plate=True)
    semis = sorted(
        (m for m in matches if m.stage == "knockout" and m.round_no == 1),
        key=lambda m: m.match_no,
    )
    plate = next(m for m in matches if m.stage == "plate")
    assert plate.home_source == {"type": "loser_of", "match_id": str(semis[0].id)}
    assert plate.away_source == {"type": "loser_of", "match_id": str(semis[1].id)}

    record_score(match=semis[0], home_score=2, away_score=0, by=admin)
    advance_from_match(semis[0].id)  # on_commit doesn't fire inside the test txn
    plate.refresh_from_db()
    assert plate.home_team_id == semis[0].away_team_id  # semi-0 loser

    record_score(match=semis[1], home_score=0, away_score=3, by=admin)
    advance_from_match(semis[1].id)
    plate.refresh_from_db()
    assert plate.away_team_id == semis[1].home_team_id  # semi-1 loser


def test_plate_ignores_bye_pairs():
    admin = _verified()
    # 6 teams: top-2 seeds get byes — only 2 concrete round-1 matches exist,
    # so the plate is a single match over exactly those two losers.
    _t, _teams, matches = _bracket(admin, 6, plate=True)
    r1 = [m for m in matches if m.stage == "knockout" and m.round_no == 1]
    plate = [m for m in matches if m.stage == "plate"]
    assert len(r1) == 2
    assert len(plate) == 1
    assert {plate[0].home_source["match_id"], plate[0].away_source["match_id"]} \
        == {str(m.id) for m in r1}


def test_plate_skipped_with_warning_under_two_sources():
    admin = _verified()
    warnings: list = []
    # 3 teams: one concrete round-1 match — a plate over <2 sources is skipped
    _t, _teams, matches = _bracket(admin, 3, plate=True, warnings=warnings)
    assert not any(m.stage == "plate" for m in matches)
    assert any(w["code"] == "plate_skipped_insufficient_sources" for w in warnings)


def test_plate_default_off_idempotent_and_retrofit():
    admin = _verified()
    t, teams, matches = _bracket(admin, 4)
    assert not any(m.stage == "plate" for m in matches)  # default off

    # Retro-fit: a result that already landed backfills the plate pointer.
    semis = sorted(
        (m for m in matches if m.round_no == 1), key=lambda m: m.match_no
    )
    record_score(match=semis[0], home_score=1, away_score=0, by=admin)
    advance_from_match(semis[0].id)

    again = generate_single_elimination(tournament=t, teams=teams, plate=True)
    assert {m.id for m in matches} <= {m.id for m in again}
    plate = [m for m in again if m.stage == "plate"]
    assert len(plate) == 1
    plate[0].refresh_from_db()  # backfill ran after bulk_create
    assert plate[0].home_team_id == semis[0].away_team_id  # backfilled loser

    third = generate_single_elimination(tournament=t, teams=teams, plate=True)
    assert {m.id for m in third} == {m.id for m in again}  # idempotent per scope
    assert Match.objects.filter(
        tournament=t, stage="plate", deleted_at__isnull=True
    ).count() == 1


def test_generate_api_reads_plate_from_stored_draw_config():
    from apps.fixtures.services.draw_config import update_draw_config

    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "leaf_key": "football.u15", "sport": "football",
                "players": []} for i in range(4)],
    )
    update_draw_config(
        tournament=t, leaf_key="football.u15",
        partial={"format": "knockout", "plate": True},
        by=admin, event_id=uuid.uuid4(),
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"leaf_key": "football.u15"}, format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["generated"] == 4  # 2 semis + final + plate
    plate = Match.objects.filter(
        tournament=t, stage="plate", deleted_at__isnull=True
    )
    assert plate.count() == 1
    assert plate.get().group_label == "Football · U15 · Plate"  # <leaf> · Plate


def test_knockout_from_groups_passes_plate_through():
    from apps.fixtures.services.generate import (
        generate_knockout_from_groups,
        generate_round_robin,
    )

    admin = _verified()
    t = create_tournament(user=admin, name="Groups KO")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)],
    )
    generate_round_robin(tournament=t, group_size=4)
    for i, m in enumerate(
        Match.objects.filter(tournament=t, stage="group").order_by("match_no")
    ):
        record_score(match=m, home_score=(i % 4) + 1, away_score=i % 3, by=admin)

    ko = generate_knockout_from_groups(tournament=t, plate=True)
    assert sum(1 for m in ko if m.stage == "knockout") == 3  # 2 SF + final
    assert sum(1 for m in ko if m.stage == "plate") == 1  # SF losers' plate

    # Retro-fit path: the existing knockout is returned and the plate stays
    # idempotent per (stage, leaf).
    again = generate_knockout_from_groups(tournament=t, plate=True)
    assert {m.id for m in again} == {m.id for m in ko}


def test_draw_config_validates_plate():
    from apps.fixtures.services.draw_config import merge_draw_config

    assert merge_draw_config({"plate": True})["plate"] is True
    with pytest.raises(ValueError):
        merge_draw_config({"plate": "yes"})


def test_preview_includes_plate_plans():
    from apps.fixtures.services.preview import preview_fixtures

    admin = _verified()
    t, _teams, _m = (None, None, None)
    t = create_tournament(user=admin, name="Preview Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(4)],
    )
    body = preview_fixtures(
        tournament=t, draw={"format": "knockout", "plate": True},
        include_schedule=False,
    )
    plate = [m for m in body["matches"] if m["stage"] == "plate"]
    assert len(plate) == 1
    assert plate[0]["home"]["source"]["type"] == "loser_of"
    assert plate[0]["home"]["source"]["ref"].startswith("p")  # plan-ref pointer
    assert Match.objects.filter(tournament=t).count() == 0  # pure simulate
