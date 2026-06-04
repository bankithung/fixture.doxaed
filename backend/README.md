# Fixture Platform — Backend (Phase 1A)

User-types vertical slice. See `../docs/superpowers/specs/v1Users.md` (canonical spec) and `../CLAUDE.md`.

## Stack
- Python 3.13, Django 5.1, DRF 3.17
- Postgres 18 (local install, no Docker)
- Custom `User` model, UUID v7 PKs throughout (`uuid_utils`)
- Argon2id password hashing, django-axes lockout
- drf-spectacular for OpenAPI / Swagger UI
- django-htmx + Tailwind for the Super-admin console

## Phase 1A apps (this slice)
- `apps/accounts` — User, 2FA, login/logout, password reset, invite-accept session cycling
- `apps/organizations` — Organization, OrganizationMembership (4 constraints), AdminInvitation, SlugRedirect, ownership transfer
- `apps/permissions` — Module catalog (22), MembershipModuleGrant, `effective_modules()` resolver, scope-filter base classes
- `apps/audit` — AuditEvent + Postgres role-deny migration; `emit_audit()` service-layer call (the canonical way to write audit rows)
- `apps/sadmin` — Custom Django+Tailwind+HTMX Super-admin console (`/sadmin/`); Feedback, UsageEvent, KPISnapshot live here

Phase 1B apps (`tournaments`, `teams`, `matches`, `disputes`, `live`, `notifications`, `fixtures`) are out of scope for this slice.

## Local dev

```pwsh
# Activate venv
.\.venv\Scripts\Activate.ps1

# Run migrations
python manage.py migrate

# Run dev server
python manage.py runserver

# OpenAPI / Swagger
# http://localhost:8000/api/docs/

# Super-admin console
# http://localhost:8000/sadmin/
```

## Auth defaults (dev)
- Super-admin: `graceschooledu@gmail.com` / `DoxaEd33@` (via `.env`)
- Postgres: local, db `fixturedb`, user `postgres`, password `postgress`

## Tests
```pwsh
pytest
```

## Audit-trail rule
**Never write to `AuditEvent` directly.** Always use `apps.audit.services.emit_audit(...)`. Direct ORM writes will be blocked by the Postgres role-deny migration once that lands (audit agent task).

## UUID v7
**Never use `uuid.uuid4`.** All PKs use `apps.accounts.models.uuid7()` which wraps `uuid_utils.uuid7()`. CI lints for `uuid.uuid4` imports under `apps/*/models.py`.
