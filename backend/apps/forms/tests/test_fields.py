from __future__ import annotations

import pytest

from apps.forms.services.fields import FieldError, validate_value


def f(type_, **kw):
    return {"key": "k", "type": type_, "label": "L", **kw}

def test_short_text_ok():
    assert validate_value(f("short_text"), "hi") == "hi"

def test_email_rejects_bad():
    with pytest.raises(FieldError):
        validate_value(f("email"), "not-an-email")

def test_email_ok():
    assert validate_value(f("email"), "a@b.com") == "a@b.com"

def test_number_coerces_and_bounds():
    assert validate_value(f("number", validation={"min": 1, "max": 10}), "5") == 5
    with pytest.raises(FieldError):
        validate_value(f("number", validation={"max": 3}), 9)

def test_single_choice_must_be_an_option():
    field = f("single_choice", options=[{"value": "a", "label": "A"}])
    assert validate_value(field, "a") == "a"
    with pytest.raises(FieldError):
        validate_value(field, "z")

def test_multi_choice_max_selections():
    field = f("multi_choice", options=[{"value": "a", "label": "A"}, {"value": "b", "label": "B"}],
              validation={"maxSelections": 1})
    assert validate_value(field, ["a"]) == ["a"]
    with pytest.raises(FieldError):
        validate_value(field, ["a", "b"])

def test_address_requires_dict_with_known_keys():
    val = {"line1": "1 Main", "city": "Kohima", "pincode": "797001"}
    assert validate_value(f("address"), val) == val
    with pytest.raises(FieldError):
        validate_value(f("address"), "flat string")
