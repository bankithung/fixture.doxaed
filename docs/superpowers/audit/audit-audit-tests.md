# Audit App — Test Gap Report
**Area:** `backend/apps/audit`
**Lens:** Cross-org isolation (#2), permission-denied/negative, idempotent-replay, untested error paths
**Date:** 2026-06-04

---

## Summary

The audit app has solid coverage for two narrow areas:
- DB-level append-only enforcement (`test_append_only.py` — 5 tests, covers ORM + raw SQL)
- Basic view happy-path, one cross-org isolation check, one module-gate deny, and cursor pagination (`test_audit_list_view.py` — 7 tests)

What is **missing** falls into six categories documented below:

1. Idempotent replay of `emit_audit()` with an `idempotency_key` is **never tested in the audit app itself** (only incidentally in accounts/orgs tests).
2. Every role that has `org.audit_log` by default is untested except `admin`; three other default roles and the override paths are not covered in the audit test module.
3. Several error/edge paths in `OrgAuditListView` (invalid cursor, invalid `actor_id`, unknown org slug/UUID, limit clamping, `from`/`to` filters, `actor_id` filter) have no tests.
4. The `emit_audit_on_commit()` helper is entirely untested.
5. The `serialize_payload()` stub in `models.py` is untested and undocumented.
6. The super-admin audit search view (`sadmin/audit/`) has no tests.

---

## Findings

### F-1 — `emit_audit()` idempotency never tested in the audit module itself

**Severity:** high
**Category:** idempotent-replay
**File:** `backend/apps/audit/services.py:45-48`

```python
if idempotency_key:
    existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        return existing
```

**Why it matters:** Invariant #3 requires every write to accept a client-generated `event_id`; replaying the same key must return the existing row (200, not 201). The replay logic sits in `emit_audit()` but `backend/apps/audit/tests/` contains zero tests for it. There are incidental tests in `apps/accounts/tests/test_signup_path_b.py:174` and `apps/organizations/tests/test_slug_routes.py:147`, but those test signup-level idempotency, not the `emit_audit()` primitive itself.

**Recommendation:**
Add to `test_audit_list_view.py` or a new `test_emit_audit.py`:
- `test_emit_audit_idempotent_replay`: call `emit_audit()` twice with the same `idempotency_key`; assert `AuditEvent.objects.count()` increased by exactly 1 and both calls return the same object pk.
- `test_emit_audit_none_idempotency_key_always_inserts`: two calls with `idempotency_key=None` both create rows (null does not participate in the unique constraint).

---

### F-2 — Only `admin` role tested for `org.audit_log` access; `co_organizer`, `game_coordinator`, `referee` untested in audit module

**Severity:** high
**Category:** permission-denied / cross-role
**File:** `backend/apps/audit/tests/test_audit_list_view.py:28-35`

```python
_DEFAULT_AUDIT_ROLES = (
    MembershipRole.ADMIN,
    MembershipRole.CO_ORGANIZER,
    MembershipRole.GAME_COORDINATOR,
    MembershipRole.REFEREE,
)
```

The constant `_DEFAULT_AUDIT_ROLES` is defined but **never iterated in a parametrized test**. `test_admin_sees_org_audit_rows` tests only `MembershipRole.ADMIN`. `test_team_manager_denied_by_module_gate` tests one denial role. The module fixture confirms all four roles get `org.audit_log` by default:

```json
"default_for_roles": ["admin", "co_organizer", "game_coordinator", "referee"]
```

**Why it matters:** A regression that accidentally removes `co_organizer` or `game_coordinator` from the module's default role list would not be caught by any existing audit test.

**Recommendation:**
Replace the single admin fixture with a `@pytest.mark.parametrize` covering all four default roles. Also parametrize the deny path over `match_scorer` and `team_manager`. Example test names: `test_default_role_can_read_audit[co_organizer]`, `test_denied_role_cannot_read_audit[match_scorer]`.

---

### F-3 — Inactive membership does not block org audit access

**Severity:** high
**Category:** permission-denied / cross-org isolation
**File:** `backend/apps/audit/tests/test_audit_list_view.py`

No test verifies that a user whose `OrganizationMembership.is_active = False` is denied access to `/api/audit/orgs/<slug>/`. The resolver in `apps/permissions/services/resolver.py:58-64` filters `is_active=True`, so this should return 403, but there is no assertion of it in the audit test suite.

**Why it matters:** An admin who was deactivated but not removed would still have their cached effective-modules set. If the cache is cleared (e.g., between test runs) and the resolver recomputes, the inactive membership should yield an empty module set and therefore 403. Without this test the gap is silent.

**Recommendation:**
Add `test_inactive_member_denied`: create an admin membership for the org, set `is_active=False`, assert the audit endpoint returns 403.

---

### F-4 — `OrgAuditListView` error paths untested

**Severity:** medium
**Category:** untested error paths
**File:** `backend/apps/audit/views.py`

Four error-handling branches in `OrgAuditListView.get()` have no corresponding tests:

**4a — Invalid cursor (line 166-169):**
```python
if decoded is None:
    return Response({"detail": "Invalid cursor."}, status=status.HTTP_400_BAD_REQUEST)
```
No test sends a corrupt/truncated cursor and asserts HTTP 400.

**4b — Invalid `actor_id` UUID (line 136-140):**
```python
except (ValueError, TypeError):
    return Response({"detail": "Invalid actor_id; expected a UUID."}, status=status.HTTP_400_BAD_REQUEST)
```
No test sends a non-UUID `actor_id` and asserts HTTP 400.

**4c — Unknown org slug returns 404 (line 127):**
```python
raise Http404("Organization not found.")
```
No test requests `/api/audit/orgs/nonexistent-org/` and asserts 404.

**4d — Soft-deleted org returns 404:**
`_resolve_org_by_slug_or_uuid` filters `deleted_at__isnull=True` (views.py:52-58), so a soft-deleted org should return None → 404. Not tested.

**Recommendation:**
Add one test per error branch: `test_invalid_cursor_returns_400`, `test_invalid_actor_id_returns_400`, `test_unknown_org_returns_404`, `test_soft_deleted_org_returns_404`.

---

### F-5 — Filter parameters `from`, `to`, and `actor_id` have no coverage

**Severity:** medium
**Category:** untested error paths / behavior
**File:** `backend/apps/audit/views.py:132-152`

The view supports `from`, `to`, and `actor_id` query parameters that filter the queryset. The only filter tested is `event_type` (`test_filter_by_event_type`). The other three filters are dead coverage.

**Why it matters:** A regression (e.g., wrong field name, off-by-one in inclusive/exclusive bound) would go undetected.

**Recommendation:**
Add `test_filter_by_actor_id`, `test_filter_by_from_timestamp`, `test_filter_by_to_timestamp`, and `test_filter_combined_actor_and_event_type`. Also test that `from` and `to` with equal value returns an empty page (exclusive upper bound).

---

### F-6 — `limit` clamping not tested

**Severity:** low
**Category:** untested error paths
**File:** `backend/apps/audit/views.py:155-159`

```python
try:
    limit = int(request.query_params.get("limit") or _DEFAULT_LIMIT)
except (ValueError, TypeError):
    limit = _DEFAULT_LIMIT
limit = max(1, min(limit, _MAX_LIMIT))
```

No test verifies:
- `limit=0` is clamped to 1.
- `limit=500` (exceeds `_MAX_LIMIT=200`) is clamped to 200.
- `limit=abc` falls back to default 50.

**Recommendation:**
Add `test_limit_clamped_to_max`, `test_limit_zero_clamped_to_one`, `test_limit_non_integer_uses_default`.

---

### F-7 — `emit_audit_on_commit()` is entirely untested

**Severity:** medium
**Category:** untested error paths
**File:** `backend/apps/audit/services.py:80-87`

```python
def emit_audit_on_commit(**kwargs):
    """Defer audit emission until transaction commit."""
    transaction.on_commit(lambda: emit_audit(**kwargs))
```

This helper is the correct pattern for WebSocket/SSE-triggered events (invariant #4: "Redis publish only in `transaction.on_commit`"). It is currently unused in Phase 1A but is part of the public API. There are no tests verifying:
- The audit row does NOT exist before the transaction commits.
- The audit row DOES exist after the transaction commits.
- A rolled-back transaction produces no row.

**Recommendation:**
Add `test_emit_audit_on_commit_fires_after_commit` and `test_emit_audit_on_commit_suppressed_on_rollback` using `@pytest.mark.django_db(transaction=True)` and explicit `django.db.transaction.atomic()` + rollback.

---

### F-8 — `serialize_payload()` stub untested and not integrated into `emit_audit()`

**Severity:** low
**Category:** untested error paths / correctness
**File:** `backend/apps/audit/models.py:103-107`

```python
def serialize_payload(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Stub for payload serialization. Real impl belongs to the audit agent.
    UUIDs and datetimes need normalization. Placeholder for now.
    """
    return d
```

`serialize_payload` is defined but: (a) never called by `emit_audit()`; (b) never tested. UUID/datetime values passed as `payload_before`/`payload_after` will fail JSON serialization or silently store non-canonical forms.

**Recommendation:**
Either remove the stub (if it is genuinely Phase 1B) or wire it into `emit_audit()` and add tests verifying UUID objects are serialized to strings and `datetime` objects to ISO 8601.

---

### F-9 — `deleted_user_handle` fallback in serializer untested

**Severity:** low
**Category:** untested error paths
**File:** `backend/apps/audit/serializers.py:50-58`

```python
def get_actor_email_at_time(self, obj: AuditEvent) -> str | None:
    if obj.actor_user_id is None:
        return obj.deleted_user_handle or None
```

The `SET_NULL` on `actor_user` means rows can exist with `actor_user=None` and `deleted_user_handle` populated. The serializer has a fallback path for this case but no test exercises it — the fallback line is annotated `# pragma: no cover`.

**Recommendation:**
Add `test_serializer_uses_deleted_user_handle_when_actor_nulled`: create an `AuditEvent` row with `actor_user=None, deleted_user_handle="deleted-user@example.com"`, serialize it, and assert `actor_email_at_time == "deleted-user@example.com"`.

---

### F-10 — Superuser bypasses `HasModule` check in audit view; not validated

**Severity:** low
**Category:** permission-denied
**File:** `backend/apps/permissions/permissions.py:43-44`

```python
if getattr(user, "is_superuser", False):
    return True
```

A superuser always bypasses the module check. No test in the audit suite verifies this shortcut works correctly for the audit endpoint (i.e., a superuser with no org membership can still read any org's audit log).

**Recommendation:**
Add `test_superuser_can_read_any_org_audit`: create a superuser with no org membership, hit `/api/audit/orgs/<slug>/`, assert HTTP 200. This also protects against future hasty changes to the superuser bypass that could lock super-admins out of their own audit surface.

---

### F-11 — `sadmin/audit/` view (`audit_search`) has zero tests

**Severity:** high
**Category:** permission-denied / untested behavior
**File:** `backend/apps/sadmin/views/audit.py`

The `audit_search` view at `GET /sadmin/audit/` is mounted at `sadmin:audit_search` and decorated with `@superadmin_required`. It reads across **all organizations** without any org-scoping filter. There are no tests for:
- Access control (anonymous → redirect, regular user → 404, superadmin → 200).
- That the `event_type`, `actor`, and `org` filters narrow results.
- That a non-UUID `org` param does not crash (the `try/except ValueError` path, views/audit.py:30-33).
- Cross-org data visibility (the view deliberately exposes all-org data to super-admins; this is correct but should be an explicit assertion).

**Why it matters:** The sadmin audit view is the only audit surface with no test coverage at all. A regression (e.g., accidentally removing `@superadmin_required`) would go undetected.

**Recommendation:**
Add `backend/apps/sadmin/tests/test_audit_search.py` covering: anonymous redirect, regular-user 404, superadmin 200, filters work, malformed org UUID does not crash.

---

## Gaps (Forward-looking)

| Item | Missing | Needed for | Effort | Blocking |
|------|---------|-----------|--------|---------|
| Phase 1B: Tournament-scoped audit feed | No test that `tournament_id` filter works; view does not exist yet | PRD §5 / tournaments app | M | No |
| Phase 1B: Match-scoped audit events | No test that `match_id` is captured and query-filterable | matches app invariant #4 | M | No |
| Phase 1B: Audit detail endpoint | Serializer references "Phase 1B detail endpoint" in comment; no route exists | Frontend diff view | S | No |
| CSV export for `org.audit_log` | Module description mentions "CSV export" but no export endpoint exists | v1Users.md Appendix A.2 | L | No |
| Cross-worker cache invalidation (Redis pub/sub) | `invalidate_cache()` only deletes local cache; multiple ASGI workers could serve stale module sets | Phase 1B live transport | M | No |
| Parametrized multi-org isolation sweep | Current cross-org test in `test_audit_list_view.py` tests one admin vs one other org; a parametrized sweep over all roles × org combinations is absent | Invariant #2 hardening | M | No |
