"""TDD — forms model constraints + scoping."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.utils import timezone

from apps.forms.constants import FormStatus
from apps.forms.models import Form, FormResponse
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> User:
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
