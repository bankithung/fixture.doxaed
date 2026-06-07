"""Per-field-type coercion + validation. The single source of truth for what a
valid answer looks like. Add a type = add a handler here; no migration."""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from apps.forms.constants import CHOICE_TYPES, DISPLAY_TYPES

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE = re.compile(r"^[+0-9][0-9\-\s()]{5,31}$")
_ADDRESS_KEYS = {"line1", "line2", "city", "district", "state", "pincode"}


class FieldError(ValueError):
    """Raised when an answer is invalid for its field."""


def _opt_values(field: dict) -> set[str]:
    return {str(o["value"]) for o in field.get("options", [])}


def _validation(field: dict) -> dict:
    return field.get("validation") or {}


def _text(field: dict, value: Any) -> str:
    if not isinstance(value, str):
        raise FieldError("expected text")
    v = _validation(field)
    if "minLength" in v and len(value) < v["minLength"]:
        raise FieldError("too short")
    if "maxLength" in v and len(value) > v["maxLength"]:
        raise FieldError("too long")
    if "pattern" in v and not re.match(v["pattern"], value):
        raise FieldError("pattern mismatch")
    return value


def _email(field: dict, value: Any) -> str:
    s = _text(field, value)
    if not _EMAIL.match(s):
        raise FieldError("invalid email")
    return s


def _phone(field: dict, value: Any) -> str:
    s = _text(field, value)
    if not _PHONE.match(s):
        raise FieldError("invalid phone")
    return s


def _number(field: dict, value: Any) -> float | int:
    try:
        num = int(value) if str(value).strip().lstrip("-").isdigit() else float(value)
    except (TypeError, ValueError):
        raise FieldError("expected number") from None
    v = _validation(field)
    if "min" in v and num < v["min"]:
        raise FieldError("below min")
    if "max" in v and num > v["max"]:
        raise FieldError("above max")
    return num


def _single_choice(field: dict, value: Any) -> str:
    s = str(value)
    if s not in _opt_values(field):
        raise FieldError("not an allowed option")
    return s


def _multi_choice(field: dict, value: Any) -> list[str]:
    if not isinstance(value, list):
        raise FieldError("expected a list")
    allowed = _opt_values(field)
    out = [str(x) for x in value]
    if any(x not in allowed for x in out):
        raise FieldError("contains a disallowed option")
    v = _validation(field)
    if "maxSelections" in v and len(out) > v["maxSelections"]:
        raise FieldError("too many selections")
    if "minSelections" in v and len(out) < v["minSelections"]:
        raise FieldError("too few selections")
    return out


def _date(field: dict, value: Any) -> str:
    s = _text(field, value)
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        raise FieldError("expected YYYY-MM-DD")
    return s


def _time(field: dict, value: Any) -> str:
    s = _text(field, value)
    if not re.match(r"^\d{2}:\d{2}$", s):
        raise FieldError("expected HH:MM")
    return s


def _rating(field: dict, value: Any) -> int:
    num = _number(field, value)
    mx = _validation(field).get("max", 5)
    if not (0 <= num <= mx):
        raise FieldError("rating out of range")
    return int(num)


def _linear_scale(field: dict, value: Any) -> int:
    v = _validation(field)
    num = _number(field, value)
    if not (v.get("min", 1) <= num <= v.get("max", 10)):
        raise FieldError("scale out of range")
    return int(num)


def _address(field: dict, value: Any) -> dict:
    if not isinstance(value, dict):
        raise FieldError("expected an address object")
    if any(k not in _ADDRESS_KEYS for k in value):
        raise FieldError("unknown address key")
    return {k: str(v) for k, v in value.items()}


def _yes_no(field: dict, value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if str(value).lower() in {"yes", "true", "1"}:
        return True
    if str(value).lower() in {"no", "false", "0"}:
        return False
    raise FieldError("expected yes/no")


def _file_upload(field: dict, value: Any) -> list[str]:
    """Answer is a list of upload_ref UUID strings (validated against rows in the
    submit service, which checks they belong to this form)."""
    refs = value if isinstance(value, list) else [value]
    return [str(r) for r in refs]


_HANDLERS: dict[str, Callable[[dict, Any], Any]] = {
    "short_text": _text, "long_text": _text,
    "single_choice": _single_choice, "dropdown": _single_choice,
    "multi_choice": _multi_choice,
    "email": _email, "phone": _phone, "number": _number,
    "date": _date, "time": _time, "rating": _rating, "linear_scale": _linear_scale,
    "address": _address, "yes_no": _yes_no, "file_upload": _file_upload,
}


def validate_value(field: dict, value: Any) -> Any:
    """Coerce + validate a single answer. Raises FieldError on invalid input.
    `group` is handled by the validation walker, not here."""
    ftype = field["type"]
    if ftype in DISPLAY_TYPES:
        raise FieldError("display field takes no answer")
    if ftype == "group":
        raise FieldError("group handled by walker")
    handler = _HANDLERS.get(ftype)
    if handler is None:
        raise FieldError(f"unknown field type: {ftype}")
    return handler(field, value)


def has_options(ftype: str) -> bool:
    return ftype in CHOICE_TYPES
