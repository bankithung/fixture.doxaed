"""Validate a Form.schema document before it is saved."""
from __future__ import annotations

from typing import Any

from apps.forms.constants import (
    CHOICE_TYPES,
    FIELD_TYPES,
    PROMOTED_ROLES,
    VISIBILITY_OPS,
)


class SchemaError(ValueError):
    """Raised when a form schema is structurally invalid."""


def _collect_fields(sections: list[dict]) -> dict[str, dict]:
    """Map field key -> field across all sections (and group children). Raises on dup."""
    seen: dict[str, dict] = {}

    def add(field: dict) -> None:
        key = field.get("key")
        if not key:
            raise SchemaError("field missing key")
        if key in seen:
            raise SchemaError(f"duplicate field key: {key}")
        seen[key] = field
        if field.get("type") == "group":
            for child in field.get("fields", []):
                add(child)
        for opt in field.get("options", []) or []:
            for child in opt.get("fields", []) or []:
                add(child)

    for sec in sections:
        for fld in sec.get("fields", []):
            add(fld)
    return seen


def _check_field(field: dict) -> None:
    ftype = field.get("type")
    if ftype not in FIELD_TYPES:
        raise SchemaError(f"unknown field type: {ftype}")
    if not field.get("label"):
        raise SchemaError(f"field {field.get('key')} missing label")
    if "role" in field and field["role"] not in PROMOTED_ROLES:
        raise SchemaError(f"unknown role: {field['role']}")
    if ftype == "group":
        mn, mx = field.get("min_items"), field.get("max_items")
        for v in (mn, mx):
            if v is not None and (isinstance(v, bool) or not isinstance(v, int) or v < 0):
                raise SchemaError(
                    f"{field.get('key')} min/max_items must be non-negative integers"
                )
        if isinstance(mn, int) and isinstance(mx, int) and mn > mx:
            raise SchemaError(f"{field.get('key')} min_items exceeds max_items")
    if ftype in CHOICE_TYPES:
        opts = field.get("options")
        # A data-bound choice (e.g. {"data_source": {"type": "institution_list"}})
        # is populated by the server at fetch time, so empty options are valid.
        if not opts:
            if field.get("data_source"):
                return
            raise SchemaError(f"{field['key']} needs options")
        if not isinstance(opts, list):
            raise SchemaError(f"{field['key']} needs options")
        for o in opts:
            if "value" not in o or "label" not in o:
                raise SchemaError("option needs value+label")


def _check_visibility(rule: Any, fields: dict[str, dict]) -> None:
    if rule is None:
        return
    if not isinstance(rule, dict) or "field" not in rule or "op" not in rule:
        raise SchemaError("visibility needs field+op")
    if rule["field"] not in fields:
        raise SchemaError(f"visibility references unknown field: {rule['field']}")
    if rule["op"] not in VISIBILITY_OPS:
        raise SchemaError(f"unknown visibility op: {rule['op']}")


def _check_field_tree(
    field: dict, section_keys: set[str], fields: dict[str, dict]
) -> None:
    """Validate a field, then recurse into each option's nested follow-up fields
    (the choice→sub-question nesting). Mirrors the renderer/validator descent."""
    _check_field(field)
    _check_visibility(field.get("visibility"), fields)
    for o in field.get("options", []) or []:
        goto = o.get("goto")
        if goto is not None and goto not in section_keys and goto != "_end":
            raise SchemaError(f"option.goto targets unknown section: {goto}")
        for child in o.get("fields", []) or []:
            _check_field_tree(child, section_keys, fields)


def validate_schema(schema: dict) -> None:
    """Raise SchemaError if invalid; return None if valid."""
    if not isinstance(schema, dict):
        raise SchemaError("schema must be an object")
    sections = schema.get("sections")
    if not isinstance(sections, list) or not sections:
        raise SchemaError("schema needs at least one section")

    keys = [s.get("key") for s in sections]
    if len(keys) != len(set(keys)) or not all(keys):
        raise SchemaError("section keys must be unique and non-empty")
    section_keys = set(keys)

    fields = _collect_fields(sections)

    for sec in sections:
        _check_visibility(sec.get("visibility"), fields)
        nxt = sec.get("next")
        if nxt is not None and nxt not in section_keys and nxt != "_end":
            raise SchemaError(f"section.next targets unknown section: {nxt}")
        for fld in sec.get("fields", []):
            _check_field_tree(fld, section_keys, fields)
