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


def _verified(email: str = "org@test.local") -> "User":
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
