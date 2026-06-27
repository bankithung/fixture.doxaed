"""TDD — tournament settings API: rules/constraints GET+PATCH, freeze, idempotency, isolation."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_get_settings_returns_defaults_and_can_edit():
    admin = _user("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    r = _client(admin).get(f"/api/tournaments/{t.id}/settings/")
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["rules"]["points"]["win"] == 3
    assert body["can_edit"] is True
    assert body["rules_frozen_at"] is None


def test_get_settings_exposes_per_sport_scoring_defaults():
    admin = _user("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    t.sports = [{"key": "table_tennis", "label": "TT"}, {"key": "football", "label": "FB"}]
    t.save(update_fields=["sports"])
    body = _client(admin).get(f"/api/tournaments/{t.id}/settings/").json()
    # researched profile is surfaced so each game shows what it inherits
    assert body["scoring_defaults"]["table_tennis"]["type"] == "sets"
    assert body["scoring_defaults"]["table_tennis"]["points"] == 11  # the TT profile
    assert body["scoring_defaults"]["football"]["type"] == "goals"


def test_patch_persists_and_clears_a_per_game_scoring_override():
    admin = _user("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = _client(admin)
    tt = {"type": "sets", "best_of": 3, "points": 15, "win_by": 2, "cap": 17}
    r = c.patch(
        f"/api/tournaments/{t.id}/settings/",
        {"rules": {"by_leaf": {"tt.open": {"scoring": tt}}}, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["rules"]["by_leaf"]["tt.open"]["scoring"]["cap"] == 17
    # clearing the override removes the game's entry
    r = c.patch(
        f"/api/tournaments/{t.id}/settings/",
        {"rules": {"by_leaf": {"tt.open": {"scoring": None}}}, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.json()["rules"]["by_leaf"] == {}


def test_patch_merges_rules_onto_current():
    admin = _user("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = _client(admin)
    c.patch(
        f"/api/tournaments/{t.id}/settings/",
        {"rules": {"format": "knockout"}, "event_id": str(uuid.uuid4())},
        format="json",
    )
    r = c.patch(
        f"/api/tournaments/{t.id}/settings/",
        {"rules": {"points": {"win": 2}}, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    rules = r.json()["rules"]
    assert rules["format"] == "knockout"   # first patch survived
    assert rules["points"]["win"] == 2      # second patch applied
    assert rules["points"]["draw"] == 1     # default intact


def test_patch_rejects_unknown_rule_key():
    admin = _user("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/settings/",
        {"rules": {"bogus": 1}, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 400


def test_patch_stores_constraints():
    admin = _user("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/settings/",
        {
            "constraints": [{"type": "min_rest_minutes", "params": {"minutes": 90}}],
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 200, r.content
    cons = r.json()["constraints"]
    assert cons[0]["type"] == "min_rest_minutes"
    assert cons[0]["hard"] is True
    assert cons[0]["params"]["minutes"] == 90


def test_patch_idempotent_replay():
    admin = _user("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = _client(admin)
    eid = str(uuid.uuid4())
    c.patch(f"/api/tournaments/{t.id}/settings/", {"rules": {"points": {"win": 2}}, "event_id": eid}, format="json")
    # replay same event_id with a different value -> ignored
    r = c.patch(f"/api/tournaments/{t.id}/settings/", {"rules": {"points": {"win": 9}}, "event_id": eid}, format="json")
    assert r.status_code == 200
    assert r.json()["rules"]["points"]["win"] == 2


def test_patch_blocked_when_frozen_then_allowed_with_amend():
    admin = _user("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    t.status = TournamentStatus.REGISTRATION_OPEN
    t.save(update_fields=["status"])
    c = _client(admin)

    blocked = c.patch(
        f"/api/tournaments/{t.id}/settings/",
        {"rules": {"points": {"win": 2}}, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert blocked.status_code == 409

    amended = c.patch(
        f"/api/tournaments/{t.id}/settings/",
        {
            "rules": {"points": {"win": 2}},
            "amend": True,
            "reason": "Correcting points before kickoff",
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert amended.status_code == 200, amended.content
    assert amended.json()["rules"]["points"]["win"] == 2


def test_outsider_cannot_read_or_edit_settings():
    admin = _user("a@test.local")
    outsider = _user("b@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = _client(outsider)
    assert c.get(f"/api/tournaments/{t.id}/settings/").status_code == 404
    assert c.patch(
        f"/api/tournaments/{t.id}/settings/",
        {"rules": {"points": {"win": 2}}, "event_id": str(uuid.uuid4())},
        format="json",
    ).status_code == 404


def test_constraint_types_catalog():
    admin = _user("a@test.local")
    r = _client(admin).get("/api/tournaments/constraint-types/")
    assert r.status_code == 200
    types = {c["type"] for c in r.json()}
    assert "min_rest_minutes" in types
    assert "no_double_booking_team" in types
