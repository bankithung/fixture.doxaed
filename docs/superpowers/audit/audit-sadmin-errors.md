# Sadmin Error-Handling Audit

**Date:** 2026-06-04
**Scope:** `backend/apps/sadmin/` — bare/broad `except`, masking fallbacks, missing validation, unguarded `None`/`KeyError`, non-atomic multi-writes, 500-on-bad-input where 400 is correct, inconsistent error bodies.

---

## Findings

### F-01 — Open redirect in sadmin login (HIGH)
**File:** `backend/apps/sadmin/views/auth.py:51-52`
**Evidence:**
```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```
**Why it matters:** The `next` parameter is used verbatim with no host/scheme validation. An attacker who can trick a super-admin into clicking `https://fixture.doxaed.com/sadmin/login/?next=https://evil.com` gets a post-auth redirect to an arbitrary URL. Django's `url_has_allowed_host_and_scheme` exists precisely to prevent this.
**Recommendation:** Validate with `django.utils.http.url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()})` before redirecting; fall back to `reverse("sadmin:dashboard")` on failure.
**Confidence:** 0.98

---

### F-02 — `csrf_exempt` on super-admin state-mutating endpoints (HIGH)
**File:** `backend/apps/sadmin/views/superadmin.py:47,97`
**Evidence:**
```python
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:
...
@csrf_exempt
def archive_feedback_api(request: HttpRequest, feedback_id: uuid.UUID) -> HttpResponse:
```
**Why it matters:** These are state-mutating POST endpoints (bulk email draft + audit write; feedback archive + audit write) gated only by session auth. Removing CSRF protection while relying on session cookies enables CSRF attacks from any origin against an authenticated super-admin. The decorator order also matters: `@superadmin_required` runs before `@csrf_exempt` in the stack but `@csrf_exempt` exempts CSRF middleware globally regardless of order, so the session check is irrelevant for CSRF.
**Recommendation:** Remove `@csrf_exempt`. The sadmin console already renders HTML pages from the same origin; the JS fetch should send the CSRF token in `X-CSRFToken` (same pattern used by the SPA). If these are called from a separate front-end, use DRF's `SessionAuthentication` which enforces CSRF automatically.
**Confidence:** 0.98

---

### F-03 — Bare `except: pass` equivalent in `users_detail` (MEDIUM)
**File:** `backend/apps/sadmin/views/users.py:48-54`
**Evidence:**
```python
try:
    memberships = list(
        subject.org_memberships.select_related("organization")
        .filter(is_active=True)
    )
except Exception:
    memberships = []
```
**Why it matters:** A `ProgrammingError` (column missing from migration), `OperationalError` (DB unreachable), or an unexpected ORM error silently returns an empty memberships list with HTTP 200. The super-admin sees no error and no indication that the data is incomplete. There is no logging call in this except block — the exception is fully swallowed.
**Recommendation:** Add `logger.exception("users_detail: failed to load memberships for user=%s", subject.id)` inside the `except` block, and consider re-raising or surfacing a warning in the template when the list is empty due to an error vs. genuinely having no memberships. For a programming error (missing column), a 500 is preferable to silent misrepresentation.
**Confidence:** 0.97

---

### F-04 — `_delete_sessions_for_user` runs outside the atomic savepoint it is called from (MEDIUM)
**File:** `backend/apps/sadmin/services/superadmin_verbs.py:185,259`
**Evidence:**
```python
# suspend_user (line 166) is @transaction.atomic
user.save(update_fields=["is_active"])
_delete_sessions_for_user(user.id)   # line 185 — session deletes in atomic block
```
```python
def _delete_sessions_for_user(user_id) -> int:
    for session in Session.objects.iterator(chunk_size=500):
        ...
        session.delete()              # line 232
```
**Why it matters:** Django's `django.contrib.sessions.models.Session` uses the default database. When `_delete_sessions_for_user` is called inside a `@transaction.atomic` block, session deletes are wrapped in the same transaction. If the `emit_audit` call that follows raises an exception and rolls back the transaction, the user's `is_active` is restored — but the session deletes were also rolled back, so the user's active sessions survive. The user is unsuspended in DB but still has "deleted" sessions — no real harm, but the semantics are wrong. Conversely, if the intent is that session deletes should always commit regardless of the audit outcome, they need to run outside the transaction (e.g., `transaction.on_commit`). Same issue applies to `force_logout_all`.
**Recommendation:** Either accept the current rollback semantics (and document them) or move `_delete_sessions_for_user` to a `transaction.on_commit` hook so session deletes only happen if the DB write commits.
**Confidence:** 0.85

---

### F-05 — `force_password_reset` swallows the email-send failure and still emits audit (MEDIUM)
**File:** `backend/apps/sadmin/services/superadmin_verbs.py:283-299`
**Evidence:**
```python
try:
    from apps.accounts.services.password_reset import request_password_reset
    request_password_reset(user.email, request=request)
except Exception:
    logger.exception("force_password_reset: underlying service failed")

emit_audit(...)
```
**Why it matters:** If `request_password_reset` fails (SMTP error, missing template, etc.), the audit row is still written as `force_password_reset_issued`. The super-admin sees "success" in the UI; the user never receives the reset email. The audit log incorrectly records that a password reset was issued when none was. The view (`users.py:96`) also shows the success message `"Issued password-reset token for {email}."`.
**Recommendation:** Either (a) re-raise after logging so the audit is not emitted and the view shows failure, or (b) change the audit event type to `force_password_reset_attempted` and add a `payload_after={"sent": False}` field on failure, so the log accurately reflects the outcome.
**Confidence:** 0.97

---

### F-06 — `bulk_email` passes unsanitised `target_filter` dict directly to ORM `filter(**{k: v})` (MEDIUM)
**File:** `backend/apps/sadmin/services/superadmin_verbs.py:409-411`
**Evidence:**
```python
for k, v in target_filter.items():
    qs = qs.filter(**{k: v})
```
**Why it matters:** `target_filter` is a user-supplied JSON dict from the request body. Even though the caller is a super-admin, arbitrary ORM lookups via unsanitised keys permit querying any field on `User` including related models via double-underscore traversal (e.g., `{"org_memberships__organization__stripe_customer_id__icontains": "x"}`). This is not SQL injection but it is an unintended data-disclosure vector for a super-admin who should only be filtering on approved fields. More critically, a key containing `__` with a non-matching ORM path raises `FieldError` (which the outer `except Exception` swallows), silently returning `recipients=0` and writing a misleading audit row.
**Recommendation:** Define an explicit allowlist of filterable field names (e.g., `{"is_active", "date_joined__gte", "email__icontains"}`) and validate each key against it before applying. Return 400 from the view if an invalid key is present.
**Confidence:** 0.90

---

### F-07 — `impersonate_stop` uses `uuid.uuid4()` fallback as `target_id` in audit (LOW)
**File:** `backend/apps/sadmin/services/superadmin_verbs.py:380`
**Evidence:**
```python
target_id=target_id or (actor.id if actor and getattr(actor, "is_authenticated", False) else uuid.uuid4()),
```
**Why it matters:** If `target_id` is `None` (i.e., no impersonation was in progress when stop was called, or the session value was corrupt) AND the actor is unauthenticated, a random UUID is generated as `target_id` for the audit row. This writes a meaningless audit record pointing at a nonexistent user ID, which undermines the audit trail integrity the PRD mandates (§4, invariant 5). The B.19 audit requirement is "impersonation_stopped recorded against the impersonated user's ID" — with a random UUID that is not satisfied.
**Recommendation:** When both `target_id` and actor are unavailable, still write the audit row but set `target_id=None` (if the schema allows nullable) or skip the audit row with a structured log warning. Do not fabricate a UUID.
**Confidence:** 0.88

---

### F-08 — `_bump_rate_counter` returns `0` on cache failure, disabling rate alarms (LOW)
**File:** `backend/apps/sadmin/services/superadmin_verbs.py:42-52`
**Evidence:**
```python
except Exception:
    logger.exception("rate-counter increment failed (key=%s)", key)
    return 0
```
**Why it matters:** When the cache backend is unavailable (or LocMemCache is cleared between requests), `_bump_rate_counter` returns `0`. The caller then compares `0 > _FORCE_LOGOUT_RATE_PER_HOUR` (or `_SUSPEND_USER_RATE_PER_HOUR`) which is always `False`, so the B.21 alarm never fires. A super-admin can perform unlimited force-logouts or suspensions without triggering any alert when the cache is down.
**Recommendation:** On cache failure, return a sentinel value that triggers the alarm (e.g., `return threshold + 1`) so the alarm is conservative (false positive on cache failure) rather than silent.
**Confidence:** 0.85

---

### F-09 — Broad `except Exception` in `_helpers.impersonation_context` silently masks DB failures (LOW)
**File:** `backend/apps/sadmin/views/_helpers.py:40-41`
**Evidence:**
```python
except Exception:
    return {"impersonating_user_id": uid, "impersonating_email": None}
```
**Why it matters:** If `User.objects.filter(pk=uid).first()` raises (e.g., DB connection lost), the context returns `impersonating_user_id=uid` but `impersonating_email=None`. The impersonation banner renders with a missing email (or "None") without alerting the operator that something went wrong. There is no `logger.exception` call here.
**Recommendation:** Add `logger.exception("impersonation_context: failed to resolve user %s", uid)` inside the except block.
**Confidence:** 0.92

---

### F-10 — `suspend_org` and `unsuspend_org` do not validate `reason` min-length before calling the fallback path (LOW)
**File:** `backend/apps/sadmin/services/superadmin_verbs.py:94-128`
**Evidence:**
```python
def suspend_org(*, org, suspended_by, reason: str = "", request: HttpRequest | None = None):
    """Suspend an Org. Reason ≥20 chars per §1.6 (enforced at view layer)."""
```
**Why it matters:** The docstring explicitly notes that the 20-char reason requirement is "enforced at view layer" — but the view layer (`orgs.py:63-74`) does NOT enforce it either. It passes `reason` directly to the verb with no length check. The inline fallback path in `suspend_org` therefore persists a `suspended_reason=""` without any validation, and the audit row carries an empty reason string. This violates the documented invariant.
**Recommendation:** Add a `if len(reason) < 20: raise ValueError("Reason must be at least 20 characters")` guard either in the verb (authoritative) or in the view before calling the verb. If the view enforces it, add a test that proves it.
**Confidence:** 0.95

---

### F-11 — `FeedbackSubmitView` returns HTTP 500 for any service-layer exception (LOW)
**File:** `backend/apps/sadmin/views/feedback.py:192-197`
**Evidence:**
```python
except Exception:
    logger.exception("feedback submit failed")
    return Response(
        {"detail": "Could not record feedback."},
        status=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )
```
**Why it matters:** `submit_feedback` can raise `ValueError` (invalid category coerced at service layer, but other validation could raise), `IntegrityError`, or Django `ValidationError` — all of which are logically 400-level errors. Returning 500 for bad input misleads the client and may trigger unnecessary alerts/retries. In practice the current service code does not raise 400-class errors visibly, but the pattern is fragile: any future validation added to `submit_feedback` will also surface as 500.
**Recommendation:** Catch specific expected exceptions (`ValueError`, `ValidationError`) separately and return 400; let the outer `except Exception` remain for truly unexpected errors (500). Alternatively, validate all inputs in the serializer (preferred since `FeedbackSubmitSerializer` already runs `is_valid(raise_exception=True)`) and trust that the service will not raise.
**Confidence:** 0.80

---

## Gaps (Forward-Looking)

| # | Area | Current State | What Is Missing | Effort | Needed For |
|---|------|--------------|-----------------|--------|-----------|
| G-01 | Open redirect test | No test for `next=` parameter | Test asserting that `?next=https://evil.com` redirects to dashboard, not external URL | S | Security hardening |
| G-02 | CSRF on sadmin API views | `@csrf_exempt` on two state-mutating views | Remove exemption; add test that a request without CSRF token is rejected | S | Security hardening |
| G-03 | `suspend_org` reason validation | Docstring says "enforced at view layer"; view does not enforce | Either verb-level guard or view-level guard + test | S | Invariant compliance |
| G-04 | `force_password_reset` audit accuracy | Audit emitted even on email failure | Unit test asserting that email failure results in accurate audit payload (or re-raise) | S | Audit integrity |
| G-05 | `bulk_email` `target_filter` allowlist | Arbitrary ORM field names accepted | Define and enforce an explicit allowlist; return 400 on unknown keys | M | Security + data integrity |
| G-06 | Rate alarm on cache failure | Returns 0, alarm silenced | Conservative sentinel value on cache miss | S | Alarm reliability |
| G-07 | `_delete_sessions_for_user` transaction semantics | Runs inside atomic block; rollback undoes session deletes | Document or fix with `on_commit` | S | Correctness |
| G-08 | Impersonation logging | `_helpers.py` except block has no logger.exception | Add logging | XS | Operational visibility |
| G-09 | `impersonate_stop` uuid4 fallback | Random UUID written to audit on unauthenticated stop | Write `target_id=None` or skip | S | Audit integrity |
| G-10 | `users_detail` silent exception | No logging in except block for memberships query | Add logger.exception | XS | Operational visibility |
