from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.forms.constants import FormStatus
from apps.forms.models import Form, FormResponse
from apps.forms.services.forms import FormEditError, publish_form, update_form
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEMA = {"version": 1, "sections": [
    {"key": "s", "title": "S", "fields": [
        {"key": "name", "type": "short_text", "label": "Name", "required": True}]}]}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _form(t):
    return Form.objects.create(organization=t.organization, tournament=t, slug="reg",
                               title="Reg", schema=SCHEMA)


def test_publish_sets_open_and_opens_at():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    publish_form(f, user=t.created_by)
    f.refresh_from_db()
    assert f.status == FormStatus.OPEN and f.opens_at is not None


def test_publish_empty_form_raises():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="empty",
                            title="Empty", schema={"version": 1, "sections": []})
    with pytest.raises(FormEditError):
        publish_form(f, user=t.created_by)


def test_safe_edit_allowed_after_responses():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    FormResponse.objects.create(form=f, organization=t.organization, tournament=t,
                                answers={"name": "MH"})
    f.response_count = 1
    f.save(update_fields=["response_count"])
    # editing a label is safe
    new = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
        {"key": "name", "type": "short_text", "label": "Full name", "required": True}]}]}
    update_form(f, {"schema": new}, user=t.created_by)
    f.refresh_from_db()
    assert f.schema["sections"][0]["fields"][0]["label"] == "Full name"
    assert f.version == 1  # safe edit does not bump


def test_destructive_edit_after_responses_bumps_version():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    FormResponse.objects.create(form=f, organization=t.organization, tournament=t,
                                answers={"name": "MH"})
    f.response_count = 1
    f.save(update_fields=["response_count"])
    # removing the field that has answers is destructive -> version bump (allowed, warned)
    removed = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
        {"key": "other", "type": "short_text", "label": "Other"}]}]}
    update_form(f, {"schema": removed}, user=t.created_by)
    f.refresh_from_db()
    assert f.version == 2


def test_is_open_respects_window():
    from datetime import timedelta

    from apps.forms.services.forms import is_open

    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    assert is_open(f) is False  # draft
    publish_form(f, user=t.created_by)
    f.refresh_from_db()
    assert is_open(f) is True
    f.closes_at = timezone.now() - timedelta(hours=1)
    f.save(update_fields=["closes_at"])
    assert is_open(f) is False  # closed window


def test_duplicate_form_copies_schema_with_new_slug():
    from apps.forms.services.forms import duplicate_form

    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = _form(t)
    copy = duplicate_form(f, user=t.created_by)
    assert copy.id != f.id
    assert copy.slug != f.slug
    assert copy.schema == f.schema
    assert copy.status == FormStatus.DRAFT
