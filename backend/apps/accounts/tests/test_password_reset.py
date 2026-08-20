"""Tests for password reset (v1Users.md §2.4, A.5, B.11)."""
from __future__ import annotations

import hashlib
from datetime import timedelta

import pytest
from django.contrib.sessions.backends.db import SessionStore
from django.core.cache import cache
from django.test import RequestFactory
from django.utils import timezone

from apps.accounts.models import PasswordResetToken
from apps.accounts.services import password_reset as svc
from apps.accounts.tests.factories import UserFactory

pytestmark = pytest.mark.django_db


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


def _request(ip: str = "203.0.113.1"):
    rf = RequestFactory()
    req = rf.post("/api/accounts/auth/password_reset_request/")
    req.META["REMOTE_ADDR"] = ip
    return req


def test_request_creates_hashed_token_and_returns_silently():
    user = UserFactory(email="user@example.test")
    svc.request_password_reset("user@example.test", _request())
    token = PasswordResetToken.objects.get(user=user)
    # No PasswordResetToken should ever store the plaintext token.
    assert token.token_hash != ""
    assert len(token.token_hash) == 64  # sha256 hex
    assert token.expires_at > timezone.now()


def test_request_for_unknown_email_is_silent_no_op():
    svc.request_password_reset("ghost@example.test", _request())
    assert PasswordResetToken.objects.count() == 0


def test_complete_password_reset_uses_token_once():
    user = UserFactory(email="reset@example.test")
    plaintext = "valid-plaintext-token"
    PasswordResetToken.objects.create(
        user=user,
        token_hash=_hash(plaintext),
        expires_at=timezone.now() + timedelta(hours=1),
    )
    svc.complete_password_reset(plaintext, "Brand-NewPass-1234!")
    user.refresh_from_db()
    assert user.check_password("Brand-NewPass-1234!")
    # Re-using the same token must fail.
    with pytest.raises(ValueError):
        svc.complete_password_reset(plaintext, "AnotherPass-1234!")


def test_complete_password_reset_rejects_expired_token():
    user = UserFactory()
    plaintext = "expired-token"
    PasswordResetToken.objects.create(
        user=user,
        token_hash=_hash(plaintext),
        expires_at=timezone.now() - timedelta(minutes=1),
    )
    with pytest.raises(ValueError):
        svc.complete_password_reset(plaintext, "AnotherPass-1234!")


def test_completing_reset_invalidates_all_sessions(settings):
    user = UserFactory()
    # Plant a session for the user.
    session = SessionStore()
    session["_auth_user_id"] = str(user.pk)
    session["_auth_user_backend"] = "django.contrib.auth.backends.ModelBackend"
    session.save()
    sid = session.session_key

    plaintext = "session-invalidation-test"
    PasswordResetToken.objects.create(
        user=user,
        token_hash=_hash(plaintext),
        expires_at=timezone.now() + timedelta(hours=1),
    )
    svc.complete_password_reset(plaintext, "BrandNewPass-9876!")

    # The planted session must be gone.
    assert not SessionStore().exists(sid)


def test_rate_limit_per_email(settings):
    settings.PASSWORD_RESET_RATE_PER_EMAIL_HOUR = 2
    user = UserFactory(email="rate@example.test")
    for _ in range(2):
        svc.request_password_reset("rate@example.test", _request())
    # Third call should be rate-limited (no new token).
    before = PasswordResetToken.objects.filter(user=user).count()
    svc.request_password_reset("rate@example.test", _request())
    after = PasswordResetToken.objects.filter(user=user).count()
    assert after == before


def test_rate_limit_per_ip(settings):
    settings.PASSWORD_RESET_RATE_PER_IP_HOUR = 2
    settings.PASSWORD_RESET_RATE_PER_EMAIL_HOUR = 100
    user1 = UserFactory(email="ip1@example.test")
    user2 = UserFactory(email="ip2@example.test")
    user3 = UserFactory(email="ip3@example.test")
    svc.request_password_reset("ip1@example.test", _request("198.51.100.5"))
    svc.request_password_reset("ip2@example.test", _request("198.51.100.5"))
    svc.request_password_reset("ip3@example.test", _request("198.51.100.5"))
    total = PasswordResetToken.objects.filter(
        user__in=[user1, user2, user3]
    ).count()
    assert total == 2  # third blocked


# --- anti-abuse budget ------------------------------------------------------
# The endpoint mails an address the caller merely NAMES, so it is an
# amplifier. It used to be bounded only by the default `anon` bucket; once
# that was raised to a blast-radius cap (venue NAT / shared logins), this
# endpoint needed a budget of its own.


def test_password_reset_throttle_reads_its_own_budget_from_settings():
    from apps.accounts.throttling import PasswordResetRateThrottle

    throttle = PasswordResetRateThrottle()
    assert throttle.rate == "5/hour"
    assert throttle.num_requests == 5
    assert throttle.duration == 3600


def test_password_reset_endpoint_is_not_bounded_by_the_anon_bucket():
    """A 6th reset request from one IP inside the hour is refused, even though
    the shared `anon` ceiling is far higher."""
    from django.conf import settings
    from django.urls import reverse
    from rest_framework import status
    from rest_framework.test import APIClient

    assert int(settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["anon"].split("/")[0]) > 5

    UserFactory(email="victim@example.test")
    api = APIClient()
    url = reverse("accounts:password_reset_request")
    for i in range(5):
        r = api.post(url, data={"email": "victim@example.test"}, format="json",
                     REMOTE_ADDR="203.0.113.9")
        assert r.status_code == status.HTTP_200_OK, f"attempt {i}: {r.status_code}"

    blocked = api.post(url, data={"email": "victim@example.test"}, format="json",
                       REMOTE_ADDR="203.0.113.9")
    assert blocked.status_code == status.HTTP_429_TOO_MANY_REQUESTS
