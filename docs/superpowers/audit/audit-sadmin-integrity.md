# Sadmin Integrity Audit — Idempotency / Audit / State (#3/#4/#5/#6)

**Date:** 2026-06-04
**Scope:** `backend/apps/sadmin/` + cross-cutting `backend/apps/audit/`
**Lens:** Invariants 3 (idempotent writes), 4 (DB-first / Redis on_commit), 5 (append-only audit at DB level), 6 (state machines not booleans)

---

## Summary

The sadmin app is generally well-structured. Audit emission (#4, #5) is solid:
the `0002_audit_append_only` migration uses `BEFORE UPDATE OR DELETE` triggers
(not GRANT/REVOKE alone), tests confirm the triggers fire even for superuser
connections, and every mutating verb calls `emit_audit()` inline inside its
`@transaction.atomic` block. State transitions in `Feedback` and `Organization`
use explicit enum choices. No raw Redis publishes exist in the sadmin surface
(Phase 1B concern); invariant #11 (SSE/WS) is correctly deferred.

**Four real defects** are documented below, ranging from high to low severity.

---

## Findings

### F-01 · HIGH — SA verb endpoints (`org_verb`, `user_verb`) accept no `event_id`; double-POSTs re-execute and double-audit

**File:** `backend/apps/sadmin/views/orgs.py:59-84`,
`backend/apps/sadmin/views/users.py:72-116`

**Evidence:**
```python
# orgs.py:63-68 — reason only; no event_id read
reason = (request.POST.get("reason") or "").strip()
user = request.user
# ... calls superadmin_verbs.suspend_org(...)
```
```python
# users.py:74-76 — same pattern
actor = request.user
reason = (request.POST.get("reason") or "").strip()
# No event_id, no idempotency check
```

**Why it matters:** Invariant 3 says "every mutation endpoint accepts a
client-generated `event_id` with a unique DB constraint; re-submitting returns
the existing record (200, not 201)." The 13 SA verbs (suspend_user,
force_logout_all, approve_org, etc.) are mutations. A network retry, double
browser submit, or accidental HTMX re-trigger will re-execute the verb, fire
`emit_audit()` a second time, and produce a duplicate AuditEvent — the audit
log is the audit log. This is a correctness problem on the audit side and
violates the idempotency invariant on the verb side. The service functions
(`suspend_user`, etc.) do not check for a prior idempotency_key either.

**Recommendation:**
1. Add `event_id` (UUID) as an optional POST field in the HTML form (hidden
   `<input>` generated on page load with a UUID v7).
2. Read it in `org_verb` and `user_verb` views and pass it through to the
   service layer.
3. Add an `idempotency_key` check at the top of each SA verb service function
   (same pattern as `submit_feedback` / `emit_audit`): look up an existing
   `AuditEvent` with that key + matching `event_type`; if found, return the
   prior result without re-executing.

---

### F-02 · HIGH — `csrf_exempt` on two JSON sadmin API endpoints breaks CSRF protection

**File:** `backend/apps/sadmin/views/superadmin.py:47,97`

**Evidence:**
```python
@superadmin_required
@require_POST
@csrf_exempt                     # line 47
def bulk_email_api(request: HttpRequest) -> HttpResponse:
    ...

@superadmin_required
@require_POST
@csrf_exempt                     # line 97
def archive_feedback_api(
    request: HttpRequest, feedback_id: uuid.UUID
) -> HttpResponse:
```

**Why it matters:** These endpoints mutate state (emit audit rows, change
Feedback status). They are consumed from the sadmin HTML console which is
a standard Django session — CSRF protection applies and is available. Exempting
CSRF opens CSRF-based attacks against super-admin sessions. The SPA uses a
custom CSRF header; the sadmin console uses Django's `CsrfViewMiddleware`
directly (it's in the middleware stack at `base.py:65`). There is no
justification for the exemption. `system_health_api` (GET) correctly has no
`@csrf_exempt`.

**Recommendation:** Remove `@csrf_exempt` from both `bulk_email_api` and
`archive_feedback_api`. Ensure the HTMX POST calls in the console include the
CSRF token (standard `{% csrf_token %}` or the `django_htmx` header).

---

### F-03 · MEDIUM — `bulk_email` audit row uses `uuid.uuid4()` as `target_id` — violates UUID v7 invariant and makes audit rows non-idempotent

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:421`

**Evidence:**
```python
emit_audit(
    ...
    event_type="bulk_email_drafted",
    target_type="bulk_email",
    target_id=uuid.uuid4(),          # <-- uuid4, not uuid7
    ...
)
```
Also `impersonate_stop` at line 380:
```python
target_id=target_id or (actor.id if actor and getattr(actor, "is_authenticated", False) else uuid.uuid4()),
```

**Why it matters:** Invariant 1 says "UUID v7 primary keys everywhere." README
states "Never use `uuid.uuid4`. All PKs use `apps.accounts.models.uuid7()`."
`target_id` is stored in `AuditEvent.target_id` (a non-PK indexed UUID column,
not a PK itself, but the invariant concern is about using monotonic v7 for
consistent ordering). More critically: each call to `bulk_email_drafted` uses a
fresh random UUID for target_id, making it impossible to detect replay via
audit lookup (you cannot correlate two audit rows for "the same" bulk email
draft). The `impersonate_stop` fallback to `uuid.uuid4()` for the anonymous
case is acceptable as a last resort but should be documented as intentional.

**Recommendation:**
- Import `uuid7` from `apps.accounts.models` and use it for `target_id` in
  `bulk_email`: e.g. pass a draft-id generated before the call or use `uuid7()`.
- For `impersonate_stop`, generate a `uuid7()` sentinel rather than `uuid.uuid4()`.

---

### F-04 · MEDIUM — `triage_feedback` and `archive_feedback` have no `@transaction.atomic` guard; audit + state-change are not atomic

**File:** `backend/apps/sadmin/services/feedback.py:103-183`

**Evidence:**
```python
def triage_feedback(
    *,
    feedback: Feedback,
    ...
) -> Feedback:
    # No @transaction.atomic
    ...
    feedback.save(update_fields=["status", ...])
    emit_audit(...)     # Can fail after save() succeeds
    return feedback


def archive_feedback(
    *,
    feedback: Feedback,
    ...
) -> Feedback:
    # No @transaction.atomic
    ...
    feedback.save(update_fields=["status", ...])
    emit_audit(...)     # Same risk
```

**Why it matters:** Invariant 4 says the DB event log is the system of record;
invariant 6 requires audited state transitions. If `emit_audit()` raises after
`feedback.save()` succeeds, the state change is committed but no audit row
exists — an unlogged state mutation. With `ATOMIC_REQUESTS = True` in
`base.py:102`, the *request* is wrapped in a transaction, so in practice the
view will roll back the entire request on an unhandled exception. But service
functions called from management commands, tests, or future async contexts
won't have that safety net. The sister functions `suspend_org`, `unsuspend_org`,
`suspend_user`, etc., all use `@transaction.atomic`, establishing the pattern.

**Recommendation:** Add `@transaction.atomic` (or a `with transaction.atomic():` block) to both `triage_feedback` and `archive_feedback`.

---

### F-05 · LOW — Append-only migration uses a trigger, not REVOKE; migration comment promises a REVOKE step that is absent

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:11`

**Evidence:**
```python
"""
...
Production deployments should ADDITIONALLY REVOKE UPDATE/DELETE on audit_event
from the application role for defense in depth — handled in deploy
provisioning, not here.
"""
```

**Why it matters:** The trigger approach is actually stronger than GRANT/REVOKE
for dev (it blocks even the postgres superuser), which is good. But the comment
promises a second layer ("REVOKE … from the application role") that is nowhere
implemented — no provisioning script, no `Makefile`, no `scripts/` file contains
`REVOKE`. This is noted in the migration but not tracked. In production, the
application DB user (`postgres` in dev, a least-privilege role in prod) can
still issue `UPDATE`/`DELETE` without the trigger catching them if a future
migration drops the trigger. This is forward-risk, not an active bug.

**Recommendation:** Create a provisioning SQL snippet (e.g.
`backend/scripts/provision_db_roles.sql`) that executes
`REVOKE UPDATE, DELETE ON audit_event FROM <app_role>;` and wire it to the
deploy checklist. Track it in the "open questions / deploy checklist" section
of the PRD.

---

### F-06 · INFO — `FeedbackStatus` transitions are not guarded by a state-machine; any status → any status transition is allowed

**File:** `backend/apps/sadmin/services/feedback.py:112-113`,
`backend/apps/sadmin/models.py:35-39`

**Evidence:**
```python
def triage_feedback(..., status: str, ...) -> Feedback:
    if status not in FeedbackStatus.values:
        raise ValueError(f"Invalid feedback status: {status!r}")
    # No guard: can go from RESOLVED → PENDING, WONTFIX → PENDING, etc.
    feedback.status = status
```

**Why it matters:** Invariant 6 says "state machines, not boolean flags; audit-logged transitions." The current code validates that the value is in the enum but does not enforce which transitions are legal. For Feedback this is lower-stakes than Tournament or Match state machines, but a SA could accidentally move a RESOLVED row back to PENDING with no record of why, which the audit log only partially mitigates.

**Recommendation:** Define a `VALID_TRANSITIONS` dict for `FeedbackStatus` (e.g. PENDING→TRIAGED, PENDING→WONTFIX, TRIAGED→RESOLVED, TRIAGED→WONTFIX, PENDING→RESOLVED) and raise `ValidationError` on illegal transitions. This is low-stakes for Phase 1A but should be in place before Phase 1B when the state-machine discipline becomes critical.

---

## Gaps (forward-looking, not current bugs)

| # | Area | Missing | Needed for | Effort | Blocking |
|---|------|---------|-----------|--------|---------|
| G-01 | DB provisioning | `REVOKE UPDATE, DELETE ON audit_event FROM <app_role>` script | Production hardening of invariant 5 | S | No |
| G-02 | SA verb idempotency | `event_id` field + per-verb idempotency_key lookup in all 13 SA verbs | Full invariant 3 compliance | M | No |
| G-03 | CSRF fix | Remove `@csrf_exempt` from `bulk_email_api` + `archive_feedback_api` | Security baseline | S | No |
| G-04 | Feedback state machine | Enforce legal `FeedbackStatus` transitions | Invariant 6 strictness | S | No |
| G-05 | uuid7 in audit target_id | Replace `uuid.uuid4()` calls in `bulk_email` and `impersonate_stop` | Invariant 1 compliance + audit linkability | S | No |
| G-06 | Rate-limit cache in prod | `CACHES` in base.py still uses `LocMemCache`; `_bump_rate_counter` in superadmin_verbs.py is per-process only | Correct B.21 alarm counts in multi-process prod | M | No (Phase 1B) |
| G-07 | `feedback_submit` throttle scope | `feedback_submit` rate scope is not declared in `DEFAULT_THROTTLE_RATES`; DRF will raise `ImproperlyConfigured` in strict mode | Runtime correctness | S | Yes (if hit) |
