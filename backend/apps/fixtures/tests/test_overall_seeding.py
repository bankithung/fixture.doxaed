"""TDD — bracket re-seed from standings (deferred-formats increment O):
draw_config ``knockout_seeding="cross"`` (default, positional cross-seeding —
current behavior) | ``"overall"`` — qualifiers seeded by their aggregate
record across ALL groups (the same per-game normalized metric increment N
uses), strength-ordered, with the existing same-group round-1 repair pass
still applied."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.generate import (
    generate_knockout_from_groups,
    generate_round_robin,
    plan_knockout_qualifiers,
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


def _played(admin, results: dict, n: int = 6, group_size: int = 3):
    t = create_tournament(user=admin, name="Groups KO")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(n)],
    )
    generate_round_robin(tournament=t, group_size=group_size)
    for m in Match.objects.filter(
        tournament=t, stage="group", deleted_at__isnull=True
    ).select_related("home_team", "away_team"):
        pair = (m.home_team.name, m.away_team.name)
        if pair in results:
            hs, as_ = results[pair]
        else:
            as_, hs = results[(pair[1], pair[0])]
        record_score(match=m, home_score=hs, away_score=as_, by=admin)
    return t


# Two groups of 3 — A: T1 6pts (+3), T2 3pts (0). B: T4 6pts (+6), T5 3pts
# (+3). Overall per-game order: T4 (3.0 ppg, +3.0 gdpg) > T1 (3.0, +1.5)
# > T5 (1.5, +1.5) > T2 (1.5, 0.0) — group B's winner outranks group A's.
RESULTS = {
    ("T1", "T2"): (1, 0), ("T1", "T3"): (2, 0), ("T2", "T3"): (1, 0),
    ("T4", "T5"): (1, 0), ("T4", "T6"): (5, 0), ("T5", "T6"): (4, 0),
}


def test_overall_seed_list_is_cross_group_strength_order():
    admin = _verified()
    t = _played(admin, RESULTS)
    seeds = plan_knockout_qualifiers(
        t, advance_per_group=2, knockout_seeding="overall",
    )
    assert [tm.name for tm in seeds] == ["T4", "T1", "T5", "T2"]
    # Default "cross" stays positional: winners layer then runners-up.
    cross = plan_knockout_qualifiers(t, advance_per_group=2)
    assert [tm.name for tm in cross] == ["T1", "T4", "T2", "T5"]


def test_overall_bracket_top_seed_is_the_strongest_record():
    admin = _verified()
    t = _played(admin, RESULTS)
    ko = generate_knockout_from_groups(
        tournament=t, advance_per_group=2, knockout_seeding="overall",
    )
    r1 = sorted(
        (m for m in ko if m.round_no == 1), key=lambda m: m.match_no
    )
    assert r1[0].home_team.name == "T4"  # overall #1, not group-A's winner
    pairings = {
        frozenset((m.home_team.name, m.away_team.name)) for m in r1
    }
    assert pairings == {frozenset(("T4", "T2")), frozenset(("T1", "T5"))}


def test_overall_still_repairs_same_group_round1_pairs():
    admin = _verified()
    # Strength order T1 (A), T4 (B), T5 (B), T2 (A) seats T1 vs T2 in round 1
    # — a same-group rematch the existing repair pass must fix.
    t = _played(admin, {
        ("T1", "T2"): (4, 0), ("T1", "T3"): (4, 0), ("T2", "T3"): (1, 0),
        ("T4", "T5"): (1, 0), ("T4", "T6"): (2, 0), ("T5", "T6"): (3, 0),
    })
    ko = generate_knockout_from_groups(
        tournament=t, advance_per_group=2, knockout_seeding="overall",
    )
    group_of = {"T1": "A", "T2": "A", "T3": "A", "T4": "B", "T5": "B", "T6": "B"}
    for m in (m for m in ko if m.round_no == 1):
        assert group_of[m.home_team.name] != group_of[m.away_team.name]


def test_overall_ranks_best_thirds_into_the_pool():
    admin = _verified()
    # Increment-N fixture: groups of 4 + 3; best third T6 carries 1.5 ppg —
    # under "overall" it seeds ABOVE the 1.33-ppg runner-up T2.
    t = _played(admin, {
        ("T1", "T2"): (1, 0), ("T1", "T3"): (1, 0), ("T1", "T4"): (1, 0),
        ("T2", "T3"): (0, 0), ("T2", "T4"): (2, 0), ("T3", "T4"): (1, 0),
        ("T5", "T6"): (3, 0), ("T6", "T7"): (1, 0), ("T7", "T5"): (1, 0),
    }, n=7, group_size=4)
    seeds = plan_knockout_qualifiers(
        t, advance_per_group=2, advance_best_thirds=1,
        knockout_seeding="overall",
    )
    assert [tm.name for tm in seeds] == ["T1", "T5", "T7", "T6", "T2"]


def test_unknown_knockout_seeding_rejected():
    from apps.fixtures.services.draw_config import merge_draw_config

    admin = _verified()
    t = _played(admin, RESULTS)
    with pytest.raises(ValueError):
        plan_knockout_qualifiers(t, knockout_seeding="snake")
    with pytest.raises(ValueError):
        merge_draw_config({"knockout_seeding": "snake"})
    assert merge_draw_config({"knockout_seeding": "overall"}) \
        == {"knockout_seeding": "overall"}


def test_generate_api_reads_knockout_seeding_from_stored_draw_config():
    from apps.fixtures.services.draw_config import update_draw_config

    admin = _verified()
    t = _played(admin, RESULTS)
    update_draw_config(
        tournament=t, leaf_key="*", partial={"knockout_seeding": "overall"},
        by=admin, event_id=uuid.uuid4(),
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "knockout_from_groups"}, format="json",
    )
    assert r.status_code == 201, r.content
    first = Match.objects.filter(
        tournament=t, stage="knockout", round_no=1, deleted_at__isnull=True
    ).select_related("home_team").order_by("match_no").first()
    assert first.home_team.name == "T4"  # overall #1 took the top seed
