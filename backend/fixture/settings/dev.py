"""Development settings — local Postgres, no Docker, console email backend."""
from __future__ import annotations

from .base import *  # noqa: F401,F403
from .base import INSTALLED_APPS, MIDDLEWARE  # explicit import for re-exposure

DEBUG = True

# CORS for the React SPA on localhost (Vite default 5173; falls back to 5174 if busy)
INSTALLED_APPS = INSTALLED_APPS  # noqa: PLW0127
CORS_ALLOWED_ORIGINS = [
    f"http://{host}:{port}"
    for host in ("localhost", "127.0.0.1")
    for port in (5173, 5174, 5175, 5176, 5177)
]
CORS_ALLOW_CREDENTIALS = True

# Django 5 CSRF: cross-origin POSTs require explicit trusted origins. The
# SPA POSTs include the csrftoken cookie + X-CSRFToken header, but the
# Origin header check still applies to non-same-origin requests.
CSRF_TRUSTED_ORIGINS = list(CORS_ALLOWED_ORIGINS)

# Console email backend so dev doesn't try to send real mail
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

# Console-level logging
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "console": {"class": "logging.StreamHandler"},
    },
    "loggers": {
        "django": {"handlers": ["console"], "level": "INFO"},
        "fixture": {"handlers": ["console"], "level": "DEBUG"},
        "apps": {"handlers": ["console"], "level": "DEBUG"},
    },
}

# Skip CSRF on Spectacular schema view in dev
SPECTACULAR_SETTINGS = {  # noqa: F811
    "TITLE": "Fixture Platform API (DEV)",
    "DESCRIPTION": "Phase 1A — User types, Org membership, RBAC modules, Super-admin console.",
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# Disable Axes lockout in tests (re-enabled in test config if needed)
AXES_ENABLED = True
