"""Tests for POST /api/feedback/submit/ — public feedback widget endpoint."""
from __future__ import annotations

import uuid

import pytest
from django.core.cache import cache
from django.urls import reverse

from apps.audit.models import AuditEvent
from apps.sadmin.models import Feedback


@pytest.fixture(autouse=True)
def _clear_cache():
    """Reset throttle cache between tests so 10/hr counters don't leak."""
    cache.clear()
    yield
    cache.clear()


@pytest.mark.django_db
def test_authenticated_user_can_submit_feedback(client, regular_user):
    client.force_login(regular_user)
    url = reverse("feedback-submit")

    resp = client.post(
        url,
        data={
            "message": "The dashboard loads slowly on my phone.",
            "page_url": "/o/acme/dashboard",
        },
        content_type="application/json",
    )

    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert "id" in body
    fb_id = uuid.UUID(body["id"])  # parses cleanly

    fb = Feedback.objects.get(pk=fb_id)
    assert fb.submitted_by_id == regular_user.id
    # The composed body includes the page_url.
    assert "/o/acme/dashboard" in fb.body

    # Audit row was emitted with event_type=feedback_submitted.
    assert AuditEvent.objects.filter(
        event_type="feedback_submitted", target_id=fb.id
    ).count() == 1


@pytest.mark.django_db
def test_rate_limit_kicks_in_at_eleventh_call(client, regular_user):
    """B.11: 10/hr/user. The 11th submit returns 429."""
    client.force_login(regular_user)
    url = reverse("feedback-submit")

    for i in range(10):
        resp = client.post(
            url,
            data={"message": f"Submission #{i}"},
            content_type="application/json",
        )
        assert resp.status_code == 201, (i, resp.status_code, resp.content)

    # 11th call must be throttled.
    blocked = client.post(
        url,
        data={"message": "One too many"},
        content_type="application/json",
    )
    assert blocked.status_code == 429, blocked.content


@pytest.mark.django_db
def test_unauthenticated_request_rejected(client):
    url = reverse("feedback-submit")
    resp = client.post(
        url,
        data={"message": "anonymous spam"},
        content_type="application/json",
    )
    # IsAuthenticated → 403 with DRF SessionAuth + no creds.
    assert resp.status_code in (401, 403)
    # No row was created.
    assert Feedback.objects.count() == 0


@pytest.mark.django_db
def test_event_id_idempotency(client, regular_user):
    """Re-submitting with the same event_id must NOT double-write."""
    client.force_login(regular_user)
    url = reverse("feedback-submit")

    event_id = str(uuid.uuid4())
    payload = {"message": "help", "event_id": event_id}

    first = client.post(url, data=payload, content_type="application/json")
    assert first.status_code == 201
    first_id = first.json()["id"]

    second = client.post(url, data=payload, content_type="application/json")
    # 200 on idempotent replay, not 201.
    assert second.status_code == 200, second.content
    assert second.json()["id"] == first_id

    # Exactly one Feedback row + one audit row.
    assert Feedback.objects.count() == 1
    assert AuditEvent.objects.filter(
        event_type="feedback_submitted"
    ).count() == 1


@pytest.mark.django_db
def test_pii_redaction_applied(client, regular_user):
    client.force_login(regular_user)
    url = reverse("feedback-submit")
    resp = client.post(
        url,
        data={
            "message": "My email user@example.com is broken",
        },
        content_type="application/json",
    )
    assert resp.status_code == 201
    fb = Feedback.objects.get(pk=resp.json()["id"])
    assert "user@example.com" not in fb.body
    assert "[REDACTED]" in fb.body
