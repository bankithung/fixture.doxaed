# Audit Integrity Review — Idempotency / Audit / State (#3/#4/#5/#6)

**Date:** 2026-06-04
**Scope:** `backend/apps/audit/` plus every caller of `emit_audit`, mutation endpoints, and state-machine status transitions across Phase 1A apps (accounts, organizations, permissions, sadmin).
**Lens:** Invariants 3 (idempotent writes via event_id), 4 (DB-first event log; Redis only on_commit), 5 (append-only audit at DB level), 6 (state-machines not booleans).

---

## Summary

The audit backbone is largely solid. Invariant 5 (append-only) is correctly implemented via a Postgres BEFORE trigger that fires even for superusers, and tests confirm it. Invariant 6 (state-machines) is upheld with explicit `TextChoices` enums and transition guards in lifecycle services. Most state-changing verbs emit `AuditEvent` rows atomically inside `transaction.atomic`. However, six specific weaknesses were found.

---

## Findings

### F1 — HIGH — `emit_audit` idempotency check is a TOCTOU race

**File:** `backend/apps/audit/services.py:45-48`
**Evidence:**
```python
if idempotency_key:
    existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        return existing
# ... then later:
return AuditEvent.objects.create(idempotency_key=idempotency_key, ...)
```
**Why it matters:** The check-then-create is a classic TOCTOU window. Two concurrent requests carrying the same `idempotency_key` can both pass the `filter().first()` check, both attempt `create()`, and one will raise an `IntegrityError` (the unique constraint on `idempotency_key` will catch it at the DB level), but the caller receives an unhandled `IntegrityError` instead of the graceful replay-200. The unique constraint IS present in migration 0001, so data integrity holds, but the error is surfaced to the client as a 500.
**Recommendation:** Replace the filter-then-create with `get_or_create(idempotency_key=idempotency_key, defaults={...})` — the `IntegrityError` will never surface because `get_or_create` retries internally, or at minimum wrap the `create` in a `try/except IntegrityError` and re-fetch on conflict.

---

### F2 — HIGH — `bulk_set_grants` `event_id` accepted but silently dropped

**File:** `backend/apps/permissions/serializers.py:107-110`
**Evidence:**
```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```
**Why it matters:** Invariant 3 is "non-negotiable for the scorer flow but applies to ALL writes." The SPA sends `event_id` with every module-grant mutation. The serializer accepts it but `bulk_set_grants` in `grants.py` has no `event_id` parameter at all — the value is validated and then thrown away. A retry of the same grant matrix mutation after a timeout will double-apply side effects (cache invalidation, audit rows with random UUIDs as `target_id` when the grant is deleted). The individual `emit_audit` calls inside `bulk_set_grants` do not receive an idempotency_key, so each retry creates fresh audit rows.
**Recommendation:** Add `event_id: uuid.UUID | None = None` to `bulk_set_grants` and `set_grant`. Pass it to `emit_audit` as `idempotency_key`. The unique constraint on `AuditEvent.idempotency_key` then naturally blocks double-audit-writes and the check-on-replay pattern guards the DB mutation.

---

### F3 — HIGH — `OrgMemberRemoveView.delete` and `user_soft_delete_view` have no `transaction.atomic`

**Files:**
- `backend/apps/organizations/views.py:368-399` (`OrgMemberRemoveView.delete`)
- `backend/apps/accounts/views.py:452-474` (`user_soft_delete_view`)

**Evidence (member remove):**
```python
def delete(self, request, uuid, membership_id):
    ...
    if membership.is_active:
        membership.is_active = False
        membership.removed_at = _tz.now()
        membership.save(update_fields=["is_active", "removed_at"])   # <- DB write
        emit_audit(...)                                               # <- second DB write
    return Response(status=status.HTTP_204_NO_CONTENT)
```
No `transaction.atomic` wrapping. If `emit_audit` raises after `membership.save()`, the state change is committed but the audit row is missing — a silent audit gap.

**Evidence (soft delete):**
```python
def user_soft_delete_view(request, user_id):
    ...
    target.soft_delete()   # <- DB write (no atomic context)
    emit_audit(...)        # <- second DB write
```
Same pattern: two sequential uncommitted-in-tandem writes.
**Recommendation:** Wrap both handlers with `with transaction.atomic():` so the membership/user mutation and its audit row are committed or rolled back together, matching the pattern used in all the service-layer verbs.

---

### F4 — MEDIUM — `me_view PATCH` is not atomic; `serializer.save()` and `emit_audit` are separate operations

**File:** `backend/apps/accounts/views.py:418-441`
**Evidence:**
```python
def me_view(request: Request) -> Response:
    ...
    serializer.save()   # user profile saved
    ...
    emit_audit(...)     # audit emitted separately, outside any transaction
```
No `transaction.atomic` and no `@transaction.atomic` decorator on the view (only `verify_email` at line 154 has that decorator). If `emit_audit` fails after `serializer.save()`, the profile update is committed but unaudited.
**Recommendation:** Wrap the PATCH branch in `with transaction.atomic():` covering both the `serializer.save()` and `emit_audit`.

---

### F5 — MEDIUM — `archive_org` uses `ActorRole.ADMIN` but is called only by super-admin

**File:** `backend/apps/organizations/services/lifecycle.py:247`
**Evidence:**
```python
emit_audit(
    actor_user=archived_by,
    actor_role=ActorRole.ADMIN,     # <-- should be SUPER_ADMIN
    event_type="org_deleted",
    ...
)
```
Every other lifecycle verb (`create_organization`, `approve_org`, `reject_org`, `suspend_org`, `unsuspend_org`) uses `ActorRole.SUPER_ADMIN`. `archive_org` is the single outlier. Audit rows for org archival will be attributed to the wrong role in the audit log, making forensic queries over `actor_role='super_admin'` miss these events.
**Recommendation:** Change `actor_role=ActorRole.ADMIN` to `actor_role=ActorRole.SUPER_ADMIN` in `archive_org`.

---

### F6 — MEDIUM — `serialize_payload` is a no-op stub; UUID/datetime values in payloads are not normalized

**File:** `backend/apps/audit/models.py:103-107`
**Evidence:**
```python
def serialize_payload(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Stub for payload serialization. Real impl belongs to the audit agent.
    UUIDs and datetimes need normalization. Placeholder for now.
    """
    return d
```
And it is not called by any caller in the codebase (grep finds zero callers). Callers like `lifecycle.py` pass raw Python `datetime` objects, e.g. `{"archived_at": org.archived_at}` (a `datetime`, not a string). Django's JSONField does serialize datetimes, but they will arrive as timezone-unaware ISO strings in some cases, and UUIDs passed as Python `uuid.UUID` objects will be coerced by the JSONField encoder. The inconsistency (some callers call `.isoformat()`, others don't) means payload shape varies across event types, making programmatic audit log parsing fragile.
**Recommendation:** Implement `serialize_payload` to normalize UUIDs to `str`, datetimes to UTC ISO8601 strings; call it at every `emit_audit` call site or inside `emit_audit` itself before `AuditEvent.objects.create`.

---

### F7 — LOW — REVOKE UPDATE/DELETE at the Postgres role layer is documented as a deployment concern but not automated

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:11`
**Evidence:**
```
Production deployments should ADDITIONALLY REVOKE UPDATE/DELETE on audit_event
from the application role for defense in depth — handled in deploy provisioning, not here.
```
The trigger-based enforcement is correct and tested. However, the defense-in-depth `REVOKE` on the application Postgres role is deferred to "deploy provisioning" with no associated script, Makefile target, or checklist item in the repo. A deploy that skips this step leaves the `audit_event` table mutable by the app DB user via raw psql (bypassing the trigger by using `SET session_replication_role = replica`).
**Recommendation:** Add a `deploy/postgres_hardening.sql` script (or equivalent) with:
```sql
REVOKE UPDATE, DELETE ON audit_event FROM <app_role>;
```
and reference it in the deploy documentation / CI pre-flight so it cannot be forgotten.

---

### F8 — INFO — `emit_audit_on_commit` is defined but has zero callers in Phase 1A

**File:** `backend/apps/audit/services.py:80-87`
**Evidence:** `grep` across all `.py` files finds only the definition — no callers.
**Why it matters:** The function exists but the docstring usage guidance ("where the verb's state change must be persisted before the audit row is meaningful") is misleading: the current preferred pattern is inline `emit_audit` inside `transaction.atomic`, which is correct for atomicity. If a future developer reaches for `emit_audit_on_commit` without understanding the trade-off (audit row outside the business transaction = no shared rollback), they will introduce subtle audit gaps.
**Recommendation:** Either add a clear warning in the docstring that using `emit_audit_on_commit` breaks shared atomicity with the state change (so the audit row can succeed even if a post-commit hook crashes), or remove the function and re-add it when Phase 1B actually needs it.

---

### F9 — INFO — No test covers the idempotency replay path in `invite_accept` or `member_remove`

**Files:**
- `backend/apps/organizations/tests/test_slug_routes.py` — tests `event_id` idempotency for `create_invitation` only
- No test for member-remove idempotency (member-remove does not even accept `event_id`)

**Why it matters:** Invariant 3 says idempotency applies to ALL writes. `accept_invitation` has no `event_id` parameter and thus no idempotency guarantee. A double-POST by the SPA after a network timeout will attempt to re-accept an already-accepted invitation, receiving a 400 "already accepted" rather than a 200 replay — which the SPA cannot distinguish from a true error.
**Recommendation:** Add `event_id` support to `accept_invitation` and `revoke_invitation` (the service-layer `event_id` plumbing already exists in `create_invitation` as a model). Add test coverage for the replay path.

---

## Gaps (forward-looking, not current bugs)

| # | Item | Missing | Needed for | Effort | Blocking |
|---|------|---------|-----------|--------|----------|
| G1 | Phase 1B state-machine audit | `Tournament`, `Match`, `MatchEvent` state transitions (PRD §5.2/§5.5) do not exist yet; audit emission contracts need to be defined before implementation | Invariant 6 coverage for Phase 1B | L | No |
| G2 | Redis publish on_commit | No call site publishes to Redis pub/sub anywhere in Phase 1A. `invalidate_cache` has a `TODO (Appendix B.3)` comment. Until channels_redis replaces `InMemoryChannelLayer`, multi-worker deployments will have stale module-cache. | Invariant 4 / SSE+WS live updates | M | No |
| G3 | Audit detail endpoint | `AuditEventSerializer` comment says "full diff via the detail endpoint (Phase 1B)" — no detail endpoint exists | Admin UI drill-down | M | No |
| G4 | Historical email snapshot in AuditEvent | `actor_email_at_time` falls back to the live `actor_user.email`. After a soft-delete + PII anonymization, the email is rewritten to `deleted-<uuid>@invalid`. All pre-deletion audit rows will then show the anonymized email, not the original — forensic integrity loss. | PRD §2.6 + GDPR-style erasure | M | No |
| G5 | Postgres role REVOKE script | See F7. No automated deployment artifact exists. | Production hardening | S | No |
| G6 | `serialize_payload` implementation | UUID and datetime normalization is absent; payload shape is inconsistent across event types | Audit log parsability | S | No |
