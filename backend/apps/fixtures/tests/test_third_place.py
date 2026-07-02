"""TDD · third-place playoff (redesign spec §4.4): the first `loser_of`
emitter, advanced end-to-end through advance.py (which already resolves
loser_of pointers · invariant 9)."""
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


def test_third_place_match_emitted_with_loser_of_pointers():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 4, third_place=True)
    assert len(matches) == 4  # 2 semis + 3rd place + final
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    finals = sorted([m for m in matches if m.round_no == 2], key=lambda m: m.match_no)
    third, final = finals
    assert third.group_label == "3rd Place"
    assert third.match_no == final.match_no - 1  # placed BEFORE the final
    assert third.round_no == final.round_no
    assert third.home_source == {"type": "loser_of", "match_id": str(semis[0].id)}
    assert third.away_source == {"type": "loser_of", "match_id": str(semis[1].id)}
    assert final.group_label == ""  # final unchanged


def test_semifinal_losers_advance_into_third_place_match():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 4, third_place=True)
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    third = next(m for m in matches if m.group_label == "3rd Place")
    final = next(m for m in matches if m.round_no == 2 and m.group_label == "")

    record_score(match=semis[0], home_score=2, away_score=0, by=admin)
    advance_from_match(semis[0].id)  # on_commit doesn't fire inside the test txn
    third.refresh_from_db(); final.refresh_from_db()
    assert third.home_team_id == semis[0].away_team_id   # semi-0 loser
    assert final.home_team_id == semis[0].home_team_id   # semi-0 winner

    record_score(match=semis[1], home_score=0, away_score=3, by=admin)
    advance_from_match(semis[1].id)
    third.refresh_from_db(); final.refresh_from_db()
    assert third.away_team_id == semis[1].home_team_id   # semi-1 loser
    assert final.away_team_id == semis[1].away_team_id   # semi-1 winner


def test_no_third_place_without_two_semifinals():
    admin = _verified()
    # 3 teams: one semi + final (bye) — the lone semi loser IS 3rd; no playoff
    _t, _teams, matches = _bracket(admin, 3, third_place=True)
    assert len(matches) == 2
    assert not any(m.group_label == "3rd Place" for m in matches)
    # 2 teams: just a final
    admin2 = _verified("b@test.local")
    _t2, _teams2, m2 = _bracket(admin2, 2, third_place=True)
    assert len(m2) == 1


def test_third_place_default_off_and_idempotent():
    admin = _verified()
    t, teams, matches = _bracket(admin, 4)
    assert len(matches) == 3  # default third_place=False — zero behavior change
    again = generate_single_elimination(tournament=t, teams=teams, third_place=True)
    assert {m.id for m in again} == {m.id for m in matches}  # idempotent per scope


def test_eight_team_bracket_third_place_sources_are_the_semis():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 8, third_place=True)
    assert len(matches) == 8  # 4 QF + 2 SF + 3rd place + final
    semis = sorted([m for m in matches if m.round_no == 2], key=lambda m: m.match_no)
    third = next(m for m in matches if m.group_label == "3rd Place")
    assert third.round_no == 3
    assert third.home_source == {"type": "loser_of", "match_id": str(semis[0].id)}
    assert third.away_source == {"type": "loser_of", "match_id": str(semis[1].id)}


def test_generate_api_reads_third_place_from_stored_draw_config():
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
        partial={"format": "knockout", "third_place": True},
        by=admin, event_id=uuid.uuid4(),
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"leaf_key": "football.u15"}, format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["generated"] == 4
    # The label is prefixed with the competition now ("Football — … — 3rd
    # Place"), so match on the suffix rather than the bare string.
    assert Match.objects.filter(
        tournament=t, group_label__endswith="3rd Place", deleted_at__isnull=True
    ).count() == 1


def test_knockout_from_groups_passes_third_place_through():
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

    ko = generate_knockout_from_groups(tournament=t, third_place=True)
    assert len(ko) == 4  # 2 semis + 3rd place + final
    assert sum(1 for m in ko if m.group_label == "3rd Place") == 1
