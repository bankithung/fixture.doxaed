"""TDD — double round-robin (redesign spec §4.2): legs=2 emits a mirrored
second cycle (home/away swapped, round_no continuing), and
rules.small_group_double_rr auto-doubles only the groups at/under the
threshold."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.generate import (
    generate_round_robin,
    generate_round_robin_by_category,
)
from apps.matches.models import Match
from apps.matches.services.scoring import record_score
from apps.matches.services.standings import compute_standings
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _register_n_teams(t, n: int, leaf_key: str = "", sport: str = ""):
    return register_school(
        tournament=t,
        school_name="Pool",
        teams=[
            {"name": f"Team {i + 1}", "leaf_key": leaf_key, "sport": sport,
             "players": []}
            for i in range(n)
        ],
    )


def test_legs_2_mirrors_every_pair_with_sides_swapped():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    _register_n_teams(t, 4)

    matches = generate_round_robin(tournament=t, group_size=4, legs=2)

    assert len(matches) == 12  # C(4,2) * 2
    first = [m for m in matches if m.round_no <= 3]
    second = [m for m in matches if m.round_no > 3]
    assert len(first) == len(second) == 6
    assert {m.round_no for m in second} == {4, 5, 6}  # round_no continues
    # inverted mirror: each first-cycle (home, away) appears swapped in the
    # second cycle, exactly once, in the same relative round.
    mirrored = {(m.away_team_id, m.home_team_id, m.round_no + 3) for m in first}
    assert {(m.home_team_id, m.away_team_id, m.round_no) for m in second} == mirrored


def test_legs_default_single_cycle_unchanged():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    _register_n_teams(t, 4)
    assert len(generate_round_robin(tournament=t, group_size=4)) == 6


def test_by_category_supports_legs():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    _register_n_teams(t, 3)

    matches = generate_round_robin_by_category(tournament=t, legs=2)
    assert len(matches) == 6  # C(3,2) * 2


def test_small_group_double_rr_doubles_only_small_groups():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    t.rules = {"small_group_double_rr": {"max_size": 3}}
    t.save(update_fields=["rules"])
    _register_n_teams(t, 7)  # group_size 4 -> groups of 4 and 3

    matches = generate_round_robin(tournament=t, group_size=4)

    by_group: dict[str, list] = {}
    for m in matches:
        by_group.setdefault(m.group_label, []).append(m)
    sizes = sorted(len(v) for v in by_group.values())
    # 4-team group: single cycle C(4,2)=6; 3-team group: doubled C(3,2)*2=6
    assert sizes == [6, 6]
    three_group = next(
        v for v in by_group.values()
        if len({m.home_team_id for m in v} | {m.away_team_id for m in v}) == 3
    )
    pair_counts: dict[frozenset, int] = {}
    for m in three_group:
        pair_counts[frozenset((m.home_team_id, m.away_team_id))] = (
            pair_counts.get(frozenset((m.home_team_id, m.away_team_id)), 0) + 1
        )
    assert set(pair_counts.values()) == {2}  # every pair met twice


def test_standings_aggregate_both_legs():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    _register_n_teams(t, 3)
    generate_round_robin(tournament=t, group_size=3, legs=2)

    for m in Match.objects.filter(tournament=t).order_by("match_no"):
        record_score(match=m, home_score=1, away_score=0, by=admin)
    rows = compute_standings(t)
    assert [r["P"] for r in rows] == [4, 4, 4]  # 3 teams x double RR
    assert sum(r["Pts"] for r in rows) == 18    # 6 matches x 3 pts each


def test_small_group_double_rr_is_a_whitelisted_rules_key():
    from apps.tournaments.services.rules import DEFAULT_RULES, merge_rules

    assert DEFAULT_RULES["small_group_double_rr"] == {"max_size": 0}  # 0 = off
    merged = merge_rules({"small_group_double_rr": {"max_size": 3}})
    assert merged["small_group_double_rr"]["max_size"] == 3
    with pytest.raises(ValueError):
        merge_rules({"small_group_double_rr": {"bogus": 1}})


def test_generate_api_reads_legs_from_stored_draw_config():
    from apps.fixtures.services.draw_config import update_draw_config

    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    _register_n_teams(t, 4)
    update_draw_config(
        tournament=t, leaf_key="*", partial={"legs": 2}, by=admin,
        event_id=uuid.uuid4(),
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(f"/api/tournaments/{t.id}/generate-fixtures/", {}, format="json")
    assert r.status_code == 201, r.content
    assert r.json()["generated"] == 12
