"""Impersonation banner + start/stop verb tests (v1Users.md B.19)."""
from __future__ import annotations

import pytest
from django.urls import reverse

from apps.audit.models import AuditEvent
from apps.sadmin.services import superadmin_verbs


@pytest.mark.django_db
def test_impersonate_start_sets_session_and_audits(authed_client_super_admin, regular_user):
    client = authed_client_super_admin
    resp = client.post(
        reverse("sadmin:user_verb", kwargs={"user_id": regular_user.id, "verb": "impersonate_start"}),
        data={"reason": "debug session"},
    )
    assert resp.status_code == 200
    assert client.session.get("impersonating_user_id") == str(regular_user.id)
    audit = AuditEvent.objects.filter(event_type="impersonation_started").latest("created_at")
    assert audit.actor_role == "super_admin"
    assert audit.impersonating_user_id == regular_user.id


@pytest.mark.django_db
def test_dashboard_renders_banner_when_impersonating(authed_client_super_admin, regular_user):
    client = authed_client_super_admin
    session = client.session
    session["impersonating_user_id"] = str(regular_user.id)
    session.save()

    resp = client.get(reverse("sadmin:dashboard"))
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "impersonating" in body.lower()
    assert regular_user.email in body


@pytest.mark.django_db
def test_impersonate_stop_clears_session(authed_client_super_admin, regular_user):
    client = authed_client_super_admin
    session = client.session
    session["impersonating_user_id"] = str(regular_user.id)
    session.save()

    resp = client.post(reverse("sadmin:impersonate_stop"))
    # Redirect back to dashboard
    assert resp.status_code in (302, 303)
    assert "impersonating_user_id" not in client.session
    assert AuditEvent.objects.filter(event_type="impersonation_stopped").exists()


@pytest.mark.django_db
def test_dashboard_no_banner_when_not_impersonating(authed_client_super_admin):
    resp = authed_client_super_admin.get(reverse("sadmin:dashboard"))
    body = resp.content.decode()
    assert 'data-testid="impersonate-banner"' not in body
