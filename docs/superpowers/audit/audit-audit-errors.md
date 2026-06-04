# Audit App Error-Handling Audit

**Date:** 2026-06-04
**Scope:** `backend/apps/audit/` — models, services, views, serializers, migrations, tests
**Lens:** bare/broad except, except:pass, masking fallbacks, missing validation, unguarded None/KeyError, non-atomic multi-writes, 500-on-bad-input where 400 is right, inconsistent error bodies.

---

## Findings

### F1 — Broad `except Exception` in serializer silently swallows real errors (medium)

**File:** `backend/apps/audit/serializers.py:57`

```python
try:
    return obj.actor_user.email  # type: ignore[union-attr]
except Exception:  # pragma: no cover - actor was hard-deleted
    return obj.deleted_user_handle or None
```

**Why it matters:** Catching `Exception` catches `AttributeError`, `OperationalError`, database connection errors, and any programming mistake alike. A real bug (e.g., a mis-joined queryset returning a proxy object without `.email`) would be silently swallowed and return an empty string — indistinguishable from the legitimate "user was hard-deleted" case. The comment `# pragma: no cover` means this branch is also untested.

**Recommendation:** Narrow to `AttributeError` only (the sole case that can arise from a soft-deleted or hard-deleted FK that `select_related` didn't resolve). Log or re-raise anything else:

```python
except AttributeError:
    return obj.deleted_user_handle or None
```

---

### F2 — `emit_audit()` accepts arbitrary freeform `actor_role` strings — no validation (medium)

**File:** `backend/apps/audit/services.py:27,59`

```python
actor_role: ActorRole | str,
...
role_value = actor_role.value if isinstance(actor_role, ActorRole) else actor_role
```

**Why it matters:** Any caller can pass `actor_role="typo_role"` and it writes straight to the DB. The model field has `choices=ActorRole.choices` but Django's ORM does NOT enforce choices constraints at the DB level — they are display-only. A misspelled role string silently persists, corrupting audit records for all downstream queries that filter or display by `actor_role`. There is no `assert`, validator, or `raise ValueError` guard in `emit_audit`.

**Recommendation:** Add a guard at the top of `emit_audit`:

```python
if isinstance(actor_role, str):
    valid = {r.value for r in ActorRole}
    if actor_role not in valid:
        raise ValueError(f"Invalid actor_role {actor_role!r}. Must be one of {valid}.")
```

---

### F3 — `emit_audit_on_commit` silently drops errors; failures are invisible (high)

**File:** `backend/apps/audit/services.py:80-87`

```python
def emit_audit_on_commit(**kwargs):
    transaction.on_commit(lambda: emit_audit(**kwargs))
```

**Why it matters:** `transaction.on_commit` callbacks run outside any active transaction and outside the request/response cycle. If `emit_audit(**kwargs)` raises (DB error, validation failure, connection timeout), Django swallows the exception by default — the caller's HTTP response already went out with a 200, and the audit row is permanently lost with no log, no alert, no retry. This is a silent audit-integrity hole.

**Recommendation:** Wrap the lambda to at minimum log exceptions:

```python
import logging
logger = logging.getLogger(__name__)

def emit_audit_on_commit(**kwargs):
    def _safe_emit():
        try:
            emit_audit(**kwargs)
        except Exception:
            logger.exception("emit_audit_on_commit failed — audit row lost. kwargs=%r", kwargs)
    transaction.on_commit(_safe_emit)
```

Consider also adding a Sentry capture or structured alert so ops knows when audit rows are being dropped.

---

### F4 — `_parse_iso8601` silently ignores bad date input, returning 400-worthy errors as no-filter (medium)

**File:** `backend/apps/audit/views.py:78-87, 146-152`

```python
def _parse_iso8601(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except (ValueError, TypeError):
        return None   # <-- swallows bad input, filter silently dropped
```

**Why it matters:** If a caller passes `?from=not-a-date`, the function returns `None`, the filter is silently omitted, and the response returns ALL records as if no date filter was requested. The caller gets a 200 with the wrong data — no indication their parameter was malformed. This should be a 400.

**Recommendation:** Return `None` only for empty input; raise a sentinel or return a distinct error for non-empty invalid input, and translate that to a 400 at the call site:

```python
# In the view:
from_raw = (request.query_params.get("from") or "").strip()
if from_raw:
    from_ts = _parse_iso8601(from_raw)
    if from_ts is None:
        return Response({"detail": "Invalid 'from' timestamp; expected ISO8601."}, status=400)
    qs = qs.filter(created_at__gte=from_ts)
```

---

### F5 — No validation that `from` is before `to` — inverted range silently returns empty queryset (low)

**File:** `backend/apps/audit/views.py:146-152`

```python
from_ts = _parse_iso8601(...)
if from_ts is not None:
    qs = qs.filter(created_at__gte=from_ts)

to_ts = _parse_iso8601(...)
if to_ts is not None:
    qs = qs.filter(created_at__lt=to_ts)
```

**Why it matters:** If the caller sends `?from=2026-06-04&to=2026-01-01`, the queryset returns zero rows with a 200 — the caller has no way to know their range was logically inverted. A 400 with a clear message is more helpful.

**Recommendation:** After parsing both values, add:

```python
if from_ts and to_ts and from_ts >= to_ts:
    return Response({"detail": "'from' must be before 'to'."}, status=400)
```

---

### F6 — `previous_cursor` in the response is semantically wrong (medium)

**File:** `backend/apps/audit/views.py:196-199`

```python
return Response(
    {
        "results": AuditEventSerializer(page, many=True).data,
        "next_cursor": next_cursor,
        "previous_cursor": cursor_raw or None,
    }
)
```

**Why it matters:** `previous_cursor` is set to `cursor_raw` — the cursor the *client* passed in. This is not a cursor that can page backwards; it is merely an echo of the input cursor. True backward pagination for cursor-based schemes requires storing the cursor of the first item on the current page. As implemented, a client that naively uses `previous_cursor` to go back would just replay the same page forward from the same position — or worse, would loop. Since the serializer and schema expose this as `previous_cursor`, it creates a misleading API contract.

**Recommendation:** Either remove `previous_cursor` from the response entirely (documenting this as forward-only pagination), or compute the actual previous cursor from the first item on the page. A comment in code should note the choice explicitly.

---

### F7 — `_resolve_org_by_slug_or_uuid`: UUID-matching org then falls through to slug search on miss — double query on valid UUID (low / info)

**File:** `backend/apps/audit/views.py:40-59`

```python
if as_uuid is not None:
    org = Organization.objects.filter(id=as_uuid, deleted_at__isnull=True).first()
    if org is not None:
        return org
return Organization.objects.filter(slug=str(value).lower(), deleted_at__isnull=True).first()
```

**Why it matters:** If a caller passes a valid UUID string that doesn't match any org, the function falls through to try it as a slug (lowercased UUID string). A UUID will never match a human slug, so this is a wasted query. More importantly, the fallthrough can return an *unrelated* org if someone has a slug that matches a UUID string representation — an obscure but real collision vector. Not a security bypass since `HasModule` still checks membership, but it is surprising behavior.

**Recommendation:** Add an early return after the UUID miss:

```python
if as_uuid is not None:
    return Organization.objects.filter(id=as_uuid, deleted_at__isnull=True).first()
# Only reach here if value is not a UUID
return Organization.objects.filter(slug=value.lower(), deleted_at__isnull=True).first()
```

---

### F8 — `serialize_payload` stub in `models.py` is exported but never called and has no safety contract (low)

**File:** `backend/apps/audit/models.py:103-107`

```python
def serialize_payload(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Stub for payload serialization. Real impl belongs to the audit agent.
    UUIDs and datetimes need normalization. Placeholder for now.
    """
    return d
```

**Why it matters:** `serialize_payload` is exported from the models module but never imported or called anywhere in the codebase. It returns its input unchanged. Callers storing `payload_before`/`payload_after` with raw UUIDs, datetimes, or Decimal values will trigger `json.dumps` failures at write time (Django JSONField serializes on save) if those types are present. The stub gives a false sense that payload normalization is handled.

**Recommendation:** Either implement minimal normalization (UUID → str, datetime → isoformat, Decimal → str) or remove the stub and document that callers must pass JSON-safe dicts. At minimum, add a guard that raises `TypeError` on non-serializable types rather than leaving the failure to surface as a cryptic `ValueError` at `AuditEvent.objects.create()`.

---

### F9 — `ip` field extracted from `HTTP_X_FORWARDED_FOR` without validation — invalid IPs passed to `GenericIPAddressField` cause 500 (medium)

**File:** `backend/apps/audit/services.py:53-55`

```python
ip = (
    request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    or request.META.get("REMOTE_ADDR", "")
)
```

Then passed directly:

```python
ip_address=ip or None,
```

**Why it matters:** `GenericIPAddressField` validates its value on `full_clean()`, but `objects.create()` does NOT call `full_clean()` by default. If a proxy or load balancer injects a malformed or spoofed `X-Forwarded-For` header (e.g. `X-Forwarded-For: not-an-ip`), the raw string is stored without validation. Worse, some database drivers may reject it at the driver level and raise an unhandled `DatabaseError`, resulting in a 500 and the entire verb (the actual state change) being rolled back — because `emit_audit` is called inside the same transaction.

**Recommendation:** Validate the IP before use:

```python
import ipaddress
def _safe_ip(raw: str) -> str | None:
    try:
        return str(ipaddress.ip_address(raw))
    except (ValueError, TypeError):
        return None
```

Apply `_safe_ip(ip)` before passing to `AuditEvent.objects.create()`.

---

### F10 — `event_type` and `target_type` have no allowed-values list — arbitrary strings silently accepted (low)

**File:** `backend/apps/audit/models.py:68-69`, `backend/apps/audit/services.py:27-40`

```python
event_type = models.CharField(max_length=64, db_index=True)
target_type = models.CharField(max_length=64, db_index=True)
```

**Why it matters:** Unlike `actor_role`, these fields have no `choices` constraint at all. A typo at any of the 40+ call sites (e.g. `event_type="user_loginn_success"`) silently writes a permanent audit row with a malformed event type. The audit log's searchability and integrity depend on a stable vocabulary.

**Recommendation:** Define an `EventType` TextChoices enum (or at minimum a module-level frozenset) and add a guard in `emit_audit` similar to the `actor_role` recommendation:

```python
if event_type not in VALID_EVENT_TYPES:
    raise ValueError(f"Unknown event_type {event_type!r}")
```

---

## Gaps (Forward-Looking)

| # | Item | Missing | Needed For | Effort | Blocking |
|---|------|---------|-----------|--------|---------|
| G1 | `emit_audit_on_commit` test | No test exercises the `on_commit` path | Proving audit row is written when used deferred | S | No |
| G2 | Bad `from`/`to` filter returns 200 not 400 | Missing input-validation test for malformed timestamps | Prevents silent no-filter behavior | S | No |
| G3 | `previous_cursor` backward pagination | No implementation — echoes input cursor only | Proper bidirectional pagination UX | M | No |
| G4 | `serialize_payload` stub | No normalization of UUID/datetime/Decimal in payloads | Prevents silent `TypeError` at write time | M | No |
| G5 | IP validation in `emit_audit` | No sanitization of `X-Forwarded-For` before `objects.create` | Prevents 500 from invalid IP causing DB error in-transaction | S | No |
| G6 | `EventType`/`TargetType` taxonomy | No `choices` or frozenset — typos silently accepted | Audit log integrity and searchability | M | No |
| G7 | Phase 1B audit coverage | `matches`, `tournaments`, `disputes` not yet built | Audit chain completeness for sport verbs | XL | No |
| G8 | PII redaction for non-Super-admin viewers | Mentioned in serializer docstring ("B.11 if non-Super-admin") but not implemented | Correct PII exposure per v1Users.md | M | No |
| G9 | `previous_cursor` schema contract | AuditEventListResponseSerializer exposes it as a real cursor | Misleading OpenAPI contract for clients | S | No |
