"""H4 — the sports-tree PUT must not orphan registered data (finding N5).

Leaf keys are rename-stable, so renames/additions always pass; only removing
a leaf that teams or matches reference is blocked. Replays with the same
event_id return the stored state (invariant 3).
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import iter_leaves, normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

TREE = [
    {
        "name": "Table Tennis",
        "nodes": [{"name": "U-14"}, {"name": "Open"}],
    }
]


def _setup():
    u = User.objects.create_user(
        email="sports-guard@test.local", password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    t = create_tournament(user=u, name="Guard Cup")
    t.sports = normalize_sports(TREE)
    t.save(update_fields=["sports"])
    leaves = iter_leaves(t.sports)
    c = APIClient()
    c.force_authenticate(user=u)
    return u, t, leaves, c


def _tree_without(t, leaf_key: str) -> list[dict]:
    """The stored tree minus the node holding leaf_key (child level)."""
    import copy

    sports = copy.deepcopy(t.sports)
    for sport in sports:
        sport["nodes"] = [
            n for n in sport.get("nodes", [])
            if n.get("key") != leaf_key.split(".")[-1]
        ]
    return sports


def test_removing_a_leaf_with_teams_is_blocked():
    u, t, leaves, c = _setup()
    used = leaves[0]["leaf_key"]
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": [], "leaf_key": used}],
    )
    resp = c.put(
        f"/api/tournaments/{t.id}/sports/",
        {"sports": _tree_without(t, used)},
        format="json",
    )
    assert resp.status_code == 400
    assert "leaf_in_use" in str(resp.data["detail"])
    t.refresh_from_db()
    assert {l["leaf_key"] for l in iter_leaves(t.sports)} == {
        l["leaf_key"] for l in leaves
    }  # tree untouched


def test_rename_and_additions_stay_legal_while_leaf_in_use():
    u, t, leaves, c = _setup()
    used = leaves[0]["leaf_key"]
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": [], "leaf_key": used}],
    )
    import copy

    sports = copy.deepcopy(t.sports)
    # Rename the in-use node (key survives) and add a brand-new sibling.
    for sport in sports:
        for n in sport.get("nodes", []):
            if used.endswith(n["key"]):
                n["name"] = "Under 14 (renamed)"
        sport["nodes"].append({"name": "U-17"})
    resp = c.put(f"/api/tournaments/{t.id}/sports/", {"sports": sports}, format="json")
    assert resp.status_code == 200
    keys = {l["leaf_key"] for l in iter_leaves(resp.data["sports"])}
    assert used in keys  # stable key survived the rename
    assert any(k.endswith("u17") or "u-17" in k or "u_17" in k for k in keys)


def test_removing_an_unused_leaf_is_fine():
    u, t, leaves, c = _setup()
    unused = leaves[1]["leaf_key"]
    resp = c.put(
        f"/api/tournaments/{t.id}/sports/",
        {"sports": _tree_without(t, unused)},
        format="json",
    )
    assert resp.status_code == 200
    assert unused not in {l["leaf_key"] for l in iter_leaves(resp.data["sports"])}


def test_event_id_replay_is_idempotent():
    u, t, leaves, c = _setup()
    eid = str(uuid.uuid4())
    body = {"sports": t.sports, "event_id": eid}
    first = c.put(f"/api/tournaments/{t.id}/sports/", body, format="json")
    assert first.status_code == 200
    second = c.put(f"/api/tournaments/{t.id}/sports/", body, format="json")
    assert second.status_code == 200
    assert AuditEvent.objects.filter(
        idempotency_key=eid, event_type="tournament_sports_updated"
    ).count() == 1


def test_sports_meta_serves_descriptors_per_sport():
    """P1.c — sports-meta returns each sport's family/boards so surfaces
    render sport-native without hardcoding."""
    u, t, leaves, c = _setup()
    r = c.get(f"/api/tournaments/{t.id}/sports-meta/")
    assert r.status_code == 200
    assert [s["key"] for s in r.data["sports"]] == ["table_tennis"]
    assert r.data["sports"][0]["leaf_count"] == 2
    d = r.data["descriptors"]["table_tennis"]
    assert d["family"] == "target"
    assert d["has_draw"] is False
    assert d["terms"]["period"] == "Game"
    assert [b["key"] for b in d["boards"]] == [
        "match_wins", "set_ratio", "point_diff"
    ]


def test_sports_meta_ships_scoring_presets():
    """P2: named ISTAF/ITTF presets ride the descriptor so Settings offers a
    one-click regime pick (owner decision D1) that stays fully editable."""
    from apps.tournaments.services.rules import merge_rules

    u, t, leaves, c = _setup()
    d = c.get(f"/api/tournaments/{t.id}/sports-meta/").data["descriptors"]
    keys = [p["key"] for p in d["table_tennis"]["presets"]]
    assert keys == ["ittf_bo3", "ittf_bo5", "ittf_bo7"]
    # EVERY preset of EVERY sport must be legal as a per-leaf override —
    # a preset that fails validation is a landmine in Settings.
    from apps.matches.services.sport_defs.presets import SCORING_PRESETS

    for presets in SCORING_PRESETS.values():
        for preset in presets:
            merge_rules({"by_leaf": {"x": {"scoring": preset["scoring"]}}})
