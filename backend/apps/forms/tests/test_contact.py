"""Public 'Contact admin' endpoint — emails the tournament organisers."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.forms.models import Form
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _open_form(admin):
    t = create_tournament(user=admin, name="Contact Cup")
    return Form.objects.create(
        organization=t.organization, tournament=t, slug="r", title="Registration",
        purpose="organization_registration", status="open",
    )


def test_contact_admin_emails_organiser_with_reply_to():
    admin = _verified("org@contact.test")
    f = _open_form(admin)
    r = APIClient().post(
        f"/api/forms/{f.id}/contact/",
        {"name": "Parent", "email": "parent@x.com", "message": "When does it start?"},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["sent"] is True
    assert len(mail.outbox) == 1
    msg = mail.outbox[0]
    assert admin.email in msg.to
    assert msg.reply_to == ["parent@x.com"]
    assert "When does it start?" in msg.body


def test_contact_admin_validates_input():
    admin = _verified("org2@contact.test")
    f = _open_form(admin)
    r = APIClient().post(
        f"/api/forms/{f.id}/contact/",
        {"name": "X", "email": "not-an-email", "message": ""},
        format="json",
    )
    assert r.status_code == 400
    assert len(mail.outbox) == 0


def test_contact_admin_unknown_form_404():
    r = APIClient().post(
        f"/api/forms/{uuid.uuid4()}/contact/",
        {"name": "X", "email": "x@y.com", "message": "hi"},
        format="json",
    )
    assert r.status_code == 404
