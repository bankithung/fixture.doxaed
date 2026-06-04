# Audit Report: accounts — Idempotency / Audit / State Integrity

**Scope:** `backend/apps/accounts/` + `backend/apps/audit/`
**Date:** 2026-06-04
**Lens:** Invariants 3 (idempotent writes), 4 (DB-first event log / on_commit), 5 (append-only audit at DB), 6 (state machines not booleans)

---

## Summary

The accounts app is largely well-implemented against the invariants. The append-only trigger is
correct and tested. Audit emission is comprehensive across all verbs. The signup idempotency
path is fully implemented and tested. However, several genuine gaps and one medium-severity
race condition were found.

---

## Findings

### F-01 [MEDIUM] Race condition: idempotency + duplicate-email checks happen OUTSIDE the atomic block

**File:** `backend/apps/accounts/services/signup.py:236–254`

```python
if event_id is not None:
    replay = _replay_from_idempotency(event_id)
    if replay is not None:
        return replay

if User.objects.filter(email=email).exists():
    return SignupResult(...)     # <-- optimistic check

with transaction.atomic():      # <-- actual write happens here
    user = User.objects.create_user(...)
```

**Why it matters:** Both the idempotency read and the duplicate-email `EXISTS` check run
*outside* the `transaction.atomic()` block. Under concurrent identical requests (e.g. a
browser double-tap or a retrying client without `event_id`), two requests can both pass
the `exists()` check, then race inside `create_user()`. The `email` unique constraint in
Postgres will prevent actual duplication (the loser gets an `IntegrityError`), but the
loser is returned as a 500 instead of the expected idempotent 200. Partial org/membership
creation is also not rolled back cleanly in all cases because the outer try/except in the
view does not swallow `IntegrityError`.

**Recommendation:** Move both checks inside `transaction.atomic()` and use
`select_for_update()` or a `get_or_create()` pattern on `User`. Alternatively, catch
`IntegrityError` on `create_user` and re-read the existing user to reconstruct the
`SignupResult` with `duplicate_email=True`.

**Confidence:** High.

---

### F-02 [MEDIUM] `reauth_view` emits no audit event

**File:** `backend/apps/accounts/views.py:277–285`

```python
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def reauth_view(request: Request) -> Response:
    ...
    request.session["last_password_reauth"] = timezone.now().isoformat()
    return Response({"status": "ok"})
```

**Why it matters:** v1Users.md B.4 requires every state-changing verb to emit an audit row.
`reauth` writes to the session (a security-sensitive verb — it grants a time-limited
privilege window for sensitive operations). A failed reauth (wrong password) also produces
no audit row. Failed reauth attempts are the primary signal for credential stuffing
against already-authenticated sessions.

**Recommendation:** Emit `reauth_success` on success and `reauth_failed` on wrong-password.
Both should include the requesting IP.

**Confidence:** High.

---

### F-03 [MEDIUM] `password_reset_request` does not emit an audit row when rate-limited or when user is inactive

**File:** `backend/apps/accounts/services/password_reset.py:62–123`

```python
if _rate_limit_hit(per_email_key, ...):
    logger.info("password_reset rate-limited (email): %s", email_norm)
    return   # <-- no audit, no observable trace in DB

...
user = User.objects.filter(email=email_norm, is_active=True, deleted_at__isnull=True).first()
if user is None:
    return   # <-- enumeration-safe but no audit row
```

**Why it matters:** The module docstring claims "Audit row is written even on no-op for
forensics." That is false for two paths: (1) rate-limited requests produce only a logger
line (disappears without structured log aggregation), and (2) requests for an inactive /
deleted user are silently dropped. For security incident reconstruction you need DB-level
evidence of repeated reset attempts.

**Recommendation:** Emit a `password_reset_rate_limited` or `password_reset_no_op` audit
row in both early-exit paths. Since `actor_user` is unknown at this point, use
`actor_user=None, actor_role=SYSTEM` and record the email in `payload_after`.

**Confidence:** High.

---

### F-04 [LOW] Inline `emit_audit` inside `@transaction.atomic` views with `ATOMIC_REQUESTS=True` — double-nested transactions fine, but `verify_email` audit is inside the view-level atomic block

**File:** `backend/apps/accounts/views.py:154–186`

```python
@api_view(["POST"])
@permission_classes([AllowAny])
@transaction.atomic         # explicit extra savepoint
def verify_email(request: Request) -> Response:
    ...
    emit_audit(...)         # inline, inside that savepoint
    return Response({"status": "verified"})
```

`ATOMIC_REQUESTS=True` wraps every request in a transaction. `@transaction.atomic` here
creates a savepoint. The `emit_audit` call writes the audit row inside that same
savepoint. If the savepoint is rolled back (e.g. an exception raised after the audit
write), the audit row disappears.

**Why it matters:** While in this particular view the audit is the *last* line before
return (so rollback risk is low), the pattern is fragile. If any code is added after
`emit_audit(...)`, a raised exception will silently swallow the audit row without
violating the DB-level trigger (which only blocks UPDATE/DELETE, not INSERT rollback).

**Recommendation:** For verbs where the audit must survive a partial failure, consider
using `emit_audit_on_commit()` which defers until the outer transaction commits. For this
specific view the risk is low, but add a comment warning future contributors.

**Confidence:** Medium.

---

### F-05 [LOW] `twofa.confirm_totp` and `twofa.disable_2fa` use boolean flags (`has_2fa_enrolled`, `twofa_enrolled_at`) rather than a formal state machine

**File:** `backend/apps/accounts/services/twofa.py:141–145`, `259–262`

```python
user.has_2fa_enrolled = True
user.twofa_enrolled_at = now
user.save(update_fields=["has_2fa_enrolled", "twofa_enrolled_at"])
```

**Why it matters:** Invariant 6 states "state machines, not boolean flags." The 2FA
lifecycle (none → enrolling → enrolled → disabled) is modelled via `has_2fa_enrolled`
(bool) + `twofa_enrolled_at` (nullable datetime) on `User`, with the intermediate
"enrolling" state implicit in the existence of an unconfirmed `TwoFactorDevice` row.
This is spread across two models and is not a single, enumerated field with audited
transitions. While functional, it violates the spirit of the invariant.

**Recommendation:** This is acceptable for Phase 1A if tracked as known technical debt.
For Phase 1B, introduce a `twofa_status` TextChoices field (`none | enrolling | active`)
and retire the boolean. Transitions should go through a service function that enforces
the valid graph.

**Confidence:** Medium.

---

### F-06 [LOW] `perform_signup` idempotency check reads audit table directly; no index on `(idempotency_key, event_type)` compound query

**File:** `backend/apps/accounts/services/signup.py:176–179`, `backend/apps/audit/models.py`

```python
audit_row = AuditEvent.objects.filter(
    idempotency_key=event_id, event_type="user_signup"
).first()
```

`idempotency_key` has a `unique=True` constraint (so a B-tree index exists on it alone),
but the query filters on *both* `idempotency_key` AND `event_type`. Postgres will use the
unique index on `idempotency_key` first and then evaluate `event_type` as a filter — this
is fine for correctness but the `event_type` condition is redundant given uniqueness.
More importantly, the `AuditEvent` model has no compound index covering both columns.
For other callers that might query `(event_type, idempotency_key)` in the opposite
selectivity order this could become a table scan.

**Recommendation:** Either (a) remove the `event_type` filter (the unique index already
guarantees the key is unique across all event types — the extra filter does nothing
useful), or (b) add a compound index `(event_type, idempotency_key)` to support both
orderings. Option (a) is simpler.

**Confidence:** Medium.

---

### F-07 [INFO] `emit_audit_on_commit` is defined but never called in accounts or audit apps — correct

**File:** `backend/apps/audit/services.py:80–87`

```python
def emit_audit_on_commit(**kwargs):
    transaction.on_commit(lambda: emit_audit(**kwargs))
```

All accounts verbs correctly use the inline `emit_audit()` which shares atomicity with
the state change. The `emit_audit_on_commit` helper exists for Phase 1B WebSocket/SSE
publish use-cases and is not yet exercised. No issue; documented here for completeness.

**Confidence:** High (non-issue).

---

### F-08 [INFO] `AuditEvent.idempotency_key` is `nullable` — `emit_audit` idempotency check skips the guard when `idempotency_key` is None

**File:** `backend/apps/audit/services.py:45–48`

```python
if idempotency_key:
    existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        return existing
```

When `idempotency_key=None` (most verbs in accounts today), `emit_audit` is not
idempotent — it always inserts. This is expected behavior: only the signup verb passes
an `event_id`. However, if the same request is replayed (e.g. via `ATOMIC_REQUESTS`
retry or network timeout retry without `event_id`), duplicate audit rows will be written.
There is currently no protection for the non-signup verbs.

**Recommendation:** For Phase 1B mutations, ensure all write endpoints accept and forward
`event_id`. This is architecturally intended but not enforced for the Phase 1A verbs
(login, verify_email, etc.) — document this as a known Phase 1A scope limit.

**Confidence:** High (by design, low severity).

---

## Append-Only Enforcement Assessment

The `0002_audit_append_only` migration installs BEFORE UPDATE and BEFORE DELETE triggers
on `audit_event` using `RAISE EXCEPTION ... USING ERRCODE = '42501'`. The trigger fires
regardless of Postgres role (including superuser, which bypasses `GRANT/REVOKE`). Four
tests in `test_append_only.py` exercise all paths (ORM update, ORM delete, raw SQL update,
raw SQL delete, plus a positive insert test). This meets the spirit and letter of
invariant 5.

One gap: the migration comment says "Production deployments should ADDITIONALLY REVOKE
UPDATE/DELETE ... from the application role — handled in deploy provisioning, not here."
There is no deploy script or provisioning manifest in the repo that implements this REVOKE.
The trigger alone is sufficient for invariant 5, but the defense-in-depth REVOKE is
untracked.

---

## Gaps (Forward-Looking)

| # | Item | Missing | Needed For | Effort | Blocking |
|---|------|---------|-----------|--------|----------|
| G-01 | Idempotency for `verify_email`, `login`, `logout`, `password_reset_complete`, 2FA verbs | These verbs have no `event_id` path; replay creates duplicate audit rows and duplicate side-effects (e.g. two `email_verified` rows if token reuse were not blocked at the DB level separately) | Invariant 3 full compliance | M | No (token single-use prevents functional harm, but audit duplication is possible) |
| G-02 | Formal 2FA state machine | `has_2fa_enrolled` bool + nullable timestamp spread across User and TwoFactorDevice; no TextChoices enum with audited-transition enforcement | Invariant 6 compliance, Phase 1B | M | No |
| G-03 | REVOKE UPDATE/DELETE on `audit_event` from app Postgres role | Migration comment acknowledges this; no deploy provisioning script exists | Defense-in-depth for Invariant 5 | S | No |
| G-04 | Redis channel layer for Phase 1B | `InMemoryChannelLayer` + `LocMemCache` are in `base.py` (not just `dev.py`) | Invariant 4 / 11 (SSE/WS live transport) | M | Yes for Phase 1B |
| G-05 | `reauth` audit events | No `reauth_success` / `reauth_failed` rows | Forensic completeness, Invariant 3 | S | No |
| G-06 | `password_reset_request` audit on no-op paths | Rate-limited and inactive-user paths silently drop | Forensic completeness | S | No |
