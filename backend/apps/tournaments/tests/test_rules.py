"""TDD — tournament structured rules: defaults, whitelist merge, freeze gate."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.rules import (
    DEFAULT_RULES,
    can_edit_rules,
    freeze_rules,
    merge_rules,
)

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email="org@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def test_merge_rules_fills_defaults_and_keeps_overrides():
    r = merge_rules({"points": {"win": 2}, "format": "knockout"})
    assert r["format"] == "knockout"
    assert r["points"]["win"] == 2          # override kept
    assert r["points"]["draw"] == 1          # default preserved
    assert r["tiebreakers"][0] == "points"   # default list present
    assert r["match"]["half_minutes"] == 45  # default nested preserved


def test_merge_rules_rejects_unknown_top_level_key():
    with pytest.raises(ValueError):
        merge_rules({"bogus_key": 1})


def test_merge_rules_rejects_unknown_nested_key():
    with pytest.raises(ValueError):
        merge_rules({"points": {"bonus": 5}})


def test_merge_rules_none_returns_defaults():
    assert merge_rules(None) == DEFAULT_RULES


# --- per-game (by_leaf) overrides: scoring + tiebreakers --------------------

_TT = {"type": "sets", "best_of": 3, "points": 15, "win_by": 2, "cap": 17}


def test_by_leaf_scoring_merge_keeps_other_leaves():
    base = merge_rules({"by_leaf": {"tt.open": {"scoring": _TT}}})
    # a second leaf merges in without dropping the first
    r = merge_rules({"by_leaf": {"tt.u14": {"scoring": {"type": "sets", "best_of": 5,
                     "points": 11, "win_by": 2}}}}, base=base)
    assert r["by_leaf"]["tt.open"]["scoring"] == _TT
    assert r["by_leaf"]["tt.u14"]["scoring"]["best_of"] == 5


def test_by_leaf_scoring_with_deciding_set():
    r = merge_rules({"by_leaf": {"tt.open": {"scoring": {
        "type": "sets", "best_of": 5, "points": 21, "win_by": 2, "cap": 25,
        "deciding": {"points": 15, "win_by": 2, "cap": 17}}}}})
    assert r["by_leaf"]["tt.open"]["scoring"]["deciding"]["cap"] == 17


def test_by_leaf_goals_override():
    r = merge_rules({"by_leaf": {"football.u17": {"scoring": {"type": "goals"}}}})
    assert r["by_leaf"]["football.u17"]["scoring"] == {"type": "goals"}


def test_by_leaf_clearing_scoring_removes_the_entry():
    base = merge_rules({"by_leaf": {"tt.open": {"scoring": _TT}}})
    r = merge_rules({"by_leaf": {"tt.open": {"scoring": None}}}, base=base)
    assert "tt.open" not in r["by_leaf"]


def test_by_leaf_setting_leaf_to_none_clears_it():
    base = merge_rules({"by_leaf": {"tt.open": {"scoring": _TT}}})
    r = merge_rules({"by_leaf": {"tt.open": None}}, base=base)
    assert r["by_leaf"] == {}


def test_by_leaf_tiebreakers_override():
    r = merge_rules({"by_leaf": {"tt.open": {"tiebreakers": [
        "points", "head_to_head", "set_difference", "point_difference",
        "points_for", "coin_toss"]}}})
    assert r["by_leaf"]["tt.open"]["tiebreakers"][-1] == "coin_toss"


@pytest.mark.parametrize("bad", [
    {"type": "innings"},                                   # unknown type
    {"type": "sets", "best_of": 0},                        # best_of < 1
    {"type": "sets", "points": 0},                         # points < 1
    {"type": "sets", "points": 15, "cap": 10},             # cap < points
    {"type": "sets", "win_by": 0},                         # win_by < 1
    {"type": "goals", "points": 11},                       # goals takes no params
    {"type": "sets", "bogus": 1},                          # unknown key
])
def test_by_leaf_scoring_rejects_invalid(bad):
    with pytest.raises(ValueError):
        merge_rules({"by_leaf": {"x": {"scoring": bad}}})


def test_by_leaf_rejects_unknown_tiebreaker():
    with pytest.raises(ValueError):
        merge_rules({"by_leaf": {"x": {"tiebreakers": ["points", "vibes"]}}})


def test_by_leaf_rejects_unknown_inner_key():
    with pytest.raises(ValueError):
        merge_rules({"by_leaf": {"x": {"discipline": {}}}})


def test_can_edit_rules_in_draft_then_frozen():
    admin = _user()
    t = create_tournament(user=admin, name="Rules Cup")
    assert t.status == TournamentStatus.DRAFT
    assert can_edit_rules(t) is True

    freeze_rules(t)
    t.refresh_from_db()
    assert t.rules_frozen_at is not None

    t.status = TournamentStatus.REGISTRATION_OPEN
    t.save(update_fields=["status"])
    assert can_edit_rules(t) is False
