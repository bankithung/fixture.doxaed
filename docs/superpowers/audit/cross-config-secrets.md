# Cross-Cutting Audit: Config & Secrets

Scope: `backend/fixture/settings/base.py`, `dev.py`, `__init__.py`, `asgi.py`, `wsgi.py`, `manage.py`, `pyproject.toml`, `.env`, `.env.example`, `.gitignore`, plus the config-coupled code that reads these settings (`apps/accounts/services/_crypto.py`, `apps/sadmin/middleware.py`, `apps/accounts/views.py`).

Date: 2026-06-04. Method: direct Read/Grep/Glob. `.venv` and `node_modules` excluded.

---

## Findings

### F1. Real (non-placeholder) credentials live in `backend/.env` — CRITICAL
`backend/.env:5-6`
```
SUPERUSER_EMAIL=graceschooledu@gmail.com
SUPERUSER_PASSWORD=DoxaEd33@
```
`backend/.env:3` `DATABASE_URL=postgres://postgres:postgress@localhost:5432/fixturedb`

Why it matters: `.env` contains the real super-admin email (matches the project owner) and a real-looking super-admin password, plus the DB password, in cleartext on disk. `SUPERUSER_PASSWORD` is read by management commands (`base.py:200`) and used to seed the highest-privilege account. Anyone with filesystem/backup/screen-share access obtains super-admin. `.env` IS listed in both `.gitignore` (`backend/.gitignore:13`, root `.gitignore:12`) and the working tree is "not a git repo", so this is not (yet) committed to history — but the secret is still at rest in plaintext and the password is reused-looking. Mitigates severity from "committed secret" to "plaintext secret on disk," still critical because it is a production-grade credential for the most privileged role.

Recommendation: rotate `DoxaEd33@` immediately; never store the real super-admin password in `.env` — seed via an interactive `createsuperuser`/one-shot command and unset afterwards. Keep `.env` out of any backup/sync that leaves the box. Confirm `.env` was never committed before the repo was de-git-ified.

### F2. No production settings module exists; every entrypoint defaults to `dev` — CRITICAL
`asgi.py:14`, `wsgi.py:14`, `manage.py:10`, `pyproject.toml:69` all set `DJANGO_SETTINGS_MODULE` to `"fixture.settings.dev"`. `base.py:3` says "Loaded by both `dev.py` and (eventually) `prod.py`" but `Glob backend/fixture/settings/prod.py` → **No files found**.

Why it matters: there is no way to run in production without `dev.py`, which forces `DEBUG = True` (`dev.py:7`), permissive CORS to localhost Vite, console email, and DEBUG-level app logging. If deployed as-is, Django serves stack traces, leaks settings on errors, and disables `SESSION_COOKIE_SECURE`/`CSRF_COOKIE_SECURE` (those are `not DEBUG` in `base.py:144,148`, so DEBUG=True → cookies sent over HTTP). This is the single largest config-readiness gap.

Recommendation: add `fixture/settings/prod.py` (DEBUG off, real ALLOWED_HOSTS, SECURE_* hardening per F7, Redis cache+channel layer per F5/F6, real email backend) and drive selection via env (`DJANGO_SETTINGS_MODULE`) rather than hardcoded `dev` in entrypoints. Deploy script must export the prod module.

### F3. ASGI application is plain HTTP — Channels `ProtocolTypeRouter` absent; live transport cannot work — HIGH
`asgi.py:16` `application = get_asgi_application()`

Why it matters: `channels` is in `INSTALLED_APPS` (`base.py:38`) and `ASGI_APPLICATION = "fixture.asgi.application"` (`base.py:98`), but `asgi.py` returns Django's bare HTTP ASGI app with no `ProtocolTypeRouter`/`URLRouter`/`AuthMiddlewareStack`. `Glob **/routing.py` and `**/consumers.py` → none exist (outside `.venv`). WebSocket (scorer/referee, invariant #11) and any SSE-over-ASGI path have no transport. This is expected for Phase 1A (live is 1B) but the ASGI file is mis-advertised as Channels-ready.

Recommendation: when Phase 1B lands, replace with `ProtocolTypeRouter({"http": django_asgi_app, "websocket": AuthMiddlewareStack(URLRouter(...))})`. Today, document that ASGI is HTTP-only.

### F4. `InMemoryChannelLayer` violates invariants #4 and #11 the moment live ships — HIGH
`base.py:186-188`
```
CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}
```
Why it matters: invariant #4 ("DB-first event log … publishes to Redis pub/sub after commit") and #11 (SSE/WS) require a cross-process broker. `InMemoryChannelLayer` is single-process only — it does not fan out across the ASGI workers a 4-vCPU VPS will run, and it is explicitly documented by Channels as test-only. `channels-redis` is already a declared dependency (`pyproject.toml:14`) but is never configured. Same backend is used in both base and dev, so there is no Redis layer anywhere.

Recommendation: configure `channels_redis.core.RedisChannelLayer` with `REDIS_URL` from env in base (or prod), keep InMemory only for the (currently nonexistent) test settings.

### F5. Cache is `LocMemCache` everywhere — breaks throttling, lockout, and reset rate-limits across workers — HIGH
`base.py:191-196`
```
CACHES = { "default": { "BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "fixture-default-cache" } }
```
Why it matters: DRF throttles (`base.py:160-169`: anon 60/min, user 240/min, signup 3/hr) and any cache-backed rate limiting (password-reset per-IP/email limits, `base.py:211-212`) use the default cache. `LocMemCache` is per-process, so with multiple ASGI/gunicorn workers each worker keeps its own counters — effective limits multiply by worker count and lockout state is not shared. On the planned single VPS with N workers, "3 signups/hr/IP" becomes "3×N/hr/IP." django-axes lockout (`base.py:180-183`) is DB-backed so it is fine, but throttles are not.

Recommendation: use Redis cache backend (`django.core.cache.backends.redis.RedisCache`) in base/prod sharing the same Redis as Channels; keep LocMem only for tests.

### F6. `channels-redis` and `daphne` declared but unconfigured/unused — MEDIUM
`pyproject.toml:14` `channels-redis>=4.2`, `pyproject.toml:15` `daphne>=4.1`. Neither appears in settings (`Grep REDIS` → only this audit). `daphne` is not in `INSTALLED_APPS` (its app entry is optional but conventional for `runserver` ASGI).

Why it matters: dependency drift — the deps imply live transport is wired when it is not (see F3-F5). Reviewers/operators may assume Redis is in play.

Recommendation: either wire them (preferred, ties to F4/F5) or move to a Phase-1B-pending extras group with a comment.

### F7. No `SECURE_*` / HSTS / proxy-SSL hardening anywhere — HIGH
`Grep "SECURE_|HSTS|SECURE_SSL_REDIRECT|SECURE_PROXY|REFERRER"` across `backend` (excl. `.venv`) → **No matches**.

Why it matters: behind nginx/Caddy TLS (per CLAUDE.md prod plan), Django needs `SECURE_PROXY_SSL_HEADER`, `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS` (+ include-subdomains/preload), `SECURE_CONTENT_TYPE_NOSNIFF`, `SECURE_REFERRER_POLICY`, and `CSRF_TRUSTED_ORIGINS` for the prod origin. None exist. Without `SECURE_PROXY_SSL_HEADER`, Django sees requests as HTTP behind the proxy, so `request.is_secure()` is False and `SESSION_COOKIE_SECURE`/`CSRF_COOKIE_SECURE` cookies may be dropped or HSTS never set. `SECURE_SSL_REDIRECT`/HSTS are entirely missing.

Recommendation: add the full SECURE_* block to the (to-be-created) prod settings; set `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` to match the reverse proxy.

### F8. TOTP secret encryption key is derived from `SECRET_KEY`; silent plaintext fallback — HIGH
`apps/accounts/services/_crypto.py:35-38` derives a Fernet key via `sha256(settings.SECRET_KEY)`. `_crypto.py:24-27` and `:45-49`: if `cryptography` import fails, `encrypt_secret` **returns the plaintext TOTP secret** and stores it as-is. `decrypt_secret` (`:56-62`) returns ciphertext unchanged on a key mismatch.

Why it matters: (1) The 2FA shared-secret encryption key is only as strong as `SECRET_KEY`. With the dev `SECRET_KEY` being a known weak placeholder (`.env:2` `dev-only-not-for-prod-replace-me-please-change-this-now`), any TOTP secrets created in that environment are trivially decryptable, and rotating `SECRET_KEY` silently bricks all stored 2FA secrets (no re-key migration). (2) The plaintext fallback means a missing/broken `cryptography` install degrades to storing TOTP seeds in cleartext in the DB with no loud failure — a silent confidentiality downgrade for an auth secret. (3) `decrypt_secret` swallowing a mismatch by returning the raw stored value can hand garbage to `pyotp` rather than failing closed.

Recommendation: use a dedicated `FIELD_ENCRYPTION_KEY` env var (not `SECRET_KEY`), fail loudly if `cryptography` is unavailable (no plaintext fallback for auth secrets), and provide a re-key migration path. Track under the existing B.21 KMS item but treat the plaintext fallback as a bug to remove now.

### F9. `pwned-passwords-django` is a dependency but not wired into `AUTH_PASSWORD_VALIDATORS` — MEDIUM
`pyproject.toml:23` `pwned-passwords-django>=2.1`. `base.py:115-120` validators list = MinimumLength(12) + CommonPassword + NumericPassword only. `Grep "pwned|Pwned"` across code → only the pyproject line.

Why it matters: PRD §2.10 password policy implies breach checking; the lib is installed but the `pwned_passwords_django.validators.PwnedPasswordsValidator` is never added, so compromised passwords pass validation. Dead dependency + weaker-than-intended policy.

Recommendation: add the Pwned validator to `AUTH_PASSWORD_VALIDATORS` (or remove the dep if intentionally deferred).

### F10. DRF unauthenticated requests return 403 not 401 — premature error banner on `/login` — MEDIUM
`base.py:153-158` sets only `SessionAuthentication` + global `IsAuthenticated`. `apps/accounts/views.py:416-418` `me_view` uses `@permission_classes([IsAuthenticated])`.

Why it matters: DRF returns 401 only when an authenticator supplies a `WWW-Authenticate` header; `SessionAuthentication` does not, so anonymous calls to `/api/accounts/me/` yield **403**, not 401. The SPA treats 403 as an error (banner) instead of "not logged in yet" on the public `/login` page — this matches known issue (b). Confirmed at the config layer: there is no `BasicAuthentication` or custom authenticator that would emit 401, and no exception handler remapping it.

Recommendation: add a custom DRF exception handler (or a thin authenticator) that returns 401 for unauthenticated access, or have the SPA treat 401/403 on `me/` as "anonymous." This is a settings/handler-level fix (`EXCEPTION_HANDLER` is not set in `REST_FRAMEWORK`).

### F11. drf-spectacular has no enum/operationId collision handling configured — MEDIUM
`base.py:172-177` and `dev.py:41-46` `SPECTACULAR_SETTINGS` set only TITLE/DESCRIPTION/VERSION/SERVE_INCLUDE_SCHEMA. No `ENUM_NAME_OVERRIDES`, no `COMPONENT_SPLIT_REQUEST`, no `postprocessing` to disambiguate duplicate routes.

Why it matters: known issue (c) — slug-vs-uuid duplicate routes (orgs/permissions), password-reset hyphen-vs-underscore routes, and RolesEnum naming produce operationId/enum collisions and `schema generation` warnings. The settings provide no `ENUM_NAME_OVERRIDES` to resolve the RolesEnum naming clash and no operationId strategy. `dev.py:41` redefines `SPECTACULAR_SETTINGS` entirely (note `# noqa: F811`), so any future additions in base are silently dropped in dev.

Recommendation: add `ENUM_NAME_OVERRIDES` for the colliding enums and a deterministic `operationId` strategy; in `dev.py` merge into base settings (`SPECTACULAR_SETTINGS = {**base, ...}`) instead of replacing, to avoid divergence.

### F12. sadmin IP allowlist trusts raw `X-Forwarded-For` — spoofable bypass — MEDIUM
`apps/sadmin/middleware.py:21-23` reads `HTTP_X_FORWARDED_FOR` (first hop) directly with no trusted-proxy verification, then `:60-67` enforces the `SADMIN_IP_ALLOWLIST` 404 gate using it.

Why it matters: invariant/B.15 intends an IP allowlist for the super-admin console. Because the client-supplied `X-Forwarded-For` is trusted verbatim, an attacker can set `X-Forwarded-For: <allowlisted-ip>` and bypass the gate unless a proxy overwrites the header. There is no `SECURE_PROXY` / trusted-proxy setting (see F7) and no use of a vetted client-IP resolver. Today the allowlist defaults empty (`base.py:78`) so it is a no-op, but the moment it is enabled in prod it is bypassable.

Recommendation: derive client IP from a known number of trusted proxy hops (e.g., django-ipware with `proxy_count`/trusted list, or read `REMOTE_ADDR` set by the proxy), and document that the allowlist requires the reverse proxy to overwrite XFF.

### F13. `ALLOWED_HOSTS` env default is dev-only; no prod value path — MEDIUM
`base.py:17` default `["localhost","127.0.0.1"]`; `.env:4` / `.env.example:4` both `localhost,127.0.0.1`.

Why it matters: with no prod settings (F2) and the env default being localhost, a real deployment that forgets to set `ALLOWED_HOSTS` either rejects all requests or (if someone sets DEBUG) bypasses the check. Combined with F2 this means there is no committed prod host config.

Recommendation: require `ALLOWED_HOSTS` explicitly in prod settings (no localhost default) and fail fast if unset when `DEBUG=False`.

### F14. `CSRF_COOKIE_HTTPONLY = False` is intentional but widens XSS blast radius — LOW
`base.py:149` `CSRF_COOKIE_HTTPONLY = False  # JS reads token for SPA + HTMX`.

Why it matters: required by the same-origin session+CSRF SPA design (invariant #15) so JS can read the token. Acceptable, but it means any XSS can read the CSRF token. Worth pairing with a strict CSP (none configured — no `SECURE_*`/CSP anywhere, see F7).

Recommendation: keep, but add a Content-Security-Policy (e.g., django-csp) in prod to constrain XSS.

### F15. `DEFAULT_FROM_EMAIL` never configured; code relies on literal fallbacks — LOW
`Grep DEFAULT_FROM_EMAIL` in settings → none. Used with fallbacks in `apps/accounts/views.py:140` (`"no-reply@fixture.local"`), `apps/accounts/services/password_reset.py:108`, and `apps/organizations/services/invitation.py:220` passes `from_email=None` (which would resolve to Django's default `webmaster@localhost`).

Why it matters: outbound auth emails (verification, reset, invites) will send from `webmaster@localhost`/`no-reply@fixture.local` in any environment with a real SMTP backend — likely rejected/spam-filed. Dev is fine (console backend, `dev.py:24`); prod has no email backend or sender configured at all.

Recommendation: set `DEFAULT_FROM_EMAIL` and a real `EMAIL_BACKEND`/SMTP config in prod settings.

### F16. `__init__.py` empty — no default settings module selection — INFO
`fixture/settings/__init__.py` is effectively empty (1 line). Selection is entirely via `DJANGO_SETTINGS_MODULE` hardcoded to `dev` in entrypoints (F2). Not a bug, but reinforces that there is no environment-driven settings selection.

### F17. `dev.py` re-imports and self-assigns `INSTALLED_APPS` as a no-op — INFO
`dev.py:5,10` `from .base import INSTALLED_APPS, MIDDLEWARE` then `INSTALLED_APPS = INSTALLED_APPS  # noqa: PLW0127`. Dead/confusing code; `MIDDLEWARE` imported but unused in dev. Harmless but signals churn.

---

## Gaps

- **prod.py / prod hardening** (blocking for any deploy): no production settings module; no SECURE_*/HSTS/SSL-redirect/proxy-SSL; no prod ALLOWED_HOSTS; no prod CACHES/CHANNEL_LAYERS/EMAIL. Effort: M.
- **Secret management**: real super-admin + DB password in plaintext `.env`; no secret-rotation/KMS story; field-encryption key piggybacks on `SECRET_KEY`. Effort: M.
- **Redis wiring**: `channels-redis` + Redis cache declared but not configured; required by invariants #4/#11 and by throttle correctness across workers. Effort: M.
- **Live transport (Phase 1B)**: ASGI is HTTP-only; no ProtocolTypeRouter/routing/consumers. Expected pre-1B but ASGI file is mislabeled Channels-ready. Effort: L (part of 1B).
- **OpenAPI schema hygiene**: no ENUM_NAME_OVERRIDES/operationId strategy; dev SPECTACULAR_SETTINGS shadows base instead of merging. Effort: S.
- **401-vs-403 contract**: no DRF `EXCEPTION_HANDLER`; unauthenticated → 403 trips SPA error UI. Effort: S.
- **Password policy**: `pwned-passwords-django` installed but not in validators (PRD §2.10 intent unmet). Effort: S.
- **Trusted-proxy / client-IP**: sadmin allowlist and axes both consume client-supplied XFF without a trusted-proxy config. Effort: S–M.
- **No test settings module**: pytest uses `fixture.settings.dev` (`pyproject.toml:69`), so tests run with DEBUG and dev cache/channel layers; no isolated test config to assert prod-like behavior or to swap in fast hashers. Effort: S.
