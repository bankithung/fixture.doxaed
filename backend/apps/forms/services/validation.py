"""Branching-aware answer validation. Walk the schema from the first section,
follow goto/next using the submitted answers, enforce required/type only on
fields actually reached AND visible. Drop answers to unreached/hidden fields so
branching can't be bypassed by posting hidden values."""
from __future__ import annotations

from typing import Any, cast

from apps.forms.constants import DISPLAY_TYPES
from apps.forms.services.fields import FieldError, validate_value


class AnswerError(ValueError):
    def __init__(self, errors: dict[str, str]):
        self.errors = errors
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))


def _visible(rule: dict | None, answers: dict) -> bool:
    if not rule:
        return True
    val = answers.get(rule["field"])
    op, target = rule["op"], rule.get("value")
    if op == "answered":
        return val not in (None, "", [], {})
    if op == "equals":
        return val == target
    if op == "not_equals":
        return val != target
    if op == "in":
        return val in (target or [])
    if op == "includes":
        return isinstance(val, list) and target in val
    if op == "gt":
        try:
            return float(cast(Any, val)) > float(cast(Any, target))
        except (TypeError, ValueError):
            return False
    if op == "lt":
        try:
            return float(cast(Any, val)) < float(cast(Any, target))
        except (TypeError, ValueError):
            return False
    return False


def _next_section(section: dict, answers: dict, sections: list[dict]) -> str | None:
    """Resolve the next section key. Resolution order (design spec §3.2): the
    chosen option's `goto`, else `section.next`, else the next section in array
    order; returns None past the last section (which ends the walk)."""
    for fld in section.get("fields", []):
        if fld.get("type") in ("single_choice", "dropdown"):
            chosen = answers.get(fld["key"])
            for o in fld.get("options", []):
                if str(o["value"]) == str(chosen) and o.get("goto"):
                    return o["goto"]
    nxt = section.get("next")
    if nxt is not None:
        return nxt
    # else: fall through to the next section in document order
    idx = next((i for i, s in enumerate(sections) if s["key"] == section["key"]), -1)
    if 0 <= idx < len(sections) - 1:
        return sections[idx + 1]["key"]
    return None


def _option_selected(fld: dict, option: dict, answers: dict) -> bool:
    """Is `option` of choice field `fld` currently chosen? Mirrors the frontend
    `optionSelected`: single_choice/dropdown by equality, multi_choice by
    membership. Drives nested-option descent."""
    a = answers.get(fld["key"])
    val = option.get("value")
    if isinstance(a, list):
        return any(str(x) == str(val) for x in a)
    return a is not None and str(a) == str(val)


def _check_group_bounds(fld: dict, raw: Any, path: str, errors: dict) -> None:
    """Enforce repeatable-group row bounds (min_items/max_items), recursing
    into child groups inside each row (W2-B: a 1v1 category's players group
    must hold exactly the configured squad). Bounds-less groups pass as
    before; a missing nested group counts as zero rows, so a team row that
    lists no players fails its squad minimum.

    Error paths: nested errors are keyed ``parent.<row>.child`` for
    repeatable parents and ``parent.child`` otherwise — and the public
    renderer maps any dotted key back onto its top-level field (review
    W2-F: dotted keys used to match nothing, failing with zero feedback)."""
    if fld.get("repeatable"):
        rows = raw if isinstance(raw, list) else (
            [] if raw in (None, "", {}) else [raw]
        )
        mn, mx = fld.get("min_items"), fld.get("max_items")
        if isinstance(mn, int) and mn > 0 and len(rows) < mn:
            errors[path] = "too_few_items"
        elif isinstance(mx, int) and mx > 0 and len(rows) > mx:
            errors[path] = "too_many_items"
        for child in fld.get("fields") or []:
            if child.get("type") != "group":
                continue
            for i, row in enumerate(rows):
                if isinstance(row, dict):
                    _check_group_bounds(
                        child, row.get(child["key"]),
                        f"{path}.{i}.{child['key']}", errors,
                    )
    else:
        row = raw if isinstance(raw, dict) else {}
        for child in fld.get("fields") or []:
            if child.get("type") == "group":
                _check_group_bounds(
                    child, row.get(child["key"]),
                    f"{path}.{child['key']}", errors,
                )


def _validate_fields(
    fields: list[dict], answers: dict, clean: dict, errors: dict
) -> None:
    """Validate a field list, descending into the nested follow-up fields of any
    SELECTED option (recursive). Unselected/hidden branches are skipped, so their
    answers are dropped — branching can't be bypassed by posting hidden values."""
    for fld in fields:
        ftype = fld["type"]
        if ftype in DISPLAY_TYPES:
            continue
        if not _visible(fld.get("visibility"), answers):
            continue
        key = fld["key"]
        raw = answers.get(key, None)
        empty = raw in (None, "", [], {})
        if empty:
            if fld.get("required"):
                errors[key] = "required"
            elif ftype == "group" and isinstance(fld.get("min_items"), int) \
                    and fld["min_items"] > 0 and fld.get("repeatable"):
                # An untouched group is zero rows — the minimum still applies
                # (review W2-F: empty used to pass while one row failed).
                errors[key] = "too_few_items"
            continue
        if ftype == "group":
            _check_group_bounds(fld, raw, key, errors)
            clean[key] = raw  # group deep-validation beyond bounds: follow-up
            continue
        try:
            clean[key] = validate_value(fld, raw)
        except FieldError as e:
            errors[key] = str(e)
            continue
        for o in fld.get("options", []) or []:
            if o.get("fields") and _option_selected(fld, o, answers):
                _validate_fields(o["fields"], answers, clean, errors)


def validate_answers(schema: dict, answers: dict) -> dict:
    """Return a cleaned answers dict (only reached+visible fields, coerced).
    Raise AnswerError(errors) on any validation failure."""
    sections = schema.get("sections", [])
    by_key = {s["key"]: s for s in sections}
    if not sections:
        return {}

    clean: dict[str, Any] = {}
    errors: dict[str, str] = {}
    visited: set[str] = set()
    current: str | None = sections[0]["key"]
    order_guard = 0

    while current and current != "_end" and order_guard < len(sections) + 1:
        order_guard += 1
        if current in visited:
            break  # cycle guard
        visited.add(current)
        section = by_key.get(current)
        if section is None:
            break

        if _visible(section.get("visibility"), answers):
            _validate_fields(section.get("fields", []), answers, clean, errors)

        current = _next_section(section, answers, sections)

    if errors:
        raise AnswerError(errors)
    return clean


def promote(schema: dict, clean: dict) -> dict:
    """Extract role->value (email/phone/name/title) for the FormResponse columns.
    Recurses into nested option fields so a promoted role can live anywhere."""
    out: dict[str, str] = {}

    def walk(fields: list[dict]) -> None:
        for fld in fields:
            role = fld.get("role")
            if role and fld["key"] in clean:
                out[role] = str(clean[fld["key"]])
            for o in fld.get("options", []) or []:
                walk(o.get("fields", []) or [])

    for sec in schema.get("sections", []):
        walk(sec.get("fields", []))
    return out
