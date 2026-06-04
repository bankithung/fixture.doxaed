# Audit App — Correctness & Logic Bug Report

**Scope:** `backend/apps/audit/` (models, services, views, serializers, migrations, tests)
**Lens:** wrong conditionals, off-by-one, races, wrong queryset filters, missing transaction.atomic / on_commit, serializer<->model mismatch, wrong HTTP status, None handling, tz math.
**Date:** 2026-06-04

---

## Findings

### F-1 · Race condition in idempotency check (TOCTOU)

**Severity:** high
**File:** `backend/apps/audit/services.py:45–48`

```python
if idempotency_key:
    existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        return existing
# ... then AuditEvent.objects.create(...)
```

**Why it matters:**
Two concurrent requests bearing the same `idempotency_key` can both execute the `filter().first()` check, both find `None`, both attempt `objects.create()`. The second will get a Postgres `IntegrityError` (the `unique=True` constraint on `idempotency_key`) that is not caught — it propagates as an unhandled exception and returns a 500.

The correct pattern is either:
1. `get_or_create(idempotency_key=…, defaults={…})` (atomic at the DB layer), or
2. Catch `IntegrityError` around the `create()` call and re-fetch the existing row.

**Recommendation:**
```python
from django.db import IntegrityError

if idempotency_key:
    try:
        obj = AuditEvent.objects.create(
            idempotency_key=idempotency_key, ...
        )
        return obj
    except IntegrityError:
        # Another worker won the race; return the winner's row.
        return AuditEvent.objects.get(idempotency_key=idempotency_key)
```
Or restructure with `get_or_create`. The current check-then-create pattern also violates the atomicity requirement: the check and the create are in two separate DB round trips with no lock held between them.

---

### F-2 · `_parse_iso8601` produces naive datetimes; Django warns and may mis-filter

**Severity:** medium
**File:** `backend/apps/audit/views.py:78–87` and usage at `146–152`

```python
def _parse_iso8601(value: str) -> Optional[datetime]:
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)
```

When a caller sends `?from=2026-01-01T12:00:00` (no tz suffix), `fromisoformat` returns a naive `datetime`. Django's ORM then emits a `RuntimeWarning: DateTimeField received a naive datetime …` and **treats it as the configured `TIME_ZONE`** (currently UTC). This happens to yield correct results because `TIME_ZONE = "UTC"`, but the code is fragile:

- If `TIME_ZONE` ever changes (e.g. to `Asia/Kolkata` for local dev), the silent coercion would silently apply a 5h30m offset, returning wrong rows with no error.
- The warning itself may be promoted to an error in test environments that use `PYTHONWARNINGS=error`.

**Recommendation:**
Make the parsed datetime timezone-aware unconditionally:

```python
from django.utils import timezone as dj_tz
import datetime

def _parse_iso8601(value: str) -> Optional[datetime.datetime]:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        dt = datetime.datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dj_tz.make_aware(dt, datetime.timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None
```

---

### F-3 · Dead orphaned `.filter()` call (no-op, misleading)

**Severity:** low
**File:** `backend/apps/audit/views.py:174–183`

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

The first `qs = qs.filter()` call (lines 174–177) has **no arguments** — it is a no-op returning an identical queryset. Its return value is immediately overwritten by the second `qs.filter(Q(…))`. The comment inside the empty filter body is also dead.

This is harmless at runtime but is confusing: a reader may think the commented condition is somehow applied. It also misplaces the `from django.db.models import Q` import inside the `if` block (should be at module top).

**Recommendation:** Remove lines 174–177 and move `from django.db.models import Q` to the top of the file.

---

### F-4 · `previous_cursor` is not a backward cursor — misleading API contract

**Severity:** low
**File:** `backend/apps/audit/views.py:198`

```python
"previous_cursor": cursor_raw or None,
```

The field named `previous_cursor` simply echoes back the cursor the client just sent. It does not compute a cursor pointing to the previous page of results. Any API consumer relying on `previous_cursor` to implement backward pagination will get an infinite loop (same page served again).

**Recommendation:** Either:
1. Remove `previous_cursor` from the response and document the endpoint as forward-only pagination (simplest), or
2. Implement a proper previous-page cursor (requires tracking the first row of the current page and inverting the sort).

---

### F-5 · `request_password_reset` creates token without `transaction.atomic`

**Severity:** medium
**File:** `backend/apps/accounts/services/password_reset.py:90–123`

```python
token = PasswordResetToken.objects.create(...)   # line 92
# ... send_mail (non-DB) ...
emit_audit(...)   # line 115
```

The token creation and audit emission are **not wrapped in `transaction.atomic()`**. If `emit_audit` raises (e.g. a transient DB error), the `PasswordResetToken` is already committed but the audit row is missing. The invariant (CLAUDE.md §4: "DB-first event log; audit + state change share atomicity") is violated.

Note: `complete_password_reset` (line 126) is correctly decorated with `@transaction.atomic`.

**Recommendation:** Wrap `request_password_reset`'s core block in `with transaction.atomic()`:

```python
with transaction.atomic():
    token = PasswordResetToken.objects.create(...)
    emit_audit(...)
```
Move the `send_mail` call outside the atomic block (email is a side effect, not DB state).

---

### F-6 · `serialize_payload` stub is dead code — raw Python objects may cause JSON encode failures

**Severity:** medium
**File:** `backend/apps/audit/models.py:103–107`

```python
def serialize_payload(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Stub for payload serialization. Real impl belongs to the audit agent.
    UUIDs and datetimes need normalization. Placeholder for now.
    """
    return d
```

This function is **never called** anywhere. The `emit_audit` service passes raw Python dicts directly to `AuditEvent.objects.create(payload_before=…, payload_after=…)`. Django's JSONField serializes these via `json.dumps`. If a caller accidentally passes Python `uuid.UUID` or `datetime` objects inside the dict (not `str`), Django raises a `TypeError` at write time.

Currently all callers manually `str()`-convert UUIDs and call `.isoformat()` on datetimes, but the stub's existence implies that this normalization was supposed to be centralized here. Any future Phase 1B caller that skips the manual conversion will cause a hard failure.

**Recommendation:**
1. Implement `serialize_payload` to handle `uuid.UUID` → `str` and `datetime` → `.isoformat()` recursively, or
2. Call `serialize_payload(payload_before)` and `serialize_payload(payload_after)` inside `emit_audit()` before the `create()` call, making normalization automatic for all callers.

---

### F-7 · `emit_audit_on_commit` docstring is misleading about atomicity

**Severity:** info
**File:** `backend/apps/audit/services.py:80–87`

```python
def emit_audit_on_commit(**kwargs):
    """Defer audit emission until transaction commit.
    Most callers want the inline emit_audit() instead so the audit +
    state change share atomicity.
    """
    transaction.on_commit(lambda: emit_audit(**kwargs))
```

The docstring recommends inline `emit_audit()` for shared atomicity, but `emit_audit` itself performs an `objects.create()` inside the caller's transaction — so it **does** share atomicity already. `emit_audit_on_commit` is useful only when the audit row must reference state that has been committed (e.g., a freshly-created FK target that hasn't been committed yet, or for denormalized fields populated by a post-save signal). The current docstring implies the distinction is about atomicity; it's actually about ordering of side effects.

More importantly: `emit_audit_on_commit` is defined but **never called** in the current codebase. It exists as dead API surface.

**Recommendation:** Add a use-case clarification to the docstring. If unused, either add a `# noqa: F401` dead-code marker or remove until a caller is added.

---

## Gaps (forward-looking)

| # | Area | Missing | Effort | Needed for |
|---|------|---------|--------|-----------|
| G-1 | Idempotency replay | `emit_audit` does not handle the `idempotency_key` race with `select_for_update` or `get_or_create`; will 500 on concurrent retries | S | Invariant 3 (idempotent writes) |
| G-2 | Payload normalization | `serialize_payload` is a stub; no centralized UUID/datetime normalization before JSONField write | M | Phase 1B callers (Matches, MatchEvent) will hit `TypeError` if they pass raw UUIDs |
| G-3 | Backward pagination | `previous_cursor` echoes input cursor; no real backward navigation | M | Admin audit log UI |
| G-4 | `from`/`to` filter TZ | Naive datetimes accepted silently; should reject or coerce explicitly | S | API correctness |
| G-5 | PII redaction | `get_actor_email_at_time` returns the user's current email, not the email at the time of the event — v1A limitation noted in docstring; will be wrong after email-change events | L | Phase 1B GDPR/audit accuracy |
| G-6 | Test: unauthenticated → 401 | `test_unauthenticated_request_denied` asserts `status_code in (401, 403)` — it should be 401 specifically; the known bug (KNOWN ISSUES b) means it returns 403, so the test is masking the issue | S | Known issue (b) fix |
| G-7 | Org-scoped index missing actor filter | No composite index on `(organization_id, actor_user_id, created_at)`. The `actor_id` filter in the list view will fall back to seq-scan on the org rows when actor filter is applied | M | Query performance on large orgs |
