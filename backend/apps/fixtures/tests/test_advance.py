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


def _verified(email: str = "org@test.local") -> User:
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
    final = next(m for m in matches if m.round_no == 2)
    assert final.home_source["type"] == "winner_of"
    assert final.away_source["type"] == "winner_of"
    assert final.home_team_id is None  # unresolved until semis finish


def test_scoring_semis_advances_winners_into_final():
    admin = _verified()
    _t, _teams, matches = _bracket(admin, 4)
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    final = next(m for m in matches if m.round_no == 2)

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

    # FIFA-style crossing: each semi pairs teams from DIFFERENT groups (the
    # interleaved seed list used to collapse into same-group rematches).
    group_of = {}
    for gm in Match.objects.filter(tournament=t, stage="group"):
        group_of[gm.home_team_id] = gm.group_label
        group_of[gm.away_team_id] = gm.group_label
    for semi in r1:
        assert group_of[semi.home_team_id] != group_of[semi.away_team_id]


def test_knockout_from_groups_winners_only():
    """advance_per_group=1 → only group winners enter the bracket."""
    from apps.fixtures.services.generate import (
        generate_knockout_from_groups,
        generate_round_robin,
    )
    from apps.matches.models import Match
    from apps.matches.services.scoring import record_score
    from apps.matches.services.standings import compute_standings

    admin = _verified()
    t = create_tournament(user=admin, name="Winners KO")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)],
    )
    generate_round_robin(tournament=t, group_size=4)
    for i, m in enumerate(Match.objects.filter(tournament=t, stage="group").order_by("match_no")):
        record_score(match=m, home_score=(i % 4) + 1, away_score=i % 3, by=admin)

    ko = generate_knockout_from_groups(tournament=t, advance_per_group=1)
    assert len(ko) == 1  # 2 winners -> a single final
    final = ko[0]
    winners = {
        compute_standings(t, group_label=g)[0]["team_id"]
        for g in Match.objects.filter(tournament=t, stage="group")
        .values_list("group_label", flat=True).distinct()
    }
    assert {str(final.home_team_id), str(final.away_team_id)} == winners


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


@pytest.mark.django_db(transaction=True)
def test_parallel_semifinal_finalization_fills_both_final_slots():
    """C6 regression: two feeders finalizing concurrently must both land.

    advance_from_match used to read dependents unlocked and save BOTH team
    fields, so the slower pass clobbered the faster pass's fill back to NULL.
    Now dependents are select_for_update-locked and only the resolved side is
    written, so concurrent passes serialize instead of racing.
    """
    import threading

    from django.db import connections

    from apps.matches.models import Match, MatchStatus

    admin = _verified()
    _t, _teams, matches = _bracket(admin, 4)
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    final = next(m for m in matches if m.round_no == 2)

    # Finalize both semis with direct updates (no service-level on_commit
    # advancement), so the two advance passes below race on a final whose
    # slots are BOTH still empty.
    Match.objects.filter(id=semis[0].id).update(
        home_score=2, away_score=0, status=MatchStatus.COMPLETED
    )
    Match.objects.filter(id=semis[1].id).update(
        home_score=0, away_score=3, status=MatchStatus.COMPLETED
    )

    barrier = threading.Barrier(2, timeout=10)
    errors: list[Exception] = []

    def run(match_id):
        try:
            barrier.wait()
            advance_from_match(match_id)
        except Exception as exc:  # pragma: no cover - surfaced via assert
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=run, args=(s.id,)) for s in semis]
    for th in threads:
        th.start()
    for th in threads:
        th.join(timeout=30)

    assert not errors
    final.refresh_from_db()
    assert final.home_team_id == semis[0].home_team_id  # semi-0 home won
    assert final.away_team_id == semis[1].away_team_id  # semi-1 away won


@pytest.mark.django_db
def test_stalled_slots_detects_silent_advancement_failures():
    """P3: a dependent whose feeder is final but whose slot stayed empty is
    reported; pending feeders and walkover loser_of slots are not."""
    from apps.fixtures.services.advance import stalled_slots
    from apps.matches.models import Match, MatchStatus as MS

    admin = _verified("stalled@test.local")
    t = create_tournament(user=admin, name="Stalled Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"S{i + 1}", "players": []} for i in range(4)],
    )
    a, b, c, d = teams
    feeder_done = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MS.COMPLETED, home_score=2, away_score=0,
    )
    feeder_pending = Match.objects.create(
        organization=t.organization, tournament=t, home_team=c, away_team=d,
    )
    dep = Match.objects.create(
        organization=t.organization, tournament=t, stage="knockout",
        home_source={"type": "winner_of", "match_id": str(feeder_done.id)},
        away_source={"type": "winner_of", "match_id": str(feeder_pending.id)},
    )
    out = stalled_slots(t)
    assert [
        (r["match_id"], r["side"], r["feeder_status"]) for r in out
    ] == [(str(dep.id), "home", "completed")]

    # A walkover loser_of slot is LEGITIMATELY empty (withdrawal never
    # occupies the loser slot) — not stalled.
    wo = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MS.WALKOVER, home_score=2, away_score=0,
    )
    Match.objects.create(
        organization=t.organization, tournament=t, stage="knockout",
        home_source={"type": "loser_of", "match_id": str(wo.id)},
    )
    assert len(stalled_slots(t)) == 1  # unchanged


@pytest.mark.django_db
def test_advancement_refire_endpoint_repairs_stalled_slots():
    from rest_framework.test import APIClient

    from apps.fixtures.services.advance import stalled_slots
    from apps.matches.models import Match, MatchStatus as MS

    admin = _verified("refire@test.local")
    t = create_tournament(user=admin, name="Refire Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "R1", "players": []}, {"name": "R2", "players": []}],
    )
    a, b = teams
    feeder = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MS.COMPLETED, home_score=2, away_score=0,
    )
    dep = Match.objects.create(
        organization=t.organization, tournament=t, stage="knockout",
        home_source={"type": "winner_of", "match_id": str(feeder.id)},
    )
    assert len(stalled_slots(t)) == 1

    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/tournaments/{t.id}/advancement:refire/")
    assert r.status_code == 200
    assert r.data["stalled_before"] == 1
    assert r.data["stalled_after"] == 0
    dep.refresh_from_db()
    assert dep.home_team_id == a.id  # the winner arrived
