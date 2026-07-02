"""Base Django settings for the Fixture Platform backend.

Loaded by both `dev.py` and (eventually) `prod.py`. Reads .env via
django-environ. See v1Users.md Appendix B for the locked-in
infrastructure decisions this file implements.
"""
from __future__ import annotations

from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # backend/

env = environ.Env(
    DEBUG=(bool, False),
    ALLOWED_HOSTS=(list, ["localhost", "127.0.0.1"]),
)
environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env("SECRET_KEY")
DEBUG = env("DEBUG")
ALLOWED_HOSTS = env("ALLOWED_HOSTS")

# --- Apps -----------------------------------------------------------------
DJANGO_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

THIRD_PARTY_APPS = [
    "rest_framework",
    "corsheaders",
    "channels",
    "rules.apps.AutodiscoverRulesConfig",
    "django_htmx",
    "axes",
    "waffle",
    "drf_spectacular",
]

# Phase 1A apps. tournaments/teams/matches/disputes deferred to Phase 1B.
# `apps.sports` is the Phase 1B-prep catalog (read-only metadata only).
LOCAL_APPS = [
    "apps.accounts",
    "apps.audit",
    "apps.organizations",
    "apps.permissions",
    "apps.sadmin",
    "apps.sports",
    "apps.tournaments",
    "apps.teams",
    "apps.forms",
    "apps.matches",
    "apps.fixtures",
    "apps.notifications",
    "apps.disputes",
    "apps.live",
    "apps.assistant",
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

# --- Middleware -----------------------------------------------------------
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django_htmx.middleware.HtmxMiddleware",
    "axes.middleware.AxesMiddleware",
    "waffle.middleware.WaffleMiddleware",
    # Super-admin IP allowlist — opt-in (no-op unless SADMIN_IP_ALLOWLIST set).
    "apps.sadmin.middleware.SadminIPAllowlistMiddleware",
]

# Super-admin IP allowlist (B.15). Default: empty list = no restriction.
# Production sets a list of CIDR / single IPs (operator home/office/VPN).
SADMIN_IP_ALLOWLIST = env.list("SADMIN_IP_ALLOWLIST", default=[])

ROOT_URLCONF = "fixture.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "fixture.wsgi.application"
ASGI_APPLICATION = "fixture.asgi.application"

# --- Database (locked: local Postgres, password via .env) ----------------
DATABASES = {"default": env.db("DATABASE_URL")}
DATABASES["default"]["ATOMIC_REQUESTS"] = True

# --- Auth -----------------------------------------------------------------
AUTH_USER_MODEL = "accounts.User"

# Argon2id per PRD §2.10 + v1Users.md §1.4 / B.12 lock.
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher",
    "django.contrib.auth.hashers.BCryptSHA256PasswordHasher",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
     "OPTIONS": {"min_length": 12}},  # PRD §2.10
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

AUTHENTICATION_BACKENDS = [
    "rules.permissions.ObjectPermissionBackend",
    "axes.backends.AxesStandaloneBackend",
    "django.contrib.auth.backends.ModelBackend",
]

# --- I18n / TZ (locked: UTC storage, default Asia/Kolkata for org tz) ---
LANGUAGE_CODE = env("LANGUAGE_CODE", default="en-us")
TIME_ZONE = "UTC"  # storage TZ; tournaments override per PRD §7.8
USE_I18N = True
USE_TZ = True

# --- Static / media -------------------------------------------------------
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"] if (BASE_DIR / "static").exists() else []
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- Sessions / CSRF ------------------------------------------------------
SESSION_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 60 * 60 * 24 * 30  # 30 days "remember me"
CSRF_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_HTTPONLY = False  # JS reads token for SPA + HTMX

# --- DRF ------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "60/min",
        "user": "240/min",
        # v1Users.md Appendix B.11: Org self-signup (Path B) 3/hr/IP.
        "signup": "3/hour",
        # Public school self-registration via shared link — anti-abuse cap.
        "school_registration": "30/hour",
        # Setup-assistant chat — bounds Gemini spend per user.
        "assistant": "30/min",
    },
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Fixture Platform API",
    "DESCRIPTION": "Phase 1A — User types, Org membership, RBAC modules, Super-admin console.",
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# --- django-axes (login lockout per PRD §2.9) ----------------------------
AXES_FAILURE_LIMIT = 10  # PRD §2.9 invariant
AXES_COOLOFF_TIME = 0.25  # 15 minutes (0.25 hours) per PRD §2.9
AXES_LOCKOUT_PARAMETERS = ["ip_address", "username"]
AXES_RESET_ON_SUCCESS = True

# --- Channels (Phase 1A: in-memory; Phase 1B: Redis) ---------------------
CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}

# --- Cache (dev: locmem; prod will be Redis) -----------------------------
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "fixture-default-cache",
    },
}

# --- Super-admin defaults (read by management commands) ------------------
SUPERUSER_EMAIL = env("SUPERUSER_EMAIL", default=None)
SUPERUSER_PASSWORD = env("SUPERUSER_PASSWORD", default=None)
SADMIN_HOST = env("SADMIN_HOST", default="localhost")

# --- Project tunables -----------------------------------------------------
# Public base URL of the SPA — used to build absolute links in outbound email
# (verification, password reset, invitations). Prod sets the real https origin.
FRONTEND_BASE_URL = env("FRONTEND_BASE_URL", default="http://localhost:5173").rstrip("/")
DEFAULT_ORG_TIMEZONE = env("TIME_ZONE", default="Asia/Kolkata")

# --- Setup assistant (Gemini) --------------------------------------------
# Server-side only; the key never reaches the browser. Empty = assistant off
# (the endpoint returns 503 and the UI hides the launcher).
GEMINI_API_KEY = env("GEMINI_API_KEY", default="")
GEMINI_MODEL = env("GEMINI_MODEL", default="gemini-2.5-flash")
INVITE_TOKEN_TTL_DAYS = 7
PENDING_ARCHIVE_DAYS = 30
OWNER_2FA_GRACE_DAYS = 7  # v1Users.md B.12

# Auth tunables (v1Users.md §2.4, A.5)
PASSWORD_RESET_TTL_MINUTES = 60
PASSWORD_RESET_RATE_PER_EMAIL_HOUR = 5
PASSWORD_RESET_RATE_PER_IP_HOUR = 10
EMAIL_VERIFICATION_TTL_HOURS = 48
TWOFA_ISSUER_NAME = "Fixture Platform"
SENSITIVE_REAUTH_WINDOW_MINUTES = 5  # B.18 password re-prompt window

# --- Error monitoring (inert unless SENTRY_DSN is set in .env) --------------
SENTRY_DSN = env("SENTRY_DSN", default="")
if SENTRY_DSN:
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=SENTRY_DSN,
            environment=env("SENTRY_ENVIRONMENT", default="production"),
            traces_sample_rate=env.float("SENTRY_TRACES_SAMPLE_RATE", default=0.0),
            send_default_pii=False,
        )
    except ImportError:  # sdk not installed: monitoring off, app unaffected
        pass
