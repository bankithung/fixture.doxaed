"""Constraint catalog v2 (fixture-engine redesign spec §3/§2.2): new types,
scope grammar validation (all | sport: | leaf: | team: | tag:k=v), weight
normalization (1-10, default 5), and the pure scope-matching helpers the
scheduler resolves records with."""
from __future__ import annotations

import pytest

from apps.fixtures.services.constraints import (
    CONSTRAINT_TYPES,
    DEFAULT_WEIGHT,
    normalize_scope,
    parse_scope,
    parse_weight,
    scope_matches,
    scope_specificity,
    validate_constraints,
)

NEW_TYPES = [
    "recurring_blackout_window",
    "ceremony_block",
    "round_pinned_to_window",
    "category_session_window",
    "official_capacity",
    "no_person_overlap",
    "reserve_days",
]


# --------------------------------------------------------------------- catalog
def test_catalog_contains_v2_types_with_params_schema():
    by_type = {c["type"]: c for c in CONSTRAINT_TYPES}
    for t in NEW_TYPES:
        assert t in by_type, f"missing catalog type {t}"
        assert isinstance(by_type[t]["params_schema"], dict)
        assert isinstance(by_type[t]["scopes"], list) and by_type[t]["scopes"]
    # legacy entries gained a scopes list too (drives the UI scope Select)
    assert "all" in by_type["min_rest_minutes"]["scopes"]
    # defaults per the spec table
    assert by_type["recurring_blackout_window"]["hard"] is True
    assert by_type["category_session_window"]["hard"] is False  # soft default
    assert by_type["official_capacity"]["params_schema"] == {"count": "int"}
    assert by_type["no_person_overlap"]["params_schema"] == {
        "min_gap_minutes": "int", "cross_venue_gap_minutes": "int",
    }


def test_validate_accepts_each_new_type():
    records = [
        {"type": "recurring_blackout_window",
         "params": {"days": ["sun"], "from": "06:00", "to": "13:00"}},
        {"type": "ceremony_block",
         "params": {"date": "2026-08-01", "from": "09:00", "to": "11:00"}},
        {"type": "round_pinned_to_window", "scope": "leaf:football.u15",
         "params": {"round": "final", "date": "last_day", "from": "14:00"}},
        {"type": "category_session_window", "scope": "leaf:football.u15",
         "params": {"from": "09:00", "to": "12:00"}},
        {"type": "official_capacity", "scope": "sport:table_tennis",
         "params": {"count": 2}},
        {"type": "no_person_overlap",
         "params": {"min_gap_minutes": 30, "cross_venue_gap_minutes": 60}},
        {"type": "reserve_days", "params": {"dates": ["2026-08-09"]}},
    ]
    out = validate_constraints(records)
    assert [r["type"] for r in out] == [r["type"] for r in records]
    assert out[2]["scope"] == "leaf:football.u15"
    assert out[3]["hard"] is False  # soft by default (hard toggle stays possible)


# ----------------------------------------------------------------------- scope
def test_scope_grammar_valid_forms_normalize():
    assert parse_scope(None) == "all"
    assert parse_scope("") == "all"
    assert parse_scope("all") == "all"
    assert parse_scope("sport:football") == "sport:football"
    assert parse_scope("leaf:football.u15.girls") == "leaf:football.u15.girls"
    assert parse_scope("team:0192b") == "team:0192b"
    assert parse_scope("tag:district=Kohima") == "tag:district=Kohima"
    assert parse_scope(" tag: district = Kohima ") == "tag:district=Kohima"


@pytest.mark.parametrize("bad", [
    "sport:", "leaf:", "team:", "tag:", "tag:district", "tag:=x", "tag:k=",
    "bogus:x", "sports:football", 42,
])
def test_scope_grammar_rejects_unknown_forms(bad):
    with pytest.raises(ValueError):
        parse_scope(bad)


def test_validate_constraints_rejects_bad_scope_on_new_records():
    with pytest.raises(ValueError):
        validate_constraints(
            [{"type": "min_rest_minutes", "scope": "bogus:x",
              "params": {"minutes": 30}}]
        )


def test_normalize_scope_is_lenient_for_stored_legacy_records():
    assert normalize_scope("bogus:x") == "all"
    assert normalize_scope(None) == "all"
    assert normalize_scope("sport:tt") == "sport:tt"


def test_scope_specificity_ordering():
    ranks = [scope_specificity(s) for s in
             ("all", "tag:k=v", "sport:x", "leaf:x.y", "team:t1")]
    assert ranks == sorted(ranks)
    assert len(set(ranks)) == 5  # strictly increasing: team > leaf > sport > tag > all


def test_scope_matches_each_kind():
    assert scope_matches("all", sport="football", leaf_key="football.u15")
    assert scope_matches("sport:football", sport="football")
    assert not scope_matches("sport:football", sport="table_tennis")
    assert scope_matches("leaf:football.u15", leaf_key="football.u15")
    assert not scope_matches("leaf:football.u15", leaf_key="football.u17")
    assert scope_matches("team:t1", team_ids=("t1", "t2"))
    assert not scope_matches("team:t9", team_ids=("t1", "t2"))
    tags = {"t1": {"district": "Kohima"}, "t2": {"district": "Mon"}}
    assert scope_matches("tag:district=Kohima", team_ids=("t1",), team_tags=tags)
    assert not scope_matches("tag:district=Kohima", team_ids=("t2",), team_tags=tags)
    assert not scope_matches("tag:district=Kohima", team_ids=("t2",))  # no tags known


# ---------------------------------------------------------------------- weight
def test_weight_defaults_and_bounds():
    assert parse_weight(None) == DEFAULT_WEIGHT == 5
    assert parse_weight(1) == 1 and parse_weight(10) == 10
    for bad in (0, 11, "5", 2.5, True):
        with pytest.raises(ValueError):
            parse_weight(bad)


def test_validate_constraints_normalizes_weight():
    out = validate_constraints([
        {"type": "preferred_window", "params": {"from": "15:00", "to": "17:00"}},
        {"type": "balance_venues", "weight": 8},
    ])
    assert out[0]["weight"] == 5  # default
    assert out[1]["weight"] == 8
    with pytest.raises(ValueError):
        validate_constraints([{"type": "balance_venues", "weight": 99}])
