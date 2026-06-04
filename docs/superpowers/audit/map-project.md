# Structural Map — `backend/fixture/` (Project Config)

**Scope:** `backend/fixture/` (settings, urls, asgi, wsgi), `backend/manage.py`, `backend/pyproject.toml`, `backend/scripts/`.  
**Date:** 2026-06-04  
**Status:** Phase 1A complete; Phase 1B not started.

---

## 1. Purpose

`backend/fixture/` is the Django project package (the "project root" in Django terms).  
It owns:
- Settings split: `settings/base.py` (shared) + `settings/dev.py` (local dev overrides). No `prod.py` yet.
- Root URL config (`urls.py`) that includes all Phase 1A app routers.
- ASGI/WSGI entry points (`asgi.py`, `wsgi.py`).

`pyproject.toml` is the PEP 517 project manifest, pinning all runtime and dev dependencies and configuring ruff, mypy, and pytest.

`manage.py` delegates to `fixture.settings.dev` by default.

---

## 2. Key Files

| File | Role |
|---|---|
| `fixture/settings/base.py` | Shared settings: INSTALLED_APPS, MIDDLEWARE, DRF config, auth, axes, channels, cache, CORS middleware load, spectacular, session/CSRF, i18n, etc. |
| `fixture/settings/dev.py` | Dev overrides: DEBUG=True, CORS_ALLOWED_ORIGINS, CSRF_TRUSTED_ORIGINS, console email backend, logging, SPECTACULAR_SETTINGS override. |
| `fixture/urls.py` | Root URLconf: api_v1 group (`/api/`), Spectacular schema (`/api/schema/`, `/api/docs/`), sadmin (`/sadmin/`). |
| `fixture/asgi.py` | Bare ASGI callable — Django HTTP only; no Channels routing installed. |
| `fixture/wsgi.py` | Standard WSGI callable. |
| `manage.py` | Django management entry point; defaults to `fixture.settings.dev`. |
| `pyproject.toml` | All deps, ruff/mypy/pytest config. Python 3.13, Django 5.1. |
| `scripts/seed_full_demo.py` | Idempotent Phase 1A demo-data seeder (7 roles, 1 org). |
| `scripts/seed_demo_admin.py` | Backwards-compatible alias that delegates to `seed_full_demo.py`. |
| `scripts/CREDENTIALS.md` | Reference card for demo accounts (not committed to version control — appears in `.gitignore`). Actually tracked; contains plain-text passwords. |

---

## 3. Installed Apps

### Django core
`django.contrib.admin`, `auth`, `contenttypes`, `sessions`, `messages`, `staticfiles`

### Third-party
`rest_framework`, `corsheaders`, `channels`, `rules.apps.AutodiscoverRulesConfig`, `django_htmx`, `axes`, `waffle`, `drf_spectacular`

### Local (Phase 1A)
`apps.accounts`, `apps.audit`, `apps.organizations`, `apps.permissions`, `apps.sadmin`, `apps.sports`

**Missing from INSTALLED_APPS vs. pyproject.toml dependencies:**
- `django-tailwind` is a declared dependency (`pyproject.toml:39`) but `tailwind` is not in `INSTALLED_APPS`.
- `django-browser-reload` is a declared dependency (`pyproject.toml:40`) but not in `INSTALLED_APPS` or `MIDDLEWARE`.
- `pwned-passwords-django` is declared (`pyproject.toml:23`) but `PwnedPasswordsValidator` is absent from `AUTH_PASSWORD_VALIDATORS` in `base.py`.

---

## 4. Endpoints / URL Routes (root-level)

| Prefix | Included from | Notes |
|---|---|---|
| `/api/accounts/` | `apps.accounts.urls` | Auth, login, 2FA, password reset, me, soft-delete |
| `/api/orgs/` | `apps.organizations.urls` | Org CRUD, invitations, members, ownership transfer, slug/UUID routes |
| `/api/invitations:accept/` | `apps.organizations.views.InvitationAcceptView` | AIP-136 colon-verb root alias |
| `/api/permissions/` | `apps.permissions.urls` | Module catalog, grants |
| `/api/audit/` | `apps.audit.urls` | Audit log read |
| `/api/sports/` | `apps.sports.urls` | Phase 1B-prep catalog (read-only) |
| `/api/feedback/submit/` | `apps.sadmin.views.FeedbackSubmitView` | Public feedback widget |
| `/api/schema/` | `drf_spectacular.views.SpectacularAPIView` | OpenAPI schema |
| `/api/docs/` | `drf_spectacular.views.SpectacularSwaggerView` | Swagger UI |
| `/sadmin/` | `apps.sadmin.urls` | Custom super-admin console |

**Notable:** `/admin/` (Django built-in admin) is intentionally absent from `urls.py` per `v1Users.md §1.5` — correct. However, `django.contrib.admin` remains in `INSTALLED_APPS` (base.py:27), which means admin migrations run and admin site templates are loaded even though the URL surface is disabled.

---

## 5. Findings

### F-01 · HIGH · DEFAULT_AUTO_FIELD is BigAutoField — violates Invariant #1 (UUID v7 PKs)

**File:** `backend/fixture/settings/base.py:141`  
**Evidence:**
```python
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
```
**Why it matters:** Invariant #1 mandates UUID v7 primary keys everywhere; no sequential/auto-increment IDs. `DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"` is the global Django fallback for any model that does not explicitly declare its primary key. Third-party apps (`waffle`, `axes`, `channels`) will create auto-increment integer PKs. More critically, any future app that forgets an explicit `id` field declaration will silently get BigAutoField rather than a UUID. This is a silent footgun that will grow harder to fix after Phase 1B adds more models.  
**Recommendation:** Change to a custom UUID v7 field if one exists, or at minimum document that every local model must declare `id = uuid7_field(...)` explicitly and add a CI lint rule asserting no local model inherits `BigAutoField` as its PK. Alternatively accept BigAutoField only for third-party apps (already the practice) but make that constraint explicit in CLAUDE.md.

---

### F-02 · HIGH · asgi.py does not configure Channels routing — live transport is broken

**File:** `backend/fixture/asgi.py:1-16`  
**Evidence:**
```python
from django.core.asgi import get_asgi_application
application = get_asgi_application()
```
**Why it matters:** `channels` is in `INSTALLED_APPS` and `ASGI_APPLICATION = "fixture.asgi.application"` is set (base.py:98), but `asgi.py` exports a plain Django HTTP application without `ProtocolTypeRouter` or `URLRouter`. WebSocket and SSE connections will fail at the protocol level — `channels` will never dispatch them. This matters for Phase 1B (Invariants #4, #11) but also means any current consumer test would fail.  
**Recommendation:** Wrap with `channels.routing.ProtocolTypeRouter` and an `http` key pointing to `get_asgi_application()`. Add a `websocket` key (even if it points to an empty `URLRouter([])`) so the protocol layer is correct before Phase 1B consumers land.

---

### F-03 · HIGH · InMemoryChannelLayer + LocMemCache in base.py — must not reach production

**File:** `backend/fixture/settings/base.py:186-196`  
**Evidence:**
```python
CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        ...
    },
}
```
**Why it matters:** Both are configured in `base.py`, meaning `prod.py` (when it lands) must remember to override them. `InMemoryChannelLayer` does not work across multiple processes/workers and loses all state on restart. `LocMemCache` cannot be shared across processes. These are hard-to-diagnose production bugs when the prod settings file is scaffolded. (Known issue; documented in task description as item (d), confirmed here.)  
**Recommendation:** Move the non-dev defaults to `dev.py` only. Add `# REQUIRED IN PROD: override CHANNEL_LAYERS + CACHES to use Redis` comments in base.py or create a stub `settings/prod.py` that asserts `CHANNEL_LAYERS["default"]["BACKEND"] != "channels.layers.InMemoryChannelLayer"`.

---

### F-04 · HIGH · No prod.py settings file exists

**File:** `backend/fixture/settings/` (directory listing)  
**Evidence:** Only `__init__.py`, `base.py`, `dev.py` exist. The base.py docstring says _"Loaded by both `dev.py` and (eventually) `prod.py`"_ (base.py:3).  
**Why it matters:** With no `prod.py`, deploying to the single Ubuntu VPS (PRD §11) requires either pointing `DJANGO_SETTINGS_MODULE` at `dev.py` (dangerous: `DEBUG=True`, console email) or manually setting environment variables. Prod-specific settings (HSTS, SSL redirect, `SECURE_*` headers, real email backend, Redis channel/cache layers, `ALLOWED_HOSTS` for the domain) are undocumented and unenforced.  
**Recommendation:** Create `settings/prod.py` even as a stub now that asserts `DEBUG=False`, overrides channel/cache to Redis, sets `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS`, `SECURE_CONTENT_TYPE_NOSNIFF`, and configures a real email backend.

---

### F-05 · MEDIUM · CORS_ALLOWED_ORIGINS and CSRF_TRUSTED_ORIGINS are dev.py only — missing from prod

**File:** `backend/fixture/settings/dev.py:11-21`  
**Evidence:**
```python
CORS_ALLOWED_ORIGINS = [
    f"http://{host}:{port}"
    for host in ("localhost", "127.0.0.1")
    for port in (5173, 5174, 5175, 5176, 5177)
]
CORS_ALLOW_CREDENTIALS = True
CSRF_TRUSTED_ORIGINS = list(CORS_ALLOWED_ORIGINS)
```
`corsheaders.middleware.CorsMiddleware` is in `base.py:62` but no `CORS_ALLOWED_ORIGINS` is set there. Without a prod override, `corsheaders` will block all cross-origin requests in production (default deny).  
**Recommendation:** Add production domain values in `prod.py`. Document that `CORS_ALLOWED_ORIGINS` is required for the deployed SPA domain.

---

### F-06 · MEDIUM · drf-spectacular operationId collisions in schema.yml

**File:** `backend/schema.yml` (lines 163, 186, 291, 749, 771, 842, 1236, 1264)  
**Evidence:**
```yaml
# line 163
operationId: accounts_auth_password_reset_complete_create_2
# line 186
operationId: accounts_auth_password_reset_request_create_2
# line 749
operationId: orgs_invitations_list_2
# line 1236
operationId: permissions_orgs_users_grants_list_2
```
The `_2` suffix means drf-spectacular auto-resolved a collision by appending a suffix. Root cause: accounts URLs define both hyphen (`password-reset-request/`) and underscore (`password_reset_request/`) aliases (accounts/urls.py:22-32); orgs URLs define both slug and UUID routes for the same resource; same for permissions grants. (Known issue; task description item (c).)  
**Recommendation:** Remove the hyphen aliases (or the underscore aliases) from `accounts/urls.py`; pick one convention per AIP-136 (hyphens). For orgs/permissions, use `extend_schema(operation_id=...)` to explicitly set unique IDs, or restructure slug-vs-UUID routing to avoid duplicate schema entries.

---

### F-07 · MEDIUM · django.contrib.admin is in INSTALLED_APPS but admin URL is intentionally disabled

**File:** `backend/fixture/settings/base.py:27`  
**Evidence:**
```python
"django.contrib.admin",
```
`urls.py` confirms: `path("admin/", ...)` is absent (intentionally, per `v1Users.md §1.5`). But the app remains installed, which means: (a) admin migrations run and create `django_admin_log`; (b) `AdminSite` is initialized; (c) any accidental `import django.contrib.admin` auto-discovers registrations; (d) the default admin index page is accessible if someone adds the URL.  
**Recommendation:** Remove `django.contrib.admin` from `INSTALLED_APPS` if the URL surface is permanently disabled. If keeping it for `LogEntry` auditing, add a comment explaining why. The admin app is also required by `django.contrib.auth` only for its `UserAdmin`—which you are not using since you have a custom admin console.

---

### F-08 · MEDIUM · pwned-passwords-django is a declared dependency but not used in AUTH_PASSWORD_VALIDATORS

**File:** `backend/pyproject.toml:23`, `backend/fixture/settings/base.py:115-120`  
**Evidence:**
```toml
# pyproject.toml
"pwned-passwords-django>=2.1",
```
```python
# base.py — AUTH_PASSWORD_VALIDATORS contains only:
MinimumLengthValidator (min_length=12)
CommonPasswordValidator
NumericPasswordValidator
```
`PwnedPasswordsValidator` is absent. The library is installed but has no effect.  
**Recommendation:** Either add `{"NAME": "pwned_passwords_django.validators.PwnedPasswordsValidator"}` to `AUTH_PASSWORD_VALIDATORS`, or remove the dependency from `pyproject.toml`. PRD §2.10 (password strength) likely intended this.

---

### F-09 · MEDIUM · django-tailwind and django-browser-reload are declared dependencies but not integrated

**File:** `backend/pyproject.toml:39-40`  
**Evidence:**
```toml
"django-tailwind>=3.8",
"django-browser-reload>=1.13",  # tailwind dev autoreload
```
Neither `tailwind` nor `django_browser_reload` appear in `INSTALLED_APPS` or `MIDDLEWARE` in `settings/base.py` or `settings/dev.py`. The sadmin console uses templates (`apps/sadmin/templates/`) but the Tailwind CSS build pipeline is not wired.  
**Recommendation:** If sadmin uses Tailwind, add `"tailwind"` (and `"django_browser_reload"`) to `INSTALLED_APPS` in `base.py` / `dev.py`, configure `TAILWIND_APP_NAME`, and add the browser-reload middleware to `dev.py`. Otherwise remove these from `pyproject.toml` to avoid confusing future developers.

---

### F-10 · MEDIUM · SPECTACULAR_SETTINGS is redundantly overridden in dev.py with identical values

**File:** `backend/fixture/settings/dev.py:41-46`  
**Evidence:**
```python
SPECTACULAR_SETTINGS = {  # noqa: F811
    "TITLE": "Fixture Platform API (DEV)",
    "DESCRIPTION": "Phase 1A — ...",
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
}
```
The only difference from `base.py:172-177` is the `TITLE` suffix `" (DEV)"`. The `SERVE_INCLUDE_SCHEMA: False` in dev means the schema endpoint returns 403 even in dev, forcing developers to use `/api/schema/` explicitly. The `noqa: F811` suppresses the redefinition lint.  
**Recommendation:** Either (a) set `SERVE_INCLUDE_SCHEMA: True` in `dev.py` so Swagger UI can serve inline schema without the extra redirect, or (b) collapse the two dict definitions by only overriding the `TITLE` key in `dev.py` (`SPECTACULAR_SETTINGS["TITLE"] += " (DEV)"`).

---

### F-11 · MEDIUM · No EMAIL_BACKEND in base.py — silent failure if prod.py never sets one

**File:** `backend/fixture/settings/base.py` (absent), `backend/fixture/settings/dev.py:24`  
**Evidence:** `EMAIL_BACKEND` appears only in `dev.py`. Django's default is `django.core.mail.backends.smtp.EmailBackend` which requires `EMAIL_HOST` etc. If prod.py is created without setting `EMAIL_BACKEND`, all email (password reset, invite) silently fails unless SMTP env vars are set.  
**Recommendation:** Add an explicit `EMAIL_BACKEND` placeholder in `base.py` (commented out or set to `smtp.EmailBackend` with `EMAIL_HOST = env("EMAIL_HOST", default="localhost")`) so the omission is visible.

---

### F-12 · LOW · INSTALLED_APPS self-assignment in dev.py is a no-op with misleading comment

**File:** `backend/fixture/settings/dev.py:5,10`  
**Evidence:**
```python
from .base import INSTALLED_APPS, MIDDLEWARE  # explicit import for re-exposure
...
INSTALLED_APPS = INSTALLED_APPS  # noqa: PLW0127
```
The `noqa: PLW0127` suppresses the "self-assignment" lint. The comment "explicit import for re-exposure" implies this is needed for something, but `from .base import *` already makes these names available. The self-assignment does nothing and could confuse future maintainers adding apps to dev.py.  
**Recommendation:** Remove the self-assignment line and the explicit import if it serves no purpose, or add a code comment explaining why re-exposure is needed (e.g., for type checkers or IDE introspection).

---

### F-13 · LOW · README.md says "Postgres 18" but CLAUDE.md / PRD says "Postgres 16"

**File:** `backend/README.md:7`  
**Evidence:**
```
- Postgres 18 (local install, no Docker)
```
CLAUDE.md line 18: `"Postgres 16, Redis 7"`. PRD canonical spec locks Postgres 16. README appears to reflect the developer's local actual installation rather than the locked spec version.  
**Recommendation:** Align README to the locked spec (Postgres 16) or update CLAUDE.md/PRD if the version decision has been deliberately upgraded. Given Postgres 18 is not yet GA as of June 2026, this may be a typo for 17.

---

### F-14 · LOW · scripts/CREDENTIALS.md contains plain-text passwords and is tracked by git

**File:** `backend/scripts/CREDENTIALS.md:27-33`  
**Evidence:**
```
| Super-admin | graceschooledu@gmail.com | DoxaEd33@ | ...
| Admin (org owner) | admin@doxaed.test | Admin123!@ | ...
```
The file is in `backend/scripts/`, and `backend/.gitignore` does not exclude `scripts/CREDENTIALS.md`. The `.env` file (which also contains passwords) is correctly listed in `.gitignore`.  
**Recommendation:** Add `scripts/CREDENTIALS.md` to `.gitignore`, or strip actual passwords from the file and reference `.env` / the seed script instead. These are dev-only credentials, but having them in git history is poor practice.

---

### F-15 · LOW · No CSRF_HEADER_NAME custom setting — Invariant #15 mentions custom header

**File:** `backend/fixture/settings/base.py` (absent)  
**Evidence:** Invariant #15 states: _"DRF cookies + CSRF token in custom header."_ Django's default is `HTTP_X_CSRFTOKEN` (header: `X-CSRFToken`). DRF also uses `X-CSRFToken` by default. No custom `CSRF_HEADER_NAME` is set. The dev.py comment at line 19 mentions `X-CSRFToken` which is the standard name — so either "custom header" in the invariant means non-JWT (not a truly custom name), or there is a missing setting.  
**Recommendation:** Clarify the invariant: if `X-CSRFToken` is the intended header (Django default), document that explicitly and remove "custom" from the invariant wording. If a different header is intended, add `CSRF_HEADER_NAME = "HTTP_X_CSRFTOKEN"` (or the custom value) explicitly.

---

### F-16 · LOW · No production security headers configured anywhere

**File:** `backend/fixture/settings/base.py` and `dev.py` (both absent)  
**Evidence:** None of the following appear in any settings file: `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS`, `SECURE_HSTS_INCLUDE_SUBDOMAINS`, `SECURE_CONTENT_TYPE_NOSNIFF`, `SECURE_BROWSER_XSS_FILTER`, `X_FRAME_OPTIONS` override.  
**Why it matters:** `SecurityMiddleware` is in `MIDDLEWARE` but does nothing for HSTS/SSL redirect unless these are set. Django's defaults are `SECURE_SSL_REDIRECT=False`, `SECURE_HSTS_SECONDS=0`. When `prod.py` is created, these are easy to forget.  
**Recommendation:** Add explicit placeholder values in `base.py` (all disabled for dev) with comments marking them as required for prod.

---

### F-17 · INFO · Channels is scaffolded but not wired — by design for Phase 1A

**File:** `backend/fixture/settings/base.py:185-188`, `backend/fixture/asgi.py`  
**Evidence:** Comment at base.py:185: `# --- Channels (Phase 1A: in-memory; Phase 1B: Redis) ---`. The `channels` package is installed and `CHANNEL_LAYERS` is configured but `asgi.py` uses plain `get_asgi_application()`.  
**Severity:** Info (expected for Phase 1A). No consumer code exists yet, so this is not broken — it is deferred. Track the upgrade to `ProtocolTypeRouter` + `channels-redis` as Phase 1B day-1 tasks.

---

### F-18 · INFO · django-waffle is installed with no feature flags configured

**File:** `backend/fixture/settings/base.py:42,71`  
**Evidence:** `waffle` in INSTALLED_APPS, `waffle.middleware.WaffleMiddleware` in MIDDLEWARE. No `WAFFLE_*` settings are configured.  
**Severity:** Info. No flags appear to be in use yet. This is fine for Phase 1A but should be documented so Phase 1B teams know they have a feature-flag system available.

---

### F-19 · INFO · Session cookie age is 30 days unconditionally — no "remember me" toggle yet

**File:** `backend/fixture/settings/base.py:147`  
**Evidence:**
```python
SESSION_COOKIE_AGE = 60 * 60 * 24 * 30  # 30 days "remember me"
```
This is a global setting applied to all sessions. A "remember me" checkbox in the SPA would require `request.session.set_expiry()` per-login to override it.  
**Severity:** Info. The comment acknowledges this is a "remember me" equivalent. Track as a UX detail.

---

### F-20 · INFO · manage.py and asgi.py/wsgi.py all default to `fixture.settings.dev`

**File:** `backend/manage.py:10`, `backend/fixture/asgi.py:14`, `backend/fixture/wsgi.py:14`  
**Evidence:** All three hardcode `fixture.settings.dev` as the `DJANGO_SETTINGS_MODULE` default.  
**Severity:** Info. This is standard for a single-developer greenfield project. A prod deploy must set `DJANGO_SETTINGS_MODULE=fixture.settings.prod` via environment variable / systemd unit — documented nowhere currently. Capture this in the future `prod.py` / deployment runbook.

---

## 6. Gaps

| Gap | Impact |
|---|---|
| No `settings/prod.py` | Critical path for deployment; all prod-specific values (Redis, HSTS, email, domain CORS) are undocumented and unenforced. |
| No Channels `ProtocolTypeRouter` in `asgi.py` | Phase 1B live features will not work without this; should be the first Phase 1B infrastructure task. |
| `pwned-passwords-django` declared but unused | Either add to `AUTH_PASSWORD_VALIDATORS` or remove; currently false security. |
| `django-tailwind` / `django-browser-reload` declared but not integrated | Sadmin Tailwind build pipeline is unverified; CSS may be hand-written or CDN-linked. |
| No `.gitignore` entry for `scripts/CREDENTIALS.md` | Plain-text demo passwords committed to the repository. |
| No production security settings scaffolded | HSTS, SSL redirect, XSS filter, content-type nosniff are all Django defaults (off) even in base.py. |
| `DEFAULT_AUTO_FIELD = BigAutoField` is a footgun for Invariant #1 | Third-party models and any local model missing an explicit PK declaration will silently get auto-increment integers. |
| No logging configuration in `base.py` | Only `dev.py` configures logging; prod will emit no structured logs until `prod.py` adds a handler. |
