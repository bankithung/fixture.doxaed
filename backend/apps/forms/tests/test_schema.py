from __future__ import annotations

import pytest

from apps.forms.services.schema import SchemaError, validate_schema


def _schema(sections):
    return {"version": 1, "sections": sections}


def test_valid_schema_ok():
    s = _schema([
        {"key": "s1", "title": "S1", "fields": [
            {"key": "name", "type": "short_text", "label": "Name"},
            {"key": "comp", "type": "single_choice", "label": "Comp",
             "options": [{"value": "a", "label": "A", "goto": "s2"}]},
        ]},
        {"key": "s2", "title": "S2", "fields": [
            {"key": "cats", "type": "multi_choice", "label": "Cats",
             "options": [{"value": "x", "label": "X"}]},
        ]},
    ])
    validate_schema(s)  # no raise


def test_duplicate_field_key_rejected():
    s = _schema([{"key": "s1", "title": "S1", "fields": [
        {"key": "dup", "type": "short_text", "label": "A"},
        {"key": "dup", "type": "short_text", "label": "B"},
    ]}])
    with pytest.raises(SchemaError):
        validate_schema(s)


def test_unknown_field_type_rejected():
    s = _schema([{"key": "s1", "title": "S1", "fields": [
        {"key": "k", "type": "wat", "label": "A"},
    ]}])
    with pytest.raises(SchemaError):
        validate_schema(s)


def test_goto_must_target_existing_section():
    s = _schema([{"key": "s1", "title": "S1", "fields": [
        {"key": "c", "type": "single_choice", "label": "C",
         "options": [{"value": "a", "label": "A", "goto": "nope"}]},
    ]}])
    with pytest.raises(SchemaError):
        validate_schema(s)


def test_visibility_must_reference_known_field():
    s = _schema([
        {"key": "s1", "title": "S1", "fields": [{"key": "a", "type": "short_text", "label": "A"}]},
        {"key": "s2", "title": "S2", "visibility": {"field": "ghost", "op": "equals", "value": "x"},
         "fields": [{"key": "b", "type": "short_text", "label": "B"}]},
    ])
    with pytest.raises(SchemaError):
        validate_schema(s)


def test_choice_field_needs_options():
    s = _schema([{"key": "s1", "title": "S1", "fields": [
        {"key": "c", "type": "single_choice", "label": "C"},
    ]}])
    with pytest.raises(SchemaError):
        validate_schema(s)


def test_nested_option_fields_validated_and_keys_unique():
    import pytest

    from apps.forms.services.schema import SchemaError, validate_schema

    good = {"version": 1, "sections": [
        {"key": "s", "title": "S", "fields": [
            {"key": "sport", "type": "single_choice", "label": "Sport", "options": [
                {"value": "fb", "label": "Football", "fields": [
                    {"key": "fmt", "type": "short_text", "label": "Format"},
                ]},
            ]},
        ]},
    ]}
    validate_schema(good)  # nested option fields are valid

    dupe = {"version": 1, "sections": [
        {"key": "s", "title": "S", "fields": [
            {"key": "shared", "type": "single_choice", "label": "X", "options": [
                {"value": "a", "label": "A", "fields": [
                    {"key": "shared", "type": "short_text", "label": "Y"},
                ]},
            ]},
        ]},
    ]}
    with pytest.raises(SchemaError):
        validate_schema(dupe)  # duplicate key across nesting is rejected


def test_all_builtin_templates_have_valid_schemas():
    from apps.forms.services.schema import validate_schema
    from apps.forms.services.templates import BUILTIN_TEMPLATES

    for t in BUILTIN_TEMPLATES:
        validate_schema(t["schema"])  # must not raise
