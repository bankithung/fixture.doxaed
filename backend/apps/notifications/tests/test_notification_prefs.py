"""Notification preferences end to end: catalog resolution, the API, the
dispatch-time gate on both channels, and the digest command."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APIClient

from apps.notifications.models import Notification, NotificationPreference
from apps.notifications.services.dispatch import create_notification
from apps.notifications.services.prefs import allows, resolved_prefs

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email=None) -> User:
    u = User.objects.create_user(
        email=email or f"np-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def test_defaults_resolve_without_a_row():
    u = _user()
    data = resolved_prefs(u)
    by_kind = {row["kind"]: row for row in data["kinds"]}
    assert by_kind["match_assignment"]["in_app"] is True
    assert by_kind["match_assignment"]["email"] is True
    assert by_kind["match_incident_filed"]["email"] is False
    assert data["digest"] is False
    assert allows(u, "match_assignment", "email") is True
    # Unknown kinds deliver in-app, hold email.
    assert allows(u, "future_kind", "in_app") is True
    assert allows(u, "future_kind", "email") is False


def test_prefs_api_roundtrip_and_validation():
    u = _user()
    c = APIClient()
    c.force_authenticate(user=u)

    r = c.get("/api/notifications/prefs/")
    assert r.status_code == 200
    assert any(k["kind"] == "match_assignment" for k in r.data["kinds"])

    r = c.put(
        "/api/notifications/prefs/",
        {"kinds": {"match_assignment": {"email": False}}, "digest": True},
        format="json",
    )
    assert r.status_code == 200
    by_kind = {row["kind"]: row for row in r.data["kinds"]}
    assert by_kind["match_assignment"]["email"] is False
    assert by_kind["match_assignment"]["in_app"] is True  # untouched
    assert r.data["digest"] is True

    r = c.put(
        "/api/notifications/prefs/",
        {"kinds": {"nope": {"email": True}}},
        format="json",
    )
    assert r.status_code == 400

    # Unauthenticated: locked.
    assert APIClient().get("/api/notifications/prefs/").status_code in (401, 403)


def test_in_app_off_suppresses_the_row():
    u = _user()
    NotificationPreference.objects.create(
        user=u, prefs={"dispute_resolved": {"in_app": False}}
    )
    out = create_notification(
        user=u, kind="dispute_resolved", title="Resolved", body="b"
    )
    assert out is None
    assert Notification.objects.filter(user=u).count() == 0
    # Other kinds still land.
    assert create_notification(user=u, kind="dispute_raised", title="x") is not None


def test_email_channel_sends_branded_mail(django_capture_on_commit_callbacks):
    u = _user()
    # match_assignment defaults email ON.
    with django_capture_on_commit_callbacks(execute=True):
        create_notification(
            user=u, kind="match_assignment", title="You are assigned",
            body="Cup A", url="/tournaments/x/matches/y",
        )
    assert len(mail.outbox) == 1
    assert "assigned" in mail.outbox[0].subject.lower()
    assert u.email in mail.outbox[0].to

    # Toggle email off: no mail, row still lands.
    mail.outbox.clear()
    NotificationPreference.objects.create(
        user=u, prefs={"match_assignment": {"email": False}}
    )
    with django_capture_on_commit_callbacks(execute=True):
        create_notification(
            user=u, kind="match_assignment", title="Again", body="",
        )
    assert len(mail.outbox) == 0
    assert Notification.objects.filter(user=u, title="Again").exists()


def test_digest_command_sends_and_stamps():
    u = _user()
    pref = NotificationPreference.objects.create(user=u, digest=True)
    Notification.objects.create(user=u, kind="dispute_raised", title="One")
    Notification.objects.create(user=u, kind="schedule_changed", title="Two")

    call_command("send_notification_digests")
    assert len(mail.outbox) == 1
    assert "2" in mail.outbox[0].subject
    pref.refresh_from_db()
    assert pref.digest_sent_at is not None

    # Nothing new since the stamp: no second email.
    mail.outbox.clear()
    call_command("send_notification_digests")
    assert len(mail.outbox) == 0

    # Users without the opt-in never get one.
    other = _user()
    Notification.objects.create(user=other, kind="dispute_raised", title="X")
    call_command("send_notification_digests")
    assert len(mail.outbox) == 0
