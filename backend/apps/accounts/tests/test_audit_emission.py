"""Tests for audit emission across accounts verbs (v1Users.md B.4 + B.6)."""
from __future__ import annotations

import hashlib
from datetime import timedelta

import pyotp
import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import EmailVerificationToken, PasswordResetToken
from apps.accounts.services import twofa as twofa_svc
from apps.accounts.services._crypto import decrypt_secret
from apps.accounts.tests.factories import UserFactory
from apps.audit.models import AuditEvent

pytestmark = pytest.mark.django_db


def _hash(p: str) -> str:
    return hashlib.sha256(p.encode()).hexdigest()


def _events(user, event_type):
    return list(AuditEvent.objects.filter(target_id=user.id, event_type=event_type))


def test_signup_emits_user_signup():
    api = APIClient()
    api.post(
        reverse("accounts:signup"),
        data={"email": "fresh@example.test", "password": "StrongP@ss12345"},
        format="json",
    )
    from apps.accounts.models import User

    u = User.objects.get(email="fresh@example.test")
    assert len(_events(u, "user_signup")) == 1


def test_email_verification_emits_email_verified():
    user = UserFactory(is_active=False)
    plaintext = "verify-me-please"
    EmailVerificationToken.objects.create(
        user=user,
        token_hash=_hash(plaintext),
        expires_at=timezone.now() + timedelta(hours=1),
    )
    api = APIClient()
    resp = api.post(
        reverse("accounts:verify_email"),
        data={"token": plaintext},
        format="json",
    )
    assert resp.status_code == 200
    assert len(_events(user, "email_verified")) == 1


def test_login_emits_user_login_success():
    pw = "StrongP@ssw0rd!"
    user = UserFactory(password=pw)
    api = APIClient()
    resp = api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": pw},
        format="json",
    )
    assert resp.status_code == 200
    assert len(_events(user, "user_login_success")) == 1


def test_login_failure_emits_login_failed():
    user = UserFactory(password="rightpw-12345!@")
    api = APIClient()
    api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": "wrongpw"},
        format="json",
    )
    assert len(_events(user, "user_login_failed")) >= 1


def test_logout_emits_user_logout():
    pw = "StrongP@ssw0rd!"
    user = UserFactory(password=pw)
    api = APIClient()
    api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": pw},
        format="json",
    )
    api.post(reverse("accounts:logout"))
    assert len(_events(user, "user_logout")) == 1


def test_password_reset_emits_requested_and_completed():
    user = UserFactory(email="pwr@example.test")
    api = APIClient()
    api.post(
        reverse("accounts:password_reset_request"),
        data={"email": user.email},
        format="json",
    )
    assert len(_events(user, "password_reset_requested")) == 1

    plaintext = "complete-me"
    PasswordResetToken.objects.create(
        user=user,
        token_hash=_hash(plaintext),
        expires_at=timezone.now() + timedelta(hours=1),
    )
    api.post(
        reverse("accounts:password_reset_complete"),
        data={"token": plaintext, "new_password": "BrandNewP@ss-123"},
        format="json",
    )
    assert len(_events(user, "password_reset_completed")) == 1


def test_twofa_enrollment_emits_event():
    user = UserFactory()
    payload = twofa_svc.enroll_totp(user)
    secret = decrypt_secret(payload["device"].secret_b32)
    twofa_svc.confirm_totp(user, pyotp.TOTP(secret).now())
    assert len(_events(user, "twofa_enrolled")) == 1


def test_user_self_update_emits_event():
    pw = "StrongP@ssw0rd!"
    user = UserFactory(password=pw, name="Original")
    api = APIClient()
    api.post(
        reverse("accounts:login"),
        data={"email": user.email, "password": pw},
        format="json",
    )
    resp = api.patch(
        reverse("accounts:me"),
        data={"name": "Renamed"},
        format="json",
    )
    assert resp.status_code == 200
    assert len(_events(user, "user_self_update")) == 1


def test_soft_delete_by_super_admin_emits_event():
    admin = UserFactory(is_superuser=True, is_staff=True, password="adminpass-12345!")
    target = UserFactory(email="kill@example.test")
    api = APIClient()
    api.post(
        reverse("accounts:login"),
        data={"email": admin.email, "password": "adminpass-12345!"},
        format="json",
    )
    resp = api.post(
        reverse("accounts:user_soft_delete", args=[str(target.id)]),
        data={"reason": "test cleanup"},
        format="json",
    )
    assert resp.status_code == 200
    assert len(_events(target, "user_soft_deleted")) == 1
