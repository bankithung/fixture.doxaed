"""Symmetric encryption helpers for accounts secrets.

Used by the 2FA service to encrypt the TOTP shared secret at rest. The
key is derived from ``settings.SECRET_KEY`` so it follows the existing
secret-rotation discipline (rotate SECRET_KEY = re-key required, which
is the same property Django session signing already has).

Falls back to plain text storage if ``cryptography`` is missing — the
dependency is committed in ``pyproject.toml``, so the fallback exists
solely as a defence-in-depth guard against import errors at deploy
time. Hardening to KMS-backed keys is tracked under v1Users.md B.21.
"""
from __future__ import annotations

import base64
import hashlib

from django.conf import settings

try:
    from cryptography.fernet import Fernet, InvalidToken  # type: ignore[import-not-found]

    _HAS_FERNET = True
except Exception:  # pragma: no cover - dependency is committed
    _HAS_FERNET = False
    Fernet = None  # type: ignore[assignment]
    InvalidToken = Exception  # type: ignore[assignment, misc]

_PREFIX = "fernet$"


def _fernet() -> Fernet | None:
    if not _HAS_FERNET:
        return None
    raw = settings.SECRET_KEY.encode("utf-8")
    digest = hashlib.sha256(raw).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt_secret(plaintext: str) -> str:
    """Encrypt the TOTP shared secret. Returns ``fernet$<token>`` or, in
    fallback mode, the plaintext itself (with a TODO comment in models).
    """
    f = _fernet()
    if f is None:
        return plaintext
    token = f.encrypt(plaintext.encode("utf-8")).decode("ascii")
    return f"{_PREFIX}{token}"


def decrypt_secret(stored: str) -> str:
    """Decrypt a stored secret. Accepts both ciphertext (Fernet) and
    plaintext (legacy/fallback) for forward compatibility.
    """
    if not stored.startswith(_PREFIX):
        return stored
    f = _fernet()
    if f is None:  # pragma: no cover - mismatch only in degraded prod
        return stored
    body = stored[len(_PREFIX):].encode("ascii")
    return f.decrypt(body).decode("utf-8")


# --- purpose-scoped reversible storage -------------------------------------
# Used for secrets an ADMIN legitimately needs to read back — today the team
# registration access codes, which a host reads out over the phone when the
# email did not arrive. Deliberately separate from the 2FA pair above: the key
# is scoped per purpose, so one stored kind can never be decrypted with
# another's derivation, and altering `encrypt_secret` would brick every TOTP
# secret already stored.
_PREFIX_V1 = "fernet1$"


def _key_material() -> bytes:
    """``FIELD_ENCRYPTION_KEY`` when configured, else ``SECRET_KEY``.

    A separate key means a leaked ``SECRET_KEY`` does not also unlock stored
    codes; the fallback keeps dev and tests working with no configuration."""
    key = getattr(settings, "FIELD_ENCRYPTION_KEY", "") or settings.SECRET_KEY
    return str(key).encode("utf-8")


def _fernet_for(purpose: str) -> Fernet | None:
    if not _HAS_FERNET:
        return None
    digest = hashlib.sha256(
        _key_material() + b"|" + purpose.encode("ascii")
    ).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_for(purpose: str, plaintext: str) -> str:
    """Reversibly store ``plaintext`` under ``purpose``.

    Returns ``""`` when encryption is unavailable — storing NOTHING is the
    right degradation for a live credential, never plaintext at rest. The
    caller treats an empty column as "not readable", which is exactly what
    every pre-existing row already is."""
    if not plaintext:
        return ""
    f = _fernet_for(purpose)
    if f is None:  # pragma: no cover - dependency is committed
        return ""
    return _PREFIX_V1 + f.encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_for(purpose: str, stored: str) -> str:
    """Read back what ``encrypt_for`` wrote, or ``""``.

    Never raises. A rotated key, a truncated column or a legacy row makes the
    panel say "not readable" rather than 500 in the middle of an event."""
    if not stored or not stored.startswith(_PREFIX_V1):
        return ""
    f = _fernet_for(purpose)
    if f is None:  # pragma: no cover - dependency is committed
        return ""
    try:
        return f.decrypt(stored[len(_PREFIX_V1):].encode("ascii")).decode("utf-8")
    except Exception:
        return ""
