from __future__ import annotations

import pytest

from apps.forms.services.validation import AnswerError, validate_answers

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
