# Subsystem analysis: Backend · project config / ASGI / deploy

> Deep read performed 2026-06-08. Scope: `backend/fixture/settings/{base,dev,prod}.py`,
> `backend/fixture/{asgi,wsgi,urls}.py`, `backend/manage.py`, `backend/pyproject.toml`,
> `deploy/*`, plus the coupled live-transport edge (`apps/live/{routing,consumers,urls}.py`)
> and the config tests (`apps/sadmin/tests/test_prod_settings.py`, `apps/live/tests/test_live.py`).

## Purpose

This subsystem is the Django **project shell**: the layered settings, the WSGI/ASGI
entrypoints, the root URL map, the management CLI, the dependency manifest, and the
native (no-Docker) production deployment artifacts (gunicorn + uvicorn worker, systemd,
nginx, Postgres role model). It is the "chassis bolts" of the platform — it owns no
domain logic but encodes nearly every cross-cutting infrastructure decision from
`v1Users.md` Appendix B and the PRD: session-auth-only, UTC storage, `ATOMIC_REQUESTS`,
append-only audit via DB roles, the SSE/WebSocket transport split, throttle budgets,
and the security headers. Everything else in the codebase loads through here.

## File-by-file roles

- **`backend/fixture/settings/base.py`** (the substantive file). Reads `.env` via
  `django-environ` (`environ.Env.read_env(BASE_DIR / ".env")`), `BASE_DIR` = `backend/`.
  Declares `INSTALLED_APPS` (6 Django + 8 third-party + 14 local), `MIDDLEWARE`
  (11 entries), `TEMPLATES`, `DATABASES` (with `ATOMIC_REQUESTS = True`), auth model +
  Argon2 hashers + password validators, `AUTHENTICATION_BACKENDS`, i18n/TZ (UTC storage),
  static/media, session/CSRF cookie flags, the full `REST_FRAMEWORK` dict (auth/perm/
  throttle), `SPECTACULAR_SETTINGS`, django-axes lockout, `CHANNEL_LAYERS` (in-memory),
  `CACHES` (locmem), and ~15 project tunables (invite TTLs, password-reset rates, 2FA).
- **`backend/fixture/settings/dev.py`** — `DEBUG=True`, CORS for Vite localhost ports
  5173–5177, `CSRF_TRUSTED_ORIGINS = CORS_ALLOWED_ORIGINS`, console email backend,
  console logging, dev Spectacular title. `import *` from base then re-imports
  `INSTALLED_APPS, MIDDLEWARE` "for re-exposure" (a no-op assignment `INSTALLED_APPS = INSTALLED_APPS`).
- **`backend/fixture/settings/prod.py`** — `DEBUG=False`, env-driven `ALLOWED_HOSTS`/
  `CSRF_TRUSTED_ORIGINS`/`CORS_ALLOWED_ORIGINS`, full TLS/HSTS hardening, forces
  `SESSION_COOKIE_SECURE`/`CSRF_COOKIE_SECURE` on (base derives them from `not DEBUG`,
  which is wrong on this box — see smells), Redis cache + Redis channel layer,
  env-selectable email (SES via `django_ses` default, SMTP fallback), production logging,
  and a hard `assert DEBUG is False` at module end.
- **`backend/fixture/settings/__init__.py`** — empty; no default settings module is
  chosen here. Selection happens via `DJANGO_SETTINGS_MODULE`.
- **`backend/fixture/asgi.py`** — initialises `get_asgi_application()` *first* (so the
  app registry is ready before importing consumers that import models), then builds a
  `ProtocolTypeRouter`: `http` → the Django ASGI app; `websocket` →
  `AllowedHostsOriginValidator(AuthMiddlewareStack(URLRouter(websocket_urlpatterns)))`.
  Defaults `DJANGO_SETTINGS_MODULE` to `fixture.settings.dev`.
- **`backend/fixture/wsgi.py`** — vanilla `get_wsgi_application()`; defaults to
  `fixture.settings.dev`. Declared as `WSGI_APPLICATION` but **not used by the deployment**
  (systemd runs the ASGI app under a uvicorn worker).
- **`backend/fixture/urls.py`** — the root URLConf. Builds `api_v1` (mounted at `/api/`),
  the schema/docs routes, and the `/sadmin/` console include; adds static/media serving
  under `DEBUG`.
- **`backend/manage.py`** — standard CLI; defaults `DJANGO_SETTINGS_MODULE=fixture.settings.dev`.
- **`backend/pyproject.toml`** — PEP 621 project metadata, runtime deps (Django 5.1.x,
  DRF, channels/channels-redis/daphne, rules, axes, waffle, drf-spectacular, argon2,
  pyotp, uuid-utils, django-environ, **django-tailwind + django-browser-reload**), a
  `dev` extra (pytest/pytest-django, factory-boy, ruff, mypy strict + django/drf stubs),
  and tool config for ruff, **pytest** (`DJANGO_SETTINGS_MODULE = "fixture.settings.dev"`,
  the `signup_throttle` marker), and mypy (strict, django plugin).
- **`deploy/README.md`** — the runbook: topology diagram, component table, Postgres
  role security model, ops commands, deploy/test procedures, and a "production hardening
  TODO" list.
- **`deploy/fixture.service`** — systemd unit: `Type=notify`, `User=ubuntu Group=www-data`,
  `Environment=DJANGO_SETTINGS_MODULE=fixture.settings.prod`, `RuntimeDirectory=fixture`
  (creates `/run/fixture` 0750 for the socket), `ExecStart` runs gunicorn `-c gunicorn.conf.py
  fixture.asgi:application`, `ExecReload=kill -HUP`, hardening (`NoNewPrivileges`,
  `ProtectSystem=full`, `PrivateTmp`).
- **`deploy/gunicorn.conf.py`** — binds `unix:/run/fixture/gunicorn.sock` (umask 0o007),
  `worker_class = uvicorn.workers.UvicornWorker`, `workers = max(2, cpu*2+1)`,
  `max_requests=1000`+jitter, `timeout=60`, `forwarded_allow_ips="*"`, stdout/stderr logs.
- **`deploy/nginx-fixture.conf`** — TLS terminator + SPA host. `:80`→`:443` redirect;
  `:443` serves `frontend/dist`, `/static/`, `/media/`, proxies `/ws/` (upgrade headers,
  3600s timeouts) and `^/(api|sadmin)/` (`proxy_buffering off` to let SSE stream) to the
  unix socket; SPA fallback `try_files ... /index.html`. `server_name` includes the bare
  IP `16.112.66.154`, `fixture.doxaed.com`, and `_`.
- **`deploy/CREDENTIALS-PROD.md`** — gitignored secret dump: super-admin login, both
  Postgres role passwords, the `SECRET_KEY`, and *published* demo-account passwords.

## Data model

None owned. This subsystem defines `AUTH_USER_MODEL = "accounts.User"`,
`DEFAULT_AUTO_FIELD = BigAutoField` (overridden in practice by UUIDv7 PKs per invariant #1),
and the single default DB connection (`env.db("DATABASE_URL")`). The only "data model"
relevant here is the **Postgres role model** (deploy/README §"Postgres roles"):
`fixture_owner` (NOSUPERUSER, owns the DB, runs migrations, `CREATEDB` toggled on only
for tests) vs `fixture_app` (non-superuser, non-owner, `UPDATE`/`DELETE` **revoked on
`audit_event`** — the DB-level enforcement of append-only audit invariant #5).

## Core algorithms / services (file:symbol, step-by-step)

This subsystem is mostly declarative; the "logic" lives in import-time construction and
a few small helpers.

- **`fixture/asgi.py` (module top level)** — ordering is load-bearing:
  1. `os.environ.setdefault("DJANGO_SETTINGS_MODULE", "fixture.settings.dev")`.
  2. `django_asgi_app = get_asgi_application()` — populates the app registry.
  3. *Only then* `from apps.live.routing import websocket_urlpatterns` (deferred imports
     marked `# noqa: E402`), because `apps/live/routing.py` imports `MatchConsumer`, which
     imports models. Reordering would raise `AppRegistryNotReady`.
  4. `application = ProtocolTypeRouter({...})`. HTTP is plain Django; WS is wrapped
     origin-check → auth → URL-route → consumer.
- **`apps/live/consumers.py::MatchConsumer`** (the WS endpoint the router targets) —
  `connect()` joins channel group `match_<id>` and `accept()`s with **no authorization
  check** (any client may subscribe to any match room, by design: viewers are public);
  `receive_json` echoes pings only (authoritative writes are REST); `match_event(event)`
  is the channel-layer handler that pushes `event["data"]` to the socket. The fan-out
  *producer* is `apps/matches/services/events.py` via `transaction.on_commit` (invariant #4).
- **`apps/accounts/throttling.py::SignupRateThrottle`** — `SimpleRateThrottle`, `scope="signup"`,
  reads its rate from `REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['signup']` (`3/hour`),
  keys on client IP. Applied per-view (`@throttle_classes([SignupRateThrottle])` in
  `apps/accounts/views.py::signup`), *not* globally.
- **`apps/teams/throttling.py` (scope `school_registration`, `30/hour`)** and
  **`apps/sadmin/views/feedback.py::FeedbackSubmitThrottle`** (`UserRateThrottle`,
  `scope="feedback_submit"`, `rate="10/hour"` hardcoded on the class — note this scope is
  *not* in `DEFAULT_THROTTLE_RATES`, so it intentionally bypasses the settings knob).
- **`apps/sadmin/middleware.py::SadminIPAllowlistMiddleware`** — wired last in `MIDDLEWARE`.
  `__call__`: if path starts with `/sadmin/`, read `settings.SADMIN_IP_ALLOWLIST`; if
  non-empty and the client IP (first `X-Forwarded-For` hop, else `REMOTE_ADDR`) is not in
  the CIDR/IP allowlist, raise `Http404` (never 403/redirect — don't reveal the surface).
  No-op when the allowlist is empty (dev default).

## API / endpoint surface (root URL map — `fixture/urls.py`)

`urlpatterns`:
- `api/` → `api_v1` (below)
- `api/schema/` → `SpectacularAPIView` (name `schema`)
- `api/docs/` → `SpectacularSwaggerView` (name `swagger-ui`)
- `sadmin/` → `apps.sadmin.urls` (custom HTMX/Tailwind super-admin console)
- under `DEBUG`: `static(STATIC_URL,...)` + `static(MEDIA_URL,...)`

`api_v1` (each is `path(...)` under `/api/`):
- `accounts/` (`apps.accounts.urls`), `orgs/` (`apps.organizations.urls`)
- `invitations:accept/` (AIP-136 colon-verb, token-based) → `InvitationAcceptView`
- `invitations/` → `MyInvitationsView`; `invitations/<uuid>:accept/` and
  `invitations/<uuid>:decline/` → by-id accept/decline (the comment explicitly argues why
  these do not collide with the token route)
- `permissions/`, `audit/`, `sports/` (read-only), `tournaments/`, `register/`
  (`apps.teams.urls` — public school self-registration), `forms/`, `matches/`,
  `notifications/`, `disputes/`, `live/` (`apps.live.urls`)
- `feedback/submit/` → `FeedbackSubmitView`

WebSocket surface (`apps/live/routing.py`): `ws/match/<uuid:match_id>/` → `MatchConsumer`.
Public REST snapshot (`apps/live/urls.py`): `match/<uuid>/` → `LiveMatchSnapshotView`
(`permission_classes = [AllowAny]`, overriding the global `IsAuthenticated`).

Note: the default Django Admin at `/admin/` is **intentionally absent** (v1Users.md §1.5).

## Invariants that must be preserved

1. **`DATABASES["default"]["ATOMIC_REQUESTS"] = True`** (base.py). Every request is one
   transaction; the `transaction.on_commit` fan-out (invariants #4/#11) and idempotent
   replay semantics (invariant #3) depend on this. Removing it silently breaks live delivery.
2. **`USE_TZ = True`, `TIME_ZONE = "UTC"`** — storage is UTC (invariant #14). `DEFAULT_ORG_TIMEZONE`
   defaults to `Asia/Kolkata`.
3. **Session auth only, no JWT** (`DEFAULT_AUTHENTICATION_CLASSES = [SessionAuthentication]`,
   invariant #15). DRF's `SessionAuthentication` enforces CSRF on unsafe methods, so the
   SPA must send the `csrftoken` cookie + `X-CSRFToken` header. `CSRF_COOKIE_HTTPONLY = False`
   is *required* (JS must read the token); `SESSION_COOKIE_HTTPONLY = True`,
   `SAMESITE = "Lax"`.
4. **Append-only audit via DB role** — prod `DATABASE_URL` MUST be the non-owner
   `fixture_app` role with `UPDATE`/`DELETE` revoked on `audit_event` (invariant #5,
   documented in prod.py docstring + deploy/README). Migrations run as `fixture_owner`.
5. **Argon2id primary hasher** + 12-char min length + axes lockout (10 fails / 15-min
   cooloff on `ip_address`+`username`) — PRD §2.9/§2.10.
6. **ASGI bootstrap order** (`get_asgi_application()` before importing consumers) — see core logic.
7. **`ProtocolTypeRouter` WS stack**: `AllowedHostsOriginValidator` → `AuthMiddlewareStack`
   → `URLRouter`. Origin validation is the WS analogue of CSRF for same-origin; dropping it
   is a CSWSH risk.
8. **Throttle budgets**: anon 60/min, user 240/min globally; signup 3/hr, school_registration
   30/hr, feedback_submit 10/hr — these are spec-locked anti-abuse numbers (v1Users.md B.11).
9. **Prod hardening** (asserted by `test_prod_settings.py`): `DEBUG False`,
   `SECURE_SSL_REDIRECT`, HSTS ≥ 1yr, secure cookies, `SECURE_PROXY_SSL_HEADER`, Redis
   cache + channel layer, SMTP-suffixed email backend. **This test will currently fail or
   mislead** because prod defaults `EMAIL_BACKEND` to smtp but the live `.env` sets
   `EMAIL_BACKEND=django_ses.SESBackend` — the test imports the module with prod's *default*,
   so it passes against defaults but does not reflect the deployed reality (see smells).
10. **Redis is mandatory in prod** for cross-worker live fan-out (gunicorn runs multiple
    uvicorn workers; in-memory channel layer would silo rooms per worker).

## Dependencies / coupling

**Outgoing (this subsystem → others):**
- `base.py INSTALLED_APPS/MIDDLEWARE` enumerate all 14 local apps + the
  `apps.sadmin.middleware.SadminIPAllowlistMiddleware`. Adding/removing a local app touches base.py.
- `urls.py` hard-imports `apps.organizations.views` (4 invitation views) and
  `apps.sadmin.views.FeedbackSubmitView` at module import, and `include()`s 12 app urlconfs.
- `asgi.py` imports `apps.live.routing.websocket_urlpatterns` → `apps.live.consumers.MatchConsumer`.
- Settings constants are read widely: throttle rates by `apps/accounts/throttling.py` &
  `apps/teams/throttling.py`; `FRONTEND_BASE_URL`, `INVITE_TOKEN_TTL_DAYS`,
  `PASSWORD_RESET_*`, `EMAIL_VERIFICATION_TTL_HOURS`, `TWOFA_ISSUER_NAME`,
  `SENSITIVE_REAUTH_WINDOW_MINUTES`, `SUPERUSER_*`, `SADMIN_HOST` by accounts/organizations/sadmin.

**Incoming (others → this subsystem):**
- Every Django process (manage, wsgi, asgi, pytest, gunicorn/systemd) selects a settings
  module here. pytest + manage + wsgi + asgi default to **dev**; only systemd sets **prod**.
- The deploy artifacts couple to concrete paths (`/home/ubuntu/Fixture/...`), the unix
  socket path (`/run/fixture/gunicorn.sock`, shared by gunicorn.conf + systemd + nginx),
  and the Postgres role names.

**External services:** Postgres (`DATABASE_URL`), Redis (`REDIS_URL`, cache+channels),
SES/SMTP (email), nginx (TLS + `X-Forwarded-Proto` for `SECURE_SSL_REDIRECT`).

## Tech debt / smells / duplication

- **`.env` on this box is a *production* env (`DEBUG=False`, `fixture_app` role) but
  `manage.py`/`wsgi.py`/`asgi.py`/pytest all default to `fixture.settings.dev`.** Running
  `manage.py` here without an explicit `DJANGO_SETTINGS_MODULE` loads **dev settings against
  the prod DB/role** — confusing and a footgun. The intended split (dev module ↔ dev env)
  is not what's on disk.
- **Cookie-secure derivation bug avoided by patching twice.** base.py sets
  `SESSION_COOKIE_SECURE = not DEBUG` / `CSRF_COOKIE_SECURE = not DEBUG`. Because the live
  `.env` has `DEBUG=False`, base already computes them `True`; but prod.py re-forces them
  `True` anyway (and *must*, because under dev settings + this env they'd also be True —
  the derivation is fragile and the comment in prod.py acknowledges it). The real risk is
  the inverse: a dev box with `DEBUG=True` correctly disables secure cookies, but the value
  is computed from the *base-time* `DEBUG`, before dev.py sets `DEBUG=True` — so under dev
  settings `SESSION_COOKIE_SECURE` reflects the `.env` DEBUG, not the module's `DEBUG=True`.
  This is a latent layering inconsistency.
- **`test_prod_settings.py` asserts `EMAIL_BACKEND.endswith("smtp.EmailBackend")`** but the
  deployed `.env` uses `django_ses.SESBackend`. The test passes only because it imports the
  module with the prod *default* (smtp); it does not validate the actual deployed value and
  would mislead anyone editing the email config.
- **`django-tailwind` + `django-browser-reload` are in `pyproject.toml` deps but absent
  from `INSTALLED_APPS` and settings.** The sadmin console's Tailwind is wired some other
  way (prebuilt CSS/CDN). Dead/aspirational dependencies.
- **`STATICFILES_DIRS` is empty** (`backend/static/` does not exist); only `STATIC_ROOT`
  (collectstatic target) is used. Harmless but a trap if someone adds project static.
- **`SPECTACULAR_SETTINGS` is duplicated** verbatim between base.py and dev.py (dev only
  changes the title), with a `# noqa: F811` redefinition.
- **dev.py has noise**: `INSTALLED_APPS = INSTALLED_APPS` (`# noqa: PLW0127`) and a redundant
  explicit re-import "for re-exposure" — both no-ops left from an earlier refactor.
- **Secrets in-repo path.** `deploy/CREDENTIALS-PROD.md` (gitignored, chmod 600) contains
  the real `SECRET_KEY`, both DB passwords, super-admin creds, and **published demo
  passwords**; `nginx-fixture.conf` and `.env` hardcode the public IP `16.112.66.154`. The
  README's hardening TODO flags removing demo data and rotating secrets — currently unmet.
- **`SECRET_KEY` has no default** in base.py: any process without `.env`/env var crashes at
  import. Good for prod safety, but means tests/CI must always provide one.
- **No `SECURE_HSTS`/TLS coverage in dev** is fine, but **`forwarded_allow_ips = "*"`** in
  gunicorn trusts `X-Forwarded-*` from anyone able to reach the socket. Acceptable only
  because the socket is unix-domain behind nginx; documented intent, but a sharp edge if the
  bind ever changes to TCP.
- **`AXES_ENABLED = True` in dev.py with a comment "Disable Axes lockout in tests"** — the
  actual disabling happens per-app in `apps/accounts/tests/conftest.py` (`_disable_axes`
  autouse), not in settings; the dev.py comment is stale/misleading.

## Restructuring seams & risks

- **Settings layering is the cleanest seam.** A future split into `base` + `dev`/`prod` +
  a dedicated `test` settings module would let pytest stop pointing at `dev` (and stop the
  dev-settings-against-prod-DB footgun). Move `ATOMIC_REQUESTS`, `USE_TZ`, throttle rates,
  auth backends, and password hashers into base and treat them as immutable invariants;
  add a startup `system check` that asserts them (so a restructure can't silently drop
  `ATOMIC_REQUESTS`).
- **URL map → versioned router.** `api_v1` is a hand-built list with a few top-level views
  hard-imported into `urls.py`. The colon-verb routes (AIP-136) are bespoke `path()`s;
  any move to a DRF router or a v2 namespace must preserve the exact colon-verb URLs (they
  are part of the contract with the SPA and `schema.yml` typegen). Risk: the invitation
  token-route vs by-id-route distinction is subtle (documented inline) — easy to break on
  reshuffle.
- **ASGI/transport seam.** `ProtocolTypeRouter` is the single composition point for HTTP +
  WS; the SSE path is plain HTTP through DRF (no special ASGI wiring beyond
  `proxy_buffering off` in nginx). If WS endpoints multiply, `apps/live/routing.py` is the
  registry to extend; keep the `AllowedHostsOriginValidator → AuthMiddlewareStack` wrapper.
  Risk: `MatchConsumer.connect()` authorizes nothing — if private rooms (scorer-only) are
  ever needed, auth must move into `connect()` (the scope already carries the user via
  `AuthMiddlewareStack`).
- **Channel/cache backend swap.** dev=in-memory/locmem, prod=Redis. This is already a clean
  env-keyed seam; the only coupling is the implicit requirement that *multi-worker prod must
  use Redis*. A restructure should encode that as a check (fail fast if `RedisChannelLayer`
  is absent while `workers > 1`).
- **Deploy artifacts hardcode absolute paths and one host.** `/home/ubuntu/Fixture`, the
  socket path, and `16.112.66.154` are baked into systemd/nginx/gunicorn. Parameterising
  these (templated unit/nginx, env-driven socket path) is a low-risk seam that would make
  the deploy portable. The Postgres two-role model is the load-bearing security invariant —
  any IaC/restructure must preserve owner-vs-app separation and the `audit_event` revokes.
- **WSGI is vestigial.** Deployment is ASGI-only; `wsgi.py`/`WSGI_APPLICATION` can be kept
  for tooling but is not on the serving path — safe to treat as deprecated.
- **Email backend indirection** (SES default in `.env`, smtp default in prod.py, console in
  dev) is env-selectable but under-tested; consolidate the assertion in `test_prod_settings`
  to read the *effective* backend or drop the smtp-specific assert.

## Ambiguities / things to verify before relying on them

- Whether the platform is actually served with `fixture.settings.prod` everywhere it should
  be: only `deploy/fixture.service` sets it. Any cron/management invocation on the box that
  forgets `DJANGO_SETTINGS_MODULE` runs **dev** against the prod DB.
- `test_prod_settings.py` validates prod *defaults*, not the deployed `.env` — treat it as a
  module-import smoke test, not a deployment conformance test.
- `django-tailwind`/`django-browser-reload` deps appear unused at the settings level;
  confirm the sadmin console's CSS pipeline before pruning them.
