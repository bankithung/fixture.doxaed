"""Increment 1 — multi-stage data model: stage schema validation, effective_stages
back-compat derivation, stored-stages round-trip + id auto-fill, Match.stage_no."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.draw_config import (
    _validate_stages,
    effective_stages,
    update_draw_config,
)
from apps.matches.models import Match, MatchStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email="s@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


GROUPS_KO = [
    {"id": "a", "type": "round_robin", "group_size": 5, "min_matches_per_team": 3},
    {"id": "b", "type": "knockout",
     "from": {"stage": "a", "method": "top_n_per_group", "advance_per_group": 2}},
]


def test_validate_accepts_single_and_groups_knockout():
    _validate_stages(None)
    _validate_stages([])
    _validate_stages([{"id": "x", "type": "round_robin", "group_size": 4}])
    _validate_stages(GROUPS_KO)
    # three stages: group → group → knockout (Cricket-WC shape)
    _validate_stages([
        {"id": "a", "type": "round_robin", "group_size": 4},
        {"id": "b", "type": "round_robin", "group_size": 4,
         "from": {"stage": "a", "advance_per_group": 2}},
        {"id": "c", "type": "knockout", "from": {"stage": "b", "advance_per_group": 1}},
    ])


@pytest.mark.parametrize("bad", [
    [{"type": "innings"}],                                              # unknown type
    [{"type": "round_robin", "from": {"stage": "x"}}],                  # from on stage 0
    [{"id": "a", "type": "round_robin"},
     {"id": "b", "type": "knockout", "from": {"stage": "b"}}],          # self/forward ref
    [{"id": "a", "type": "knockout"},
     {"id": "b", "type": "round_robin", "from": {}}],                   # knockout not last
    [{"id": "a", "type": "round_robin", "group_size": 3},
     {"id": "b", "type": "knockout", "from": {"advance_per_group": 3}}],  # advance >= group_size
    [{"id": "a", "type": "round_robin", "min_matches_per_team": 2},     # min_matches wrong type
     {"id": "b", "type": "knockout", "min_matches_per_team": 2, "from": {}}],
    [{"id": "a", "type": "round_robin"}, {"id": "a", "type": "knockout", "from": {}}],  # dup ids
    [{"id": str(i), "type": "round_robin"} for i in range(5)],          # > _MAX_STAGES
    [{"id": "a", "type": "swiss"}, {"id": "b", "type": "swiss", "from": {}}],  # two swiss
])
def test_validate_rejects_invalid(bad):
    with pytest.raises(ValueError):
        _validate_stages(bad)


def test_effective_stages_derives_one_stage_from_legacy_format():
    admin = _user()
    t = create_tournament(user=admin, name="X")
    t.draw_config = {"*": {"format": "knockout", "third_place": True}}
    t.save(update_fields=["draw_config"])
    st = effective_stages(t)
    assert len(st) == 1
    assert st[0]["type"] == "knockout" and st[0]["third_place"] is True
    assert st[0]["id"].startswith("legacy:")  # synthetic stable id


def test_effective_stages_groups_knockout_derives_single_round_robin():
    admin = _user()
    t = create_tournament(user=admin, name="X")
    t.draw_config = {"*": {"format": "groups_knockout", "group_size": 4}}
    t.save(update_fields=["draw_config"])
    st = effective_stages(t)
    # legacy groups_knockout → ONE round_robin stage (knockout stays manual)
    assert [s["type"] for s in st] == ["round_robin"]
    assert st[0]["group_size"] == 4


def test_effective_stages_uses_stored_stages_when_present():
    admin = _user()
    t = create_tournament(user=admin, name="X")
    t.draw_config = {"*": {"stages": GROUPS_KO}}
    t.save(update_fields=["draw_config"])
    st = effective_stages(t)
    assert [s["type"] for s in st] == ["round_robin", "knockout"]
    assert st[0]["id"] == "a"


def test_update_draw_config_persists_stages_and_fills_ids():
    admin = _user()
    t = create_tournament(user=admin, name="X")
    import uuid
    update_draw_config(
        tournament=t, leaf_key="*",
        partial={"stages": [
            {"type": "round_robin", "group_size": 4},  # no id → auto-filled
            {"type": "knockout", "from": {"advance_per_group": 2}},
        ]},
        by=admin, event_id=str(uuid.uuid4()),
    )
    t.refresh_from_db()
    stages = t.draw_config["*"]["stages"]
    assert all(s.get("id") for s in stages)  # ids auto-filled (invariant 1)
    assert len({s["id"] for s in stages}) == 2


def test_match_stage_no_defaults_to_zero():
    admin = _user()
    t = create_tournament(user=admin, name="X")
    m = Match.objects.create(
        organization=t.organization, tournament=t, status=MatchStatus.SCHEDULED,
    )
    assert m.stage_no == 0  # legacy rows read as stage 0 (DB-layer back-compat)
