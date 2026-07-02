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
    assert leaves["football.u15.girls.5v5"]["label"] == "U15 · Girls · 5v5"
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
    assert leaf_label(sports, "football.u15.boys") == "Football · U15 · Boys"
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


# ---------------------------------------------------------------- W2-B kinds


def test_nvn_names_autodetect_format_and_kind():
    from apps.tournaments.services.sports import leaf_roster_rules

    sports = normalize_sports([
        {"name": "Football", "nodes": [
            {"name": "U15", "children": [
                {"name": "5v5"},
                {"name": "Open"},
            ]},
        ]},
    ])
    five = sports[0]["nodes"][0]["children"][0]
    assert five["kind"] == "format"
    assert five["format"] == {"players_per_side": 5}
    # plain names carry no format
    assert "format" not in sports[0]["nodes"][0]["children"][1]

    # nearest format node on the path wins; defaults pin the squad to
    # players_per_side until the admin widens it
    rules = leaf_roster_rules(sports, "football.u15.5v5")
    assert rules == {"players_per_side": 5, "squad_min": 5, "squad_max": 5}
    # no format anywhere on the path → unbounded
    assert leaf_roster_rules(sports, "football.u15.open") == {
        "players_per_side": None, "squad_min": None, "squad_max": None,
    }


def test_explicit_format_and_squad_round_trip():
    from apps.tournaments.services.sports import leaf_roster_rules

    sports = normalize_sports([
        {"name": "Sepak Takraw", "nodes": [
            {"name": "Regu", "kind": "format",
             "format": {"players_per_side": 3, "squad_min": 3, "squad_max": 5}},
        ]},
    ])
    node = sports[0]["nodes"][0]
    assert node["kind"] == "format"
    assert node["format"] == {"players_per_side": 3, "squad_min": 3,
                              "squad_max": 5}
    assert leaf_roster_rules(sports, "sepak_takraw.regu") == {
        "players_per_side": 3, "squad_min": 3, "squad_max": 5,
    }


def test_generated_team_form_pins_roster_bounds_and_validator_enforces():
    from apps.forms.services.generation import generate_team_form_template
    from apps.forms.services.validation import AnswerError, validate_answers

    admin = _verified("rb@test.local")
    t = create_tournament(user=admin, name="Bounds Cup")
    t.sports = normalize_sports([
        {"name": "Table Tennis", "nodes": [{"name": "1v1"}]},
    ])
    t.save(update_fields=["sports"])
    form = generate_team_form_template(tournament=t, created_by=admin)

    sec = next(s for s in form.schema["sections"]
               if (s.get("visibility") or {}).get("value") == "table_tennis.1v1")
    team_group = sec["fields"][0]
    # The team group now also carries a coaches group; pin the *players* group
    # by key so the roster-bound assertion isn't fooled by field order.
    players = next(f for f in team_group["fields"]
                   if f["type"] == "group" and f["key"].startswith("players_"))
    assert players["min_items"] == 1
    assert players["max_items"] == 1

    groups = {g["leaf_key"]: g for g in
              form.settings["bindings"]["category_groups"]}
    g = groups["table_tennis.1v1"]
    base = {
        "institution_id": "00000000-0000-0000-0000-000000000001",
        "sports": ["table_tennis"],
        "categories_table_tennis": ["table_tennis.1v1"],
    }
    ok = validate_answers(form.schema, {
        **base,
        g["group"]: [{g["team_name"]: "TT A",
                      g["players_group"]: [{g["player_name"]: "Asen",
                                            g["player_dob"]: "2012-04-01"}]}],
    })
    assert ok[g["group"]][0][g["team_name"]] == "TT A"

    # two players in a 1v1 squad → rejected server-side
    with pytest.raises(AnswerError) as exc:
        validate_answers(form.schema, {
            **base,
            g["group"]: [{g["team_name"]: "TT A",
                          g["players_group"]: [
                              {g["player_name"]: "Asen",
                               g["player_dob"]: "2012-04-01"},
                              {g["player_name"]: "Ben",
                               g["player_dob"]: "2012-05-01"},
                          ]}],
        })
    assert "too_many_items" in str(exc.value)

    # a team row with no players misses the squad minimum
    with pytest.raises(AnswerError) as exc:
        validate_answers(form.schema, {
            **base,
            g["group"]: [{g["team_name"]: "TT A"}],
        })
    assert "too_few_items" in str(exc.value)


def test_age_groups_carry_structured_rules():
    """W2: 'U15'-style names self-describe as age groups with NUMBERS, and
    explicit operator rules round-trip; the nearest rule governs each leaf."""
    from apps.tournaments.services.sports import (
        age_rule_label,
        leaf_age_rule,
        normalize_sports,
    )

    sports = normalize_sports([{"name": "Football", "nodes": [
        {"name": "U15", "children": [{"name": "Girls"}]},
        {"name": "16+"},
        {"name": "Seniors", "kind": "age_group",
         "age": {"op": "between", "min": 18, "max": 35}},
        {"name": "Open"},
    ]}])
    nodes = sports[0]["nodes"]
    assert nodes[0]["kind"] == "age_group"
    assert nodes[0]["age"] == {"op": "under", "age": 15}
    assert nodes[1]["age"] == {"op": "over", "age": 16}
    assert nodes[2]["age"] == {"op": "between", "min": 18, "max": 35}
    assert "age" not in nodes[3]

    # the deeper Girls leaf inherits U15's rule (nearest on the path)
    assert leaf_age_rule(sports, "football.u15.girls") == {"op": "under", "age": 15}
    assert leaf_age_rule(sports, "football.open") is None
    assert age_rule_label({"op": "under", "age": 15}) == "under 15"
    assert age_rule_label({"op": "over", "age": 16}) == "16+"
    assert age_rule_label({"op": "between", "min": 18, "max": 35}) == "18-35"

    # invalid shapes are dropped, never stored as garbage
    bad = normalize_sports([{"name": "F", "nodes": [
        {"name": "Cat", "age": {"op": "between", "min": 20, "max": 10}},
        {"name": "Cat2", "age": {"op": "under", "age": "fifteen"}},
    ]}])
    assert "age" not in bad[0]["nodes"][0]
    assert "age" not in bad[0]["nodes"][1]


def test_generated_team_form_shows_age_limit():
    from apps.forms.services.generation import generate_team_form_template

    admin = _verified("age@test.local")
    t = create_tournament(user=admin, name="Age Cup")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}]},
    ])
    t.save(update_fields=["sports"])
    form = generate_team_form_template(tournament=t, created_by=admin)
    sec = next(s for s in form.schema["sections"]
               if (s.get("visibility") or {}).get("value") == "football.u15")
    assert sec["description"] == "Age limit: under 15."
