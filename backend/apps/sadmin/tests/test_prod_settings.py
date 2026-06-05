"""Smoke test: the production settings module is hardened (DEBUG off, TLS, Redis, SMTP)."""
from __future__ import annotations

import importlib


def test_prod_settings_are_hardened():
    m = importlib.import_module("fixture.settings.prod")

    assert m.DEBUG is False
    assert m.SECURE_SSL_REDIRECT is True
    assert m.SECURE_HSTS_SECONDS >= 31_536_000  # >= 1 year
    assert m.SESSION_COOKIE_SECURE is True
    assert m.CSRF_COOKIE_SECURE is True
    assert m.SECURE_PROXY_SSL_HEADER == ("HTTP_X_FORWARDED_PROTO", "https")
    assert "redis" in m.CACHES["default"]["BACKEND"].lower()
    assert "redis" in m.CHANNEL_LAYERS["default"]["BACKEND"].lower()
    assert m.EMAIL_BACKEND.endswith("smtp.EmailBackend")
