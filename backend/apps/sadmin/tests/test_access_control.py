"""Access-control tests for the Super-admin console.

Locked invariants:
- Anonymous → redirect to /sadmin/login/ (Phase 1A relaxation: the
  login URL must be public for the SA to bootstrap a session; everything
  past it preserves §1.5).
- Authenticated-but-NOT-Super-admin → 404 (NOT 403, NOT a redirect).
  Real users hitting the surface still see no evidence it exists.
"""
from __future__ import annotations

import pytest
from django.urls import reverse


@pytest.mark.django_db
def test_anonymous_get_dashboard_redirects_to_login(client):
    resp = client.get(reverse("sadmin:dashboard"))
    assert resp.status_code == 302
    assert resp.url.startswith(reverse("sadmin:login"))


@pytest.mark.django_db
def test_regular_user_get_dashboard_returns_404(authed_client_regular):
    resp = authed_client_regular.get(reverse("sadmin:dashboard"))
    assert resp.status_code == 404


@pytest.mark.django_db
def test_super_admin_get_dashboard_returns_200(authed_client_super_admin):
    resp = authed_client_super_admin.get(reverse("sadmin:dashboard"))
    assert resp.status_code == 200


@pytest.mark.django_db
def test_inactive_super_admin_returns_404(client, super_admin):
    super_admin.is_active = False
    super_admin.save(update_fields=["is_active"])
    client.force_login(super_admin)
    resp = client.get(reverse("sadmin:dashboard"))
    # Inactive users are rejected by Django auth; but at minimum we
    # confirm no 200.
    assert resp.status_code in (302, 404)
