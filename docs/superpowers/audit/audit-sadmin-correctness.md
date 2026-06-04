# Sadmin Correctness Audit

**Scope:** `backend/apps/sadmin/` — all Python files (models, middleware, services, views, tests, management commands).
**Lens:** Wrong conditionals, off-by-one, races, wrong queryset filters, missing transaction.atomic / on_commit, serializer↔model mismatch, wrong HTTP status (idempotent replay must be 200), None handling, tz math.
**Date:** 2026-06-04

---

## Findings

---

### F-01 — Open redirect in sadmin login `?next=` parameter (HIGH)

**File:** `backend/apps/sadmin/views/auth.py:51`

```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```

**Why it matters:** An attacker who can trick a super-admin into clicking `https://sadmin.fixture.doxaed.com/sadmin/login/?next=https://evil.com` will have the SA redirected to the attacker's site after a legitimate login. This is a classic open-redirect / phishing vector against the highest-privilege account in the system.

**Recommendation:** Validate that `next_url` is a relative path (starts with `/` and does not start with `//`) before accepting it. Use `django.utils.http.url_has_allowed_host_and_scheme` or simply strip to safe default:
```python
from django.utils.http import url_has_allowed_host_and_scheme
next_url = request.GET.get("next", "")
if not url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()}, require_https=True):
    next_url = reverse("sadmin:dashboard")
```

---

### F-02 — `csrf_exempt` is shadowed by `@superadmin_required` — CSRF exemption silently has no effect (HIGH)

**File:** `backend/apps/sadmin/views/superadmin.py:45-50`, `95-100`

```python
@superadmin_required   # outermost — MIDDLEWARE sees this wrapper
@require_POST
@csrf_exempt           # innermost — middleware never reaches this
def bulk_email_api(request: HttpRequest) -> HttpResponse:
```

**Why it matters:** Python decorators are applied bottom-up. The Django CSRF middleware checks for `csrf_exempt` on the view function it receives from URL routing. What the URL resolver exposes is `_wrapped` (from `superadmin_required`), which is NOT the `csrf_exempt`-marked function. The `functools.wraps` in `superadmin_required` copies `__name__` and `__doc__`, but it does NOT propagate `csrf_exempt`'s `csrf_exempt = True` attribute. As a result the CSRF middleware enforces the token on both `bulk_email_api` and `archive_feedback_api`, making them break for any JavaScript caller that doesn't include the CSRF header — which is exactly what the comment on `_parse_json_body` implies is the intended usage (raw JSON body, no form token). The `@csrf_exempt` must be the outermost decorator to take effect, or `superadmin_required` must propagate the attribute.

**Recommendation:** Move `@csrf_exempt` to be the outermost decorator (above `@superadmin_required`). Alternatively, since these endpoints are sadmin-only and behind session auth + IP allowlist, simply remove `@csrf_exempt` and require the caller to send the CSRF header like every other session-auth endpoint.

---

### F-03 — `force_password_reset` emits a successful audit row even when the reset email fails (MEDIUM)

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:283-299`

```python
@transaction.atomic
def force_password_reset(*, user, requested_by, reason="", request=None):
    try:
        from apps.accounts.services.password_reset import request_password_reset
        request_password_reset(user.email, request=request)
    except Exception:
        logger.exception("force_password_reset: underlying service failed")
    # audit row emitted regardless of whether the reset actually fired
    emit_audit(
        ...
        event_type="force_password_reset_issued",
        ...
    )
```

**Why it matters:** If `request_password_reset` raises (SMTP down, misconfigured token backend, etc.), the exception is swallowed and an `emit_audit` row is written stating that a password reset was "issued." This is false. The super-admin and any future compliance review will believe the reset was sent when it was not. In an incident scenario (account takeover), a super-admin relying on this audit trail to confirm a forced reset occurred would be misled.

**Recommendation:** Track whether the underlying call succeeded and include that in the audit payload:
```python
sent = False
try:
    request_password_reset(user.email, request=request)
    sent = True
except Exception:
    logger.exception("force_password_reset: underlying service failed")
emit_audit(..., payload_after={"sent": sent}, ...)
```
Or, if the contract is "record intent not delivery," rename the event_type to `force_password_reset_requested` and document the distinction.

---

### F-04 — `impersonate_stop` assigns a random `uuid4()` as `target_id` when no impersonation was active (MEDIUM)

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:375-383`

```python
emit_audit(
    ...
    target_id=target_id or (actor.id if actor and getattr(actor, "is_authenticated", False) else uuid.uuid4()),
    impersonating_user_id=target_id,
    ...
)
```

**Why it matters:** If `impersonate_stop` is called when no impersonation session was active (e.g., stale double-click or a forged POST), `target` is `None`, so `target_id` resolves to `None`, then falls through to `actor.id` (if authenticated) or `uuid.uuid4()` (if unauthenticated). The unauthenticated branch is unreachable in practice (superadmin_required gates the view), but if somehow called directly, the audit row gets a random UUID as `target_id`, which is meaningless and corrupts the audit trail. Even the authenticated-but-no-active-impersonation branch emits an `impersonation_stopped` event pointing at the actor's own `id` as the target — which is factually wrong.

**Recommendation:** Guard the audit emission: if there was no active impersonation session, log a warning and do not emit an audit row (or emit with `event_type="impersonation_stop_noop"`):
```python
if target is None:
    logger.warning("impersonate_stop called with no active impersonation session")
    return
```

---

### F-05 — `users_list` default queryset includes soft-deleted users without filtering (MEDIUM)

**File:** `backend/apps/sadmin/views/users.py:22`

```python
qs = User.objects.all().order_by("-date_joined")
```

**Why it matters:** Without a status filter the query returns ALL users, including those with `deleted_at` set. A soft-deleted user appears alongside active users in the default listing, which is misleading. The three status-filtered branches (`active`, `inactive`, `deleted`) each correctly apply `deleted_at__isnull` predicates, but the unfiltered view mixes states silently. An SA running the list without filtering will see deleted users as if they were normal accounts.

**Recommendation:** Add `deleted_at__isnull=True` as a default (or add a visible indicator in the template for deleted users). Alternatively, default to `status_filter="active"` pre-applied and let the SA explicitly choose "All" or "Deleted".

---

### F-06 — TOCTOU race in `FeedbackSubmitView`: `existed_before` check and actual write are not atomic (LOW)

**File:** `backend/apps/sadmin/views/feedback.py:174-202`

```python
existed_before = False
if event_id is not None:
    existed_before = Feedback.objects.filter(
        pk__in=AuditEvent.objects.filter(
            idempotency_key=event_id,
            event_type="feedback_submitted",
        ).values("target_id")
    ).exists()

fb = submit_feedback(...)  # service performs its own idempotency check

return Response(
    {"id": str(fb.id)},
    status=status.HTTP_200_OK if existed_before else status.HTTP_201_CREATED,
)
```

**Why it matters:** Between the `existed_before` check and the `submit_feedback` call, a concurrent request with the same `event_id` could have inserted the row. In that case `existed_before=False` but `submit_feedback` returns the existing row. The response will have HTTP 201 (Created) but no new row was created — the wrong status code is returned. The idempotency invariant (PRD §3: replay→200) is violated on this race path. The race is narrow (milliseconds) but real under load.

**Recommendation:** Remove the pre-check entirely. Let `submit_feedback` perform the authoritative check. The service returns either a new row or the existing one; the caller can detect "new vs existing" by whether the audit row pre-existed:
```python
existed_before = event_id is not None and AuditEvent.objects.filter(
    idempotency_key=event_id, event_type="feedback_submitted"
).exists()
# Call service, then emit status based on existed_before
```
Or, wrap both the check and the insert in a `select_for_update` / serializable transaction.

---

### F-07 — `_bump_rate_counter` can reset to 1 under cache-race, defeating the B.21 alarm (LOW)

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:42-49`

```python
def _bump_rate_counter(key: str, window_seconds: int = 3600) -> int:
    try:
        cache.add(key, 0, window_seconds)
        return int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, window_seconds)
        return 1
```

**Why it matters:** On most Django cache backends, `cache.incr` raises `ValueError` when the key is absent. `cache.add` initialises only if absent, so if two concurrent requests both hit `cache.add` simultaneously, only one wins; the other finds the key already there. But if a third party expires the key between `add` and `incr` (TTL jitter, Redis eviction under memory pressure), `incr` raises `ValueError` and the fallback calls `cache.set(key, 1, ...)` — resetting the counter to 1. Under sustained concurrent load this can reset the counter repeatedly, keeping it permanently below the alarm threshold (20 or 50). The alarm never fires.

**Recommendation:** Use `cache.get_or_set` + atomic backend operations, or switch to a Redis `INCR` with `EXPIRE` using a pipeline. Alternatively, accept this as a best-effort alarm with a known failure mode (document it).

---

### F-08 — `triage_feedback` sets `triaged_by` and `triaged_at` even for non-triage status transitions (INFO)

**File:** `backend/apps/sadmin/services/feedback.py:119-135`

```python
feedback.triaged_by = triaged_by
feedback.triaged_at = timezone.now()
if status == FeedbackStatus.RESOLVED:
    feedback.resolved_at = timezone.now()
```

**Why it matters:** If an SA marks feedback as `wontfix`, `triaged_by` and `triaged_at` are set (correct), but `resolved_at` is left `None`. This creates an ambiguous state: the feedback is "closed" (won't be fixed) but has no `resolved_at` timestamp. Any dashboard query filtering on `resolved_at__isnull=False` for "closed" items will miss WONTFIX entries. Not currently causing user-visible bugs (no such query exists in Phase 1A), but it's a latent schema inconsistency.

**Recommendation:** Set `resolved_at` for both `RESOLVED` and `WONTFIX` status transitions:
```python
if status in (FeedbackStatus.RESOLVED, FeedbackStatus.WONTFIX):
    feedback.resolved_at = timezone.now()
```

---

### F-09 — `suspend_user` audit does not include `organization_id` even when user has org memberships (INFO)

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:187-198`

```python
emit_audit(
    actor_user=suspended_by,
    actor_role=ActorRole.SUPER_ADMIN,
    event_type="user_suspended",
    target_type="user",
    target_id=user.id,
    payload_before=before,
    payload_after={"is_active": False},
    reason=reason,
    ...
    # organization_id not set
)
```

**Why it matters:** For Phase 1A this is acceptable — user verbs are platform-wide, not org-scoped. However, once Phase 1B lands (tournaments), audit queries filtered by `organization_id` will not surface cross-org user suspensions even if the suspended user was a member of multiple orgs. This is a data-quality gap, not currently a bug.

**Recommendation:** Accepted for Phase 1A. Revisit when the audit query layer gains org-scoped views.

---

## Gaps (forward-looking, not current bugs)

| # | Area | Gap | Needed for | Effort |
|---|------|-----|-----------|--------|
| G-01 | `superadmin_verbs.bulk_email` | `bulk_email_api` does NOT use `BulkEmailRequestSerializer` — it manually parses the JSON body and validates `subject` only. The `body` field is not validated for min_length. The serializer exists but is unused. If the body field is empty, the verb silently passes an empty string. | correctness + DRF schema consistency | S |
| G-02 | `_delete_sessions_for_user` | The function loads ALL sessions from the DB via iterator and decodes each one in Python. On a multi-node deployment with Redis session backend this will miss sessions stored in Redis. For Phase 1A (DB session backend only) this is fine but must be revisited when session backend changes. | Phase 1B deployment hardening | M |
| G-03 | `FeedbackSubmitView` | `permission_classes = [IsAuthenticated]` — anonymous users cannot submit feedback despite the model explicitly supporting `submitted_by=None` for anonymous viewers (§1.12, §9.6). The service layer supports anonymous, but the API view rejects them. | anonymous viewer feedback (Phase 1B public viewer) | S |
| G-04 | `sadmin_login` `?next=` | After the open-redirect fix (F-01), also add a test asserting that an external-host `next=` is rejected. No test exists today. | security regression prevention | S |
| G-05 | `views/superadmin.py` CSRF | No test asserts that `@csrf_exempt` works (or fails). Adding a test that posts without a CSRF token and verifies the response will catch the decorator-order bug (F-02) and prevent it from silently re-emerging. | regression prevention | S |
| G-06 | `compute_metrics_live` | `seven_days_ago` is computed twice in separate try blocks (lines 77 and 122). If the clock advances between the two calls (unlikely but not impossible in a long-running process), the two windows are slightly inconsistent. Extract to one assignment at top of function. | code quality | XS |
| G-07 | Rate-counter / B.21 alarm | No integration test covers the case where the rate counter is reset by a cache race (F-07). The existing test only proves the alarm fires under the happy path. | correctness confidence | M |
