"""Sports/category-hierarchy registry (spec 2026-06-10 §3): recursive nodes,
stable leaf keys, legacy-shape coercion, per-sport config preservation."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import (
    iter_leaves,
    leaf_label,
    normalize_sports,
    sport_for_leaf,
)

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


DEEP = [{
    "name": "Football",
    "nodes": [
        {"name": "U15", "children": [
            {"name": "Girls", "children": [{"name": "5v5"}, {"name": "11v11"}]},
            {"name": "Boys"},
        ]},
        {"name": "U17"},
    ],
}]


def test_normalize_supports_arbitrary_depth_with_stable_keys():
    out = normalize_sports(DEEP)
    fb = out[0]
    assert fb["key"] == "football"
    u15 = fb["nodes"][0]
    assert u15["key"] == "u15"
    girls = u15["children"][0]
    assert [c["key"] for c in girls["children"]] == ["5v5", "11v11"]
    # legacy projection derived from the first two levels
    assert fb["categories"] == [
        {"name": "U15", "subcategories": ["Girls", "Boys"]},
        {"name": "U17", "subcategories": []},
    ]


def test_normalize_coerces_legacy_two_level_shape():
    out = normalize_sports([
        {"name": "Football", "categories": [
            {"name": "U-14", "subcategories": ["5v5", "11v11", "5v5"]},
            {"name": "U-14"},  # dup dropped
            "U-16",            # legacy string
        ]},
    ])
    nodes = out[0]["nodes"]
    assert [n["name"] for n in nodes] == ["U-14", "U-16"]
    assert [c["name"] for c in nodes[0]["children"]] == ["5v5", "11v11"]


def test_normalize_preserves_scoring_and_scheduling():
    out = normalize_sports([{
        "name": "Sepak Takraw",
        "scoring": {"type": "sets", "best_of": 3, "points": 21, "win_by": 2,
                    "cap": 25, "deciding": {"points": 15, "cap": 17},
                    "junk": "dropped"},
        "scheduling": {"duration_minutes": 45, "venue_type": "indoor_court",
                       "junk": 1},
    }])
    s = out[0]
    assert s["scoring"] == {"type": "sets", "best_of": 3, "points": 21,
                            "win_by": 2, "cap": 25,
                            "deciding": {"points": 15, "cap": 17}}
    assert s["scheduling"] == {"duration_minutes": 45,
                               "venue_type": "indoor_court"}


def test_explicit_node_keys_survive_rename():
    out = normalize_sports([{
        "name": "Football",
        "nodes": [{"key": "u15", "name": "Under Fifteen (renamed)"}],
    }])
    node = out[0]["nodes"][0]
    assert node["key"] == "u15"
    assert node["name"] == "Under Fifteen (renamed)"


def test_iter_leaves_walks_to_leaves_and_sport_level():
    sports = normalize_sports([*DEEP, {"name": "Table Tennis"}])
    leaves = {lf["leaf_key"]: lf for lf in iter_leaves(sports)}
    assert set(leaves) == {
        "football.u15.girls.5v5",
        "football.u15.girls.11v11",
        "football.u15.boys",
        "football.u17",
        "table_tennis",
    }
    assert leaves["football.u15.girls.5v5"]["label"] == "U15 — Girls — 5v5"
    assert leaves["football.u15.girls.5v5"]["path"] == ["U15", "Girls", "5v5"]
    # sport with no categories → one sport-level leaf
    assert leaves["table_tennis"]["path"] == []
    assert leaves["table_tennis"]["label"] == "Table Tennis"


def test_iter_leaves_coerces_legacy_stored_rows():
    # rows written before the registry have only `categories`
    leaves = iter_leaves([{"key": "football", "name": "Football", "categories": [
        {"name": "U-14", "subcategories": ["5v5"]},
    ]}])
    assert [lf["leaf_key"] for lf in leaves] == ["football.u_14.5v5"]


def test_sport_for_leaf_and_label():
    sports = normalize_sports(DEEP)
    assert sport_for_leaf(sports, "football.u15.girls.5v5") == "football"
    assert sport_for_leaf(sports, "cricket.u15") == ""
    assert sport_for_leaf(sports, "") == ""
    assert leaf_label(sports, "football.u15.boys") == "Football — U15 — Boys"
    assert leaf_label(sports, "gone.leaf") == "gone.leaf"  # fallback


def test_sports_put_persists_deep_tree_and_config():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Multi")
    resp = _client(admin).put(
        f"/api/tournaments/{t.id}/sports/",
        {"sports": [{**DEEP[0],
                     "scoring": {"type": "goals"},
                     "scheduling": {"duration_minutes": 100}}]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    saved = resp.json()["sports"][0]
    # deep structure persisted (B4) and per-sport config no longer stripped (B3)
    assert saved["nodes"][0]["children"][0]["children"][0]["key"] == "5v5"
    assert saved["scoring"] == {"type": "goals"}
    assert saved["scheduling"] == {"duration_minutes": 100}
    t.refresh_from_db()
    assert t.sports[0]["nodes"][0]["key"] == "u15"
