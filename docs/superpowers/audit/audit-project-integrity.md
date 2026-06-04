# Audit: Project Integrity — Idempotency / Audit / State (#3/#4/#5/#6)

**Date:** 2026-06-04
**Scope:** Phase 1A backend (accounts, organizations, permissions, audit, sadmin, sports)
**Invariants under review:** #3 (idempotent writes + event_id), #4 (DB-first, Redis on_commit), #5 (append-only audit at DB layer), #6 (state machines, not booleans)

---

## Findings

### FINDING-01 [HIGH] — `OrgDetailView.patch` mutates org name/time_zone without emitting an audit row

**File:** `backend/apps/organizations/views.py:198-220`

```python
def patch(self, request, slug_or_uuid: str):
    ...
    if update_fields:
        org.save(update_fields=update_fields)
    return Response(OrganizationSerializer(org).data)
```

**Why it matters:** `PATCH /api/orgs/{uuid}/` can change `name` and `time_zone` on an Organization with no audit trail. Every other state-changing verb in the organizations app (suspend, unsuspend, archive, change_slug, transfer_ownership) emits an `AuditEvent`. This gap means a silent, untraced mutation is possible through a permissioned endpoint. The invariant (B.4: "every verb calls emit_audit() at the same call site that performs the state change") is violated.

**Recommendation:** Move the PATCH body into `lifecycle_svc.update_org_metadata(...)`, emit `org_settings_changed` with `payload_before`/`payload_after`, and add an `event_id` field to `OrganizationUpdateSerializer` for idempotency. The slug-change verb already sets the precedent (`org_settings_changed` event type).

---

### FINDING-02 [HIGH] — `emit_audit` idempotency check is a TOCTOU race under concurrent requests

**File:** `backend/apps/audit/services.py:45-48`

```python
if idempotency_key:
    existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        return existing
```

**Why it matters:** The check-then-insert is not wrapped in a `select_for_update()` or a `get_or_create()` with the unique constraint as the conflict target. Under concurrent duplicate submissions (the exact scenario idempotency is meant to protect against), both requests can pass the filter check simultaneously, then both attempt `AuditEvent.objects.create()`. The `unique` constraint on `idempotency_key` will cause one of them to raise `IntegrityError` at the DB level, but that exception propagates up as a 500 to the caller. The correct pattern is to catch `IntegrityError` and re-fetch, or use `get_or_create`.

**Recommendation:**
```python
if idempotency_key:
    try:
        obj, _ = AuditEvent.objects.get_or_create(
            idempotency_key=idempotency_key,
            defaults={...all fields...}
        )
        return obj
    except IntegrityError:
        return AuditEvent.objects.get(idempotency_key=idempotency_key)
```
Alternatively wrap the entire body in an atomic block and use `select_for_update(nowait=False)` on the idempotency key lookup.

---

### FINDING-03 [HIGH] — Bulk-grant `event_id` is accepted but silently ignored

**File:** `backend/apps/permissions/serializers.py:107-110`

```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```

**Why it matters:** The SPA matrix UI sends `event_id` expecting idempotent behaviour (invariant #3). The field is deserialized but never passed to `bulk_set_grants(...)`. A network retry or double-click from the frontend silently double-writes grants and emits duplicate audit rows, one per module per attempt. This is the exact problem idempotency is designed to prevent and the API contract the client relies on.

**Recommendation:** Either (a) wire `event_id` through to the service layer using the existing audit-row lookup pattern (check `AuditEvent.objects.filter(idempotency_key=event_id, event_type="module_grant_changed")` and short-circuit), or (b) surface a clear deprecation error telling callers `event_id` is not yet honoured. Do not silently accept and discard it.

---

### FINDING-04 [MEDIUM] — `archive_org` allows archiving from any non-ARCHIVED status, including SUSPENDED and ORPHANED

**File:** `backend/apps/organizations/services/lifecycle.py:227-257`

```python
def archive_org(...):
    if org.status == OrgStatus.ARCHIVED:
        return org
    # No other precondition check — any status can proceed
    if not reason or len(reason.strip()) < 3:
        raise ValidationError(...)
    ...
    org.status = OrgStatus.ARCHIVED
```

**Why it matters:** The function permits archiving an org that is `SUSPENDED`, `ORPHANED`, or even `PENDING_REVIEW` without any precondition check. The state machine table in the PRD (§5.2 equivalent for Org lifecycle) should define which transitions are valid. Archiving a `SUSPENDED` org bypasses the audit trail that would otherwise record the unsuspend-then-archive sequence. At minimum, a SUSPENDED org should be unsuspended by a super-admin before being archived, or the archive verb should explicitly check allowed source states.

**Recommendation:** Add an explicit whitelist: `if org.status not in (OrgStatus.ACTIVE, OrgStatus.PENDING_REVIEW, OrgStatus.ORPHANED): raise ValidationError(...)`. Document this as the canonical transition table for org lifecycle.

---

### FINDING-05 [MEDIUM] — `archive_org` uses event_type `"org_deleted"` instead of `"org_archived"`

**File:** `backend/apps/organizations/services/lifecycle.py:248`

```python
emit_audit(
    ...
    event_type="org_deleted",
    ...
)
```

**Why it matters:** Archiving is a reversible soft-state change, not deletion. `"org_deleted"` misleads anyone querying the audit log, including the `org_rejected` flow that also sets `status=ARCHIVED` but uses `event_type="org_rejected"` (correct). The inconsistency means the audit taxonomy is broken: you cannot reliably filter for "all archive actions" without also seeing rejection events, and "deletion" events do not reflect actual hard-deletes. Tests in `test_audit_emission.py:57` currently assert `event_type="org_deleted"`, locking in the wrong name.

**Recommendation:** Change `event_type` to `"org_archived"` in `lifecycle.py:248`. Update the corresponding test assertion.

---

### FINDING-06 [MEDIUM] — `emit_audit` target_id uses `uuid.uuid4()` (random v4) for deleted grants and bulk_email, breaking traceability

**Files:**
- `backend/apps/permissions/services/grants.py:118` — `target_id=(row.id if row else uuid.uuid4())`
- `backend/apps/permissions/services/grants.py:197` — same pattern
- `backend/apps/sadmin/services/superadmin_verbs.py:421` — `target_id=uuid.uuid4()`

```python
# grants.py:118
target_id=(row.id if row else uuid.uuid4()),
```

**Why it matters:** When `state == GrantState.DEFAULT`, the grant row is deleted (`row = None`). The audit row then records a random v4 UUID as the target. This makes the audit row untraceable: you cannot correlate it with any entity in the database. The audit is supposed to answer "what changed and on what object" — a random target_id defeats that. The same problem exists for `bulk_email_drafted` and the fallback path in `impersonate_stop`.

**Recommendation:** For deleted grant rows, keep the row's UUID before deletion (already done as `row_id = row.id` in `clear_grants`, but not in `set_grant`/`bulk_set_grants`). For `bulk_email_drafted`, create a stable `BulkEmailDraft` model or use a hash of the payload. For `impersonate_stop` fallback, default to the actor's own ID, not a random UUID.

---

### FINDING-07 [MEDIUM] — `suspend_org` in `sadmin/services/superadmin_verbs.py` has a dead fallback path that would double-emit audit if it fired

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:94-128`

```python
try:
    from apps.organizations.services.lifecycle import suspend_org as svc_suspend
    return svc_suspend(org=org, ...)
except (ImportError, AttributeError):
    # inline fallback: emits its own audit row
    ...
    emit_audit(...)
```

**Why it matters:** The lifecycle service is fully implemented and the `try` branch always succeeds. The dead `except` path would double-emit an `org_suspended` audit row if the import ever failed. More importantly, since the `@transaction.atomic` decorator wraps the entire function, a failure of `svc_suspend` inside the `try` block rolls back the transaction but the catch path then tries to emit audit outside a fresh atomic block — creating a state where the status change is rolled back but audit is committed. The fallback should be removed entirely; the `@transaction.atomic` decorator on the sadmin verb wrapper conflicts with the inner `transaction.atomic()` in the lifecycle service (they nest correctly but the outer decorator becomes a savepoint that wraps an already-atomic inner call — harmless but confusing).

**Recommendation:** Remove the try/except fallback entirely. The lifecycle service is always importable. Keep the sadmin verb as a thin delegate without `@transaction.atomic` (the inner service handles atomicity).

---

### FINDING-08 [MEDIUM] — No production settings file: `InMemoryChannelLayer` and `LocMemCache` are the only configured backends

**File:** `backend/fixture/settings/base.py:186-196`

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

**Why it matters:** There is no production settings file. `InMemoryChannelLayer` and `LocMemCache` are per-process, non-shared, and will lose all state on worker restart. Invariant #4 (Redis publish in `on_commit`) cannot be fulfilled without a real Redis-backed channel layer. Invariant #11 (SSE for one-way, WebSockets for two-way) also depends on a shared channel layer. The `effective_modules` resolver comment already acknowledges cross-worker invalidation is broken without Redis pub/sub. This is intentional in Phase 1A per the inline `TODO`, but the lack of a production settings file means there is no documented path to flip the switch.

**Recommendation:** Create `backend/fixture/settings/prod.py` that overrides `CHANNEL_LAYERS` to `channels_redis.core.RedisChannelLayer` and `CACHES` to a Redis backend. Even if not deployed yet, having the file prevents the currently-undocumented gap from being forgotten. Add a CI check that the prod settings file imports cleanly.

---

### FINDING-09 [LOW] — `signup.perform_signup` idempotency check is outside the atomic transaction, creating a TOCTOU gap

**File:** `backend/apps/accounts/services/signup.py:236-254`

```python
if event_id is not None:
    replay = _replay_from_idempotency(event_id)
    if replay is not None:
        return replay

# -- Duplicate email guard --
if User.objects.filter(email=email).exists():
    ...

with transaction.atomic():
    user = User.objects.create_user(...)
```

**Why it matters:** Both the idempotency check (`_replay_from_idempotency`) and the duplicate-email guard are performed outside the `transaction.atomic()` block. Under concurrent identical submissions, both can pass the filter and enter the atomic block, where one will fail on the `email` unique constraint or the `idempotency_key` unique constraint in `emit_audit`. This surfaces as an unhandled `IntegrityError` rather than a clean 200 replay. The email `unique` constraint at the DB level is the safety net, but the Django ORM raises `IntegrityError` which propagates as a 500.

**Recommendation:** Wrap the email uniqueness check and user creation in the same `atomic()` block, and catch `IntegrityError` to re-route to the replay path.

---

### FINDING-10 [LOW] — `emit_audit_on_commit` decouples audit from the transaction, silently breaking atomicity for callers that use it

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

**Why it matters:** The docstring acknowledges this breaks atomicity between the state change and the audit row. The function is defined but currently has zero callers in production code (only the definition in `services.py`). This is a readiness gap: Phase 1B callers will be tempted to use it for Redis publish (`on_commit` is the correct pattern for Redis), but the function conflates two distinct concerns — deferred audit emission and deferred Redis publish. Using it for audit means that if the `on_commit` callback fails (e.g., DB connection drops after commit), the audit is silently lost.

**Recommendation:** Rename to `_publish_on_commit` (or remove it) to prevent future misuse. The documented pattern (PRD invariant #4) is: state change + audit share the transaction; Redis publish fires in `transaction.on_commit`. Implement a separate `publish_to_redis_on_commit(channel, payload)` helper distinct from audit emission.

---

### FINDING-11 [INFO] — Trigger-based append-only enforcement in migration 0002 does not include a production REVOKE

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:11`

```
Production deployments should ADDITIONALLY REVOKE UPDATE/DELETE on audit_event
from the application role for defense in depth — handled in deploy provisioning,
not here.
```

**Why it matters:** The trigger fires for all roles including superuser (correct), but the comment explicitly acknowledges that the second defense layer (REVOKE at the Postgres role level) is deferred to deploy provisioning. There is no deploy provisioning script yet (no production settings file, no deploy runbook). This means the "defense in depth" is not implemented anywhere in the repository. The trigger alone is strong, but the REVOKE would prevent a compromised application credential from attempting direct SQL mutations.

**Recommendation:** Add a `backend/provisioning/apply_pg_roles.sql` script with the `REVOKE UPDATE, DELETE ON TABLE audit_event FROM <app_role>;` statement, and reference it from a deploy checklist doc.

---

### FINDING-12 [INFO] — `suspend_org` early-return on already-SUSPENDED is silent, not idempotent-200

**File:** `backend/apps/organizations/services/lifecycle.py:159-160`

```python
if org.status == OrgStatus.SUSPENDED:
    return org
```

**Why it matters:** The function silently returns without error when called twice. This is an application-layer idempotency pattern but it does not emit an audit row on the replay, so it is not distinguishable in the audit log from the first successful suspension. No event_id is accepted by this function, so callers cannot confirm replay semantics. Compare: `archive_org` has the same pattern for already-ARCHIVED. Neither function accepts or documents idempotency guarantees to callers.

**Recommendation:** Document these as "no-op idempotent" (acceptable) but ensure callers (views) surface a clear API behaviour — either a 200 with the current state or a 409 Conflict.

---

## Gaps (forward-looking, not current bugs)

| Item | Missing | Needed for | Effort | Blocking? |
|------|---------|-----------|--------|-----------|
| Phase 1B: Redis `on_commit` publish | No Redis publish in any current verb. Only `transaction.on_commit` helper defined, no callers. | Invariant #4 / live scoring transport | M | No (1B) |
| Phase 1B: production settings file | `settings/prod.py` does not exist; `InMemoryChannelLayer` + `LocMemCache` are the only configs | Shared state across workers, live channel broadcast | S | No (deploy) |
| Phase 1B: global event_id deduplication table | `BulkGrantsCellsSerializer.event_id` accepted, not stored | Full invariant #3 compliance for bulk-grant endpoint | M | No (1B) |
| Org lifecycle state-machine table | `archive_org` lacks source-state whitelist; no formal transition table exists in code | Invariant #6 completeness for org status | S | No |
| Deploy provisioning script | `REVOKE UPDATE, DELETE ON audit_event` not applied anywhere | Defense-in-depth for invariant #5 | S | No (deploy) |
| Tournaments / matches / MatchEvent | Entire Phase 1B domain does not exist | Invariants #3/#4/#6/#7/#8/#9/#10 for the core product | XL | Yes (1B) |
