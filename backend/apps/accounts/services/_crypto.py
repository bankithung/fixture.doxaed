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


def _fernet() -> "Fernet | None":
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
