"""Tests for login flow (v1Users.md §2.4, B.11 fixation defense, axes)."""
from __future__ import annotations

import pyotp
import pytest
from django.contrib.sessions.backends.db import SessionStore
from django.urls import reverse
from rest_framework.test import APIClient

from apps.accounts.services import twofa as twofa_svc
from apps.accounts.services._crypto import decrypt_secret
from apps.accounts.tests.factories import UserFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def password() -> str:
    return "StrongP@ssw0rdz!#"


def test_session_key_cycles_on_successful_login(client, password):
    user = UserFactory(password=password)
    # Establish a session key BEFORE login.
    pre_session = SessionStore()
    pre_session.save()
    pre_key = pre_session.session_key
    client.cookies["sessionid"] = pre_key

    response = client.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": password},
        content_type="application/json",
    )
    assert response.status_code == 200
    post_key = client.session.session_key
    assert post_key is not None
    assert post_key != pre_key  # B.11: cycle on auth-state change


def test_login_with_2fa_required_returns_flag(password):
    user = UserFactory(password=password)
    payload = twofa_svc.enroll_totp(user)
    secret = decrypt_secret(payload["device"].secret_b32)
    twofa_svc.confirm_totp(user, pyotp.TOTP(secret).now())

    api = APIClient()
    resp = api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": password},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data == {"requires_2fa": True}

    # Wrong TOTP rejected.
    resp = api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": password, "totp_code": "000000"},
        format="json",
    )
    assert resp.status_code == 400

    # Right TOTP succeeds.
    code = pyotp.TOTP(secret).now()
    resp = api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": password, "totp_code": code},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data == {"status": "ok"}


def test_login_invalid_password_rejected(password):
    user = UserFactory(password=password)
    api = APIClient()
    resp = api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": "wrong"},
        format="json",
    )
    assert resp.status_code == 400


def test_axes_locks_out_after_failure_limit(axes_enabled, password, settings):
    """PRD §2.9: 10 failed logins → lockout (axes governs the count)."""
    settings.AXES_FAILURE_LIMIT = 3  # tighten so the test runs fast
    settings.AXES_RESET_ON_SUCCESS = True

    user = UserFactory(password=password)
    api = APIClient()
    for _ in range(settings.AXES_FAILURE_LIMIT):
        resp = api.post(
            reverse("accounts:login"),
            data={"email": user.email, "password": "wrong"},
            format="json",
        )
        assert resp.status_code == 400

    # Subsequent attempts (even with the right password) are blocked by axes.
    resp = api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": password},
        format="json",
    )
    # axes returns 403 (forbidden) once locked out.
    assert resp.status_code in (400, 403)
    # If a 200 came back we definitively did NOT lock out — fail loudly.
    assert resp.status_code != 200


def test_logout_clears_session(client, password):
    user = UserFactory(password=password)
    client.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": password},
        content_type="application/json",
    )
    assert client.session.get("_auth_user_id")
    client.post(reverse("accounts:logout"))
    assert "_auth_user_id" not in client.session
