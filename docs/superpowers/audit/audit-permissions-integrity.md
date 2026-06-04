# Audit: permissions — Idempotency / Audit / State Integrity

**Date:** 2026-06-04
**Scope:** `backend/apps/permissions/` + `backend/apps/audit/`
**Lens:** Invariants #3 (idempotent writes), #4 (DB-first / on_commit publish), #5 (append-only audit at DB role), #6 (state machines)

---

## Findings

### F-1 HIGH — `event_id` accepted but never consumed (full-endpoint idempotency absent)

**File:** `backend/apps/permissions/serializers.py:107-110` and `backend/apps/permissions/views.py:238-246`

**Evidence:**
```python
# serializers.py lines 107-110
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```

The `BulkGrantsCellsSerializer` parses `event_id` from the PUT request body, but the view extracts only `cells` and `reason` from `payload`, discarding `event_id` entirely. The `bulk_set_grants` service call at lines 238-246 of `views.py` has no `idempotency_key` or `event_id` parameter. This means a client that retries a `PUT /grants/` with the same `event_id` will re-execute the entire bulk operation rather than receiving the cached result — violating invariant #3.

**Why it matters:** The scorer flow (and any networked client) can retry PUT requests on transient failure. Without endpoint-level idempotency keyed on `event_id`, each retry may write duplicate audit rows (one per module per retry) even if the grant state is already correct. In the case where `prior_state == state`, `bulk_set_grants` does skip audit emission (no-op check at line 169), so the second retry is safe for the grant state itself — but the risk grows in Phase 1B where the scorer flow does NOT benefit from that check.

**Recommendation:** Pass `event_id` from the serialized payload through to the service and use it as `idempotency_key` on at least the audit `emit_audit` call, or gate the entire operation on a global idempotency-key table (as the TODO comment promises for Phase 1B). Add a test: two identical PUT requests with the same `event_id` must produce the same response and the same audit count.

---

### F-2 HIGH — `invalidate_cache` fires inside `transaction.atomic()`, before commit

**File:** `backend/apps/permissions/services/grants.py:109-111` (set_grant) and `:211` (bulk_set_grants) and `:266` (clear_grants)

**Evidence (set_grant):**
```python
with transaction.atomic():
    ...  # grant row mutated
    # Invalidate cache (resolver layer).
    # TODO (Appendix B.3): also publish to Redis pub/sub for cross-worker.
    invalidate_cache(user.id, organization.id)  # line 111 — still inside atomic()

    emit_audit(...)  # line 113
```

`invalidate_cache` calls `cache.delete()` synchronously inside the `transaction.atomic()` block. Because `ATOMIC_REQUESTS = True` (settings/base.py line 102) wraps each request in an outer transaction, a nested `transaction.atomic()` becomes a savepoint, not a true commit. The cache entry is deleted before the grant row is committed to Postgres. A concurrent worker that reads `effective_modules` in the window between cache invalidation and transaction commit will rebuild the cache from the DB — where the grant row does not yet exist — and cache the stale result for up to 5 minutes.

**Why it matters:** Under ATOMIC_REQUESTS, every view handler runs inside a transaction. The inner `transaction.atomic()` in the service is always a savepoint. Cache deletion happens at savepoint exit, but the DB row only becomes visible after the outermost transaction commits. A race window exists on every concurrent write where a reading worker repopulates the stale pre-grant cache.

**Recommendation:** Move all three `invalidate_cache(...)` calls to `transaction.on_commit(lambda: invalidate_cache(...))` to ensure cache invalidation only fires after the DB row is durably committed. The Redis pub/sub broadcast (Appendix B.3 TODO) must also be on_commit.

---

### F-3 MEDIUM — `payload_after["state"]` in `clear_grants` stores enum object, not string

**File:** `backend/apps/permissions/services/grants.py:257-259`

**Evidence:**
```python
payload_after={
    "state": GrantState.DEFAULT,   # TextChoices enum member, not "default"
    "module_code": module_code,
},
```

Every other call to `emit_audit` in this file uses string values (`prior_state` and `state` are already strings at that point, taken from `existing.state` or validated via `_validate_state`). But inside `clear_grants`, `payload_after["state"]` is set to `GrantState.DEFAULT` — the `TextChoices` enum member — rather than `GrantState.DEFAULT.value` ("default"). When Django serializes this into the `payload_after` JSONB column, Django's JSON encoder will call `str()` on the enum member, which for `TextChoices` returns `"GrantState.DEFAULT"` in some Django versions (behaviour depends on version; Django 4.x+ coerces `.value` but this is version-dependent). This will produce inconsistent audit payloads compared to `set_grant` and `bulk_set_grants` which store `"default"`.

**Why it matters:** Audit payload consistency is required for forensic tooling and export. A `payload_after["state"] == "GrantState.DEFAULT"` row cannot be reliably compared to `"default"` rows from other code paths. The `test_clear_grants_emits_one_audit_per_row` test at line 132-161 of `test_grant_audit.py` does not assert `payload_after` content, so this defect is untested.

**Recommendation:** Change line 258 to `"state": GrantState.DEFAULT.value` (i.e., the string `"default"`). Add assertions to `test_clear_grants_emits_one_audit_per_row` that verify `payload_after == {"state": "default", "module_code": ...}`.

---

### F-4 MEDIUM — Audit `emit_audit` called inside `transaction.atomic()` (shares atomicity with grant write — correct for integrity, but means audit rows are NOT actually committed on_commit)

**File:** `backend/apps/permissions/services/grants.py:113` (set_grant), `192` (bulk_set_grants), `247` (clear_grants)

**Evidence:**
```python
with transaction.atomic():
    ...  # grant row mutated
    emit_audit(...)   # audit row inserted — same transaction savepoint
```

This is intentional (the docstring says "audit + state change share atomicity") and correct for invariant #4's DB-first requirement: both the grant row and audit row land atomically. However, the PRD invariant says "every state-changing action publishes to Redis pub/sub *after* the DB transaction commits (`transaction.on_commit`)." The current grants service has no Redis publish at all (the `# TODO (Appendix B.3)` comment at line 110 acknowledges this). When Phase 1B adds Redis publish, it is critical that the publish hook is placed on `transaction.on_commit` — not inside the `atomic()` block alongside the audit emit.

**Why it matters:** This is a confirmed gap rather than a defect in Phase 1A code (the TODO is explicit). But it is noted here because the pattern in the service makes it easy for a future developer to add the Redis publish call in the wrong place (inside `atomic()`), violating invariant #4. The `emit_audit_on_commit` helper in `audit/services.py` exists but is unused in the grants service.

**Recommendation:** When Phase 1B adds Redis pub/sub: use `transaction.on_commit(lambda: redis_publish(...))` at the end of each `with transaction.atomic():` block, not `emit_audit_on_commit`. Add a docstring comment making the boundary explicit.

---

### F-5 LOW — `AuditEvent.idempotency_key` is nullable; `emit_audit` in grants never passes it

**File:** `backend/apps/audit/models.py:48`, `backend/apps/permissions/services/grants.py:113,192,247`

**Evidence:**
```python
# audit/models.py
idempotency_key = models.UUIDField(unique=True, null=True, blank=True)

# grants.py — all three emit_audit() calls:
emit_audit(
    ...
    # idempotency_key not passed → defaults to None
)
```

The `emit_audit()` function supports idempotency via `idempotency_key` (audit/services.py line 45-47). The grants service never passes one. This means if the same grant mutation is retried (e.g. network timeout, ATOMIC_REQUESTS rollback + client retry), a second audit row will be written even if the underlying grant state is unchanged. Combined with F-1 (no endpoint-level idempotency), a retry produces duplicate audit rows.

**Why it matters:** Duplicate audit rows for the same real-world action pollute the audit log and make it harder to reconstruct state history. The `unique=True` constraint on `idempotency_key` only prevents duplication when the key is non-null.

**Recommendation:** Pass the `event_id` from the PUT request body (once F-1 is fixed) through `bulk_set_grants` → each `emit_audit` call as `idempotency_key`. For `set_grant` and `clear_grants`, generate a deterministic UUID (e.g. UUID5 over `user_id + org_id + module_id + prior_state + new_state + timestamp`) or accept a caller-supplied key.

---

### F-6 INFO — Trigger-based append-only is correct, but production REVOKE is deferred and undocumented

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:11-12`

**Evidence:**
```
# migration docstring lines 11-12:
Production deployments should ADDITIONALLY REVOKE UPDATE/DELETE on
audit_event from the application role for defense in depth —
handled in deploy provisioning, not here.
```

The trigger exists and is tested (`test_append_only.py` passes ORM + raw SQL UPDATE/DELETE). However, the secondary REVOKE layer (which would block even trigger-bypassing superuser operations at the Postgres role level) is deferred to deployment provisioning with no tracking ticket, no deploy script, and no CI assertion.

**Why it matters:** Invariant #5 says "UPDATE/DELETE on AuditEvent are denied by Postgres role permissions, not just application code." The trigger satisfies the "not just application code" requirement, but the Postgres GRANT/REVOKE layer (which protects against DBA-level tampering outside the application) is untracked. This gap is only a risk at production scale but warrants a deployment checklist entry.

**Recommendation:** Add a `check_audit_permissions` management command (or a deploy-time assertion in the CI matrix) that connects as the application DB role and asserts `has_table_privilege('audit_event', 'UPDATE')` returns `f` and `has_table_privilege('audit_event', 'DELETE')` returns `f`. Reference the provisioning step in the deployment runbook.

---

### F-7 INFO — `GrantState` is a tri-state with no transition validation (by design, but undocumented)

**File:** `backend/apps/permissions/models.py:26-39`, `backend/apps/permissions/services/grants.py:33-39`

**Evidence:**
```python
class GrantState(models.TextChoices):
    DEFAULT = "default", _("Default (no override)")
    GRANT = "grant", _("Grant (force on)")
    DENY = "deny", _("Deny (force off)")
```

`GrantState` is a three-value enumeration, not a state machine with typed transitions. Any value can transition to any other value with no precondition checks. This is correct for Phase 1A (module grants have no lifecycle states), but it differs from the invariant #6 requirement for "state machines not boolean flags" — which applies to Tournament and Match status, not to permission overrides. The code and tests are consistent with this design; the finding is informational only.

**Recommendation:** Add a comment to the model clarifying that `GrantState` is intentionally not a state machine (all transitions are valid; the business rule is that any admin can change any grant to any state at any time, and the audit row records what happened). This prevents future contributors from adding spurious transition guards.

---

## Gaps (forward-looking, not currently blocking Phase 1A)

| # | Item | Missing | Effort | Blocking Phase 1B? |
|---|------|---------|--------|-------------------|
| G-1 | Endpoint-level `event_id` idempotency for PUT /grants/ | Service parameter + global idempotency table | M | Yes — scorer flow requires full replay safety |
| G-2 | Redis pub/sub broadcast of cache invalidation (Appendix B.3) | `on_commit` publish to `effective_modules_invalidate` channel | M | Yes — multi-worker ASGI requires this |
| G-3 | Production REVOKE UPDATE/DELETE on `audit_event` | Deploy script + CI assertion via `has_table_privilege()` | S | No, but required before go-live |
| G-4 | `idempotency_key` passed from client `event_id` through to `emit_audit` in grants | Thread `event_id` through service signatures | S | Yes — prevents duplicate audit rows on retry |
| G-5 | `test_clear_grants_emits_one_audit_per_row` asserts payload shape | Add `payload_after == {"state": "default", ...}` assertion | S | No, but required to catch F-3 regression |
| G-6 | Cross-worker cache invalidation test (verify Redis pub/sub path) | Test with multiple cache backends simulating worker isolation | L | Phase 1B |
