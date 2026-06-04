# Sadmin Test-Gap Audit

**Date:** 2026-06-04
**Scope:** `backend/apps/sadmin` — missing cross-org isolation tests, permission-denied/negative tests, state-machine + blocked-transition tests, idempotent-replay tests, and untested error paths.
**Method:** Read every source file and test file in the module. Findings cite file:line + quoted snippet.

---

## Summary

The sadmin test suite is partially healthy: access-control gate (404/302), impersonation banner, PII redaction, feedback submit/triage, rate-limit alarms, and KPI snapshot are covered. However, the following concrete gaps were found.

---

## Findings

### F-1 (HIGH) — No HTTP-layer tests for org view routes (`orgs_list`, `orgs_detail`, `org_verb`)

**File:** `backend/apps/sadmin/tests/` — no file covers any of these three URL names.

**Evidence:** Grepping all sadmin test files for `orgs_list`, `orgs_detail`, `org_verb`, `sadmin:orgs`, `sadmin:org_verb` returns zero matches. The routes exist at:

- `backend/apps/sadmin/urls.py:28–35` — `"orgs/"`, `"orgs/<uuid:org_id>/"`, `"orgs/<uuid:org_id>/<str:verb>/"`

**Why it matters:**
- `@superadmin_required` on all three views is never validated by an integration test. A decorator accident (wrong order with `@require_GET`) would silently break the surface-hide invariant.
- The `org_verb` view branches across four verbs (`approve`, `reject`, `suspend`, `unsuspend`) plus an `else` (unknown verb → error response). None of these code paths have HTTP-level coverage.
- The `orgs_list` search filter (`q`, `status`) and `orgs_detail` membership display are untested.

**Recommendation:** Add `test_org_views.py` covering: SA gets 200, non-SA gets 404, anonymous gets 302, each verb returns verb-result partial, unknown verb returns error partial.

---

### F-2 (HIGH) — No HTTP-layer tests for user view routes (`users_list`, `users_detail`, `user_verb`)

**File:** `backend/apps/sadmin/tests/` — no file covers `sadmin:users_list`, `sadmin:users_detail`.

**Evidence:** Grepping all sadmin test files for `users_list`, `users_detail`, `sadmin:users` returns zero matches. The only `user_verb` test is the impersonation test (`test_impersonation_banner.py:15`) — a single verb out of six.

**Routes at:** `backend/apps/sadmin/urls.py:37–43`

**Untested verbs at the HTTP layer:**
- `suspend` (`views/users.py:78`)
- `unsuspend` (`views/users.py:83`)
- `force_logout_all` (`views/users.py:88`)
- `force_password_reset` (`views/users.py:93`)
- `unlock_account` (`views/users.py:98`)

The `else` branch (unknown verb → `render_verb_result(ok=False)`) at `views/users.py:111` is also uncovered.

**Recommendation:** Add `test_user_views.py` covering: SA gets 200 for list/detail; non-SA gets 404; each verb dispatches correctly; unknown verb returns error partial; `users_detail` audit event panel renders without error.

---

### F-3 (HIGH) — Blocked-transition tests missing for all org state-machine verbs

**File:** `backend/apps/sadmin/tests/test_superadmin_verbs.py`

**Evidence:** Existing tests only verify the happy path:
- `test_sadmin_approve_calls_lifecycle_service` (line 128): starts from `PENDING_REVIEW` → passes.
- `test_sadmin_reject_calls_lifecycle_service` (line 151): starts from `PENDING_REVIEW` → passes.

There are no tests for blocked transitions. The lifecycle service raises `ValidationError` for:
- `approve_org` called on a non-`PENDING_REVIEW` org (`lifecycle.py:91`): `"Cannot approve org in status {org.status}"`
- `reject_org` called on a non-`PENDING_REVIEW` org (`lifecycle.py:121`): `"Cannot reject org in status {org.status}"`
- `reject_org` with a reason shorter than 8 chars (`lifecycle.py:122`): `"Reason required (>= 8 chars)."`
- `unsuspend_org` called on a non-`SUSPENDED` org (`lifecycle.py:197`): `"Cannot unsuspend an org in status '{org.status}'."`
- `suspend_org` called on an `ARCHIVED` org (`lifecycle.py:161`)

The `org_verb` view (`views/orgs.py:81`) catches `Exception` and calls `render_verb_result(ok=False, message=str(exc))` — but no test verifies that the exception surface produces an error response rather than a 500.

**Recommendation:** Add parametrized blocked-transition tests at both the service layer (`test_superadmin_verbs.py`) and the view layer (via `org_verb` POST), asserting that the HTTP response carries `ok=False` and the audit row count does NOT increase.

---

### F-4 (HIGH) — No tests for sadmin login/logout auth flows

**File:** `backend/apps/sadmin/tests/` — no test file covers `sadmin:login` or `sadmin:logout`.

**Evidence:** Grepping all sadmin test files for `sadmin_login`, `sadmin_logout`, `sadmin:login` (as a tested URL, not as an assertion target in a redirect) returns zero test function bodies that exercise the login form. The `test_access_control.py:20` and `test_superadmin_api_verbs.py:64` merely assert that *redirects land on* the login URL — they do not POST credentials.

**Missing scenarios from `views/auth.py`:**
- Valid SA credentials → 302 to dashboard + `sadmin_login` audit row emitted + session cycled (`auth.py:41–51`).
- Invalid credentials (wrong password) → stays on login page with error (`auth.py:37–38`).
- Regular (non-SA) user credentials → same generic error, no 200 (`auth.py:37`).
- Soft-deleted super-admin (has `deleted_at`) trying to log in.
- Logout POST → session cleared + `sadmin_logout` audit emitted (`auth.py:58–70`).
- Logout by non-SA user (no audit row expected).
- Session fixation defense: `cycle_key()` called after login (`auth.py:41`).

**Recommendation:** Add `test_auth_views.py` covering all branches above. The `sadmin_login` audit row is a security audit trace and must be confirmed to emit.

---

### F-5 (MEDIUM) — No test for `impersonate_start` as anonymous or non-SA user

**File:** `backend/apps/sadmin/tests/test_impersonation_banner.py`

**Evidence:** `test_impersonate_start_sets_session_and_audits` (line 12) only tests the happy path (SA user). There is no test asserting:
- Anonymous user POSTing to `sadmin:user_verb` with verb `impersonate_start` → 302 to login (not a session injection).
- Non-SA user POSTing same → 404.

**Why it matters:** If `@superadmin_required` ordering were ever changed (e.g., moving `@require_POST` before `@superadmin_required`), an anonymous POST could slip through the method guard before auth is checked. The negative path is not tested.

**Recommendation:** Add two negative tests to `test_impersonation_banner.py`: one for anonymous, one for a regular user.

---

### F-6 (MEDIUM) — No test for `impersonate_stop` when no active impersonation session exists

**File:** `backend/apps/sadmin/tests/test_impersonation_banner.py`

**Evidence:** `test_impersonate_stop_clears_session` (line 40) only tests the case where a session key exists. The `impersonate_stop` verb (`services/superadmin_verbs.py:362–383`) pops `impersonating_user_id` (safe even if absent), then emits an audit row using `actor.id` as the fallback target when `target_id` is None (line 380). This path — where `impersonate_stop` is called with no active impersonation — is untested.

**Recommendation:** Add a test that POSTs to `sadmin:impersonate_stop` without a prior impersonation, verifies a redirect to dashboard, and confirms an audit row is emitted (with the SA's own ID as target, since `target` is `None`).

---

### F-7 (MEDIUM) — No test for `audit_search` view at the HTTP layer

**File:** `backend/apps/sadmin/tests/` — no file covers `sadmin:audit_search`.

**Evidence:** Grepping all sadmin test files for `audit_search`, `sadmin:audit` returns zero matches.

**Missing scenarios from `views/audit.py`:**
- SA GET → 200 with results (`audit.py:17`).
- Non-SA GET → 404.
- Anonymous GET → 302.
- Filter by `event_type` (line 25): `qs.filter(event_type__icontains=event_type)`.
- Filter by `actor` email (line 27).
- Filter by `org_raw` UUID (line 30): malformed UUID → gracefully ignored (`pass` at line 32) — this silent swallow is completely untested.

**Recommendation:** Add `test_audit_views.py` covering access control plus the malformed-UUID `org` filter path (line 32 — the `except (ValueError, TypeError): pass` branch is a silent swallow that should be explicitly verified to not 500).

---

### F-8 (MEDIUM) — No test for `dashboard_kpis` HTMX-refresh partial

**File:** `backend/apps/sadmin/tests/` — no test covers `sadmin:dashboard_kpis`.

**Evidence:** Grepping for `dashboard_kpis` in the test directory returns zero matches. The route exists at `urls.py:23` (`"kpis/"`) and is decorated with `@superadmin_required` (`dashboard.py:41`).

**Why it matters:** The `dashboard_kpis` view is the HTMX auto-refresh endpoint (every 30 s). If it regresses (e.g., `compute_metrics_live` raises), the dashboard silently shows stale data. No test asserts 200 for SA, 404 for non-SA, or that the partial template renders without error.

**Recommendation:** Add two tests to cover the endpoint: one as SA (200), one as regular user (404).

---

### F-9 (MEDIUM) — No test for `feedback_list` and `feedback_triage` HTML views at the HTTP layer

**File:** `backend/apps/sadmin/tests/` — no test covers `sadmin:feedback_list` or `sadmin:feedback_triage`.

**Evidence:** Grepping for these names in test files returns zero HTTP-layer test hits. The service-level `triage_feedback` is covered (`test_feedback_triage.py`), but the view-layer dispatch (including invalid status → `render_verb_result(ok=False)` at `views/feedback.py:97`) is not.

**Recommendation:** Add tests for: SA gets 200 for list; non-SA gets 404; POST to triage with valid status succeeds; POST with invalid status returns error partial.

---

### F-10 (MEDIUM) — No idempotent-replay test for sadmin org/user verbs

**File:** `backend/apps/sadmin/tests/test_superadmin_verbs.py`

**Evidence:** The sadmin org and user verbs (`approve_org`, `reject_org`, `suspend_org`, `unsuspend_org`, `suspend_user`, `force_logout_all`) do not accept an `event_id` parameter and have no idempotency mechanism. This is consistent with Invariant #3 which applies to "all writes" — but there is no test confirming that double-POSTing the same verb (e.g., `approve_org` twice) is handled gracefully via the blocked-transition check rather than a DB exception or 500.

**Specific untested scenario:** Posting `approve` to an already-`ACTIVE` org should produce an error partial, not a 500. The `org_verb` view at `views/orgs.py:81` catches generic `Exception`, but the test that verifies this path does not exist.

**Recommendation:** Add a "double-verb" test for each state-machine verb to confirm graceful error response (not 500) on repeated calls.

---

### F-11 (MEDIUM) — `suspend_user` self-suspension: SA suspending themselves is untested

**File:** `backend/apps/sadmin/services/superadmin_verbs.py` lines 166–199

**Evidence:** `suspend_user` does not guard against `user == suspended_by`. There is no business-logic check preventing a SA from suspending themselves. If a SA suspends themselves, they `is_active = False` + sessions deleted, which locks them out permanently with no recovery path except direct DB. The test suite never exercises this edge case.

**Recommendation:** Add a test asserting either: (a) the verb raises a `ValueError` when `user == suspended_by`, or (b) the current behavior (lockout) is documented and accepted. If (b), a comment in the code and a regression test are needed.

---

### F-12 (LOW) — Soft-deleted super-admin access gap: `deleted_at != None` check in decorator is on the wrong condition branch

**File:** `backend/apps/sadmin/decorators.py` lines 35–39

**Evidence:**
```python
if (
    not getattr(user, "is_superuser", False)
    or getattr(user, "is_active", True) is False
    or getattr(user, "deleted_at", None) is not None
):
    raise Http404
```

The `deleted_at` check is inside the same `if` block that raises `Http404` only when the user is NOT a superuser OR is inactive OR is deleted. The logic is correct, but only the `is_active = False` case is tested in `test_access_control.py:36`. The `deleted_at is not None` case (soft-deleted SA) is never tested.

**Recommendation:** Add a test to `test_access_control.py` that creates a SA with `deleted_at` set and asserts they receive 404 on any sadmin route.

---

### F-13 (LOW) — `_parse_json_body` malformed-JSON path is untested

**File:** `backend/apps/sadmin/views/superadmin.py` lines 35–42

**Evidence:**
```python
def _parse_json_body(request: HttpRequest) -> dict[str, Any]:
    raw = request.body or b"{}"
    try:
        parsed = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return {}
```

The `except` branch returns `{}`, causing the caller (`bulk_email_api`) to read empty strings for `subject` and `body`, triggering the 400 response at line 57. There is no test sending a malformed JSON body to `POST /sadmin/api/bulk-email/` and confirming 400 (not 500).

**Recommendation:** Add a test POSTing `b"not-json"` to `sadmin:api_bulk_email` as SA and assert 400.

---

### F-14 (LOW) — `bulk_email_api` missing-subject validation is untested

**File:** `backend/apps/sadmin/views/superadmin.py` lines 55–59

**Evidence:**
```python
subject = (body.get("subject") or "").strip()
if not subject:
    return JsonResponse({"detail": "subject is required"}, status=400)
```

The test `test_bulk_email_as_super_admin_returns_200` (`test_superadmin_api_verbs.py:27`) only sends a valid subject. No test verifies the 400 response when subject is absent or empty.

**Recommendation:** Add a test POSTing `{"body": "test"}` (no `subject`) to `sadmin:api_bulk_email` and asserting 400.

---

### F-15 (LOW) — `UsageEvent` model has zero test coverage

**File:** `backend/apps/sadmin/models.py` lines 105–134, `backend/apps/sadmin/services/usage.py`

**Evidence:** No test file in `backend/apps/sadmin/tests/` references `UsageEvent` or imports from `services.usage`. The model factory `UsageEventFactory` exists in `tests/factories.py:52` but is never used in any test.

**Recommendation:** At minimum, add a smoke test verifying that `UsageEvent` rows can be created and that the `organization_id` FK-less UUID field stores correctly. Check `services/usage.py` for any logic that needs covering.

---

## Gaps (Forward-Looking)

| Item | Missing | Blocking | Effort | Needed For |
|------|---------|----------|--------|------------|
| Cross-org isolation on `audit_search` | `audit_search` has no `organization_id` FK guard — a logged-in SA by definition sees all orgs, but once org-scoped sadmin roles land, an org-admin hitting `/sadmin/audit/?org=<other-org-id>` path would need isolation | No (SA is platform-level) | S | Phase 1B multi-admin model |
| `snapshot_kpi` management command test | `management/commands/snapshot_kpi.py` — no test calls `call_command("snapshot_kpi")` and asserts a row was upserted | No | S | Cron reliability |
| Impersonation time-limit enforcement | `impersonating_started_at` is stored in session (`superadmin_verbs.py:346`) but there is no test verifying it is enforced as a timeout or warning | No | M | B.19 expiry (Phase 1B) |
| SA login brute-force / lockout | No test verifies that repeated failed logins to `/sadmin/login/` are throttled or produce axes lockout | No | M | B.15 security |
| `bulk_email` actual SMTP send | Phase 1A only audits a draft; Phase 1B needs a test for the actual send path | No | L | Phase 1B |
