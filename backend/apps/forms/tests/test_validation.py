from __future__ import annotations

import pytest

from apps.forms.services.validation import AnswerError, _visible, validate_answers

SCHEMA = {"version": 1, "sections": [
    {"key": "school", "title": "School", "fields": [
        {"key": "school_name", "type": "short_text", "label": "School",
         "required": True, "role": "title"},
        {"key": "email", "type": "email", "label": "Email", "required": True, "role": "email"},
    ]},
    {"key": "competition", "title": "Comp", "fields": [
        {"key": "competition", "type": "single_choice", "label": "Which?", "required": True,
         "options": [
             {"value": "sepak", "label": "Sepak", "goto": "sepak"},
             {"value": "tt", "label": "TT", "goto": "tt"},
             {"value": "none", "label": "None", "goto": "confirm"},
         ]},
    ]},
    {"key": "sepak", "title": "Sepak cats",
     "visibility": {"field": "competition", "op": "in", "value": ["sepak", "both"]},
     "fields": [{"key": "sepak_cats", "type": "multi_choice", "label": "Cats", "required": True,
                 "options": [{"value": "u14b", "label": "U-14 B"}]}], "next": "confirm"},
    {"key": "tt", "title": "TT cats",
     "visibility": {"field": "competition", "op": "in", "value": ["tt", "both"]},
     "fields": [{"key": "tt_cats", "type": "multi_choice", "label": "Cats", "required": True,
                 "options": [{"value": "u14bs", "label": "U-14 BS"}]}], "next": "confirm"},
    {"key": "confirm", "title": "Confirm", "fields": [
        {"key": "agree", "type": "single_choice", "label": "OK", "required": True,
         "options": [{"value": "yes", "label": "Yes"}]},
    ]},
]}


def test_required_on_reached_path_enforced():
    with pytest.raises(AnswerError):
        validate_answers(SCHEMA, {"school_name": "MH", "email": "a@b.com"})  # missing competition


def test_branch_sepak_requires_sepak_cats_only():
    # choosing sepak: sepak_cats required, tt_cats must NOT be required
    clean = validate_answers(SCHEMA, {
        "school_name": "MH", "email": "a@b.com",
        "competition": "sepak", "sepak_cats": ["u14b"], "agree": "yes",
    })
    assert clean["competition"] == "sepak"
    assert "tt_cats" not in clean  # hidden branch dropped


def test_hidden_answer_is_dropped():
    clean = validate_answers(SCHEMA, {
        "school_name": "MH", "email": "a@b.com",
        "competition": "none", "agree": "yes",
        "sepak_cats": ["u14b"],  # not on the 'none' path -> dropped
    })
    assert "sepak_cats" not in clean


def test_invalid_value_rejected():
    with pytest.raises(AnswerError):
        validate_answers(SCHEMA, {
            "school_name": "MH", "email": "bad", "competition": "none", "agree": "yes",
        })


@pytest.mark.parametrize("val", ["", None, "abc", [], {}])
def test_gt_lt_non_numeric_is_hidden(val):
    # Contract pinned by the client/server parity fix (verdict V5): gt/lt are
    # False for empty/null/non-numeric answers (float() raises -> False). The
    # frontend lib/formLogic.ts::toFiniteNumber mirrors this exactly.
    assert _visible({"field": "x", "op": "gt", "value": -1}, {"x": val}) is False
    assert _visible({"field": "x", "op": "lt", "value": 10}, {"x": val}) is False


def test_gt_lt_numeric_compares():
    assert _visible({"field": "x", "op": "gt", "value": 3}, {"x": 5}) is True
    assert _visible({"field": "x", "op": "gt", "value": "3"}, {"x": "5"}) is True
    assert _visible({"field": "x", "op": "gt", "value": 0}, {"x": -2}) is False
    assert _visible({"field": "x", "op": "lt", "value": "10"}, {"x": "3"}) is True


NESTED = {"version": 1, "sections": [
    {"key": "s", "title": "S", "fields": [
        {"key": "sport", "type": "single_choice", "label": "Sport", "required": True,
         "options": [
             {"value": "football", "label": "Football", "fields": [
                 {"key": "fmt", "type": "single_choice", "label": "Format", "required": True,
                  "options": [{"value": "5v5", "label": "5v5"},
                              {"value": "11v11", "label": "11v11"}]},
             ]},
             {"value": "tt", "label": "Table Tennis"},
         ]},
    ]},
]}


def test_nested_option_field_required_only_when_selected():
    # Football selected -> its nested 'fmt' becomes required.
    with pytest.raises(AnswerError) as ei:
        validate_answers(NESTED, {"sport": "football"})
    assert "fmt" in ei.value.errors
    # Provide it -> clean carries both.
    clean = validate_answers(NESTED, {"sport": "football", "fmt": "5v5"})
    assert clean == {"sport": "football", "fmt": "5v5"}


def test_nested_option_field_dropped_when_branch_inactive():
    # 'tt' has no nested fields -> a stray 'fmt' answer is not active and is dropped.
    clean = validate_answers(NESTED, {"sport": "tt", "fmt": "5v5"})
    assert clean == {"sport": "tt"}


def test_multi_sport_template_reveals_categories_by_competition():
    from apps.forms.services.templates import get_template

    schema = get_template("template:multi-sport-institution")["schema"]
    base = {"school_name": "MH", "contact_name": "A", "contact_phone": "12345678"}

    # Sepak only -> Sepak categories kept, TT categories dropped (inactive).
    clean = validate_answers(schema, {
        **base, "competition": "sepak",
        "sepak_categories": ["u14_boys"],
        "tt_categories": ["u14_boys_singles"],
    })
    assert clean.get("sepak_categories") == ["u14_boys"]
    assert "tt_categories" not in clean

    # Both -> both category groups kept.
    clean2 = validate_answers(schema, {
        **base, "competition": "both",
        "sepak_categories": ["u14_girls"],
        "tt_categories": ["a14_girls_doubles"],
    })
    assert clean2.get("sepak_categories") == ["u14_girls"]
    assert clean2.get("tt_categories") == ["a14_girls_doubles"]
