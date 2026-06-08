"""Production settings — DEBUG off, TLS/HSTS, Redis cache + channels, real SMTP.

Operators MUST provide via environment (see .env.example); there are NO
production-safe fallbacks for these:
  - SECRET_KEY  : strong, 50+ random chars (base.py requires it — no default)
  - DATABASE_URL: a NON-superuser, non-owner Postgres role, so the append-only
                  audit guarantee (REVOKE UPDATE/DELETE on audit_event) holds.
  - REDIS_URL   : for cache + channels pub/sub (live transport, invariant #11)
  - ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS, CORS_ALLOWED_ORIGINS
  - EMAIL_* (SMTP), DEFAULT_FROM_EMAIL
  - SUPERUSER_* are read only at one-time bootstrap, then should be unset.

Deploy pre-flight must also assert no tournament is in a live state before
running migrations (PRD §5).
"""
from __future__ import annotations

from .base import *  # noqa: F401,F403
from .base import env

DEBUG = False

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost"])
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])
CORS_ALLOW_CREDENTIALS = True

# --- Transport security (behind nginx/Caddy TLS per the VPS plan) ---------
SECURE_SSL_REDIRECT = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 60 * 60 * 24 * 365  # 1 year
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# base.py derives these from the (dev) .env DEBUG; force them on in prod.
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

# --- Cache — Redis --------------------------------------------------------
REDIS_URL = env("REDIS_URL", default="redis://127.0.0.1:6379/0")
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL,
    }
}

# --- Channels — Redis pub/sub (live delivery layer, invariants #4/#11) -----
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [REDIS_URL]},
    }
}

# --- Email -----------------------------------------------------------------
# Backend is env-selectable. Production uses Amazon SES via django-ses
# (EMAIL_BACKEND=django_ses.SESBackend); SMTP remains available as a fallback.
EMAIL_BACKEND = env("EMAIL_BACKEND", default="django.core.mail.backends.smtp.EmailBackend")
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="no-reply@fixture.doxaed.com")
SERVER_EMAIL = env("SERVER_EMAIL", default=DEFAULT_FROM_EMAIL)

# SES (django-ses) — auth via the shared IAM key pair, API not SMTP.
AWS_ACCESS_KEY_ID = env("AWS_ACCESS_KEY_ID", default="")
AWS_SECRET_ACCESS_KEY = env("AWS_SECRET_ACCESS_KEY", default="")
AWS_SES_REGION_NAME = env("AWS_SES_REGION_NAME", default="ap-south-2")
AWS_SES_REGION_ENDPOINT = env(
    "AWS_SES_REGION_ENDPOINT", default="email.ap-south-2.amazonaws.com"
)

# SMTP fallback (only used when EMAIL_BACKEND is the smtp backend).
EMAIL_HOST = env("EMAIL_HOST", default="")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="")
EMAIL_USE_TLS = env.bool("EMAIL_USE_TLS", default=True)

# --- Logging --------------------------------------------------------------
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "django": {"handlers": ["console"], "level": "INFO", "propagate": False},
    },
}

# Hard guard: production must never run with DEBUG on.
assert DEBUG is False, "prod settings must have DEBUG=False"
