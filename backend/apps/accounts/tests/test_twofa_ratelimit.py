"""TDD — 2FA second-factor brute-force lockout + recovery-code single-use.

Audit BLOCKER: the 2FA gate runs after a successful password auth, and
django-axes resets on password success, so TOTP codes were brute-forceable.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache

from apps.accounts.services import twofa as twofa_svc

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email: str = "u@test.local") -> User:
    return User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)


def test_twofa_locks_after_max_attempts_and_resets():
    cache.clear()
    u = _user()
    assert not twofa_svc.twofa_is_locked(u)

    for _ in range(twofa_svc.TWOFA_MAX_ATTEMPTS):
        twofa_svc.twofa_record_failure(u)
    assert twofa_svc.twofa_is_locked(u)

    twofa_svc.twofa_reset_attempts(u)
    assert not twofa_svc.twofa_is_locked(u)
    cache.clear()


def test_recovery_code_is_single_use():
    u = _user()
    u.has_2fa_enrolled = True
    u.save(update_fields=["has_2fa_enrolled"])
    codes = twofa_svc._generate_recovery_codes(u)
    code = codes[0]

    assert twofa_svc.verify_totp_or_recovery(u, code) is True
    # Re-using the same recovery code must fail (consumed atomically).
    assert twofa_svc.verify_totp_or_recovery(u, code) is False
