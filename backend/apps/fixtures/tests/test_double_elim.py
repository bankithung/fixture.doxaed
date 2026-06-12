"""TDD — double elimination (deferred-formats increment Q). Winners bracket =
the existing single-elim planner (stage="knockout"); a losers bracket
(stage="losers") is wired entirely from ``loser_of`` pointers advance.py
already resolves (invariant 9): LB round 1 pairs the WB round-1 losers, each
later WB round's losers FOLD IN (reversed order, the standard crossing that
delays rematches), with a minor LB round between fold-ins. The grand final
(stage="grand_final") meets the WB winner and the LB winner ONCE — the
bracket reset is deliberately skipped in v1. ``third_place`` is ignored: the
LB final IS the third-place decider (its loser finishes 3rd)."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.advance import advance_from_match
from apps.fixtures.services.generate import generate_double_elimination
from apps.matches.models import Match
from apps.matches.services.scoring import record_score
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _bracket(admin, n: int, **kwargs):
    t = create_tournament(user=admin, name="DE Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(n)],
    )
    matches = generate_double_elimination(tournament=t, teams=teams, **kwargs)
    return t, teams, matches


def _by_stage_round(matches):
    out: dict[tuple, list[Match]] = {}
    for m in matches:
        out.setdefault((m.stage, m.round_no), []).append(m)
    for v in out.values():
        v.sort(key=lambda m: m.match_no)
    return out


def _win_home(admin, m: Match) -> None:
    record_score(match=m, home_score=1, away_score=0, by=admin)
    advance_from_match(m.id)  # on_commit doesn't fire inside the test txn


def test_eight_team_structure_wb_lb_grand_final():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 8)
    assert len(matches) == 14  # 2n-2: 7 WB + 6 LB + 1 grand final (no reset)
    sr = _by_stage_round(matches)
    assert len(sr[("knockout", 1)]) == 4  # WB untouched: QFs
    assert len(sr[("knockout", 2)]) == 2  # WB semis
    assert len(sr[("knockout", 3)]) == 1  # WB final
    assert len(sr[("losers", 1)]) == 2
    assert len(sr[("losers", 2)]) == 2
    assert len(sr[("losers", 3)]) == 1
    assert len(sr[("losers", 4)]) == 1
    assert len(sr[("grand_final", 1)]) == 1

    qf = sr[("knockout", 1)]
    sf = sr[("knockout", 2)]
    final = sr[("knockout", 3)][0]
    lb1, lb2 = sr[("losers", 1)], sr[("losers", 2)]
    lb3, lb_final = sr[("losers", 3)][0], sr[("losers", 4)][0]
    gf = sr[("grand_final", 1)][0]

    # LB round 1: adjacent WB QF losers pair up
    assert lb1[0].home_source == {"type": "loser_of", "match_id": str(qf[0].id)}
    assert lb1[0].away_source == {"type": "loser_of", "match_id": str(qf[1].id)}
    assert lb1[1].home_source == {"type": "loser_of", "match_id": str(qf[2].id)}
    assert lb1[1].away_source == {"type": "loser_of", "match_id": str(qf[3].id)}
    # LB round 2: WB semi losers fold in REVERSED (crossing halves so a WB
    # rematch can only happen late)
    assert lb2[0].home_source == {"type": "winner_of", "match_id": str(lb1[0].id)}
    assert lb2[0].away_source == {"type": "loser_of", "match_id": str(sf[1].id)}
    assert lb2[1].home_source == {"type": "winner_of", "match_id": str(lb1[1].id)}
    assert lb2[1].away_source == {"type": "loser_of", "match_id": str(sf[0].id)}
    # LB round 3 (minor): LB round-2 winners meet
    assert lb3.home_source == {"type": "winner_of", "match_id": str(lb2[0].id)}
    assert lb3.away_source == {"type": "winner_of", "match_id": str(lb2[1].id)}
    # LB final: WB final loser folds in — its loser is THIRD PLACE, which is
    # why third_place is ignored for double elim
    assert lb_final.home_source == {"type": "winner_of", "match_id": str(lb3.id)}
    assert lb_final.away_source == {"type": "loser_of", "match_id": str(final.id)}
    # Grand final: WB winner vs LB winner, once (no bracket reset in v1)
    assert gf.group_label == "Grand Final"
    assert gf.home_source == {"type": "winner_of", "match_id": str(final.id)}
    assert gf.away_source == {"type": "winner_of", "match_id": str(lb_final.id)}


def test_eight_team_e2e_every_loser_ripples_into_the_right_lb_slot():
    admin = _verified()
    t, _teams, matches = _bracket(admin, 8)
    sr = _by_stage_round(matches)
    qf, sf = sr[("knockout", 1)], sr[("knockout", 2)]
    final = sr[("knockout", 3)][0]
    lb1, lb2 = sr[("losers", 1)], sr[("losers", 2)]
    lb3, lb_final = sr[("losers", 3)][0], sr[("losers", 4)][0]
    gf = sr[("grand_final", 1)][0]

    def names(m: Match) -> tuple:
        m.refresh_from_db()
        return (
            m.home_team.name if m.home_team else None,
            m.away_team.name if m.away_team else None,
        )

    # Seeded bracket order over T1..T8: QFs (T1,T8) (T4,T5) (T2,T7) (T3,T6)
    assert [names(m) for m in qf] == [
        ("T1", "T8"), ("T4", "T5"), ("T2", "T7"), ("T3", "T6"),
    ]
    for m in qf:
        _win_home(admin, m)
    # every QF loser lands in its LB round-1 slot
    assert names(lb1[0]) == ("T8", "T5")
    assert names(lb1[1]) == ("T7", "T6")
    assert names(sf[0]) == ("T1", "T4")
    assert names(sf[1]) == ("T2", "T3")

    for m in (*sf, *lb1):
        _win_home(admin, m)
    # WB semi losers cross into the OPPOSITE LB half
    assert names(lb2[0]) == ("T8", "T3")  # LB top half hosts SF2's loser
    assert names(lb2[1]) == ("T7", "T4")  # LB bottom half hosts SF1's loser
    for m in lb2:
        _win_home(admin, m)
    assert names(lb3) == ("T8", "T7")
    _win_home(admin, lb3)

    assert names(final) == ("T1", "T2")
    _win_home(admin, final)
    # the WB final loser drops to the LB final…
    assert names(lb_final) == ("T8", "T2")
    _win_home(admin, lb_final)
    # …and the LB winner reaches the grand final against the WB winner
    assert names(gf) == ("T1", "T8")
    _win_home(admin, gf)
    gf.refresh_from_db()
    assert gf.winner_id == gf.home_team_id  # champion decided — single GF


def test_byes_forward_lb_lanes_six_teams():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 6)
    assert len(matches) == 10  # 2n-2 holds with byes
    sr = _by_stage_round(matches)
    # WB: 2 concrete R1 matches (2 byes), 2 semis, final
    assert len(sr[("knockout", 1)]) == 2
    # bye pairs leave no round-1 loser: LB round 1 is empty — both R1 losers
    # FORWARD into LB round 2 against the WB semi losers (reversed)
    assert ("losers", 1) not in sr
    lb2 = sr[("losers", 2)]
    r1, sf = sr[("knockout", 1)], sr[("knockout", 2)]
    assert len(lb2) == 2
    assert lb2[0].home_source == {"type": "loser_of", "match_id": str(r1[0].id)}
    assert lb2[0].away_source == {"type": "loser_of", "match_id": str(sf[1].id)}
    assert lb2[1].home_source == {"type": "loser_of", "match_id": str(r1[1].id)}
    assert lb2[1].away_source == {"type": "loser_of", "match_id": str(sf[0].id)}
    assert len(sr[("losers", 3)]) == 1
    assert len(sr[("losers", 4)]) == 1
    assert len(sr[("grand_final", 1)]) == 1


def test_three_teams_minimum_and_two_raises():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 3)
    assert len(matches) == 4  # 2n-2: WB semi + WB final, LB final, grand final
    sr = _by_stage_round(matches)
    assert len(sr[("knockout", 1)]) == 1 and len(sr[("knockout", 2)]) == 1
    assert len(sr[("losers", 2)]) == 1  # forwarded R1 loser vs WB final loser
    assert len(sr[("grand_final", 1)]) == 1

    with pytest.raises(ValueError):
        _bracket(_verified("two@test.local"), 2)


def test_third_place_flag_ignored_lb_final_decides_third():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 8, third_place=True)
    # no 3rd-place playoff is emitted — the LB final's loser IS third place
    assert not any(m.group_label == "3rd Place" for m in matches)
    assert len(matches) == 14


def test_idempotent_per_scope():
    admin = _verified()
    t, teams, matches = _bracket(admin, 8)
    again = generate_double_elimination(tournament=t, teams=teams)
    assert {m.id for m in again} == {m.id for m in matches}
    assert Match.objects.filter(tournament=t, deleted_at__isnull=True).count() == 14


def test_generate_api_reads_double_elim_from_stored_draw_config():
    from apps.fixtures.services.draw_config import update_draw_config

    admin = _verified()
    t = create_tournament(user=admin, name="API DE")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "leaf_key": "football.u15",
                "sport": "football", "players": []} for i in range(8)],
    )
    update_draw_config(
        tournament=t, leaf_key="football.u15",
        partial={"format": "double_elim"},
        by=admin, event_id=uuid.uuid4(),
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"leaf_key": "football.u15"}, format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["generated"] == 14
    assert r.json()["format"] == "double_elim"
    by_stage = {
        m.stage for m in Match.objects.filter(tournament=t, deleted_at__isnull=True)
    }
    assert by_stage == {"knockout", "losers", "grand_final"}
    assert all(
        m.leaf_key == "football.u15" and m.sport == "football"
        for m in Match.objects.filter(tournament=t, deleted_at__isnull=True)
    )


def test_draw_config_validates_double_elim():
    from apps.fixtures.services.draw_config import merge_draw_config

    assert merge_draw_config({"format": "double_elim"})["format"] == "double_elim"


def test_preview_plans_double_elim_without_persisting():
    from apps.fixtures.services.preview import preview_fixtures

    admin = _verified()
    t = create_tournament(user=admin, name="Preview DE")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)],
    )
    body = preview_fixtures(
        tournament=t, draw={"format": "double_elim"}, include_schedule=False,
    )
    stages = [m["stage"] for m in body["matches"]]
    assert stages.count("knockout") == 7
    assert stages.count("losers") == 6
    assert stages.count("grand_final") == 1
    gf = next(m for m in body["matches"] if m["stage"] == "grand_final")
    assert gf["home"]["source"]["type"] == "winner_of"
    assert gf["away"]["source"]["type"] == "winner_of"
    assert Match.objects.filter(tournament=t).count() == 0  # pure simulate
