"""TOTP 2FA enrollment, verification, and recovery codes.

Implements v1Users.md §1.4, §2.4, §2.12, B.14, B.18. Recovery codes
are argon2id-hashed at rest (B.14 lock — never store plaintext).

Public surface
--------------
- ``enroll_totp(user)`` — start enrollment; returns the otpauth URI and
  optional QR data-URI plus the unconfirmed device.
- ``confirm_totp(user, code)`` — verify the rolling TOTP, mark the
  device confirmed, generate ten recovery codes, and emit audit.
- ``verify_totp_or_recovery(user, code)`` — accept either a TOTP code
  or one of the recovery codes; consumes a recovery code on use.
- ``regenerate_recovery_codes(user)`` — invalidate the prior set,
  generate ten new codes, audit-logged.
- ``disable_2fa(user, actor, reason)`` — strip 2FA enrollment; audit.
"""
from __future__ import annotations

import base64
import io
import logging
import secrets
import string
from typing import Any

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import RecoveryCode, TwoFactorDevice, User
from apps.accounts.services._crypto import decrypt_secret, encrypt_secret
from apps.audit.models import ActorRole
from apps.audit.services import emit_audit

logger = logging.getLogger(__name__)

# Argon2id parameters: argon2-cffi defaults are sane (RFC 9106 'low memory'
# profile); we simply reuse the library default hasher.
_HASHER = PasswordHasher()

RECOVERY_CODE_COUNT = 10
RECOVERY_CODE_LEN = 10  # 10 base32 chars ~= 50 bits entropy
_RECOVERY_ALPHABET = string.ascii_uppercase + string.digits

# 2FA second-factor brute-force lockout. Deliberately SEPARATE from the
# django-axes password lockout (AXES_RESET_ON_SUCCESS=True) so a correct
# password cannot reset the attacker's second-factor attempt counter.
TWOFA_MAX_ATTEMPTS = 5
TWOFA_LOCK_SECONDS = 15 * 60


def _random_secret_b32() -> str:
    """160-bit shared secret, base32-encoded (RFC 6238 standard length)."""
    return pyotp.random_base32(length=32)


def _generate_recovery_plaintext() -> str:
    raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(RECOVERY_CODE_LEN))
    # Render as XXXXX-XXXXX for human readability.
    return f"{raw[:5]}-{raw[5:]}"


def _normalize_recovery(code: str) -> str:
    return code.strip().upper().replace(" ", "")


# ---------------------------------------------------------------------------
# Enrollment
# ---------------------------------------------------------------------------


def enroll_totp(user: User) -> dict[str, Any]:
    """Start TOTP enrollment.

    Creates an unconfirmed ``TwoFactorDevice`` row (replacing any prior
    unconfirmed row) and returns the ``otpauth://`` URI plus a base64
    data URI of a QR code rendering it.
    """
    # Replace any prior pending enrollment so a user can re-scan the QR.
    TwoFactorDevice.objects.filter(user=user, confirmed_at__isnull=True).delete()

    secret = _random_secret_b32()
    device = TwoFactorDevice.objects.create(
        user=user,
        secret_b32=encrypt_secret(secret),
    )

    issuer = getattr(settings, "TWOFA_ISSUER_NAME", "Fixture")
    otpauth_uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=user.email, issuer_name=issuer
    )

    qr_data_uri = ""
    try:
        import qrcode

        img = qrcode.make(otpauth_uri)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        qr_data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(
            "ascii"
        )
    except Exception:  # pragma: no cover - QR is best-effort
        logger.exception("Failed to render 2FA QR code; returning URI only")

    return {
        "device": device,
        "otpauth_uri": otpauth_uri,
        "qr_data_uri": qr_data_uri,
    }


def _verify_totp(secret_b32: str, code: str) -> bool:
    code = code.strip().replace(" ", "")
    if not code.isdigit():
        return False
    return pyotp.TOTP(secret_b32).verify(code, valid_window=1)


@transaction.atomic
def confirm_totp(user: User, code: str, *, request=None) -> list[str]:
    """Confirm the pending TOTP enrollment.

    Returns the list of plaintext recovery codes — they are shown to the
    user EXACTLY ONCE and the DB only retains argon2id hashes (B.14).
    """
    device = (
        TwoFactorDevice.objects.select_for_update()
        .filter(user=user, confirmed_at__isnull=True)
        .order_by("-created_at")
        .first()
    )
    if device is None:
        raise ValueError("No pending 2FA enrollment for this user.")

    secret = decrypt_secret(device.secret_b32)
    if not _verify_totp(secret, code):
        raise ValueError("Invalid TOTP code.")

    now = timezone.now()
    device.confirmed_at = now
    device.save(update_fields=["confirmed_at"])

    user.has_2fa_enrolled = True
    user.twofa_enrolled_at = now
    user.save(update_fields=["has_2fa_enrolled", "twofa_enrolled_at"])

    plaintext_codes = _generate_recovery_codes(user)

    emit_audit(
        actor_user=user,
        actor_role=_actor_role_for(user),
        event_type="twofa_enrolled",
        target_type="user",
        target_id=user.id,
        payload_after={"twofa_enrolled_at": now.isoformat(), "device_id": str(device.id)},
        request=request,
    )
    return plaintext_codes


@transaction.atomic
def regenerate_recovery_codes(user: User, *, actor: User | None = None, request=None) -> list[str]:
    """Invalidate any prior recovery codes (used or unused) and mint
    ``RECOVERY_CODE_COUNT`` new ones. Returns the plaintext codes —
    callers must surface them once and discard.
    """
    RecoveryCode.objects.filter(user=user).delete()
    plaintext_codes = _generate_recovery_codes(user)
    emit_audit(
        actor_user=actor or user,
        actor_role=_actor_role_for(actor or user),
        event_type="recovery_codes_regenerated",
        target_type="user",
        target_id=user.id,
        payload_after={"count": RECOVERY_CODE_COUNT},
        request=request,
    )
    return plaintext_codes


def _generate_recovery_codes(user: User) -> list[str]:
    codes: list[str] = []
    for _ in range(RECOVERY_CODE_COUNT):
        plaintext = _generate_recovery_plaintext()
        codes.append(plaintext)
        RecoveryCode.objects.create(
            user=user,
            code_hash=_HASHER.hash(_normalize_recovery(plaintext)),
        )
    return codes


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def _twofa_attempt_key(user_id) -> str:
    return f"2fa-attempts:{user_id}"


def twofa_is_locked(user: User) -> bool:
    """True once the user has hit TWOFA_MAX_ATTEMPTS failed second factors."""
    return int(cache.get(_twofa_attempt_key(user.id), 0)) >= TWOFA_MAX_ATTEMPTS


def twofa_record_failure(user: User) -> int:
    """Increment the failed-2FA counter (TTL = lock window). Returns the count."""
    key = _twofa_attempt_key(user.id)
    try:
        return cache.incr(key)
    except ValueError:
        cache.set(key, 1, TWOFA_LOCK_SECONDS)
        return 1


def twofa_reset_attempts(user: User) -> None:
    cache.delete(_twofa_attempt_key(user.id))


def _verify_recovery(user: User, code: str) -> bool:
    """Argon2id-verify ``code`` against the user's unused recovery codes
    in O(n) (n=10). On match, mark the row used and return True.
    """
    candidate = _normalize_recovery(code)
    qs = RecoveryCode.objects.filter(user=user, used_at__isnull=True)
    for row in qs:
        try:
            _HASHER.verify(row.code_hash, candidate)
        except VerifyMismatchError:
            continue
        except Exception:  # pragma: no cover - hash format defensive
            logger.exception("Recovery code hash verification failed")
            continue
        # Atomic single-use claim: conditional UPDATE ... WHERE used_at IS NULL.
        # Only the first concurrent consumer gets rowcount == 1.
        claimed = RecoveryCode.objects.filter(
            pk=row.pk, used_at__isnull=True
        ).update(used_at=timezone.now())
        if claimed == 1:
            return True
        return False  # consumed by a concurrent request
    return False


def verify_totp_or_recovery(user: User, code: str, *, request=None) -> bool:
    """Verify ``code`` as a rolling TOTP or as a recovery code.

    On a recovery-code match, the row is marked used (audit-logged) and
    cannot be reused.
    """
    if not code:
        return False

    device = (
        TwoFactorDevice.objects.filter(user=user, confirmed_at__isnull=False)
        .order_by("-confirmed_at")
        .first()
    )
    if device is not None:
        secret = decrypt_secret(device.secret_b32)
        if _verify_totp(secret, code):
            return True

    if _verify_recovery(user, code):
        emit_audit(
            actor_user=user,
            actor_role=_actor_role_for(user),
            event_type="recovery_code_consumed",
            target_type="user",
            target_id=user.id,
            request=request,
        )
        return True

    return False


# ---------------------------------------------------------------------------
# Disable
# ---------------------------------------------------------------------------


@transaction.atomic
def disable_2fa(user: User, *, actor: User | None = None, reason: str = "", request=None) -> None:
    """Strip 2FA — drop devices, drop recovery codes, audit."""
    TwoFactorDevice.objects.filter(user=user).delete()
    RecoveryCode.objects.filter(user=user).delete()
    user.has_2fa_enrolled = False
    user.twofa_enrolled_at = None
    user.save(update_fields=["has_2fa_enrolled", "twofa_enrolled_at"])

    emit_audit(
        actor_user=actor or user,
        actor_role=_actor_role_for(actor or user),
        event_type="twofa_disabled",
        target_type="user",
        target_id=user.id,
        reason=reason,
        request=request,
    )


def _actor_role_for(user: User | None) -> ActorRole:
    if user is None:
        return ActorRole.SYSTEM
    if getattr(user, "is_superuser", False):
        return ActorRole.SUPER_ADMIN
    # Default to admin tier for self-service verbs in Phase 1A.
    # The richer (org-membership-aware) role resolver lives in the
    # permissions app and supersedes this when calling from a verb that
    # already knows the actor's role.
    return ActorRole.ADMIN
