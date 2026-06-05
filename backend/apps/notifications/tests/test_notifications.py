"""TDD — notifications: idempotent dispatch, per-user isolation, read/mark-all."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.notifications.models import Notification
from apps.notifications.services.dispatch import create_notification

User = get_user_model()
pytestmark = pytest.mark.django_db


def _u(email: str) -> "User":
    return User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)


def test_create_notification_idempotent():
    u = _u("a@test.local")
    eid = uuid.uuid4()
    create_notification(user=u, kind="x", title="Hi", event_id=eid)
    create_notification(user=u, kind="x", title="Hi", event_id=eid)
    assert Notification.objects.filter(user=u).count() == 1


def test_list_shows_only_own_with_unread_count():
    a, b = _u("a@test.local"), _u("b@test.local")
    create_notification(user=a, kind="x", title="A1")
    create_notification(user=a, kind="x", title="A2")
    create_notification(user=b, kind="x", title="B1")
    client = APIClient()
    client.force_authenticate(user=a)

    r = client.get("/api/notifications/")
    assert r.status_code == 200
    assert len(r.json()["results"]) == 2
    assert r.json()["unread_count"] == 2


def test_mark_read_and_mark_all():
    a = _u("a@test.local")
    n1 = create_notification(user=a, kind="x", title="A1")
    create_notification(user=a, kind="x", title="A2")
    client = APIClient()
    client.force_authenticate(user=a)

    r = client.post(f"/api/notifications/{n1.id}/read/")
    assert r.status_code == 200
    assert r.json()["read_at"] is not None
    assert client.get("/api/notifications/").json()["unread_count"] == 1

    client.post("/api/notifications/read-all/")
    assert client.get("/api/notifications/").json()["unread_count"] == 0


def test_cannot_read_others_notification():
    a, b = _u("a@test.local"), _u("b@test.local")
    n = create_notification(user=b, kind="x", title="B1")
    client = APIClient()
    client.force_authenticate(user=a)
    assert client.post(f"/api/notifications/{n.id}/read/").status_code == 404
