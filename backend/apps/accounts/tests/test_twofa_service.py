"""Tests for the 2FA service (v1Users.md §1.4, §2.4, B.14)."""
from __future__ import annotations

import pyotp
import pytest

from apps.accounts.models import RecoveryCode, TwoFactorDevice
from apps.accounts.services import twofa as svc
from apps.accounts.services._crypto import decrypt_secret
from apps.accounts.tests.factories import UserFactory
from apps.audit.models import AuditEvent

pytestmark = pytest.mark.django_db


def _confirm_user(user) -> tuple[TwoFactorDevice, list[str]]:
    payload = svc.enroll_totp(user)
    device = payload["device"]
    secret = decrypt_secret(device.secret_b32)
    code = pyotp.TOTP(secret).now()
    codes = svc.confirm_totp(user, code)
    return TwoFactorDevice.objects.get(pk=device.pk), codes


def test_enrollment_emits_ten_recovery_codes():
    user = UserFactory()
    device, codes = _confirm_user(user)
    assert len(codes) == svc.RECOVERY_CODE_COUNT == 10
    assert RecoveryCode.objects.filter(user=user).count() == 10
    assert device.confirmed_at is not None
    user.refresh_from_db()
    assert user.has_2fa_enrolled is True
    assert user.twofa_enrolled_at is not None


def test_recovery_codes_are_argon2id_hashed_never_plaintext():
    """B.14 lock: plaintext recovery codes MUST NOT appear in DB."""
    user = UserFactory()
    _, codes = _confirm_user(user)
    db_hashes = list(RecoveryCode.objects.filter(user=user).values_list("code_hash", flat=True))
    assert all(h.startswith("$argon2") for h in db_hashes), db_hashes
    for plaintext in codes:
        assert plaintext not in db_hashes
        # Also assert no row contains the plaintext substring anywhere.
        assert all(plaintext not in h for h in db_hashes)


def test_recovery_code_consumed_exactly_once():
    user = UserFactory()
    _, codes = _confirm_user(user)
    chosen = codes[0]
    # First use: success.
    assert svc.verify_totp_or_recovery(user, chosen) is True
    # Second use: same code rejected.
    assert svc.verify_totp_or_recovery(user, chosen) is False
    # Different unused code still works.
    assert svc.verify_totp_or_recovery(user, codes[1]) is True


def test_totp_code_verifies():
    user = UserFactory()
    device, _ = _confirm_user(user)
    secret = decrypt_secret(device.secret_b32)
    rolling = pyotp.TOTP(secret).now()
    assert svc.verify_totp_or_recovery(user, rolling) is True


def test_regenerate_invalidates_old_codes():
    user = UserFactory()
    _, old = _confirm_user(user)
    new = svc.regenerate_recovery_codes(user)
    assert RecoveryCode.objects.filter(user=user).count() == 10
    # Old codes no longer recognised.
    for plaintext in old:
        assert svc.verify_totp_or_recovery(user, plaintext) is False
    # New codes work.
    assert svc.verify_totp_or_recovery(user, new[0]) is True


def test_disable_2fa_removes_device_and_codes():
    user = UserFactory()
    _confirm_user(user)
    svc.disable_2fa(user, actor=user, reason="testing")
    assert TwoFactorDevice.objects.filter(user=user).count() == 0
    assert RecoveryCode.objects.filter(user=user).count() == 0
    user.refresh_from_db()
    assert user.has_2fa_enrolled is False


def test_audit_emitted_on_enrollment_and_consumption():
    user = UserFactory()
    _, codes = _confirm_user(user)
    svc.verify_totp_or_recovery(user, codes[0])

    types = set(
        AuditEvent.objects.filter(target_id=user.id).values_list("event_type", flat=True)
    )
    assert "twofa_enrolled" in types
    assert "recovery_code_consumed" in types
