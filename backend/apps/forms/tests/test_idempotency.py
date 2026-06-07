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
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


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


def test_submit_increments_response_count():
    t = create_tournament(user=_verified("a@test.local"), name="Cup")
    f = Form.objects.create(organization=t.organization, tournament=t, slug="r", title="R",
                            schema=SCHEMA, status="open", opens_at=timezone.now())
    submit_response(form=f, answers={"school": "MH", "email": "a@b.com"}, event_id=uuid.uuid4())
    f.refresh_from_db()
    assert f.response_count == 1
