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
