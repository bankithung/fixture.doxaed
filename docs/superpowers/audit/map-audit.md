# Audit App — Structural Map

**Date:** 2026-06-04
**Area:** `backend/apps/audit/`
**Status:** Phase 1A implemented; Phase 1B extensions deferred.

---

## Purpose

The `audit` app is the platform's immutable, append-only event log. Every state-changing verb across all apps writes one `AuditEvent` row via `apps.audit.services.emit_audit()`. The DB-level append-only guarantee (invariant 5 in CLAUDE.md) is enforced by a Postgres `BEFORE UPDATE OR DELETE` trigger installed in migration `0002`. The DRF surface is read-only (one list endpoint); all writes flow through the service layer only.

---

## Key Files

| File | Role |
|------|------|
| `models.py` | `AuditEvent` model + `ActorRole` enum + `serialize_payload` stub |
| `services.py` | `emit_audit()` + `emit_audit_on_commit()` — the ONLY write path |
| `migrations/0001_initial.py` | Schema + composite indexes |
| `migrations/0002_audit_append_only.py` | Postgres trigger: blocks UPDATE/DELETE |
| `views.py` | `OrgAuditListView` — GET cursor-paginated audit feed |
| `serializers.py` | `AuditEventSerializer` + `AuditEventListResponseSerializer` |
| `urls.py` | Single route: `orgs/<slug>/` → `OrgAuditListView` |
| `apps.py` | `AuditConfig` — label `"audit"`, verbose `"Audit log"` |
| `tests/test_append_only.py` | 5 tests: ORM + raw SQL UPDATE/DELETE blocked; insert allowed |
| `tests/test_audit_list_view.py` | 7 tests: RBAC, cross-org leak, cursor pagination, filters |
| `tests/conftest.py` | `_clear_cache` (autouse) + `loaded_modules` fixture |

**External consumers of `emit_audit`** (grep-verified):
- `apps.accounts.views` — login/logout/password/2FA events
- `apps.accounts.services.*` — signup, password_reset, twofa
- `apps.organizations.services.*` — lifecycle, invitation, slug, ownership
- `apps.organizations.views` — invitation accept inline
- `apps.permissions.services.grants` — module grant changes
- `apps.sadmin.services.*` — superadmin verbs, feedback
- `apps.sadmin.views.auth` — sadmin login/logout

---

## Models / Types

### `ActorRole` (`models.py:22`)
TextChoices enum — 8 values: `super_admin`, `admin`, `co_organizer`, `game_coordinator`, `match_scorer`, `referee`, `team_manager`, `system`.

### `AuditEvent` (`models.py:35`)
| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID v7 PK | time-ordered; breaks `created_at` ties in cursor |
| `idempotency_key` | UUID UNIQUE nullable | replay → existing row |
| `actor_user` | FK → User `SET_NULL` | nulled on user deletion |
| `actor_role` | CharField(32) | snapshot of role at emit time |
| `deleted_user_handle` | CharField(64) | intended post-deletion fallback — **never populated by emit_audit()** |
| `impersonating_user_id` | UUID nullable | sadmin impersonation |
| `organization_id` | UUID nullable indexed | scope filter |
| `tournament_id` | UUID nullable indexed | scope filter (Phase 1B) |
| `match_id` | UUID nullable indexed | scope filter (Phase 1B) |
| `event_type` | CharField(64) indexed | free-form string — no enum |
| `target_type` | CharField(64) indexed | free-form string |
| `target_id` | UUID indexed | |
| `payload_before` / `payload_after` | JSONField nullable | JSONB |
| `reason` | TextField | optional human note |
| `ip_address` | GenericIPAddressField nullable | from `X-Forwarded-For` or `REMOTE_ADDR` |
| `user_agent` | CharField(255) | |
| `created_at` | DateTimeField auto_now_add | UTC |

**Composite indexes:** `(organization_id, -created_at)`, `(target_type, target_id, -created_at)`, `(actor_user, -created_at)`.

### `serialize_payload` (`models.py:103`)
A **stub** — returns its input unchanged. No UUID/datetime normalization implemented yet.

---

## Endpoints / Routes

Mounted at `/api/audit/` in `fixture/urls.py:34`.

| Method | Path | View | Auth | Permission |
|--------|------|------|------|-----------|
| GET | `/api/audit/orgs/<slug>/` | `OrgAuditListView` | `IsAuthenticated` | `HasModule("org.audit_log")` |

**Query params:** `cursor` (urlsafe-base64), `limit` (1–200, default 50), `actor_id` (UUID), `event_type` (exact), `from` (ISO8601 inclusive), `to` (ISO8601 exclusive).

**Sadmin surface** (separate, not in this app):
- `GET /sadmin/audit/` → `apps.sadmin.views.audit.audit_search` — full-table search for super-admins, Django paginator, `event_type__icontains` / `actor_user__email__icontains` / `organization_id` filters.

---

## Module Gate

`org.audit_log` in `apps/permissions/fixtures/modules.json:17` — default-on for roles: `admin`, `co_organizer`, `game_coordinator`, `referee`. `team_manager` and `match_scorer` are default-off.

`tournament.audit_log` is defined in the module fixture (default-on for `admin`, `co_organizer`, `game_coordinator`) but has **no corresponding DRF view** yet (Phase 1B gap).

---

## Findings

### F-01 — `deleted_user_handle` is never populated (HIGH)

**File:** `backend/apps/audit/models.py:59` / `services.py:61-76`

The field comment says it is "preserved as deleted_user_handle below" when `actor_user` is SET_NULL, but `emit_audit()` never accepts or writes `deleted_user_handle`. When a user account is deleted, all existing audit rows that referenced them will have `actor_user=NULL` and `deleted_user_handle=""`, so `get_actor_email_at_time` returns `None` (serializers.py:54). The audit trail loses actor identity on account deletion.

**Recommendation:** Add `deleted_user_handle: str = ""` parameter to `emit_audit()` and populate it from `actor_user.email` before the FK can be nulled. Alternatively, wire a `pre_delete` signal on `User` to snapshot email into existing audit rows before SET_NULL fires — but that conflicts with the append-only trigger. The correct fix is to pass the email at emit time and store it in `emit_audit`, so the handle is written at row creation, not at user deletion.

---

### F-02 — `serialize_payload` stub is a no-op (MEDIUM)

**File:** `backend/apps/audit/models.py:103-107`

```python
def serialize_payload(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Stub for payload serialization. Real impl belongs to the audit agent.
    UUIDs and datetimes need normalization. Placeholder for now.
    """
    return d
```

The function is never called by any other module (grep-verified). UUID and datetime normalization is omitted, meaning callers who pass raw Python `datetime` objects or `uuid.UUID` values into `payload_before`/`payload_after` may get non-JSON-serializable content stored in the JSONB column, depending on Django's JSONField encoder. In practice Django's encoder handles `UUID` and `datetime`, but without normalization the stored JSON is inconsistent (UUIDs as strings in some callers, hyphenated vs non-hyphenated, etc.).

**Recommendation:** Either implement `serialize_payload` properly and call it in `emit_audit()`, or delete the stub to avoid confusion. At minimum document that Django's encoder is relied on.

---

### F-03 — Dead no-op `.filter()` call in cursor pagination (LOW)

**File:** `backend/apps/audit/views.py:174-177`

```python
qs = qs.filter(
    # (created_at < cur_ts) OR (created_at = cur_ts AND id < cur_id)
    # — mapped to two ORM queries combined with Q for safety.
)
from django.db.models import Q

qs = qs.filter(
    Q(created_at__lt=cur_ts)
    | Q(created_at=cur_ts, id__lt=cur_id)
)
```

The first `.filter()` call (lines 174-177) is a no-op with only a comment as its argument; it applies no filtering and just reassigns `qs` to itself. The real filter is on line 180. This is dead code — likely a refactoring artifact. Also note the `from django.db.models import Q` import is inside the `if cursor_raw:` block; it should be at module level.

**Recommendation:** Remove the no-op `.filter()` call at line 174. Move `from django.db.models import Q` to the top-level imports of `views.py`.

---

### F-04 — `previous_cursor` is not a real reverse cursor (LOW)

**File:** `backend/apps/audit/views.py:198` / `serializers.py:78`

The response includes `"previous_cursor": cursor_raw or None`, but `cursor_raw` is the *input* cursor the client just sent, not a cursor computed for the preceding page. This means the client cannot paginate backwards; they get back their own cursor, which is meaningless as a "previous" pointer. The `AuditEventListResponseSerializer` declares it as a real field, misleading API consumers.

**Recommendation:** Either implement true reverse pagination (requires a separate cursor direction mechanism) or rename the field to `request_cursor` / remove it entirely and document the API as forward-only cursor pagination. The OpenAPI schema (via drf-spectacular) will document the misleading field as-is.

---

### F-05 — `emit_audit_on_commit` has no tests and its docstring caution is backwards (LOW)

**File:** `backend/apps/audit/services.py:80-87`

```python
def emit_audit_on_commit(**kwargs):
    """Defer audit emission until transaction commit.

    Usage: where the verb's state change must be persisted before the
    audit row is meaningful. Most callers want the inline emit_audit()
    instead so the audit + state change share atomicity.
    """
    transaction.on_commit(lambda: emit_audit(**kwargs))
```

No test covers this function. More importantly, its stated use-case ("where the verb's state change must be persisted before the audit row is meaningful") is exactly backwards: if the audit row is emitted *after* commit, it falls outside the enclosing transaction. If the process dies between commit and `on_commit`, the audit row is never written — silently losing the event. The inline `emit_audit()` is atomic with the state change; `emit_audit_on_commit` is for the Redis publish pattern (invariant 4), not for audit rows. The function is not called anywhere in the codebase (grep-verified), making it dead code with a misleading docstring.

**Recommendation:** Either delete `emit_audit_on_commit` (since it's unused and the use case is wrong for auditing) or, if needed for a future Redis publish use case, rename it `publish_on_commit` and move it to the `live` app. Add a comment in `emit_audit` pointing to the correct pattern if deferred emission is ever genuinely needed.

---

### F-06 — `tournament.audit_log` module exists but has no view (MEDIUM)

**File:** `backend/apps/permissions/fixtures/modules.json` (code `tournament.audit_log`)

The module catalog defines `tournament.audit_log` with defaults for `admin`, `co_organizer`, `game_coordinator`. There is no corresponding DRF view or URL route — the tournament-scoped audit feed is entirely absent. This is a Phase 1B gap, but it means the module entry in the DB is currently inert.

**Recommendation:** Track in Phase 1B scope. When implementing, follow the same cursor-pagination + `HasModule("tournament.audit_log")` pattern as `OrgAuditListView`.

---

### F-07 — No PII redaction implemented despite being documented (MEDIUM)

**File:** `backend/apps/audit/serializers.py:4-5`

The serializer docstring states "PII redaction is applied at the email field per B.11 if a non-Super-admin viewer fetches a row authored by another user." The `get_actor_email_at_time` method performs no such redaction — it returns the full email unconditionally for all callers. A `co_organizer` or `game_coordinator` calling `GET /api/audit/orgs/<slug>/` can read the raw email of any actor, including personal accounts.

**Recommendation:** Implement the redaction gate: if `request.user` is not a super-admin and `obj.actor_user_id != request.user.id`, mask the email (e.g. first char + `***@domain`). The serializer needs access to `request` via context (`serializer.context["request"]`).

---

### F-08 — Test gap: `actor_id`, `from`/`to` date filters untested (LOW)

**File:** `backend/apps/audit/tests/test_audit_list_view.py`

Tests cover `event_type` filter and cursor pagination but do not test the `actor_id`, `from`, or `to` query parameters. The `actor_id` parse path has a UUID validation branch (`400` on bad UUID) that is also untested.

**Recommendation:** Add parametrized tests for `actor_id` (valid UUID, invalid UUID → 400), `from` (ISO8601 inclusive), `to` (ISO8601 exclusive), and `from+to` range. This matches the PRD §7 coverage requirements.

---

### F-09 — sadmin `audit_search` uses `icontains` on `event_type` (INFO)

**File:** `backend/apps/sadmin/views/audit.py:25`

The sadmin audit search uses `event_type__icontains=event_type` — a `LIKE '%...%'` query on an indexed `event_type` column. At low audit volumes this is fine, but `LIKE '%x%'` does not use the B-tree index. At scale (millions of rows), this degrades to a seq-scan.

**Recommendation:** Switch to exact-match (`event_type=event_type`) or add a GIN trigram index (`pg_trgm`) if partial match is genuinely needed for the sadmin UX.

---

### F-10 — `default_auto_field` mismatch in `apps.py` (INFO)

**File:** `backend/apps/audit/apps.py:3`

```python
default_auto_field = "django.db.models.BigAutoField"
```

The `AuditEvent` model uses a UUID v7 PK explicitly, so `default_auto_field` is irrelevant for the only model in this app. However it's inconsistent: the project's architecture mandates UUID v7 everywhere (invariant 1); having `BigAutoField` as the default could cause confusion if a developer adds a sub-model without specifying `pk=` explicitly.

**Recommendation:** Set `default_auto_field = "django.db.models.UUIDField"` or, better, inherit the project-wide setting defined in `fixture/settings/base.py`.

---

## Gaps Section

| Gap | Severity | Notes |
|-----|----------|-------|
| `deleted_user_handle` never written | HIGH | Actor identity lost on account deletion |
| PII redaction not implemented | MEDIUM | Documented but absent; email exposed to all `org.audit_log` holders |
| `tournament.audit_log` view missing | MEDIUM | Phase 1B; module catalog entry is inert |
| `serialize_payload` stub unused / no-op | MEDIUM | Payload type normalization deferred; risk of subtle JSONB inconsistency |
| `emit_audit_on_commit` unused + misleading | LOW | Dead code; wrong use case; should be removed or renamed |
| `previous_cursor` not a real backward cursor | LOW | Misleading API contract |
| `from`/`to`/`actor_id` filter tests absent | LOW | Coverage gap |
| No `AuditEventType` enum | LOW | `event_type` is a free-form string; typos in callers are not caught at import time |
| Cursor pagination test asserts `initial[0]` is oldest | INFO | Relies on insertion order matching UUID v7 time-ordering, which holds in tests but depends on DB clock resolution |
| `from django.db.models import Q` inside function body | INFO | Minor style issue; should be top-level import |
