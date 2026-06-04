"""IP allowlist middleware tests (v1Users.md B.15)."""
from __future__ import annotations

import pytest
from django.test import override_settings
from django.urls import reverse


@pytest.mark.django_db
@override_settings(SADMIN_IP_ALLOWLIST=["192.0.2.0/24"])
def test_disallowed_ip_returns_404(client, super_admin):
    client.force_login(super_admin)
    resp = client.get(reverse("sadmin:dashboard"), REMOTE_ADDR="10.0.0.1")
    assert resp.status_code == 404


@pytest.mark.django_db
@override_settings(SADMIN_IP_ALLOWLIST=["192.0.2.0/24"])
def test_allowed_ip_returns_200(client, super_admin):
    client.force_login(super_admin)
    resp = client.get(reverse("sadmin:dashboard"), REMOTE_ADDR="192.0.2.10")
    assert resp.status_code == 200


@pytest.mark.django_db
@override_settings(SADMIN_IP_ALLOWLIST=[])
def test_empty_allowlist_is_noop(client, super_admin):
    client.force_login(super_admin)
    resp = client.get(reverse("sadmin:dashboard"), REMOTE_ADDR="10.0.0.1")
    assert resp.status_code == 200


@pytest.mark.django_db
@override_settings(SADMIN_IP_ALLOWLIST=["203.0.113.42"])
def test_single_ip_allowlist(client, super_admin):
    client.force_login(super_admin)
    ok = client.get(reverse("sadmin:dashboard"), REMOTE_ADDR="203.0.113.42")
    assert ok.status_code == 200
    blocked = client.get(reverse("sadmin:dashboard"), REMOTE_ADDR="203.0.113.43")
    assert blocked.status_code == 404
