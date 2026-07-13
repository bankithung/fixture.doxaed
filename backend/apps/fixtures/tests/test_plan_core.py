"""TDD · pure pairing core (redesign spec §4.1): plan_* functions return
MatchPlan dataclasses with ZERO DB writes; the generate_* wrappers persist
them with match_no/inputs_hash/idempotency exactly as before (the rest of the
fixtures suite proves zero behavior change). The preview endpoint will call
plan_* directly."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import (
    MatchPlan,
    plan_round_robin,
    plan_round_robin_pool,
    plan_single_elimination,
)
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _teams(n: int):
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    return register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1:02d}", "players": []} for i in range(n)],
    )


def test_plan_round_robin_writes_nothing_and_pairs_everyone():
    teams = _teams(10)
    before = Match.objects.count()

    plans = plan_round_robin(teams, group_size=5)

    assert Match.objects.count() == before  # pure — zero DB writes
    assert len(plans) == 20  # 2 groups x C(5,2)
    assert all(isinstance(p, MatchPlan) for p in plans)
    assert {p.group_label for p in plans} == {"Group A", "Group B"}
    assert all(p.stage == "group" for p in plans)
    assert all(p.home_team_id and p.away_team_id for p in plans)
    assert [p.ref for p in plans] == list(range(20))  # stable plan handles


def test_plan_round_robin_pool_single_bucket():
    teams = _teams(3)
    plans = plan_round_robin_pool(teams, label="U-14", legs=2)
    assert len(plans) == 6  # C(3,2) x 2 legs
    assert {p.group_label for p in plans} == {"U-14"}


def test_plan_single_elimination_uses_ref_pointers_not_match_ids():
    teams = _teams(4)
    before = Match.objects.count()

    plans = plan_single_elimination(teams, third_place=True)

    assert Match.objects.count() == before  # pure — zero DB writes
    assert len(plans) == 4
    semis = [p for p in plans if p.round_no == 1]
    third = next(p for p in plans if p.group_label == "3rd Place")
    final = next(p for p in plans if p.round_no == 2 and p.group_label == "")
    # cross-plan pointers are plan refs (no DB ids exist yet)
    assert final.home_source == {"type": "winner_of", "ref": semis[0].ref}
    assert final.away_source == {"type": "winner_of", "ref": semis[1].ref}
    assert third.home_source == {"type": "loser_of", "ref": semis[0].ref}
    assert third.away_source == {"type": "loser_of", "ref": semis[1].ref}
    # the 3rd-place plan precedes the final (match_no ordering on persist)
    assert plans.index(third) < plans.index(final)


def test_plan_single_elimination_label_prefix_names_every_match():
    """A knockout has no group_label by default → the schedule showed a bare
    "R1". With a label_prefix every bracket match carries the competition name
    (owner ask 2026-06-27: "i cannt see tt")."""
    teams = _teams(4)
    plans = plan_single_elimination(
        teams, third_place=True,
        label_prefix="Table Tennis · u-14 · boys · 1v1 · ",
    )
    bracket = "Table Tennis · u-14 · boys · 1v1"
    third = next(p for p in plans if p.group_label.endswith("3rd Place"))
    assert third.group_label == f"{bracket} · 3rd Place"
    assert all(
        p.group_label == bracket
        for p in plans
        if not p.group_label.endswith("3rd Place")
    )


def test_plan_single_elimination_byes_carry_team_sources():
    teams = _teams(3)
    plans = plan_single_elimination(teams)
    final = next(p for p in plans if p.round_no == 2)
    assert final.home_source == {"type": "team", "team_id": str(teams[0].id)}
    assert final.home_team_id == teams[0].id
    assert final.away_source["type"] == "winner_of"


def test_wrapper_resolves_refs_into_real_match_ids():
    from apps.fixtures.services.generate import generate_single_elimination

    teams = _teams(4)
    t = teams[0].tournament
    matches = generate_single_elimination(tournament=t, teams=teams, third_place=True)
    semis = sorted([m for m in matches if m.round_no == 1], key=lambda m: m.match_no)
    third = next(m for m in matches if m.group_label == "3rd Place")
    assert third.home_source == {"type": "loser_of", "match_id": str(semis[0].id)}
    assert "ref" not in third.home_source  # refs never leak into rows


# ------------------------------------------------------------ pair_all byes
def test_pair_all_20_teams_full_first_round():
    """bye_policy=pair_all (owner ask 2026-07-13): a 20-team field plays a
    full 10-match round 1; byes only appear when a round goes odd."""
    teams = _teams(20)
    plans = plan_single_elimination(teams, bye_policy="pair_all")
    by_round: dict[int, int] = {}
    for p in plans:
        by_round[p.round_no] = by_round.get(p.round_no, 0) + 1
    # 20 -> 10 -> 5 -> (2 + bye) -> (1 + bye) -> final
    assert by_round == {1: 10, 2: 5, 3: 2, 4: 1, 5: 1}
    assert len(plans) == 19
    # Round 1 pairs every team exactly once — no team missing, none doubled.
    r1_ids = [
        tid
        for p in plans
        if p.round_no == 1
        for tid in (p.home_team_id, p.away_team_id)
    ]
    assert sorted(map(str, r1_ids)) == sorted(str(t.id) for t in teams)


def test_pair_all_byes_forward_winner_pointers_across_rounds():
    """A byed slot re-enters a LATER round as a winner_of pointer to its
    earlier match (no phantom matches for byes)."""
    teams = _teams(5)  # 5 -> (2 + bye) -> (1 + bye) -> final: 4 matches
    plans = plan_single_elimination(teams, bye_policy="pair_all")
    assert [p.round_no for p in plans] == [1, 1, 2, 3]
    final = plans[-1]
    # One final side comes from round 2, the other rode a bye from round 1.
    refs = {final.home_source["ref"], final.away_source["ref"]}
    feeder_rounds = sorted(plans[r].round_no for r in refs)
    assert feeder_rounds == [1, 2]


def test_pair_all_third_place_meets_the_final_feeders_losers():
    teams = _teams(20)
    plans = plan_single_elimination(
        teams, bye_policy="pair_all", third_place=True,
    )
    assert len(plans) == 20
    third = [p for p in plans if "3rd Place" in (p.group_label or "")]
    assert len(third) == 1
    final = plans[-1]
    assert {third[0].home_source["ref"], third[0].away_source["ref"]} == {
        final.home_source["ref"],
        final.away_source["ref"],
    }
    assert third[0].home_source["type"] == "loser_of"


def test_pair_all_default_policy_unchanged():
    """Without the flag the classic padded bracket is byte-identical."""
    teams = _teams(20)
    classic = plan_single_elimination(teams)
    explicit = plan_single_elimination(teams, bye_policy="seeded_byes")
    assert [
        (p.round_no, p.home_team_id, p.away_team_id) for p in classic
    ] == [(p.round_no, p.home_team_id, p.away_team_id) for p in explicit]
    by_round: dict[int, int] = {}
    for p in classic:
        by_round[p.round_no] = by_round.get(p.round_no, 0) + 1
    assert by_round == {1: 4, 2: 8, 3: 4, 4: 2, 5: 1}
