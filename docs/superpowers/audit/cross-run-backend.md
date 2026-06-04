# Cross-cutting audit: run-backend (boot / migrate / test-collection coherence)

Scope: Statically (and where safe, dynamically) determine whether the Phase 1A
Django backend boots, migrates, and runs its test suite. Verified
`INSTALLED_APPS` vs apps on disk, `AppConfig` names/labels, import errors,
model/migration drift, fixture data files, `DJANGO_SETTINGS_MODULE`, and
pytest/conftest coherence.

Environment: Django 5.1.15, pytest 9.0.3, pytest-django 4.12.0, Python 3.13
(`backend/.venv`). A live local Postgres was reachable, so beyond static
analysis the suite was actually executed.

## Headline result: the backend boots, migrates, and all 350 tests pass.

- `manage.py check` -> "System check identified no issues (0 silenced)."
- `manage.py makemigrations --check --dry-run` -> "No changes detected" (no model/migration drift).
- `pytest --collect-only` -> "350 tests collected" with zero collection/import errors.
- Full suite executed in slices: sports 7, audit+permissions 192, accounts+organizations+sadmin 151 = **350 passed**.
- `manage.py spectacular` -> exit 0 (schema generates), 9 warnings, 0 errors.

The findings below are therefore mostly INFO/LOW (hygiene + deploy-readiness),
plus the previously-known MEDIUM drf-spectacular collisions confirmed here.

---

## Findings

### F1. drf-spectacular operationId + enum collisions (9 warnings) — MEDIUM
- Category: api/schema hygiene. Confidence: high.
- Evidence (`manage.py spectacular` and `manage.py check --deploy`):
  - `Warning: encountered multiple names for the same choice set (RolesEnum)...`
  - `operationId "accounts_auth_password_reset_complete_create" has collisions [('/api/accounts/auth/password-reset-complete/','post'),('/api/accounts/auth/password_reset_complete/','post')]`
  - `operationId "accounts_auth_password_reset_request_create" has collisions [...-request/ , ..._request/]`
  - `operationId "accounts_auth_verify_email_create" has collisions [...verify-email/ , ...verify_email/]`
  - `operationId "orgs_invitations_list"/"orgs_invitations_create" has collisions [('/api/orgs/{slug}/invitations/'),('/api/orgs/{uuid}/invitations/')]`
  - `operationId "orgs_members_list" has collisions [{slug}/members vs {uuid}/members]`
  - `operationId "permissions_orgs_users_grants_list"/"_update" has collisions [{org_uuid}/... vs {slug}/...]`
- Why it matters: two route shapes (hyphen vs underscore for password-reset/verify-email; `{slug}` vs `{uuid}`/`{org_uuid}` for orgs/permissions) are registered for the same logical endpoint. The schema "resolves with numeral suffixes," producing ugly client SDKs and signalling duplicate URL surface. The duplicate hyphen/underscore auth routes in particular look like an accidental double-registration, not a deliberate slug/uuid dual-lookup.
- Recommendation: (a) For the auth endpoints, pick ONE canonical spelling (hyphen per AIP/REST convention) and drop the underscore duplicate from `apps/accounts/urls.py`. (b) For `{slug}` vs `{uuid}` org/permission routes, keep both if dual-lookup is intended but set explicit `operation_id`s via `@extend_schema`. (c) Add `ENUM_NAME_OVERRIDES = {"RolesEnum": "..."}` to `SPECTACULAR_SETTINGS` so the role choice set has one stable name.

### F2. Dev uses InMemoryChannelLayer + LocMemCache — blocks Phase 1B live transport — MEDIUM
- Category: infra/config. Confidence: high.
- Evidence (`backend/fixture/settings/base.py:186`):
  `CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}`
  and `base.py:191` `CACHES = { "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", ...}}`
- Why it matters: invariants #4 (DB-first event log -> Redis pub/sub on commit) and #11 (SSE/WS) require a cross-process broker. `InMemoryChannelLayer` does not fan out across ASGI workers and `LocMemCache` is per-process; neither supports the scorer/viewer live fan-out. This does NOT crash 1A boot (Phase 1A doesn't use Channels), but it is a hard blocker the moment `apps.live` is built. `channels-redis` is already a declared dependency (`pyproject.toml:14`) but unused.
- Recommendation: Add a Redis-backed `CHANNEL_LAYERS` (channels-redis) and `CACHES` (redis) before Phase 1B, gated by `REDIS_URL` env. Keep in-memory only as an explicit test override.

### F3. ASGI application is plain HTTP — no WebSocket ProtocolTypeRouter — LOW
- Category: infra/config (Phase 1B prerequisite). Confidence: high.
- Evidence (`backend/fixture/asgi.py:16`): `application = get_asgi_application()` — no `ProtocolTypeRouter`, no `URLRouter`, no `AuthMiddlewareStack`.
- Why it matters: even though `ASGI_APPLICATION = "fixture.asgi.application"` (`base.py:98`) and `channels`/`daphne` are installed, WebSocket routing is not wired. Expected for Phase 1A, but the live consumers (invariant #11) have no entry point yet.
- Recommendation: When `apps.live` lands, wrap with `ProtocolTypeRouter({"http": ..., "websocket": AuthMiddlewareStack(URLRouter(live_ws_urls))})`.

### F4. No production settings module (`prod.py` absent) — LOW
- Category: deploy-readiness. Confidence: high.
- Evidence: `ls fixture/settings/prod.py` -> "NO prod.py"; only `base.py`, `dev.py`, `__init__.py` exist. `base.py:6` comment says "Loaded by both `dev.py` and (eventually) `prod.py`." `manage.py:10` and `asgi.py:14` both `setdefault(..., "fixture.settings.dev")`.
- Why it matters: there is no deployable settings target. `manage.py check --deploy` (run against dev) surfaces 14 issues including `security.W018 DEBUG=True`, `W008 SECURE_SSL_REDIRECT`, `W004 SECURE_HSTS_SECONDS`, `W012 SESSION_COOKIE_SECURE`, `W016 CSRF_COOKIE_SECURE`. `base.py` already conditions `SESSION_COOKIE_SECURE = not DEBUG` (line 144) and `CSRF_COOKIE_SECURE = not DEBUG` (line 148), so a prod module that sets `DEBUG=False` clears most of these — it just doesn't exist yet.
- Recommendation: Add `fixture/settings/prod.py` (DEBUG=False, HSTS, SSL redirect, Redis channel/cache, real email backend, ALLOWED_HOSTS/CSRF_TRUSTED_ORIGINS from env) before deploy.

### F5. Catalog data is NOT seeded by `migrate` — empty tables on fresh deploy — LOW
- Category: deploy-sequencing. Confidence: high.
- Evidence: no `RunPython` in any migration (`grep RunPython apps/*/migrations/*.py` -> none). Catalogs load only via management commands: `apps/permissions/management/commands/load_modules.py` (reads `apps/permissions/fixtures/modules.json`, 22 modules) and `apps/sports/management/commands/load_sports.py` (reads `apps/sports/fixtures/sports.json`, 59 sports).
- Why it matters: `migrate` alone leaves `Module`/`Sport` tables empty. RBAC `HasModule` gates and the sports list endpoint silently behave as "module absent" until `load_modules`/`load_sports` are run. Tests paper over this with the `loaded_modules` fixture (`apps/permissions/tests/conftest.py`, `apps/audit/tests/conftest.py`), so the suite passes regardless — masking the deploy step.
- Recommendation: Document `load_modules` + `load_sports` as mandatory post-migrate deploy steps (or fold into a data migration / `post_migrate` signal so a fresh DB is self-seeding). Fixture files verified present and well-formed (modules.json = 22 entries with keys category/code/default_for_roles/description/name; sports.json = 59 entries).

### F6. factory-boy DeprecationWarning across all factory-using tests — LOW
- Category: test hygiene / future breakage. Confidence: high.
- Evidence: 101 warnings in the accounts+organizations+sadmin slice; with `-W error::DeprecationWarning`:
  `DeprecationWarning: UserFactory._after_postgeneration will stop saving the instance after postgeneration hooks in the next major release. ... set skip_postgeneration_save=True in the UserFactory.Meta.` (`.venv/.../factory/django.py:182`)
- Why it matters: non-fatal today, but a future factory-boy major will change instance-saving behavior and could silently break fixtures that rely on the post-generation save (e.g., password set via postgeneration). Suite currently does not run with `-W error`, so this is latent.
- Recommendation: Add `skip_postgeneration_save = True` to the affected `Factory.Meta` classes (UserFactory and any password/postgen factories) and move explicit `save()` into the hook.

### F7. Dependency pins drifted vs installed (pytest 9 vs `>=8.3`, ruff 0.15 vs `>=0.6`) — INFO
- Category: dependency hygiene. Confidence: high.
- Evidence: `pyproject.toml:45` `"pytest>=8.3"` but installed `pytest 9.0.3`; `pyproject.toml:51` `"ruff>=0.6"` but `.ruff_cache/0.15.12` indicates ruff 0.15. Lower-bound-only pins allow major jumps.
- Why it matters: pytest 9 dropped some pytest-8 behaviors; collection/run pass today, but unpinned upper bounds make CI non-reproducible and risk a future silent break. (No functional failure observed.)
- Recommendation: Consider a lockfile (uv/pip-tools) or upper bounds on test/lint tooling for reproducible CI.

### F8. Deprecated `default_app_config` in permissions `__init__.py` — INFO
- Category: code hygiene. Confidence: high.
- Evidence (`apps/permissions/__init__.py` last line): `default_app_config = "apps.permissions.apps.PermissionsConfig"`.
- Why it matters: `default_app_config` was deprecated in Django 3.2 and is ignored in Django 5 (Django auto-discovers the single `AppConfig`). It is harmless now (no crash, no warning observed because there is exactly one AppConfig), but it is dead/misleading config. The app is correctly registered as `"apps.permissions"` in `INSTALLED_APPS` (`base.py:52`) with label `permissions_app` (`apps/permissions/apps.py`), which correctly avoids the `django.contrib.auth` "permissions" label collision.
- Recommendation: Delete the `default_app_config` line.

---

## Positive verifications (no issue — recorded for completeness)

- **INSTALLED_APPS vs disk**: all 6 LOCAL_APPS (`apps.accounts`, `apps.audit`, `apps.organizations`, `apps.permissions`, `apps.sadmin`, `apps.sports`; `base.py:48-55`) exist on disk with valid `apps.py`. No phantom apps; no missing apps.
- **AppConfig coherence**: every app declares `name = "apps.<x>"` + explicit `label`. `permissions` deliberately uses `label = "permissions_app"` to avoid the contrib.auth collision (`apps/permissions/apps.py`). No `ready()` hooks, no `signals.py`, no `.connect()`/`@receiver` anywhere — so there is no risk of un-registered signal handlers.
- **Settings module**: `DJANGO_SETTINGS_MODULE` consistently `fixture.settings.dev` across `manage.py:10`, `asgi.py:14`, `wsgi.py`, `pyproject.toml:69` (pytest) and `pyproject.toml:81` (django-stubs). `.env` present with `SECRET_KEY`, `DATABASE_URL`, `ALLOWED_HOSTS` set, so `env("SECRET_KEY")` (`base.py:21`) won't raise.
- **Model/migration sync**: `makemigrations --check --dry-run` reports no drift. Every app has `0001_initial`; accounts +`0002`, audit +`0002_audit_append_only`.
- **Append-only audit migration**: `apps/audit/migrations/0002_audit_append_only.py` RunSQL trigger targets table `audit_event`, which matches `AuditEvent.Meta.db_table = "audit_event"` (`apps/audit/models.py:82`). Applies cleanly — the `transaction=True` trigger tests in `apps/audit/tests/test_append_only.py` pass (192-test slice green), confirming invariant #5 enforced at DB level.
- **UUID v7 PKs**: `uuid7()` helper (`apps/accounts/models.py:28-30`, wrapping `uuid_utils.uuid7`) is referenced in every `0001_initial` as `default=apps.accounts.models.uuid7`. `uuid_utils` imports and produces a v7 UUID at runtime. No autoincrement PKs (invariant #1).
- **pytest/conftest coherence**: 5 per-app conftests, no top-level conftest needed. Autouse fixtures (`_disable_axes`, `_clear_cache`) and shared fixtures (`loaded_modules`, `super_admin`, `authed_client_*`) all resolve; `--strict-markers` passes with the one custom marker `signup_throttle` registered in `pyproject.toml:72-74` and used in `apps/accounts/tests/test_signup_path_b.py`.
- **Key deps import**: `python-magic` (Windows `python-magic-bin`), `uuid_utils`, Django 5.1.15 all import. Seed scripts `scripts/seed_full_demo.py` and `scripts/seed_demo_admin.py` parse without syntax error.
- **drf-spectacular schema**: generates with exit 0 (warnings only, see F1).

---

## Gaps

1. **No `prod.py` settings** — cannot deploy; security hardening (HSTS/SSL/secure cookies) only partially conditioned on DEBUG. Effort S. Blocking for deploy.
2. **No Redis-backed channel layer / cache** — `channels-redis` declared but unused; in-memory layer cannot fan out. Effort S-M. Blocking for Phase 1B live (#4, #11).
3. **No WebSocket ASGI routing** — `asgi.py` is plain HTTP; no ProtocolTypeRouter/URLRouter. Effort M. Blocking for Phase 1B scorer/referee.
4. **Catalog seeding not wired into migrate** — fresh deploy has empty Module/Sport tables until `load_modules`/`load_sports` run manually; not documented as a deploy step. Effort S.
5. **No CI lockfile / upper bounds** — installed pytest 9 / ruff 0.15 exceed declared lower bounds; runs are non-reproducible. Effort S.
6. **Suite not run under `-W error`** — latent factory-boy (and any other) DeprecationWarnings are tolerated; a future major bump could break fixtures silently. Effort S.
