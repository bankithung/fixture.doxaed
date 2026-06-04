# Audit: sadmin — Tenant Isolation (Invariant #2)

**Date:** 2026-06-04  
**Scope:** `backend/apps/sadmin/` — all views, services, models, serializers, middleware, tests.  
**Lens:** Can Org A data be reached by Org B users (or org-scoped users generally)?  
**Methodology:** Read every file; trace every queryset, object lookup, serializer FK, and filter.

---

## Context: Sadmin is intentionally cross-org

The sadmin console is a **Super-admin-only** surface. By design, a Super-admin can see all orgs, all users, all audit events, and all feedback — because that is their job. Therefore "cross-org reach" is **intended and correct** for Super-admins. The isolation question here is:

1. Can a **non-Super-admin user** (ordinary org member) reach sadmin data?
2. Is the Super-admin gate correctly implemented everywhere?
3. Are there secondary surfaces (e.g. the public `/api/feedback/submit/` endpoint) that inadvertently expose cross-org data to ordinary users?
4. Is there a mechanism that could let a non-SA user elevate into a sadmin session?

---

## Findings

### F-01 — `@csrf_exempt` on three POST API endpoints (HIGH)

**File:** `backend/apps/sadmin/views/superadmin.py:47`, `superadmin.py:97`  
**Evidence:**
```python
@superadmin_required
@require_POST
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:
```
and identically:
```python
@superadmin_required
@require_POST
@csrf_exempt
def archive_feedback_api(request: HttpRequest, feedback_id: uuid.UUID) -> HttpResponse:
```

**Why it matters:** The `@superadmin_required` decorator prevents non-SA users from reaching these views, so ordinary org members cannot directly exploit this. However, `@csrf_exempt` means that if an attacker can induce a logged-in SA to visit a malicious page (CSRF attack), they can execute `bulk_email_api` (drafts a bulk-email audit row) and `archive_feedback_api` (irreversibly archives feedback) without a CSRF token. This is a direct CSRF vector against the sadmin surface, even though it is not a cross-org data leak per se. The sadmin surface holds elevated power (force logout, impersonation, org suspension); protecting its POST endpoints with CSRF is mandatory. The comment in the code implies `@csrf_exempt` was added to support JSON `Content-Type: application/json` clients, but Django's CSRF middleware does not block JSON body requests when the CSRF cookie+header is sent — the exemption is unnecessary.

**Recommendation:** Remove `@csrf_exempt` from all three decorated views (`bulk_email_api`, `archive_feedback_api`). Update the HTMX/JS callers to send the CSRF token in the `X-CSRFToken` header (project convention in CLAUDE.md invariant #15). Add a test asserting a POST to these endpoints without a CSRF token returns 403.

**Confidence:** High.

---

### F-02 — `bulk_email` `target_filter` accepts arbitrary ORM kwargs — QuerySet injection (MEDIUM)

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:410–411`  
**Evidence:**
```python
qs = User.objects.filter(deleted_at__isnull=True, is_active=True)
if target_filter:
    for k, v in target_filter.items():
        qs = qs.filter(**{k: v})
```
The caller (`bulk_email_api`) reads `target_filter` directly from the JSON request body:
```python
target_filter = body.get("target_filter") or {}
```

**Why it matters:** An authenticated Super-admin can supply any arbitrary ORM lookup expression as a key (e.g. `{"org_memberships__organization__name__icontains": "Acme"}`), including cross-table traversals, related-model field access, time-based blind inference attacks, and even DoS via expensive lookups. In Phase 1B when `User` gains FK relations to `Tournament` and `Match`, this surface expands significantly. This is not a cross-org leak in Phase 1A (SA already sees all data), but it becomes a data-exfiltration oracle and a DoS vector in Phase 1B where the count response leaks existence of related objects.

**Recommendation:** Replace the open `filter(**{k: v})` loop with an explicit allowlist of permitted filter keys (e.g. `is_active`, `date_joined__gte`, `org_memberships__organization_id`). Validate keys against the allowlist before applying. Reject unknown keys with a 400 response. Add a test asserting unknown filter keys are rejected.

**Confidence:** High.

---

### F-03 — Open redirect in `sadmin_login` via unchecked `next` parameter (MEDIUM)

**File:** `backend/apps/sadmin/views/auth.py:51–52`  
**Evidence:**
```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```
The `next` param is read verbatim from `GET` query string and fed directly to `HttpResponseRedirect` without URL validation.

**Why it matters:** An attacker can craft `https://sadmin.fixture.doxaed.com/sadmin/login/?next=https://evil.com` and send it to an SA. After successful login, the SA is redirected to the attacker's site. This is a classic phishing vector for credential harvesting against the most privileged account in the system. It is not an org-isolation leak directly, but an account-takeover vector that can lead to full cross-org compromise via impersonation.

**Recommendation:** Validate `next` with Django's `url_has_allowed_host_and_scheme` (from `django.utils.http`) before using it. Fall back to `sadmin:dashboard` if the value fails validation. This is the standard Django pattern also used by `django.contrib.auth.views.LoginView`. Add a test asserting external URLs in `next` are rejected.

**Confidence:** High.

---

### F-04 — `audit_search` exposes ALL audit events across ALL orgs to the Super-admin without org filter enforcement — no isolation test exists (LOW/INFO for sadmin design; GAP for test coverage)

**File:** `backend/apps/sadmin/views/audit.py:18`  
**Evidence:**
```python
qs = AuditEvent.objects.select_related("actor_user").order_by("-created_at")
```
The `org_raw` filter is optional and caller-supplied:
```python
if org_raw:
    try:
        qs = qs.filter(organization_id=uuid.UUID(org_raw))
    except (ValueError, TypeError):
        pass
```

**Why it matters:** This is **intentional** for the Super-admin (see context above). However, there is NO test asserting that a non-SA user cannot reach `audit_search` — the existing access-control tests (`test_access_control.py`) only cover `sadmin:dashboard`. The decorator is present, but the test coverage gap means a regression (e.g. someone accidentally removing `@superadmin_required`) would not be caught by CI.

**Recommendation:** Add parametrized access-control tests for ALL sadmin URL names (not just `dashboard`): `orgs_list`, `orgs_detail`, `org_verb`, `users_list`, `users_detail`, `user_verb`, `audit_search`, `feedback_list`, `feedback_triage`, `api_bulk_email`, `api_system_health`, `api_archive_feedback`. Assert each returns 404 for a regular authenticated user and 302 for anonymous. A single parametrized test covering all names is 15 lines.

**Confidence:** High (gap is real; the design intent is correct but untested at URL level).

---

### F-05 — `Feedback` model has no `organization` FK — feedback submitted from Org A is visible to Org B's admin if they gain SA access (INFO)

**File:** `backend/apps/sadmin/models.py:42–97`  
**Evidence:**
```python
class Feedback(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    submitted_by = models.ForeignKey(settings.AUTH_USER_MODEL, ...)
    category = ...
    subject = ...
    body = ...
```
No `organization` FK exists. The `FeedbackSubmitView` (`POST /api/feedback/submit/`) is accessible to any authenticated user from any org and writes a `Feedback` row with only `submitted_by` set.

**Why it matters:** All feedback from all orgs lives in one pool, visible to the Super-admin. This is by design for the SA console. However, if Phase 1B introduces org-scoped admin roles that need access to their own org's feedback (e.g. org-level support dashboards), the model will need retrofitting. More acutely: the `feedback_list` view does not filter by org, so the SA sees feedback from all orgs without any partitioning UI (which is the correct design, but the missing org FK makes org-scoped queries impossible in future without a migration). No isolation concern in Phase 1A because feedback is SA-only.

**Recommendation:** This is a forward-looking structural note. If org-scoped access to feedback is ever needed in Phase 1B, add `organization = models.ForeignKey(Organization, null=True, on_delete=SET_NULL)` and populate it at submit time. No immediate action required for Phase 1A isolation. Document the intentional design choice in `models.py`.

**Confidence:** High (design observation, not a bug).

---

### F-06 — `UsageEvent.organization_id` is a bare `UUIDField`, not an FK — no referential integrity or org-scoped filtering (LOW)

**File:** `backend/apps/sadmin/models.py:117`  
**Evidence:**
```python
organization_id = models.UUIDField(null=True, blank=True, db_index=True)
```
This is a bare UUID, not `ForeignKey(Organization)`.

**Why it matters:** The `UsageEvent` table is already append-only telemetry; deleting a `UsageEvent` when an org is deleted is probably undesirable (you want historical analytics). The bare UUID is intentional for loose coupling. However, the `dashboard` view renders `UsageEvent.objects.order_by("-created_at")[:5]` without any org filter — meaning the SA sees usage events from all orgs co-mingled in the dashboard recent activity panel. That is correct. The issue is that `organization_id` accepts any UUID and there is no DB-level check that the UUID actually references an `Organization` row — a stale/invalid UUID silently produces a dangling reference. This is not an isolation bug but a data-integrity concern for future analytics queries.

**Recommendation:** Add a comment explaining the intentional loose-FK design (analytics survives org deletion). Consider adding a Postgres partial index or a periodic reconciliation cron to detect dangling `organization_id` values in Phase 1B.

**Confidence:** Medium (structural observation).

---

### F-07 — `impersonate_start` does not prevent impersonating another Super-admin (MEDIUM)

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:332–358`  
**Evidence:**
```python
def impersonate_start(*, target_user, requested_by, reason: str = "", request: HttpRequest | None = None):
    if request is not None:
        request.session["impersonating_user_id"] = str(target_user.id)
        ...
    emit_audit(...)
    return target_user
```
No guard checks whether `target_user.is_superuser` is `True`. A Super-admin can start an impersonation session as another Super-admin.

**Why it matters:** From an isolation perspective, impersonation of a Super-admin effectively grants the attacker a second SA session with its own audit trail under the target's identity, which could be used to cover tracks or to perform actions that appear to originate from a different SA. The spec (v1Users.md B.19) does not explicitly prohibit SA-on-SA impersonation, but it is a security best-practice gap.

**Recommendation:** Add a guard in `impersonate_start`: if `target_user.is_superuser` is `True`, raise `ValueError("Cannot impersonate a Super-admin.")`. Add a test asserting the guard fires. Update the `user_verb` view to surface this as a 400-class error via `render_verb_result`.

**Confidence:** High (technical finding; policy call for product owner to confirm).

---

### F-08 — `sadmin_login` `next` redirect is also produced by `superadmin_required` decorator with raw `request.path` — decorator-generated redirect is safe, but no URL sanitization exists (INFO)

**File:** `backend/apps/sadmin/decorators.py:33`  
**Evidence:**
```python
return HttpResponseRedirect(f"{login_url}?next={request.path}")
```
`request.path` is always a path (never includes scheme/host), so the decorator-side redirect is safe. The vulnerability is only in the login view consuming the `?next` param (F-03 above). Noted here for completeness.

**Confidence:** High (decorator side is safe; login-view consumption is the bug).

---

## Summary table

| ID | Severity | Area | Description |
|----|----------|------|-------------|
| F-01 | HIGH | CSRF | `@csrf_exempt` on `bulk_email_api` and `archive_feedback_api` |
| F-02 | MEDIUM | ORM injection | `target_filter` arbitrary ORM kwargs in `bulk_email` service |
| F-03 | MEDIUM | Open redirect | `next` param in `sadmin_login` not validated against same-host |
| F-04 | LOW | Test gap | URL-level access-control tests only cover `dashboard`, not all 13 routes |
| F-05 | INFO | Structure | `Feedback` has no org FK; forward-compatibility concern for Phase 1B |
| F-06 | INFO | Integrity | `UsageEvent.organization_id` is bare UUID, no referential integrity |
| F-07 | MEDIUM | Impersonation | `impersonate_start` does not block SA-on-SA impersonation |
| F-08 | INFO | Redirect | Decorator `next` append uses `request.path` (safe); logged for completeness |

---

## Gaps (missing tests / coverage)

### G-01 — No parametrized URL-level access-control test for all 13 sadmin routes

**Current state:** `test_access_control.py` only tests `sadmin:dashboard` for anonymous→302 and regular-user→404.  
**Missing:** Tests for `orgs_list`, `orgs_detail`, `org_verb`, `users_list`, `users_detail`, `user_verb`, `impersonate_stop`, `feedback_list`, `feedback_triage`, `audit_search`, `api_bulk_email`, `api_system_health`, `api_archive_feedback`.  
**Needed for:** CI regression protection (a decorator accidentally removed would not be caught).  
**Effort:** S (one parametrized `pytest.mark.parametrize` block, ~20 lines).  
**Blocking:** No, but should be added before Phase 1B landing.

### G-02 — No test for open redirect in `sadmin_login` `next` parameter (F-03)

**Current state:** No test.  
**Missing:** Test asserting `?next=https://evil.com` is rejected and redirected to dashboard instead.  
**Effort:** S (2 test cases).

### G-03 — No test for `@csrf_exempt` regression on API endpoints (F-01)

**Current state:** `test_superadmin_api_verbs.py` does not test CSRF enforcement.  
**Missing:** Test asserting POST without CSRF token returns 403 (once `@csrf_exempt` is removed).  
**Effort:** S (2 test cases, one per endpoint).

### G-04 — No test for `impersonate_start` blocking SA-on-SA impersonation (F-07)

**Current state:** No test.  
**Missing:** Test asserting impersonating a Super-admin raises `ValueError` or returns an error response.  
**Effort:** S (1 unit test + 1 view test).

### G-05 — No test for `bulk_email` rejecting unknown `target_filter` keys (F-02)

**Current state:** `test_superadmin_verbs.py` tests the happy path with `{}` only.  
**Missing:** Test asserting a malicious/unknown filter key returns 400.  
**Effort:** S (2 test cases once the allowlist is implemented).

---

## Verdict: sadmin isolation is STRUCTURALLY CORRECT for Phase 1A

The core isolation property — only `is_superuser=True` users can reach the sadmin surface — is correctly implemented:

- `@superadmin_required` is applied to every view (verified by reading all view files).
- The decorator checks `is_superuser AND is_active AND deleted_at IS NULL`.
- The middleware adds an IP-allowlist layer on top.
- The `FeedbackSubmitView` (the one public sadmin-adjacent endpoint) is gated by `IsAuthenticated` only, which is correct: any logged-in user may submit feedback, but only the SA reads it.

No ordinary org member can reach Org B data through sadmin in Phase 1A. The five findings above are either security hygiene issues (CSRF, open redirect, ORM injection allowlist) or Phase 1B forward-compatibility notes, not Phase 1A isolation failures.
