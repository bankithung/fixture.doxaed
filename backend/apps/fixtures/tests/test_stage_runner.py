"""Increment 2 — the multi-stage runner: min_matches partial round-robin, the
entry-stage front door, and deferred materialization of the next stage when the
source stage finalizes."""
from __future__ import annotations

from collections import Counter

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.draw_config import effective_draw_config
from apps.fixtures.services.generate import (
    _positional_qualifier_slots,
    _round_robin,
    _truncate_to_min_matches,
    generate_for_leaf,
    generate_round_robin,
    plan_knockout_from_positions,
)
from apps.fixtures.services.stages import materialize_ready_stages
from apps.matches.models import Match
from apps.matches.services.scoring import record_score
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin(email="s@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


class _T:
    def __init__(self, i):
        self.id = i


def test_truncate_to_min_matches_keeps_a_round_prefix():
    group = [_T(i) for i in range(5)]
    full = _round_robin(group, legs=1)
    assert len(full) == 10  # full single round-robin of 5
    kept = _truncate_to_min_matches(full, group, 3)
    assert len(kept) == 8  # 4 circle rounds x 2 matches
    c: Counter = Counter()
    for (_r, h, a) in kept:
        c[h.id] += 1
        c[a.id] += 1
    assert min(c.values()) >= 3 and max(c.values()) <= 4  # "at least 3"


def test_truncate_degenerates_to_full_when_min_exceeds_size():
    group = [_T(i) for i in range(4)]
    full = _round_robin(group, legs=1)
    assert _truncate_to_min_matches(full, group, 10) == full  # clamps to full RR


def test_generate_round_robin_honours_min_matches_per_team():
    admin = _admin()
    t = create_tournament(user=admin, name="MM")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i + 1}", "players": []} for i in range(5)])
    warnings: list = []
    created = generate_round_robin(
        tournament=t, group_size=5, min_matches_per_team=3, warnings=warnings,
    )
    assert len(created) == 8
    c: Counter = Counter()
    for m in created:
        c[m.home_team_id] += 1
        c[m.away_team_id] += 1
    assert min(c.values()) >= 3
    assert any(w.startswith("matches_per_team_uneven") for w in warnings)


def test_positional_slots_cross_seed_winners_away_from_runners_up():
    # 2 groups, top 2 → A1, B1 as the top layer; A2, B2 as the bottom layer
    slots = _positional_qualifier_slots(["Group A", "Group B"], 2)
    assert len(slots) == 4
    assert all(s["type"] == "group_position" for s in slots)
    # the two group winners are the top two seeds (positions resolve later)
    top_two = {(s["group_label"], s["position"]) for s in slots[:2]}
    assert top_two == {("Group A", 1), ("Group B", 1)}


def test_plan_from_positions_forwards_bye_pointers_to_round_two():
    # 3 groups x top 2 = 6 qualifiers -> bracket of 8 with 2 byes
    slots = _positional_qualifier_slots(["A", "B", "C"], 2)
    assert len(slots) == 6
    plans = plan_knockout_from_positions(slots, leaf_key="x")
    by_round: dict[int, list] = {}
    for p in plans:
        by_round.setdefault(p.round_no, []).append(p)
    assert len(by_round[1]) == 2  # 2 round-1 matches (4 teams), 2 get byes
    # a bye lane forwards its group_position pointer straight into round 2
    r2_sources = [p.home_source for p in by_round[2]] + [p.away_source for p in by_round[2]]
    assert any(s.get("type") == "group_position" for s in r2_sources)
    assert any(s.get("type") == "winner_of" for s in r2_sources)
    assert len(by_round[max(by_round)]) == 1  # a single final


def _multi_stage(t, *, seeding="cross", best_thirds=0):
    t.draw_config = {"*": {"stages": [
        {"id": "g", "type": "round_robin", "group_size": 4},
        {"id": "k", "type": "knockout",
         "from": {"stage": "g", "method": "top_n_per_group", "advance_per_group": 2,
                  "seeding": seeding, "advance_best_thirds": best_thirds}},
    ]}}
    t.save(update_fields=["draw_config"])


def test_front_door_draws_group_stage_and_eager_knockout():
    admin = _admin()
    t = create_tournament(user=admin, name="MS")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)])
    _multi_stage(t)  # 2 groups of 4 → top 2 cross-seed → eager bracket (Mode A)
    created = generate_for_leaf(tournament=t, leaf_key="", cfg=effective_draw_config(t, ""))
    # the group stage AND the knockout are both drawn up front
    assert any(m.stage == "group" and m.stage_no == 0 for m in created)
    ko = list(Match.objects.filter(tournament=t, stage="knockout", deleted_at__isnull=True))
    assert ko and all(m.stage_no == 1 for m in ko)
    # the bracket's first round carries group_position pointers, teams unresolved
    r1 = [m for m in ko if m.round_no == 1]
    assert r1 and all(m.home_team_id is None and m.away_team_id is None for m in r1)
    srcs = [m.home_source["type"] for m in r1] + [m.away_source["type"] for m in r1]
    assert all(s == "group_position" for s in srcs)


def test_eager_bracket_fills_in_as_groups_finalize():
    from apps.fixtures.services.advance import advance_from_match

    admin = _admin()
    t = create_tournament(user=admin, name="MS")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)])
    _multi_stage(t)
    generate_for_leaf(tournament=t, leaf_key="", cfg=effective_draw_config(t, ""))

    group = list(Match.objects.filter(tournament=t, stage="group").order_by("match_no"))
    for m in group:
        record_score(match=m, home_score=2, away_score=0, by=admin)
    # on_commit doesn't fire under the test transaction — resolve each group directly
    for m in group:
        advance_from_match(m.id)

    r1 = Match.objects.filter(
        tournament=t, stage="knockout", round_no=1, deleted_at__isnull=True,
    )
    # the group_position pointers are now resolved to real qualifying teams
    assert r1.exists()
    assert not r1.filter(home_team__isnull=True).exists()
    assert not r1.filter(away_team__isnull=True).exists()
    # eager bracket already present → materialize is a no-op (no double-draw)
    assert materialize_ready_stages(group[-1]) == []


def test_non_mode_a_knockout_is_deferred_not_eager():
    admin = _admin()
    t = create_tournament(user=admin, name="MS")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)])
    _multi_stage(t, seeding="overall")  # overall reseed needs results → deferred
    created = generate_for_leaf(tournament=t, leaf_key="", cfg=effective_draw_config(t, ""))
    assert created and all(m.stage == "group" and m.stage_no == 0 for m in created)
    assert not Match.objects.filter(tournament=t, stage="knockout").exists()

    group = list(Match.objects.filter(tournament=t, stage="group").order_by("match_no"))
    for m in group:
        record_score(match=m, home_score=2, away_score=0, by=admin)
    drawn = materialize_ready_stages(group[-1])
    assert drawn, "knockout should materialize once all groups are final"
    ko = Match.objects.filter(tournament=t, stage="knockout", deleted_at__isnull=True)
    assert ko.exists() and all(m.stage_no == 1 for m in ko)


def test_single_stage_competition_is_unchanged_by_the_front_door():
    admin = _admin()
    t = create_tournament(user=admin, name="RR")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i + 1}", "players": []} for i in range(4)])
    # no stages stored → derives a single round_robin stage → today's path
    created = generate_for_leaf(tournament=t, leaf_key="", cfg=effective_draw_config(t, ""))
    assert len(created) == 6  # full RR of 4
    assert all(m.stage == "group" and m.stage_no == 0 for m in created)
