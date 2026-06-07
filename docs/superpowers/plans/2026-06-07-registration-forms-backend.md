# Registration Form Builder — Backend Implementation Plan (Increments 1–5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend of a data-driven, Google-Forms-style registration form engine in a new `apps/forms` app: a JSONB form schema interpreted at runtime, a branching-aware validation service, builder + public submission APIs, and purpose-driven entity mapping that reuses `register_school` for Stage-2.

**Architecture:** New Django app `apps/forms`. `Form.schema` (JSONB) holds sections→fields→branching; `FormResponse.answers` (JSONB) holds submissions with promoted indexed columns (email/phone/name/title). Validation walks the schema following branching and enforces `required` only on reachable+visible fields. Mapping dispatches by `Form.purpose`; `team_registration` calls the existing `apps/teams/services/registration.py::register_school`. Mirrors the existing data-driven `Tournament.rules`/`constraints` pattern.

**Tech Stack:** Django 5, DRF, Postgres JSONB, pytest. Reuses: `apps.accounts.models.uuid7`, `apps.audit.services.emit_audit`, `apps.tournaments.scope.accessible_tournaments`, `apps.tournaments.permissions.can_manage_tournament`, `apps.tournaments.services.create.create_tournament` (tests), throttle pattern from `apps.teams.throttling`.

**Spec:** `docs/superpowers/specs/2026-06-07-registration-form-builder-design.md`

**Test command (always pass `-c`):**
```bash
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms -q
```

---

## File Structure (what gets created/modified)

```
backend/apps/forms/
  __init__.py
  apps.py                         # FormsConfig
  models.py                       # Form, FormResponse, FormShareLink, FormFileUpload
  admin.py                        # minimal registrations (dev convenience)
  urls.py                         # /api/forms/... routes
  views.py                        # builder + public + responses views
  serializers.py                  # FormSerializer, FormSchemaSerializer, FormResponseSerializer
  throttling.py                   # PublicFormThrottle (per-IP)
  constants.py                    # FieldType, FormStatus, FormPurpose, ResponseStatus, VISIBILITY_OPS
  services/
    __init__.py
    fields.py                     # field-type registry (coerce/validate per type)
    schema.py                     # validate_schema(schema)
    validation.py                 # validate_answers(form, answers) — branching-aware
    forms.py                      # create_form, update_form, publish/close/duplicate, edit-freeze
    responses.py                  # submit_response (idempotent), export
    links.py                      # create_share_link, resolve_share_link (generalizes RegistrationLink)
    mapping.py                    # map_response (dispatch by purpose) + send_stage2
  migrations/0001_initial.py
  tests/
    test_models.py  test_fields.py  test_schema.py  test_validation.py
    test_builder_api.py  test_public_api.py  test_freeze.py  test_mapping.py
    test_isolation.py  test_idempotency.py

backend/fixture/settings/base.py  # add "apps.forms" to LOCAL_APPS (after "apps.teams", line ~56)
backend/fixture/urls.py           # add path("forms/", include("apps.forms.urls")) to api_v1
backend/apps/tournaments/urls.py  # add path("<uuid:tournament_id>/forms/", TournamentFormsView.as_view())
backend/apps/permissions/fixtures/modules.json  # add "forms" module (22 -> 23)
```

---

# Increment 1 — App + models + migrations

### Task 1.1: Scaffold the app and register it

**Files:**
- Create: `backend/apps/forms/__init__.py` (empty)
- Create: `backend/apps/forms/apps.py`
- Create: `backend/apps/forms/models.py` (empty for now: `# models added in Task 1.2`)
- Modify: `backend/fixture/settings/base.py` (LOCAL_APPS, after `"apps.teams",`)

- [ ] **Step 1: Create `apps.py`**
```python
from django.apps import AppConfig


class FormsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.forms"
    verbose_name = "Registration forms"
```

- [ ] **Step 2: Register in `LOCAL_APPS`** — add `"apps.forms",` immediately after `"apps.teams",` in `backend/fixture/settings/base.py`.

- [ ] **Step 3: Verify Django sees the app**

Run: `backend/.venv/Scripts/python.exe backend/manage.py check`
Expected: `System check identified no issues`.

- [ ] **Step 4: Commit**
```bash
git add backend/apps/forms/__init__.py backend/apps/forms/apps.py backend/apps/forms/models.py backend/fixture/settings/base.py
git commit -m "feat(forms): scaffold apps.forms and register it"
```

---

### Task 1.2: Constants enums

**Files:**
- Create: `backend/apps/forms/constants.py`

- [ ] **Step 1: Write the enums + op list** (complete file)
```python
from __future__ import annotations

from django.db import models
from django.utils.translation import gettext_lazy as _


class FormStatus(models.TextChoices):
    DRAFT = "draft", _("Draft")
    OPEN = "open", _("Open")
    CLOSED = "closed", _("Closed")


class FormPurpose(models.TextChoices):
    ORGANIZATION_REGISTRATION = "organization_registration", _("Organization registration")
    TEAM_REGISTRATION = "team_registration", _("Team registration")
    GENERIC = "generic", _("Generic")


class ResponseStatus(models.TextChoices):
    SUBMITTED = "submitted", _("Submitted")
    ACCEPTED = "accepted", _("Accepted")
    REJECTED = "rejected", _("Rejected")
    WAITLISTED = "waitlisted", _("Waitlisted")


# Field types whose answers are simple scalars/lists. The registry in
# services/fields.py is the source of truth for coerce/validate behaviour.
FIELD_TYPES = frozenset({
    "short_text", "long_text", "single_choice", "multi_choice", "dropdown",
    "email", "phone", "number", "date", "time", "rating", "linear_scale",
    "address", "file_upload", "section_text", "yes_no", "group",
})

# Field types that carry an `options` array.
CHOICE_TYPES = frozenset({"single_choice", "multi_choice", "dropdown"})

# Display-only types that never produce an answer.
DISPLAY_TYPES = frozenset({"section_text"})

# Visibility rule operators (see services/validation.py).
VISIBILITY_OPS = frozenset({
    "equals", "not_equals", "in", "includes", "gt", "lt", "answered",
})

# Roles that promote an answer onto a FormResponse column.
PROMOTED_ROLES = frozenset({"email", "phone", "name", "title"})
```

- [ ] **Step 2: Commit**
```bash
git add backend/apps/forms/constants.py
git commit -m "feat(forms): field/status/purpose enums + visibility ops"
```

---

### Task 1.3: The four models

**Files:**
- Modify: `backend/apps/forms/models.py`

- [ ] **Step 1: Write all four models** (complete file)
```python
"""Registration form engine — data-driven (FET-style) forms.

`Form.schema` (JSONB) is the form definition; `FormResponse.answers` (JSONB)
the submission. Mirrors the Tournament.rules/constraints JSONB pattern. All
models are org-scoped (invariant #2) with UUID v7 PKs (invariant #1).
"""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q, UniqueConstraint

from apps.accounts.models import uuid7
from apps.forms.constants import FormPurpose, FormStatus, ResponseStatus


class Form(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="forms"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="forms"
    )
    slug = models.CharField(max_length=63)
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    purpose = models.CharField(
        max_length=32, choices=FormPurpose.choices, default=FormPurpose.GENERIC
    )
    schema = models.JSONField(default=dict, blank=True)
    status = models.CharField(
        max_length=12, choices=FormStatus.choices, default=FormStatus.DRAFT, db_index=True
    )
    opens_at = models.DateTimeField(null=True, blank=True)
    closes_at = models.DateTimeField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)
    max_responses = models.PositiveIntegerField(null=True, blank=True)
    response_count = models.PositiveIntegerField(default=0)
    confirmation_message = models.TextField(blank=True)
    settings = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="forms_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "forms_form"
        constraints = [
            UniqueConstraint(
                fields=["tournament", "slug"],
                condition=Q(deleted_at__isnull=True),
                name="unique_form_slug_per_tournament",
            ),
        ]
        indexes = [models.Index(fields=["tournament", "status"], name="form_trn_status_idx")]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.title} ({self.slug})"


class FormShareLink(models.Model):
    """Public access token for a form (generalizes teams.RegistrationLink)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="form_share_links"
    )
    form = models.ForeignKey(Form, on_delete=models.CASCADE, related_name="share_links")
    token_hash = models.CharField(max_length=128, db_index=True)
    label = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    max_submissions = models.PositiveIntegerField(null=True, blank=True)
    submission_count = models.PositiveIntegerField(default=0)
    bound_entity = models.JSONField(default=dict, blank=True)
    prefill = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="form_share_links_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "forms_share_link"

    def __str__(self) -> str:  # pragma: no cover
        return f"FormShareLink({self.form_id})"


class FormResponse(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    form = models.ForeignKey(Form, on_delete=models.CASCADE, related_name="responses")
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="form_responses"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="form_responses"
    )
    answers = models.JSONField(default=dict, blank=True)
    form_version = models.PositiveIntegerField(default=1)
    respondent_email = models.CharField(max_length=254, blank=True, db_index=True)
    respondent_phone = models.CharField(max_length=32, blank=True, db_index=True)
    respondent_name = models.CharField(max_length=200, blank=True)
    title = models.CharField(max_length=200, blank=True, db_index=True)
    status = models.CharField(
        max_length=12, choices=ResponseStatus.choices,
        default=ResponseStatus.SUBMITTED, db_index=True,
    )
    event_id = models.UUIDField(null=True, blank=True)
    submitted_via = models.ForeignKey(
        FormShareLink, null=True, blank=True, on_delete=models.SET_NULL, related_name="responses"
    )
    mapped_entities = models.JSONField(default=dict, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "forms_response"
        constraints = [
            UniqueConstraint(
                fields=["form", "event_id"],
                condition=Q(event_id__isnull=False),
                name="unique_form_response_event_id",
            ),
        ]
        indexes = [
            models.Index(fields=["form", "status"], name="resp_form_status_idx"),
            models.Index(fields=["form", "created_at"], name="resp_form_created_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"FormResponse({self.form_id})"


class FormFileUpload(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="form_uploads"
    )
    form = models.ForeignKey(Form, on_delete=models.CASCADE, related_name="uploads")
    response = models.ForeignKey(
        FormResponse, null=True, blank=True, on_delete=models.SET_NULL, related_name="files"
    )
    field_key = models.CharField(max_length=80)
    upload_ref = models.UUIDField(default=uuid7, db_index=True, editable=False)
    file = models.FileField(upload_to="form_uploads/%Y/%m/")
    original_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=127)
    size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "forms_file_upload"

    def __str__(self) -> str:  # pragma: no cover
        return self.original_name
```

- [ ] **Step 2: Make migrations**

Run: `backend/.venv/Scripts/python.exe backend/manage.py makemigrations forms`
Expected: creates `backend/apps/forms/migrations/0001_initial.py` with the four models.

- [ ] **Step 3: Apply migrations**

Run: `backend/.venv/Scripts/python.exe backend/manage.py migrate forms`
Expected: `Applying forms.0001_initial... OK`.

- [ ] **Step 4: Commit**
```bash
git add backend/apps/forms/models.py backend/apps/forms/migrations/0001_initial.py
git commit -m "feat(forms): Form, FormResponse, FormShareLink, FormFileUpload models"
```

---

### Task 1.4: Model constraint + multi-tenancy tests

**Files:**
- Create: `backend/apps/forms/tests/__init__.py` (empty)
- Create: `backend/apps/forms/tests/test_models.py`

- [ ] **Step 1: Write the failing tests**
```python
"""TDD — forms model constraints + scoping."""
from __future__ import annotations

import pytest
from django.db import IntegrityError
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.forms.constants import FormStatus
from apps.forms.models import Form, FormResponse
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _form(t, **kw) -> Form:
    return Form.objects.create(
        organization=t.organization, tournament=t,
        slug=kw.pop("slug", "reg"), title=kw.pop("title", "Registration"), **kw,
    )


def test_form_defaults():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    assert f.status == FormStatus.DRAFT
    assert f.version == 1 and f.response_count == 0
    assert f.schema == {} and f.settings == {}


def test_unique_slug_per_tournament():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    _form(t, slug="reg")
    with pytest.raises(IntegrityError):
        _form(t, slug="reg", title="Dup")


def test_response_event_id_unique_per_form():
    import uuid
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    eid = uuid.uuid4()
    FormResponse.objects.create(form=f, organization=t.organization, tournament=t, event_id=eid)
    with pytest.raises(IntegrityError):
        FormResponse.objects.create(form=f, organization=t.organization, tournament=t, event_id=eid)
```

- [ ] **Step 2: Run tests to verify they pass** (models already exist)

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_models.py -q`
Expected: 3 passed.

- [ ] **Step 3: Commit**
```bash
git add backend/apps/forms/tests/
git commit -m "test(forms): model constraints + defaults"
```

---

# Increment 2 — Schema + answer validation service

### Task 2.1: Field-type registry

**Files:**
- Create: `backend/apps/forms/services/__init__.py` (empty)
- Create: `backend/apps/forms/services/fields.py`
- Create: `backend/apps/forms/tests/test_fields.py`

- [ ] **Step 1: Write failing tests**
```python
from __future__ import annotations

import pytest

from apps.forms.services.fields import validate_value, FieldError

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
```

- [ ] **Step 2: Run to verify fail**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_fields.py -q`
Expected: ImportError / FAIL.

- [ ] **Step 3: Implement `services/fields.py`** (complete file)
```python
"""Per-field-type coercion + validation. The single source of truth for what a
valid answer looks like. Add a type = add a handler here; no migration."""
from __future__ import annotations

import re
from typing import Any, Callable

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
        raise FieldError("expected number")
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_fields.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**
```bash
git add backend/apps/forms/services/__init__.py backend/apps/forms/services/fields.py backend/apps/forms/tests/test_fields.py
git commit -m "feat(forms): field-type registry with per-type validation"
```

---

### Task 2.2: Schema validation

**Files:**
- Create: `backend/apps/forms/services/schema.py`
- Create: `backend/apps/forms/tests/test_schema.py`

- [ ] **Step 1: Write failing tests**
```python
from __future__ import annotations

import pytest

from apps.forms.services.schema import validate_schema, SchemaError


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
```

- [ ] **Step 2: Run to verify fail**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_schema.py -q`
Expected: ImportError / FAIL.

- [ ] **Step 3: Implement `services/schema.py`** (complete file)
```python
"""Validate a Form.schema document before it is saved."""
from __future__ import annotations

from typing import Any

from apps.forms.constants import (
    CHOICE_TYPES, FIELD_TYPES, PROMOTED_ROLES, VISIBILITY_OPS,
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
    if ftype in CHOICE_TYPES:
        opts = field.get("options")
        if not opts or not isinstance(opts, list):
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
            _check_field(fld)
            _check_visibility(fld.get("visibility"), fields)
            for o in fld.get("options", []):
                goto = o.get("goto")
                if goto is not None and goto not in section_keys and goto != "_end":
                    raise SchemaError(f"option.goto targets unknown section: {goto}")
```

- [ ] **Step 4: Run to verify pass**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_schema.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**
```bash
git add backend/apps/forms/services/schema.py backend/apps/forms/tests/test_schema.py
git commit -m "feat(forms): schema validation (keys, types, goto/visibility targets)"
```

---

### Task 2.3: Branching-aware answer validation

**Files:**
- Create: `backend/apps/forms/services/validation.py`
- Create: `backend/apps/forms/tests/test_validation.py`

- [ ] **Step 1: Write failing tests**
```python
from __future__ import annotations

import pytest

from apps.forms.services.validation import validate_answers, AnswerError

SCHEMA = {"version": 1, "sections": [
    {"key": "school", "title": "School", "fields": [
        {"key": "school_name", "type": "short_text", "label": "School", "required": True, "role": "title"},
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
```

- [ ] **Step 2: Run to verify fail**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_validation.py -q`
Expected: ImportError / FAIL.

- [ ] **Step 3: Implement `services/validation.py`** (complete file)
```python
"""Branching-aware answer validation. Walk the schema from the first section,
follow goto/next using the submitted answers, enforce required/type only on
fields actually reached AND visible. Drop answers to unreached/hidden fields so
branching can't be bypassed by posting hidden values."""
from __future__ import annotations

from typing import Any

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
            return float(val) > float(target)
        except (TypeError, ValueError):
            return False
    if op == "lt":
        try:
            return float(val) < float(target)
        except (TypeError, ValueError):
            return False
    return False


def _next_section(section: dict, answers: dict, sections: list[dict]) -> str | None:
    """Resolve the next section key: the chosen option's goto, else section.next,
    else the next section in document order; None when there is no next."""
    for fld in section.get("fields", []):
        if fld.get("type") in ("single_choice", "dropdown"):
            chosen = answers.get(fld["key"])
            for o in fld.get("options", []):
                if str(o["value"]) == str(chosen) and o.get("goto"):
                    return o["goto"]
    if section.get("next"):
        return section["next"]
    keys = [s["key"] for s in sections]
    idx = keys.index(section["key"])
    return keys[idx + 1] if idx + 1 < len(keys) else None


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
            for fld in section.get("fields", []):
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
                    continue
                if ftype == "group":
                    clean[key] = raw  # group deep-validation: follow-up; store as-is for v1
                    continue
                try:
                    clean[key] = validate_value(fld, raw)
                except FieldError as e:
                    errors[key] = str(e)

        current = _next_section(section, answers, sections)

    if errors:
        raise AnswerError(errors)
    return clean


def promote(schema: dict, clean: dict) -> dict:
    """Extract role->value (email/phone/name/title) for the FormResponse columns."""
    out: dict[str, str] = {}
    for sec in schema.get("sections", []):
        for fld in sec.get("fields", []):
            role = fld.get("role")
            if role and fld["key"] in clean:
                out[role] = str(clean[fld["key"]])
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_validation.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**
```bash
git add backend/apps/forms/services/validation.py backend/apps/forms/tests/test_validation.py
git commit -m "feat(forms): branching-aware answer validation + role promotion"
```

---

# Increment 3 — Builder API (CRUD + lifecycle + module)

### Task 3.1: Add the `forms` RBAC module

**Files:**
- Modify: `backend/apps/permissions/fixtures/modules.json`

- [ ] **Step 1: Inspect the existing catalog** — `Read backend/apps/permissions/fixtures/modules.json` to copy the exact object shape (code/label/category/default roles keys).

- [ ] **Step 2: Add a `forms` entry** following that exact shape, e.g.:
```jsonc
{ "code": "forms", "label": "Registration forms", "category": "<match existing>",
  "default_roles": ["admin", "co_organizer"] }   // mirror an existing manage-type module's role keys
```

- [ ] **Step 3: Load it**

Run: `backend/.venv/Scripts/python.exe backend/manage.py load_modules`
Expected: `... created: 1, updated: 22, total in DB: 23.`

- [ ] **Step 4: Commit**
```bash
git add backend/apps/permissions/fixtures/modules.json
git commit -m "feat(forms): add 'forms' RBAC module to the catalog (23 total)"
```

---

### Task 3.2: Form service (create/update/lifecycle/freeze)

**Files:**
- Create: `backend/apps/forms/services/forms.py`
- Create: `backend/apps/forms/tests/test_freeze.py`

- [ ] **Step 1: Write failing tests** (lifecycle + edit-freeze)
```python
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.forms.constants import FormStatus
from apps.forms.models import Form, FormResponse
from apps.forms.services.forms import publish_form, update_form, FormEditError
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEMA = {"version": 1, "sections": [
    {"key": "s", "title": "S", "fields": [
        {"key": "name", "type": "short_text", "label": "Name", "required": True}]}]}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now(); u.save(update_fields=["email_verified_at"]); return u


def _form(t):
    return Form.objects.create(organization=t.organization, tournament=t, slug="reg",
                               title="Reg", schema=SCHEMA)


def test_publish_sets_open_and_opens_at():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    publish_form(f, user=t.created_by)
    f.refresh_from_db()
    assert f.status == FormStatus.OPEN and f.opens_at is not None


def test_safe_edit_allowed_after_responses():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    FormResponse.objects.create(form=f, organization=t.organization, tournament=t)
    f.response_count = 1; f.save(update_fields=["response_count"])
    # editing a label is safe
    new = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
        {"key": "name", "type": "short_text", "label": "Full name", "required": True}]}]}
    update_form(f, {"schema": new}, user=t.created_by)
    f.refresh_from_db(); assert f.schema["sections"][0]["fields"][0]["label"] == "Full name"


def test_destructive_edit_after_responses_bumps_version():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    FormResponse.objects.create(form=f, organization=t.organization, tournament=t)
    f.response_count = 1; f.save(update_fields=["response_count"])
    # removing the field that has answers is destructive -> version bump (allowed, warned)
    removed = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
        {"key": "other", "type": "short_text", "label": "Other"}]}]}
    update_form(f, {"schema": removed}, user=t.created_by)
    f.refresh_from_db(); assert f.version == 2
```

- [ ] **Step 2: Run to verify fail**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_freeze.py -q`
Expected: ImportError / FAIL.

- [ ] **Step 3: Implement `services/forms.py`** (complete file)
```python
"""Form lifecycle + edit-freeze. Schema is validated on every write."""
from __future__ import annotations

import re
import secrets

from django.utils import timezone

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.forms.constants import FormStatus
from apps.forms.models import Form
from apps.forms.services.schema import validate_schema

_SCRUB = re.compile(r"[^a-z0-9-]+")


class FormEditError(ValueError):
    pass


def _slugify(raw: str) -> str:
    return _SCRUB.sub("-", (raw or "").strip().lower()).strip("-")[:63] or "form"


def _unique_slug(tournament, title: str) -> str:
    base = _slugify(title)
    slug, n = base, 2
    while Form.objects.filter(tournament=tournament, slug=slug, deleted_at__isnull=True).exists():
        slug = f"{base}-{n}"[:63]
        n += 1
    return slug


def create_form(*, tournament, title, purpose, schema=None, created_by=None, request=None) -> Form:
    schema = schema or {"version": 1, "sections": []}
    if schema.get("sections"):
        validate_schema(schema)
    form = Form.objects.create(
        organization=tournament.organization, tournament=tournament,
        slug=_unique_slug(tournament, title), title=title[:200],
        purpose=purpose, schema=schema, created_by=created_by,
    )
    emit_audit(actor_user=created_by, actor_role=ActorRole.SYSTEM, event_type="form_created",
               target_type="form", target_id=form.id, organization_id=tournament.organization_id,
               payload_after={"title": form.title, "purpose": form.purpose}, request=request)
    return form


def _answered_keys(form: Form) -> set[str]:
    keys: set[str] = set()
    for r in form.responses.all().only("answers"):
        keys |= set(r.answers.keys())
    return keys


def _schema_field_keys(schema: dict) -> set[str]:
    out: set[str] = set()
    for sec in schema.get("sections", []):
        for fld in sec.get("fields", []):
            out.add(fld["key"])
    return out


def update_form(form: Form, data: dict, *, user=None, request=None) -> Form:
    """Apply a partial update. If schema changes after responses exist, a
    destructive change (removing/retyping an answered field) bumps `version`."""
    changed = []
    if "schema" in data and data["schema"] is not None:
        new_schema = data["schema"]
        validate_schema(new_schema)
        if form.response_count > 0:
            answered = _answered_keys(form)
            new_keys = _schema_field_keys(new_schema)
            if answered - new_keys:  # an answered field disappeared -> destructive
                form.version += 1
                changed.append("version")
        form.schema = new_schema
        changed.append("schema")
    for f in ("title", "description", "confirmation_message", "closes_at", "opens_at",
              "max_responses", "settings"):
        if f in data:
            setattr(form, f, data[f])
            changed.append(f)
    if changed:
        form.save(update_fields=list({*changed, "updated_at"}))
        emit_audit(actor_user=user, actor_role=ActorRole.SYSTEM, event_type="form_updated",
                   target_type="form", target_id=form.id, organization_id=form.organization_id,
                   payload_after={"changed": changed}, request=request)
    return form


def publish_form(form: Form, *, user=None, request=None) -> Form:
    if not form.schema.get("sections"):
        raise FormEditError("cannot publish an empty form")
    validate_schema(form.schema)
    form.status = FormStatus.OPEN
    if form.opens_at is None:
        form.opens_at = timezone.now()
    form.save(update_fields=["status", "opens_at", "updated_at"])
    emit_audit(actor_user=user, actor_role=ActorRole.SYSTEM, event_type="form_published",
               target_type="form", target_id=form.id, organization_id=form.organization_id,
               request=request)
    return form


def close_form(form: Form, *, user=None, request=None) -> Form:
    form.status = FormStatus.CLOSED
    form.save(update_fields=["status", "updated_at"])
    emit_audit(actor_user=user, actor_role=ActorRole.SYSTEM, event_type="form_closed",
               target_type="form", target_id=form.id, organization_id=form.organization_id,
               request=request)
    return form


def duplicate_form(form: Form, *, user=None) -> Form:
    return Form.objects.create(
        organization=form.organization, tournament=form.tournament,
        slug=_unique_slug(form.tournament, f"{form.title} copy"),
        title=f"{form.title} (copy)", description=form.description, purpose=form.purpose,
        schema=form.schema, confirmation_message=form.confirmation_message,
        settings=form.settings, created_by=user,
    )


def is_open(form: Form) -> bool:
    now = timezone.now()
    if form.status != FormStatus.OPEN:
        return False
    if form.opens_at and now < form.opens_at:
        return False
    if form.closes_at and now >= form.closes_at:
        return False
    return True
```

- [ ] **Step 4: Run to verify pass**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_freeze.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**
```bash
git add backend/apps/forms/services/forms.py backend/apps/forms/tests/test_freeze.py
git commit -m "feat(forms): form lifecycle service (create/update/publish/close/duplicate + edit-freeze)"
```

---

### Task 3.3: Serializers

**Files:**
- Create: `backend/apps/forms/serializers.py`

- [ ] **Step 1: Implement serializers** (complete file)
```python
from __future__ import annotations

from rest_framework import serializers

from apps.forms.models import Form, FormResponse
from apps.forms.services.schema import SchemaError, validate_schema


class FormSchemaField(serializers.JSONField):
    def to_internal_value(self, data):
        data = super().to_internal_value(data)
        try:
            if data.get("sections"):
                validate_schema(data)
        except SchemaError as e:
            raise serializers.ValidationError(str(e))
        return data


class FormSerializer(serializers.ModelSerializer):
    schema = FormSchemaField(required=False)

    class Meta:
        model = Form
        fields = [
            "id", "slug", "title", "description", "purpose", "schema", "status",
            "opens_at", "closes_at", "version", "max_responses", "response_count",
            "confirmation_message", "settings", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "slug", "status", "version", "response_count",
                            "created_at", "updated_at"]


class FormCreateSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200)
    purpose = serializers.ChoiceField(
        choices=["organization_registration", "team_registration", "generic"],
        default="organization_registration",
    )
    schema = FormSchemaField(required=False)


class FormResponseSerializer(serializers.ModelSerializer):
    class Meta:
        model = FormResponse
        fields = ["id", "answers", "form_version", "respondent_email", "respondent_phone",
                  "respondent_name", "title", "status", "mapped_entities", "created_at"]
        read_only_fields = fields


class PublicSubmitSerializer(serializers.Serializer):
    answers = serializers.DictField()
    event_id = serializers.UUIDField(required=False)
    upload_refs = serializers.DictField(required=False, default=dict)
```

- [ ] **Step 2: Sanity import check**

Run: `backend/.venv/Scripts/python.exe -c "import os,django;os.environ.setdefault('DJANGO_SETTINGS_MODULE','fixture.settings.dev');import sys;sys.path.insert(0,'backend');django.setup();import apps.forms.serializers;print('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**
```bash
git add backend/apps/forms/serializers.py
git commit -m "feat(forms): serializers (schema-validating Form + response + submit)"
```

---

### Task 3.4: Builder views + URLs

**Files:**
- Create: `backend/apps/forms/views.py`
- Create: `backend/apps/forms/urls.py`
- Modify: `backend/fixture/urls.py` (add `path("forms/", include("apps.forms.urls"))` to `api_v1`)
- Modify: `backend/apps/tournaments/urls.py` (add tournament-scoped list/create)
- Create: `backend/apps/forms/tests/test_builder_api.py`
- Create: `backend/apps/forms/tests/test_isolation.py`

- [ ] **Step 1: Write failing API tests**
```python
# test_builder_api.py
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEMA = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
    {"key": "name", "type": "short_text", "label": "Name", "required": True, "role": "title"}]}]}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now(); u.save(update_fields=["email_verified_at"]); return u


def test_create_list_and_publish_form():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = APIClient(); c.force_authenticate(user=admin)

    r = c.post(f"/api/tournaments/{t.id}/forms/",
               {"title": "School registration", "purpose": "organization_registration"}, format="json")
    assert r.status_code == 201, r.content
    fid = r.json()["id"]

    r = c.patch(f"/api/forms/{fid}/", {"schema": SCHEMA}, format="json")
    assert r.status_code == 200, r.content

    r = c.post(f"/api/forms/{fid}:publish/", {}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "open"

    r = c.get(f"/api/tournaments/{t.id}/forms/")
    assert r.status_code == 200 and len(r.json()) == 1


def test_field_types_catalog_is_public_to_authed():
    admin = _verified("a@test.local")
    c = APIClient(); c.force_authenticate(user=admin)
    r = c.get("/api/forms/field-types/")
    assert r.status_code == 200
    assert any(ft["type"] == "single_choice" for ft in r.json())
```

```python
# test_isolation.py — cross-org 404, no leak (invariant #2)
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now(); u.save(update_fields=["email_verified_at"]); return u


def test_outsider_cannot_read_form_404():
    owner = _verified("owner@test.local")
    t = create_tournament(user=owner, name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R")
    outsider = _verified("out@test.local")
    c = APIClient(); c.force_authenticate(user=outsider)
    assert c.get(f"/api/forms/{f.id}/").status_code == 404
    assert c.patch(f"/api/forms/{f.id}/", {"title": "x"}, format="json").status_code == 404


def test_outsider_cannot_create_form_on_others_tournament():
    owner = _verified("owner@test.local")
    t = create_tournament(user=owner, name="Cup")
    outsider = _verified("out@test.local")
    c = APIClient(); c.force_authenticate(user=outsider)
    r = c.post(f"/api/tournaments/{t.id}/forms/", {"title": "X", "purpose": "generic"}, format="json")
    assert r.status_code in (403, 404)
```

- [ ] **Step 2: Run to verify fail**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_builder_api.py backend/apps/forms/tests/test_isolation.py -q`
Expected: 404/endpoint-missing FAIL.

- [ ] **Step 3: Implement `views.py`** (builder portion — complete)
```python
from __future__ import annotations

from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.forms.constants import CHOICE_TYPES, FIELD_TYPES
from apps.forms.models import Form
from apps.forms.serializers import FormCreateSerializer, FormSerializer
from apps.forms.services.forms import (
    close_form, create_form, duplicate_form, publish_form, update_form,
)
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


def _get_manageable_tournament(user, tournament_id):
    t = Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True).first()
    if t is None or not accessible_tournaments(user).filter(id=tournament_id).exists():
        raise NotFound("tournament_not_found")
    if not can_manage_tournament(user, t):
        raise PermissionDenied("not_tournament_manager")
    return t


def _get_manageable_form(user, form_id):
    f = Form.objects.filter(id=form_id, deleted_at__isnull=True).select_related(
        "tournament", "organization").first()
    if f is None or not accessible_tournaments(user).filter(id=f.tournament_id).exists():
        raise NotFound("form_not_found")
    if not can_manage_tournament(user, f.tournament):
        raise PermissionDenied("not_tournament_manager")
    return f


class TournamentFormsView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        qs = Form.objects.filter(tournament_id=tournament_id, deleted_at__isnull=True).order_by("-created_at")
        return Response(FormSerializer(qs, many=True).data)

    def post(self, request, tournament_id):
        t = _get_manageable_tournament(request.user, tournament_id)
        ser = FormCreateSerializer(data=request.data); ser.is_valid(raise_exception=True)
        form = create_form(tournament=t, title=ser.validated_data["title"],
                           purpose=ser.validated_data["purpose"],
                           schema=ser.validated_data.get("schema"),
                           created_by=request.user, request=request)
        return Response(FormSerializer(form).data, status=201)


class FormDetailView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, form_id):
        return Response(FormSerializer(_get_manageable_form(request.user, form_id)).data)

    def patch(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        ser = FormSerializer(form, data=request.data, partial=True); ser.is_valid(raise_exception=True)
        update_form(form, ser.validated_data, user=request.user, request=request)
        return Response(FormSerializer(form).data)

    def delete(self, request, form_id):
        from django.utils import timezone
        form = _get_manageable_form(request.user, form_id)
        form.deleted_at = timezone.now(); form.save(update_fields=["deleted_at"])
        return Response(status=204)


class FormPublishView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, form_id):
        form = publish_form(_get_manageable_form(request.user, form_id), user=request.user, request=request)
        return Response(FormSerializer(form).data)


class FormCloseView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, form_id):
        form = close_form(_get_manageable_form(request.user, form_id), user=request.user, request=request)
        return Response(FormSerializer(form).data)


class FormDuplicateView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, form_id):
        src = _get_manageable_form(request.user, form_id)
        return Response(FormSerializer(duplicate_form(src, user=request.user)).data, status=201)


class FieldTypesView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response([
            {"type": ft, "has_options": ft in CHOICE_TYPES} for ft in sorted(FIELD_TYPES)
        ])
```

- [ ] **Step 4: Implement `urls.py`**
```python
from __future__ import annotations

from django.urls import path

from apps.forms.views import (
    FieldTypesView, FormCloseView, FormDetailView, FormDuplicateView, FormPublishView,
)

# Mounted at /api/forms/
urlpatterns = [
    path("field-types/", FieldTypesView.as_view(), name="form-field-types"),
    path("<uuid:form_id>/", FormDetailView.as_view(), name="form-detail"),
    path("<uuid:form_id>:publish/", FormPublishView.as_view(), name="form-publish"),
    path("<uuid:form_id>:close/", FormCloseView.as_view(), name="form-close"),
    path("<uuid:form_id>:duplicate/", FormDuplicateView.as_view(), name="form-duplicate"),
]
```

- [ ] **Step 5: Wire into project URLs** — in `backend/fixture/urls.py` `api_v1`, after the `register/` line add:
```python
    path("forms/", include("apps.forms.urls")),
```
And in `backend/apps/tournaments/urls.py` add (import `from apps.forms.views import TournamentFormsView`):
```python
    path("<uuid:tournament_id>/forms/", TournamentFormsView.as_view(), name="tournament-forms"),
```

- [ ] **Step 6: Run to verify pass**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms/tests/test_builder_api.py backend/apps/forms/tests/test_isolation.py -q`
Expected: all passed.

- [ ] **Step 7: Commit**
```bash
git add backend/apps/forms/views.py backend/apps/forms/urls.py backend/fixture/urls.py backend/apps/tournaments/urls.py backend/apps/forms/tests/test_builder_api.py backend/apps/forms/tests/test_isolation.py
git commit -m "feat(forms): builder API (CRUD + publish/close/duplicate + field-types) with cross-org isolation"
```

---

# Increment 4 — Public submission API

### Task 4.1: Share-link service (generalize RegistrationLink)

**Files:**
- Create: `backend/apps/forms/services/links.py`

- [ ] **Step 1: Implement** (complete file; mirrors `apps/teams/services/registration.py` token pattern)
```python
from __future__ import annotations

import hashlib
import secrets

from django.utils import timezone

from apps.forms.models import Form, FormShareLink


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def create_share_link(*, form: Form, created_by=None, label="", expires_at=None,
                      max_submissions=None, bound_entity=None, prefill=None):
    token = secrets.token_urlsafe(24)
    link = FormShareLink.objects.create(
        organization=form.organization, form=form, token_hash=_hash(token),
        label=(label or "")[:120], expires_at=expires_at, max_submissions=max_submissions,
        bound_entity=bound_entity or {}, prefill=prefill or {}, created_by=created_by,
    )
    return link, token


def resolve_share_link(token_plaintext: str):
    if not token_plaintext:
        return None
    link = (FormShareLink.objects.filter(
        token_hash=_hash(token_plaintext), is_active=True, form__deleted_at__isnull=True)
        .select_related("form", "form__tournament", "form__organization").first())
    if link is None:
        return None
    if link.expires_at is not None and link.expires_at <= timezone.now():
        return None
    if link.max_submissions is not None and link.submission_count >= link.max_submissions:
        return None
    return link
```

- [ ] **Step 2: Commit**
```bash
git add backend/apps/forms/services/links.py
git commit -m "feat(forms): share-link service (sha256 token, expiry/cap)"
```

---

### Task 4.2: Submit service (idempotent) + throttle

**Files:**
- Create: `backend/apps/forms/services/responses.py`
- Create: `backend/apps/forms/throttling.py`
- Create: `backend/apps/forms/tests/test_idempotency.py`

- [ ] **Step 1: Write failing idempotency test**
```python
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.forms.models import Form, FormResponse
from apps.forms.services.responses import submit_response
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEMA = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
    {"key": "school", "type": "short_text", "label": "School", "required": True, "role": "title"},
    {"key": "email", "type": "email", "label": "Email", "required": True, "role": "email"}]}]}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now(); u.save(update_fields=["email_verified_at"]); return u


def test_submit_promotes_and_is_idempotent():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R",
                            schema=SCHEMA, status="open", opens_at=timezone.now())
    eid = uuid.uuid4()
    r1 = submit_response(form=f, answers={"school": "MH", "email": "a@b.com"}, event_id=eid)
    r2 = submit_response(form=f, answers={"school": "MH", "email": "a@b.com"}, event_id=eid)
    assert r1.id == r2.id  # replay returns same row
    assert FormResponse.objects.filter(form=f).count() == 1
    assert r1.respondent_email == "a@b.com" and r1.title == "MH"
```

- [ ] **Step 2: Run to verify fail.** Run the file; expect ImportError.

- [ ] **Step 3: Implement `services/responses.py`** (complete file)
```python
from __future__ import annotations

import uuid as _uuid

from django.db import transaction
from django.db.models import F

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.forms.constants import ResponseStatus
from apps.forms.models import Form, FormFileUpload, FormResponse
from apps.forms.services.validation import promote, validate_answers


def submit_response(*, form: Form, answers: dict, event_id=None, share_link=None,
                    upload_refs=None, request=None) -> FormResponse:
    if event_id is not None:
        prior = FormResponse.objects.filter(form=form, event_id=event_id).first()
        if prior is not None:
            return prior

    clean = validate_answers(form.schema, answers)   # raises AnswerError on invalid
    roles = promote(form.schema, clean)

    with transaction.atomic():
        resp = FormResponse.objects.create(
            form=form, organization=form.organization, tournament=form.tournament,
            answers=clean, form_version=form.version,
            respondent_email=roles.get("email", "")[:254],
            respondent_phone=roles.get("phone", "")[:32],
            respondent_name=roles.get("name", "")[:200],
            title=roles.get("title", "")[:200],
            status=ResponseStatus.SUBMITTED, event_id=event_id, submitted_via=share_link,
        )
        if upload_refs:
            FormFileUpload.objects.filter(
                form=form, upload_ref__in=list(upload_refs.values()), response__isnull=True
            ).update(response=resp)
        Form.objects.filter(pk=form.pk).update(response_count=F("response_count") + 1)
        if share_link is not None:
            type(share_link).objects.filter(pk=share_link.pk).update(
                submission_count=F("submission_count") + 1)
        emit_audit(actor_user=None, actor_role=ActorRole.SYSTEM, event_type="form_response_submitted",
                   target_type="form", target_id=form.id, organization_id=form.organization_id,
                   idempotency_key=event_id, payload_after={"title": resp.title}, request=request)
    return resp
```

- [ ] **Step 4: Implement `throttling.py`** (mirror teams)
```python
from __future__ import annotations

from rest_framework.throttling import SimpleRateThrottle


class PublicFormThrottle(SimpleRateThrottle):
    scope = "public_form"
    rate = "30/hour"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
```

- [ ] **Step 5: Run to verify pass.** Run test_idempotency.py — expect passed.

- [ ] **Step 6: Commit**
```bash
git add backend/apps/forms/services/responses.py backend/apps/forms/throttling.py backend/apps/forms/tests/test_idempotency.py
git commit -m "feat(forms): idempotent submit service + public throttle"
```

---

### Task 4.3: Public views + uploads + URLs

**Files:**
- Modify: `backend/apps/forms/views.py` (append public views)
- Modify: `backend/apps/forms/urls.py` (append public routes)
- Create: `backend/apps/forms/tests/test_public_api.py`

- [ ] **Step 1: Write failing public-flow test**
```python
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEMA = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
    {"key": "school", "type": "short_text", "label": "School", "required": True, "role": "title"},
    {"key": "email", "type": "email", "label": "Email", "required": True, "role": "email"}]}]}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now(); u.save(update_fields=["email_verified_at"]); return u


def test_public_get_open_form_and_submit():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="Reg",
                            schema=SCHEMA, status="open", opens_at=timezone.now())
    c = APIClient()  # public
    g = c.get(f"/api/forms/{f.id}/public/")
    assert g.status_code == 200 and g.json()["form"]["title"] == "Reg"

    p = c.post(f"/api/forms/{f.id}/public/",
               {"answers": {"school": "MH", "email": "a@b.com"}, "event_id": str(uuid.uuid4())},
               format="json")
    assert p.status_code == 201, p.content
    assert "response_id" in p.json()


def test_public_get_closed_form_returns_closed():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="Reg",
                            schema=SCHEMA, status="draft")
    c = APIClient()
    g = c.get(f"/api/forms/{f.id}/public/")
    assert g.status_code == 200 and g.json().get("closed") is True


def test_public_submit_invalid_answer_400():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="Reg",
                            schema=SCHEMA, status="open", opens_at=timezone.now())
    c = APIClient()
    p = c.post(f"/api/forms/{f.id}/public/",
               {"answers": {"school": "MH", "email": "not-email"}}, format="json")
    assert p.status_code == 400
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Append public views to `views.py`** (complete additions)
```python
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny

from apps.forms.serializers import PublicSubmitSerializer
from apps.forms.services.forms import is_open
from apps.forms.services.links import resolve_share_link
from apps.forms.services.responses import submit_response
from apps.forms.services.validation import AnswerError
from apps.forms.throttling import PublicFormThrottle


def _public_payload(form):
    return {"form": {"id": str(form.id), "title": form.title, "description": form.description,
                     "schema": form.schema, "confirmation_message": form.confirmation_message},
            "tournament_name": form.tournament.name}


class PublicFormView(GenericAPIView):
    permission_classes = [AllowAny]
    throttle_classes = [PublicFormThrottle]

    def _resolve(self, form_id=None, token=None):
        if token is not None:
            link = resolve_share_link(token)
            if link is None:
                raise NotFound("invalid_link")
            return link.form, link
        form = Form.objects.filter(id=form_id, deleted_at__isnull=True).select_related(
            "tournament").first()
        if form is None:
            raise NotFound("form_not_found")
        return form, None

    def get(self, request, form_id=None, token=None):
        form, _link = self._resolve(form_id, token)
        if not is_open(form):
            return Response({"closed": True, "tournament_name": form.tournament.name})
        return Response(_public_payload(form))

    def post(self, request, form_id=None, token=None):
        form, link = self._resolve(form_id, token)
        if not is_open(form):
            raise DRFValidationError({"detail": "registration_closed"})
        ser = PublicSubmitSerializer(data=request.data); ser.is_valid(raise_exception=True)
        try:
            resp = submit_response(
                form=form, answers=ser.validated_data["answers"],
                event_id=ser.validated_data.get("event_id"), share_link=link,
                upload_refs=ser.validated_data.get("upload_refs"), request=request)
        except AnswerError as e:
            raise DRFValidationError({"errors": e.errors})
        from apps.forms.services.mapping import map_response  # local import (Increment 5)
        map_response(resp)
        return Response({"response_id": str(resp.id), "message": form.confirmation_message}, status=201)


class PublicUploadView(GenericAPIView):
    permission_classes = [AllowAny]
    throttle_classes = [PublicFormThrottle]
    parser_classes = [MultiPartParser, FormParser]
    MAX_BYTES = 10 * 1024 * 1024
    ALLOWED = {"application/pdf", "image/png", "image/jpeg"}

    def post(self, request, form_id):
        form = Form.objects.filter(id=form_id, deleted_at__isnull=True).first()
        if form is None or not is_open(form):
            raise NotFound("form_not_found")
        f = request.FILES.get("file")
        if f is None:
            raise DRFValidationError({"detail": "no_file"})
        if f.size > self.MAX_BYTES:
            raise DRFValidationError({"detail": "file_too_large"})
        if f.content_type not in self.ALLOWED:
            raise DRFValidationError({"detail": "unsupported_type"})
        from apps.forms.models import FormFileUpload
        up = FormFileUpload.objects.create(
            organization=form.organization, form=form, field_key=request.data.get("field_key", ""),
            file=f, original_name=f.name[:255], content_type=f.content_type, size=f.size)
        return Response({"upload_ref": str(up.upload_ref)}, status=201)
```
> NOTE: the `map_response` import is forward-declared here; Increment 5 creates it. To keep Increment 4 green on its own, add a temporary no-op `backend/apps/forms/services/mapping.py` with `def map_response(resp): return resp` and replace it in Increment 5.

- [ ] **Step 4: Add the temporary mapping stub** `backend/apps/forms/services/mapping.py`:
```python
def map_response(resp):
    return resp  # replaced in Increment 5
```

- [ ] **Step 5: Append public routes to `urls.py`**
```python
from apps.forms.views import PublicFormView, PublicUploadView
# ... add to urlpatterns:
    path("<uuid:form_id>/public/", PublicFormView.as_view(), name="form-public"),
    path("<uuid:form_id>/uploads/", PublicUploadView.as_view(), name="form-upload"),
    path("r/<str:token>/", PublicFormView.as_view(), name="form-public-token"),
```

- [ ] **Step 6: Run to verify pass.** Run test_public_api.py — expect passed.

- [ ] **Step 7: Commit**
```bash
git add backend/apps/forms/views.py backend/apps/forms/urls.py backend/apps/forms/services/mapping.py backend/apps/forms/tests/test_public_api.py
git commit -m "feat(forms): public GET/POST submission + token + uploads (AllowAny, throttled)"
```

---

# Increment 5 — Entity mapping (purpose dispatch; reuse register_school)

### Task 5.1: Mapping service + Stage-2 bridge

**Files:**
- Modify: `backend/apps/forms/services/mapping.py` (replace stub)
- Create: `backend/apps/forms/tests/test_mapping.py`

- [ ] **Step 1: Write failing mapping test**
```python
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.forms.models import Form, FormResponse
from apps.forms.services.mapping import map_response
from apps.teams.models import Team
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now(); u.save(update_fields=["email_verified_at"]); return u


def test_team_registration_maps_to_register_school():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    # bindings tell the mapper how to read answers into register_school params
    f = Form.objects.create(
        organization=t.organization, tournament=t, slug="roster", title="Roster",
        purpose="team_registration",
        settings={"bindings": {"school_name": "school", "team_name": "team",
                               "players_group": "players", "player_name": "pname"}},
        schema={"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
            {"key": "school", "type": "short_text", "label": "School", "role": "title"},
            {"key": "team", "type": "short_text", "label": "Team"}]}]})
    resp = FormResponse.objects.create(
        form=f, organization=t.organization, tournament=t,
        answers={"school": "Mount Hermon", "team": "MH A"}, title="Mount Hermon")
    map_response(resp)
    resp.refresh_from_db()
    assert Team.objects.filter(tournament=t, school="Mount Hermon").exists()
    assert resp.mapped_entities.get("team_ids")


def test_org_registration_is_noop_mapping():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="org", title="Org",
                            purpose="organization_registration", schema={"version": 1, "sections": []})
    resp = FormResponse.objects.create(form=f, organization=t.organization, tournament=t,
                                       title="A School")
    map_response(resp)  # no exception; response itself is the participant record
```

- [ ] **Step 2: Run to verify fail** (stub returns no-op → first test fails on Team existence).

- [ ] **Step 3: Replace `services/mapping.py`** (complete file)
```python
"""Map a submitted FormResponse into domain entities, dispatched by Form.purpose.
team_registration reuses apps/teams register_school (no rewrite)."""
from __future__ import annotations

from apps.forms.constants import FormPurpose
from apps.forms.models import FormResponse
from apps.teams.services.registration import register_school


def map_response(resp: FormResponse) -> FormResponse:
    purpose = resp.form.purpose
    if purpose == FormPurpose.TEAM_REGISTRATION:
        return _map_team_registration(resp)
    # organization_registration + generic: the response IS the record.
    return resp


def _map_team_registration(resp: FormResponse) -> FormResponse:
    form = resp.form
    b = (form.settings or {}).get("bindings", {})
    a = resp.answers
    school_name = a.get(b.get("school_name", "school_name")) or resp.title or "School"

    # A team_registration form may use a repeating `group` for players; v1 supports
    # either a single team (flat) or a players group. Build register_school's
    # teams=[{name, players:[{full_name, jersey_no?, position?, dob_year?}]}].
    team_name = a.get(b.get("team_name", "team_name")) or school_name
    players_raw = a.get(b.get("players_group", "players"), []) or []
    players = []
    name_key = b.get("player_name", "full_name")
    for p in players_raw if isinstance(players_raw, list) else []:
        if isinstance(p, dict) and p.get(name_key):
            players.append({
                "full_name": p[name_key],
                **({"jersey_no": p["jersey_no"]} for _ in [0] if "jersey_no" in p),
            } if False else {"full_name": p[name_key],
                             **({k: p[k] for k in ("jersey_no", "position", "dob_year") if k in p)}})

    teams = register_school(
        tournament=form.tournament, school_name=school_name,
        teams=[{"name": team_name, "players": players}],
        channel="self", event_id=resp.event_id,
    )
    resp.mapped_entities = {"team_ids": [str(t.id) for t in teams]}
    resp.save(update_fields=["mapped_entities"])
    return resp
```
> NOTE: simplify the player-dict construction to plain code (the conditional-dict trick above is illustrative); final form:
> ```python
> for p in players_raw:
>     if isinstance(p, dict) and p.get(name_key):
>         row = {"full_name": p[name_key]}
>         for k in ("jersey_no", "position", "dob_year"):
>             if k in p:
>                 row[k] = p[k]
>         players.append(row)
> ```

- [ ] **Step 4: Run to verify pass.** Run test_mapping.py — expect passed.

- [ ] **Step 5: Run the FULL forms suite + teams suite (prove no regressions)**

Run:
```bash
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps/forms backend/apps/teams -q
```
Expected: all passed (forms green + existing teams tests still green).

- [ ] **Step 6: Commit**
```bash
git add backend/apps/forms/services/mapping.py backend/apps/forms/tests/test_mapping.py
git commit -m "feat(forms): purpose-driven entity mapping (team_registration -> register_school)"
```

---

### Task 5.2: Responses list + export + status + Stage-2 send (API)

**Files:**
- Modify: `backend/apps/forms/views.py` (append responses views)
- Modify: `backend/apps/forms/urls.py` (append responses routes)
- Create: `backend/apps/forms/tests/test_responses_api.py`

- [ ] **Step 1: Write failing tests** (list, csv export, accept)
```python
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form, FormResponse
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now(); u.save(update_fields=["email_verified_at"]); return u


def _setup():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R",
                            purpose="organization_registration")
    FormResponse.objects.create(form=f, organization=t.organization, tournament=t,
                                title="MH", respondent_email="a@b.com")
    return admin, t, f


def test_list_and_csv_export():
    admin, t, f = _setup()
    c = APIClient(); c.force_authenticate(user=admin)
    assert c.get(f"/api/forms/{f.id}/responses/").status_code == 200
    csv = c.get(f"/api/forms/{f.id}/responses/?export=csv")
    assert csv.status_code == 200 and csv["Content-Type"].startswith("text/csv")
    assert b"MH" in csv.content


def test_accept_response():
    admin, t, f = _setup()
    rid = FormResponse.objects.filter(form=f).first().id
    c = APIClient(); c.force_authenticate(user=admin)
    r = c.patch(f"/api/forms/{f.id}/responses/{rid}/", {"status": "accepted"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "accepted"
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Append responses views to `views.py`** (complete additions)
```python
import csv
from django.http import HttpResponse

from apps.forms.models import FormResponse
from apps.forms.serializers import FormResponseSerializer
from apps.forms.services.links import create_share_link


class FormResponsesView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        qs = FormResponse.objects.filter(form=form, deleted_at__isnull=True).order_by("-created_at")
        if request.query_params.get("export") == "csv":
            return self._csv(form, qs)
        return Response(FormResponseSerializer(qs, many=True).data)

    def _csv(self, form, qs):
        resp = HttpResponse(content_type="text/csv")
        resp["Content-Disposition"] = f'attachment; filename="{form.slug}-responses.csv"'
        keys = []
        for sec in form.schema.get("sections", []):
            for fld in sec.get("fields", []):
                if fld.get("type") != "section_text":
                    keys.append(fld["key"])
        w = csv.writer(resp)
        w.writerow(["title", "email", "phone", "status", "submitted_at", *keys])
        for r in qs:
            w.writerow([r.title, r.respondent_email, r.respondent_phone, r.status,
                        r.created_at.isoformat(), *[r.answers.get(k, "") for k in keys]])
        return resp


class FormResponseDetailView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def patch(self, request, form_id, response_id):
        form = _get_manageable_form(request.user, form_id)
        r = FormResponse.objects.filter(form=form, id=response_id, deleted_at__isnull=True).first()
        if r is None:
            raise NotFound("response_not_found")
        new_status = request.data.get("status")
        if new_status not in {"submitted", "accepted", "rejected", "waitlisted"}:
            raise DRFValidationError({"detail": "invalid_status"})
        r.status = new_status; r.save(update_fields=["status"])
        return Response(FormResponseSerializer(r).data)


class FormSendStage2View(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        target = request.data.get("target_form_id")
        target_form = Form.objects.filter(id=target, tournament=form.tournament,
                                          deleted_at__isnull=True).first()
        if target_form is None:
            raise DRFValidationError({"detail": "target_form_not_found"})
        accepted = FormResponse.objects.filter(form=form, status="accepted", deleted_at__isnull=True)
        out = []
        for r in accepted:
            link, token = create_share_link(
                form=target_form, created_by=request.user, label=r.title,
                bound_entity={"participant_response_id": str(r.id)}, max_submissions=1)
            out.append({"response_id": str(r.id), "email": r.respondent_email,
                        "path": f"/r/{token}"})
            # TODO(notify): enqueue email via apps/notifications using r.respondent_email
        return Response({"sent": len(out), "links": out}, status=201)
```
> NOTE: the email enqueue is wired to `apps/notifications` during Increment 8 (frontend) / a follow-up; the endpoint returns the minted links now so the flow is testable and the UI can display/copy them.

- [ ] **Step 4: Append responses routes to `urls.py`**
```python
from apps.forms.views import FormResponsesView, FormResponseDetailView, FormSendStage2View
# add to urlpatterns:
    path("<uuid:form_id>/responses/", FormResponsesView.as_view(), name="form-responses"),
    path("<uuid:form_id>/responses/<uuid:response_id>/", FormResponseDetailView.as_view(),
         name="form-response-detail"),
    path("<uuid:form_id>:send-stage2/", FormSendStage2View.as_view(), name="form-send-stage2"),
```

- [ ] **Step 5: Run to verify pass.** Run test_responses_api.py — expect passed.

- [ ] **Step 6: Full backend suite (no regressions across the whole project)**

Run: `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/apps -q`
Expected: all passed (the prior ~448 + the new forms tests).

- [ ] **Step 7: Ruff + mypy on the new app**

Run:
```bash
backend/.venv/Scripts/python.exe -m ruff check backend/apps/forms
backend/.venv/Scripts/python.exe -m mypy backend/apps/forms
```
Expected: clean (fix any issues before committing).

- [ ] **Step 8: Commit**
```bash
git add backend/apps/forms/views.py backend/apps/forms/urls.py backend/apps/forms/tests/test_responses_api.py
git commit -m "feat(forms): responses list/export/status + Stage-2 link minting"
```

---

## Backend self-review checklist (run after Increment 5)

- [ ] **Spec coverage:** models (§1) ✓, schema+field catalog (§2) ✓, branching (§3) ✓, lifecycle/freeze (§4) ✓, builder API (§5) ✓, public API (§6) ✓, mapping (§7) ✓, RBAC module (§8) ✓. Export (§5) ✓.
- [ ] **Schema regen:** run `npm --prefix frontend run gen:types` so the frontend plan has up-to-date `src/types` (DRF spectacular picks up the new endpoints/serializers).
- [ ] **Type consistency:** service signatures used by views match (`submit_response`, `map_response`, `create_form`, `update_form`, `publish_form`, `close_form`, `create_share_link`, `resolve_share_link`).
- [ ] **Group deep-validation** is a documented v1 simplification (`validate_answers` stores `group` answers as-is) — fine for org registration; tighten when Stage-2 rosters move fully onto `group`.
- [ ] **No placeholders** remain in shipped code (the `map_response` stub was replaced in 5.1; the `_map_team_registration` player-dict uses the plain-code form from the NOTE).
