"""TDD — best-N-thirds qualification (deferred-formats increment N): groups →
knockout can append the best ``advance_best_thirds`` NEXT-PLACED teams
(position advance_per_group+1 across groups) to the qualifier pool before
cross-seeding. Ranking is normalized per game (points-per-game, then GD per
game, then GF per game) because group sizes may differ; unequal sizes emit a
named warning."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.generate import (
    generate_knockout_from_groups,
    generate_round_robin,
)
from apps.matches.models import Match
from apps.matches.services.scoring import record_score
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _tournament(admin, n: int, group_size: int):
    t = create_tournament(user=admin, name="Groups KO")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(n)],
    )
    generate_round_robin(tournament=t, group_size=group_size)
    return t


def _play(t, results: dict, admin) -> None:
    """Record every group match's score from an orientation-agnostic
    (name, name) -> (goals, goals) table."""
    for m in Match.objects.filter(
        tournament=t, stage="group", deleted_at__isnull=True
    ).select_related("home_team", "away_team"):
        pair = (m.home_team.name, m.away_team.name)
        if pair in results:
            hs, as_ = results[pair]
        else:
            as_, hs = results[(pair[1], pair[0])]
        record_score(match=m, home_score=hs, away_score=as_, by=admin)


# Group A (4 teams): T1 9pts; T2 4pts GD+1; T3 4pts GD0 -> third T3,
# 4 pts over 3 games (1.33 ppg). Group B (3 teams, a cycle): all 3 pts;
# GD T5 +2, T7 0, T6 -2 -> third T6, 3 pts over 2 games (1.5 ppg).
# Raw points favor T3; per-game normalization favors T6.
UNEQUAL_RESULTS = {
    ("T1", "T2"): (1, 0), ("T1", "T3"): (1, 0), ("T1", "T4"): (1, 0),
    ("T2", "T3"): (0, 0), ("T2", "T4"): (2, 0), ("T3", "T4"): (1, 0),
    ("T5", "T6"): (3, 0), ("T6", "T7"): (1, 0), ("T7", "T5"): (1, 0),
}


def test_best_third_ranked_per_game_across_unequal_groups():
    admin = _verified()
    t = _tournament(admin, 7, group_size=4)  # groups of 4 + 3
    _play(t, UNEQUAL_RESULTS, admin)

    warnings: list = []
    ko = generate_knockout_from_groups(
        tournament=t, advance_per_group=2, advance_best_thirds=1,
        warnings=warnings,
    )
    assert len(ko) == 4  # 5 qualifiers -> bracket of 8 with byes
    names = {
        team.name
        for m in ko
        for team in (m.home_team, m.away_team)
        if team is not None
    }
    assert "T6" in names   # 1.5 points per game beats...
    assert "T3" not in names  # ...4 raw points over 3 games (1.33 ppg)
    assert any(w["code"] == "best_thirds_unequal_groups" for w in warnings)


def test_best_next_placed_is_generic_over_advance_per_group():
    admin = _verified()
    t = _tournament(admin, 6, group_size=3)  # 2 equal groups of 3
    # A: T1 wins both; runner-up T2 takes 3 pts. B: T4 wins both; T5 and T6
    # draw each other and lose to T4 -> runner-up T5 has 1 pt.
    _play(t, {
        ("T1", "T2"): (1, 0), ("T1", "T3"): (2, 0), ("T2", "T3"): (5, 0),
        ("T4", "T5"): (1, 0), ("T4", "T6"): (2, 0), ("T5", "T6"): (0, 0),
    }, admin)

    warnings: list = []
    # advance_per_group=1 -> "thirds" are the RUNNERS-UP (position 2).
    ko = generate_knockout_from_groups(
        tournament=t, advance_per_group=1, advance_best_thirds=1,
        warnings=warnings,
    )
    names = {
        team.name
        for m in ko
        for team in (m.home_team, m.away_team)
        if team is not None
    }
    assert names == {"T1", "T4", "T2"}  # winners + the stronger runner-up
    assert len(ko) == 2  # 3 entrants -> semi (with bye) + final
    # Equal group sizes -> no normalization warning.
    assert not any(w["code"] == "best_thirds_unequal_groups" for w in warnings)


def test_too_few_next_placed_candidates_raises():
    admin = _verified()
    t = _tournament(admin, 4, group_size=2)  # 2 groups of 2 -> no thirds
    _play(t, {("T1", "T2"): (1, 0), ("T3", "T4"): (2, 0)}, admin)
    with pytest.raises(ValueError):
        generate_knockout_from_groups(
            tournament=t, advance_per_group=2, advance_best_thirds=1,
        )


def test_default_zero_keeps_existing_behavior():
    admin = _verified()
    t = _tournament(admin, 7, group_size=4)
    _play(t, UNEQUAL_RESULTS, admin)
    ko = generate_knockout_from_groups(tournament=t, advance_per_group=2)
    names = {
        team.name
        for m in ko
        for team in (m.home_team, m.away_team)
        if team is not None
    }
    assert names == {"T1", "T2", "T5", "T7"}  # top-2 per group only


def test_draw_config_validates_advance_best_thirds():
    from apps.fixtures.services.draw_config import merge_draw_config

    assert merge_draw_config({"advance_best_thirds": 2})["advance_best_thirds"] == 2
    for bad in (-1, "two", True):
        with pytest.raises(ValueError):
            merge_draw_config({"advance_best_thirds": bad})


def test_generate_api_reads_best_thirds_from_stored_draw_config():
    from apps.fixtures.services.draw_config import update_draw_config

    admin = _verified()
    t = _tournament(admin, 7, group_size=4)
    _play(t, UNEQUAL_RESULTS, admin)
    update_draw_config(
        tournament=t, leaf_key="*", partial={"advance_best_thirds": 1},
        by=admin, event_id=uuid.uuid4(),
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "knockout_from_groups"}, format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["generated"] == 4  # 5 qualifiers incl. the best third
    ko_teams = {
        team.name
        for m in Match.objects.filter(
            tournament=t, stage="knockout", deleted_at__isnull=True
        ).select_related("home_team", "away_team")
        for team in (m.home_team, m.away_team)
        if team is not None
    }
    assert "T6" in ko_teams
