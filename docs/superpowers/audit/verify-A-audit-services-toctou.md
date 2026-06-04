# Adversarial Verify A — emit_audit idempotency TOCTOU

**Finding (original):** severity=high — "emit_audit idempotency check is a TOCTOU race (check-then-create without select_for_update)"
**File:** backend/apps/audit/services.py:45

## Verdict
- **is_real:** true (mechanism partially real) — but **severity overstated (high -> low)** and **proposed remedy is wrong**.

## Evidence seen

backend/apps/audit/services.py:45-48 (check) then :61 (create):
```python
if idempotency_key:
    existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        return existing
...
return AuditEvent.objects.create(idempotency_key=idempotency_key, ...)
```
There IS a check-then-create gap with no lock. Two concurrent calls with the
same key can both pass the check.

backend/apps/audit/models.py:48 — the decisive fact:
```python
idempotency_key = models.UUIDField(unique=True, null=True, blank=True)
```
Confirmed also in backend/apps/audit/migrations/0001_initial.py:31.

## Why severity is wrong (high -> low)
- The `unique=True` DB constraint (invariant 3) is the real enforcer. The
  losing racer's `create()` raises IntegrityError; it CANNOT insert a
  duplicate audit row. So the harmful outcome a "TOCTOU race" implies
  (duplicate / corrupted append-only log) cannot occur. Audit log integrity
  is preserved.
- Residual real bug: emit_audit does not catch IntegrityError and re-fetch,
  so a genuine simultaneous double-submit makes one request 500 instead of
  returning the existing row (the documented "Re-submission returns the
  existing row" behavior, services.py:9-10,43). This is a robustness/UX
  defect, only under exact-concurrency replay, no data corruption -> low.
- `select_for_update` is NOT the correct fix: on the INSERT path there is no
  existing row to lock. Correct remedy is `get_or_create` or
  try/except IntegrityError + refetch.

## Confidence
High (0.9). Both the code and the unique constraint were read directly.
