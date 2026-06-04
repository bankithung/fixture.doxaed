"""Tests for the JSON URL routes that wire previously-unwired SA verbs.

Covers ``/sadmin/api/bulk-email/``, ``/sadmin/api/system-health/``, and
``/sadmin/api/feedback/<uuid>:archive/``. The underlying services are
already covered by ``test_superadmin_verbs.py`` and
``test_feedback_triage.py`` — these tests prove the URL wiring +
``@superadmin_required`` access gate.
"""
from __future__ import annotations

import json

import pytest
from django.urls import reverse

from apps.audit.models import AuditEvent
from apps.sadmin.models import Feedback, FeedbackStatus
from apps.sadmin.tests.factories import FeedbackFactory


# ---------------------------------------------------------------------------
# bulk_email
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_bulk_email_as_super_admin_returns_200(authed_client_super_admin):
    url = reverse("sadmin:api_bulk_email")
    resp = authed_client_super_admin.post(
        url,
        data=json.dumps({"subject": "Hello world", "body": "test", "target_filter": {}}),
        content_type="application/json",
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["subject"] == "Hello world"
    assert "recipients" in body
    # Audit row emitted.
    assert AuditEvent.objects.filter(event_type="bulk_email_drafted").count() == 1


@pytest.mark.django_db
def test_bulk_email_as_non_super_admin_returns_404(authed_client_regular):
    """Non-SA → 404 (surface-hide invariant from ``superadmin_required``)."""
    url = reverse("sadmin:api_bulk_email")
    resp = authed_client_regular.post(
        url,
        data=json.dumps({"subject": "x", "body": "y"}),
        content_type="application/json",
    )
    assert resp.status_code == 404


@pytest.mark.django_db
def test_bulk_email_as_anonymous_redirects_to_login(client):
    """Anonymous → 302 to the SA login page (Phase 1A bootstrap path)."""
    url = reverse("sadmin:api_bulk_email")
    resp = client.post(
        url,
        data=json.dumps({"subject": "x", "body": "y"}),
        content_type="application/json",
    )
    assert resp.status_code == 302
    assert reverse("sadmin:login") in resp.url


# ---------------------------------------------------------------------------
# system_health
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_system_health_as_super_admin_returns_200(authed_client_super_admin):
    url = reverse("sadmin:api_system_health")
    resp = authed_client_super_admin.get(url)
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert "db" in body
    assert body["db"] is True
    assert "tables" in body


@pytest.mark.django_db
def test_system_health_as_non_super_admin_returns_404(authed_client_regular):
    url = reverse("sadmin:api_system_health")
    resp = authed_client_regular.get(url)
    assert resp.status_code == 404


@pytest.mark.django_db
def test_system_health_as_anonymous_redirects(client):
    url = reverse("sadmin:api_system_health")
    resp = client.get(url)
    assert resp.status_code == 302


# ---------------------------------------------------------------------------
# archive_feedback
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_archive_feedback_as_super_admin_returns_200(authed_client_super_admin):
    fb = FeedbackFactory()
    url = reverse(
        "sadmin:api_archive_feedback", kwargs={"feedback_id": fb.id}
    )
    resp = authed_client_super_admin.post(url, data="{}", content_type="application/json")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["id"] == str(fb.id)
    fb.refresh_from_db()
    assert fb.status == FeedbackStatus.RESOLVED
    # Audit row emitted by the archive_feedback service.
    assert AuditEvent.objects.filter(event_type="feedback_archived").count() == 1


@pytest.mark.django_db
def test_archive_feedback_as_non_super_admin_returns_404(authed_client_regular):
    fb = FeedbackFactory()
    url = reverse(
        "sadmin:api_archive_feedback", kwargs={"feedback_id": fb.id}
    )
    resp = authed_client_regular.post(url, data="{}", content_type="application/json")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_archive_feedback_as_anonymous_redirects(client):
    fb = FeedbackFactory()
    url = reverse(
        "sadmin:api_archive_feedback", kwargs={"feedback_id": fb.id}
    )
    resp = client.post(url, data="{}", content_type="application/json")
    assert resp.status_code == 302
