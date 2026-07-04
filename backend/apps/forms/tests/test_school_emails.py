"""H6 — school lifecycle emails (finding N6: one email ever, then silence).

Receipt on submit, accept/reject notice on review, schedule-change email for
accountless contacts, and the truthful access-code delivery ledger (C21).
Django's locmem test mail backend captures sends in ``mail.outbox``.
"""
from __future__ import annotations

import uuid
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.forms.models import Form
from apps.forms.services.responses import submit_response
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SCHEMA = {"version": 1, "sections": [{"key": "s", "title": "S", "fields": [
    {"key": "school", "type": "short_text", "label": "School", "required": True, "role": "title"},
    {"key": "email", "type": "email", "label": "Email", "required": True, "role": "email"}]}]}


def _verified(email="org-h6@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _form():
    admin = _verified()
    t = create_tournament(user=admin, name="Email Cup")
    f = Form.objects.create(
        organization=t.organization, tournament=t, slug="r", title="Registration",
        schema=SCHEMA, status="open", opens_at=timezone.now(),
    )
    return admin, t, f


def test_submit_sends_receipt_to_respondent(django_capture_on_commit_callbacks):
    admin, t, f = _form()
    with django_capture_on_commit_callbacks(execute=True):
        resp = submit_response(
            form=f, answers={"school": "MH", "email": "school@x.test"},
            event_id=uuid.uuid4(),
        )
    receipts = [m for m in mail.outbox if "Registration received" in m.subject]
    assert len(receipts) == 1
    assert receipts[0].to == ["school@x.test"]
    assert str(resp.id)[:8].upper() in receipts[0].body
    # Ledger records the outcome.
    assert AuditEvent.objects.filter(
        event_type="email_sent", target_id=resp.id
    ).exists()


def test_replay_does_not_resend_receipt(django_capture_on_commit_callbacks):
    admin, t, f = _form()
    eid = uuid.uuid4()
    with django_capture_on_commit_callbacks(execute=True):
        submit_response(form=f, answers={"school": "MH", "email": "a@x.test"}, event_id=eid)
    n = len(mail.outbox)
    with django_capture_on_commit_callbacks(execute=True):
        submit_response(form=f, answers={"school": "MH", "email": "a@x.test"}, event_id=eid)
    assert len(mail.outbox) == n  # replay returns the row, no second email


def test_review_decision_emails_the_school(django_capture_on_commit_callbacks):
    admin, t, f = _form()
    with django_capture_on_commit_callbacks(execute=True):
        resp = submit_response(
            form=f, answers={"school": "MH", "email": "school@x.test"},
            event_id=uuid.uuid4(),
        )
    mail.outbox.clear()

    c = APIClient()
    c.force_authenticate(user=admin)
    with django_capture_on_commit_callbacks(execute=True):
        r = c.patch(
            f"/api/forms/{f.id}/responses/{resp.id}/",
            {"status": "accepted"},
            format="json",
        )
    assert r.status_code == 200
    notices = [m for m in mail.outbox if "accepted" in m.subject]
    assert len(notices) == 1 and notices[0].to == ["school@x.test"]

    # Re-saving the SAME status must not re-send.
    mail.outbox.clear()
    with django_capture_on_commit_callbacks(execute=True):
        c.patch(
            f"/api/forms/{f.id}/responses/{resp.id}/",
            {"status": "accepted"},
            format="json",
        )
    assert mail.outbox == []


def test_send_failure_is_recorded_not_hidden(django_capture_on_commit_callbacks):
    admin, t, f = _form()
    with mock.patch(
        "apps.accounts.services.mailer.EmailMultiAlternatives.send",
        side_effect=OSError("smtp down"),
    ):
        with django_capture_on_commit_callbacks(execute=True):
            resp = submit_response(
                form=f, answers={"school": "MH", "email": "school@x.test"},
                event_id=uuid.uuid4(),
            )
    assert AuditEvent.objects.filter(
        event_type="email_failed", target_id=resp.id
    ).exists()
