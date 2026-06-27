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
    _round_robin,
    _truncate_to_min_matches,
    generate_for_leaf,
    generate_round_robin,
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
    assert len(kept) == 8  # 4 circle rounds × 2 matches
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


def _multi_stage(t):
    t.draw_config = {"*": {"stages": [
        {"id": "g", "type": "round_robin", "group_size": 4},
        {"id": "k", "type": "knockout",
         "from": {"stage": "g", "method": "top_n_per_group", "advance_per_group": 2}},
    ]}}
    t.save(update_fields=["draw_config"])


def test_front_door_generates_entry_stage_only_then_defers_knockout():
    admin = _admin()
    t = create_tournament(user=admin, name="MS")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)])
    _multi_stage(t)
    created = generate_for_leaf(tournament=t, leaf_key="", cfg=effective_draw_config(t, ""))
    # only the entry (group) stage is drawn; knockout is deferred
    assert created and all(m.stage == "group" and m.stage_no == 0 for m in created)
    assert not Match.objects.filter(tournament=t, stage="knockout").exists()


def test_knockout_materializes_when_the_group_stage_finalizes():
    admin = _admin()
    t = create_tournament(user=admin, name="MS")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i + 1}", "players": []} for i in range(8)])
    _multi_stage(t)
    generate_for_leaf(tournament=t, leaf_key="", cfg=effective_draw_config(t, ""))

    group = list(Match.objects.filter(tournament=t, stage="group").order_by("match_no"))
    for m in group:
        record_score(match=m, home_score=2, away_score=0, by=admin)

    # the on_commit advancement hook doesn't fire under the test transaction, so
    # invoke the materializer directly (it's idempotent + lock-guarded)
    created = materialize_ready_stages(group[-1])
    assert created, "knockout should materialize once all groups are final"
    ko = Match.objects.filter(tournament=t, stage="knockout", deleted_at__isnull=True)
    assert ko.exists() and all(m.stage_no == 1 for m in ko)
    # idempotent: a second call draws nothing new
    assert materialize_ready_stages(group[-1]) == []


def test_single_stage_competition_is_unchanged_by_the_front_door():
    admin = _admin()
    t = create_tournament(user=admin, name="RR")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i + 1}", "players": []} for i in range(4)])
    # no stages stored → derives a single round_robin stage → today's path
    created = generate_for_leaf(tournament=t, leaf_key="", cfg=effective_draw_config(t, ""))
    assert len(created) == 6  # full RR of 4
    assert all(m.stage == "group" and m.stage_no == 0 for m in created)
