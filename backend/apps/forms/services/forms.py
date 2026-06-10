"""Form lifecycle + edit-freeze. Schema is validated on every write.

Mirrors the Tournament rules-freeze pattern: a form is freely editable while in
``draft``; once responses exist a *destructive* schema change (removing/retyping
an answered field) bumps ``version`` so old responses stay pinned to the schema
they were submitted against. Label/help-text edits are non-destructive.
"""
from __future__ import annotations

import re

from django.utils import timezone

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.forms.constants import FormStatus, PURPOSE_TO_STAGE
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


def create_form(*, tournament, title, purpose, schema=None, stage="",
                source_form_id=None, created_by=None, request=None) -> Form:
    # "Start from an existing form" — copy a sibling form's schema (same tenant).
    if source_form_id and not schema:
        src = Form.objects.filter(
            id=source_form_id, tournament=tournament, deleted_at__isnull=True
        ).first()
        if src is not None:
            schema = src.schema
    schema = schema or {"version": 1, "sections": []}
    if schema.get("sections"):
        validate_schema(schema)
    # Bind the form to its setup stage from its purpose when the caller didn't
    # specify one, so registration forms are ALWAYS stage-bound — the stage
    # auto-close/reopen keys on `stage`, and a blank stage would silently slip
    # past it. Explicit `stage` always wins. Driven by the canonical map, never
    # hardcoded per call site.
    resolved_stage = stage or PURPOSE_TO_STAGE.get(str(purpose), "")
    form = Form.objects.create(
        organization=tournament.organization, tournament=tournament,
        slug=_unique_slug(tournament, title), title=title[:200],
        purpose=purpose, stage=resolved_stage, schema=schema, created_by=created_by,
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
    destructive change (removing/retyping an answered field) bumps ``version``."""
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
    for field in ("title", "description", "confirmation_message", "closes_at", "opens_at",
                  "max_responses", "settings"):
        if field in data:
            setattr(form, field, data[field])
            changed.append(field)
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
