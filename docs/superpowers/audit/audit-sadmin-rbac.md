# Sadmin RBAC Audit — fixture.doxaed.com

**Audit date:** 2026-06-04
**Scope:** `backend/apps/sadmin` — all views, decorators, middleware, services, URL routing, and tests.
**Lens:** Are every mutating and sensitive-read endpoint gated server-side by role/module (not just SPA UI hiding)? Are the `effective_modules` resolver, per-user grants, owner-only verbs, invite tree, `single_org_per_admin_user`, default-deny, and password-reprompt in place?

---

## Summary

The sadmin console is **substantially well-protected** at the view layer. Every named view (dashboard, orgs, users, feedback triage, audit log, and the three JSON API verbs) carries the `@superadmin_required` decorator, which is the correct gate: anonymous → 302 to login, authenticated-but-not-SA → 404. The IP allowlist middleware adds a defence-in-depth layer. The decorator also checks `is_active` and `deleted_at`. Audit rows are emitted for every mutating verb.

However, **three real bugs** and **several missing protections / gaps** were found.

---

## Findings

### FINDING-1 — CRITICAL: `@csrf_exempt` on two mutating JSON API views

**File:** `backend/apps/sadmin/views/superadmin.py`, lines 47 and 97

**Quoted evidence:**
```python
# line 45-48
@superadmin_required
@require_POST
@csrf_exempt            # ← strips the only CSRF defence for POST
def bulk_email_api(request: HttpRequest) -> HttpResponse:
```
```python
# line 95-99
@superadmin_required
@require_POST
@csrf_exempt            # ← same
def archive_feedback_api(request: HttpRequest, feedback_id: uuid.UUID) -> HttpResponse:
```

**Why it matters:** Both endpoints are mutating POSTs (bulk-email drafts an audit row and queries recipient counts; archive mutates a Feedback row). With CSRF exempt, any page on the internet that tricks an authenticated super-admin's browser into a cross-origin POST will execute those mutations. Django's session cookie is SameSite=Lax (base.py:146), which blocks top-level navigation-initiated POSTs from other origins, but `fetch(url, {method:'POST'})` from a same-site framed page or subresource can still bypass Lax in many browsers. The risk is highest for `bulk_email_api`, which reads `target_filter` from the body — an attacker who can craft a valid JSON body and trick the SA can enumerate user counts.

**Recommendation:** Remove both `@csrf_exempt` decorators. The HTMX base template (line 14-18 of `_base.html`) already injects `X-CSRFToken` on every HTMX request, so form-submitted calls work correctly. For direct JavaScript `fetch` calls, read the CSRF token from the meta tag that the base template already emits (`<meta name="csrf-token" …>`). No `@csrf_exempt` is needed here.

---

### FINDING-2 — HIGH: Open redirect in sadmin login `?next=` parameter

**File:** `backend/apps/sadmin/views/auth.py`, lines 51-52

**Quoted evidence:**
```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```

**Why it matters:** `next_url` is taken verbatim from the query string. An attacker who sends a super-admin a link like `https://fixture.doxaed.com/sadmin/login/?next=https://evil.com/steal` will redirect the SA to the attacker's site after a successful login. This is a standard phishing vector for privilege-escalation flows. Django's `url_has_allowed_host_and_scheme` utility exists for exactly this case and is not used.

**Recommendation:** Wrap with Django's safe-URL check:
```python
from django.utils.http import url_has_allowed_host_and_scheme
raw_next = request.GET.get("next") or ""
next_url = raw_next if url_has_allowed_host_and_scheme(
    raw_next, allowed_hosts={request.get_host()}, require_https=not settings.DEBUG
) else reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```

---

### FINDING-3 — HIGH: Reason length for destructive verbs not enforced server-side

**File:** `backend/apps/sadmin/services/superadmin_verbs.py`, line 96 (comment); `backend/apps/sadmin/views/orgs.py`, lines 63-74; `backend/apps/sadmin/views/users.py`, lines 75-108

**Quoted evidence (service comment):**
```python
"""Suspend an Org. Reason ≥20 chars per §1.6 (enforced at view layer)."""
```

**Quoted evidence (view — no enforcement present):**
```python
reason = (request.POST.get("reason") or "").strip()
# ... passed directly to superadmin_verbs.suspend_org(..., reason=reason, ...)
```

**Why it matters:** The spec (§1.6) requires a minimum-length reason for destructive verbs (`suspend_org`, `reject_org`, `suspend_user`, `force_logout_all`, `force_password_reset`). The comment says this is "enforced at view layer" but neither `orgs.py` nor `users.py` contains any `len(reason)` check. A super-admin can submit an empty reason string and the action succeeds, audit row carries an empty reason, and there is no after-the-fact way to reconstruct *why* the action was taken. This undermines the mandatory audit trail.

**Recommendation:** Add a server-side check in both `org_verb` and `user_verb` for destructive verbs before calling the service. Example for `org_verb`:
```python
REASON_REQUIRED_VERBS = {"reject", "suspend"}
REASON_MIN_LEN = 20
if verb in REASON_REQUIRED_VERBS and len(reason) < REASON_MIN_LEN:
    return render_verb_result(request, ok=False,
        message=f"Reason must be at least {REASON_MIN_LEN} characters.")
```

---

### FINDING-4 — MEDIUM: `sadmin_logout` is a `@require_POST` view but no CSRF enforcement explicitly verified for non-HTMX callers

**File:** `backend/apps/sadmin/views/auth.py`, lines 57-70

**Quoted evidence:**
```python
@require_POST
def sadmin_logout(request: HttpRequest) -> HttpResponse:
```

**Why it matters:** Django's `CsrfViewMiddleware` (present in `base.py:65`) does gate POST requests globally. The logout view correctly uses `@require_POST`. The base template sends the CSRF token via the form (`{% csrf_token %}`). This works for HTMX/form posts. However, the logout view does NOT carry `@superadmin_required`, meaning it is callable by any authenticated user — including regular users. A regular user POSTing to `/sadmin/logout/` will be logged out (Django's `django_logout` destroys their session). This is a low-impact CSRF-log-out attack on regular users if they are tricked into POSTing to this URL, but it also confirms the surface is discoverable to regular users by response code (200 vs 404).

**Recommendation:** Add `@superadmin_required` to `sadmin_logout` so regular users get 404 rather than a successful session destruction. The SA bootstrap case (unauthenticated hitting logout) is a no-op anyway since `user.is_authenticated` is already checked before emitting audit.

---

### FINDING-5 — MEDIUM: No password-reprompt for highest-impact verbs (impersonate, suspend, force_logout_all)

**File:** `backend/apps/sadmin/views/users.py`, lines 70-116; `backend/apps/sadmin/services/superadmin_verbs.py`, lines 332-358

**Why it matters:** v1Users.md §1.5/§1.8 talks about the surface-hiding invariant, but a separate security best-practice for privileged operations is a password-reprompt (confirm-your-password) gate before taking the highest-impact SA actions: `impersonate_start`, `suspend_user`, `force_logout_all`. Without it, an unattended SA browser session or an XSS payload that successfully bypasses the CSRF gate can immediately take those actions without friction. No evidence of a reprompt mechanism exists anywhere in the codebase.

**Recommendation:** For Phase 1B hardening, add a `POST /sadmin/verify-password/` endpoint (POST-only, CSRF-protected, rate-limited, session-keyed token with a 5-minute window) that the three highest-impact verbs require before execution. This is a gap item rather than a blocking bug for Phase 1A.

---

### FINDING-6 — MEDIUM: Access-control test suite covers only `dashboard`; no tests for the orgs/users/feedback/audit routes against non-SA users

**File:** `backend/apps/sadmin/tests/test_access_control.py`

**Quoted evidence:**
```python
# All four tests use sadmin:dashboard only; no tests for:
# sadmin:orgs_list, sadmin:orgs_detail, sadmin:org_verb
# sadmin:users_list, sadmin:users_detail, sadmin:user_verb
# sadmin:feedback_list, sadmin:feedback_triage, sadmin:audit_search
# sadmin:impersonate_stop
```

**Why it matters:** If a decorator is accidentally dropped from a view in a future edit, only the dashboard check would catch it. The remaining 10 routes are untested for the `@superadmin_required` gate. The `test_superadmin_api_verbs.py` does test the three JSON API routes, but the HTML routes are uncovered.

**Recommendation:** Parametrize the access-control test across all route names (both GET and POST endpoints), asserting:
- Anonymous → 302
- Regular user → 404
- SA → 200/successful execution

---

### FINDING-7 — LOW: `impersonate_start` can target a super-admin account (no guard)

**File:** `backend/apps/sadmin/services/superadmin_verbs.py`, lines 332-358

**Quoted evidence:**
```python
def impersonate_start(*, target_user, requested_by, reason: str = "", ...):
    if request is not None:
        request.session["impersonating_user_id"] = str(target_user.id)
```

**Why it matters:** Nothing prevents the SA from starting impersonation of another super-admin. While this is audit-logged, impersonating a second SA and then taking SA-level actions through that session could produce ambiguous audit attribution. The impersonation mechanism does NOT change the request.user — it only stores a session key for the banner — so the actual privilege level in `request.user` remains the first SA. This is likely harmless in implementation but the spec does not explicitly permit SA-to-SA impersonation and the missing guard could cause audit confusion.

**Recommendation:** Add a guard in `impersonate_start` (or the view layer) to reject impersonation of `is_superuser=True` targets:
```python
if getattr(target_user, "is_superuser", False):
    raise ValueError("Cannot impersonate another Super-admin.")
```

---

### FINDING-8 — LOW: IP allowlist defaults to no restriction in all environments (including production if env var unset)

**File:** `backend/fixture/settings/base.py`, line 78

**Quoted evidence:**
```python
SADMIN_IP_ALLOWLIST = env.list("SADMIN_IP_ALLOWLIST", default=[])
```

**Why it matters:** The middleware correctly documents that empty list = no-op. But the default is open, meaning a production deployment that forgets to set `SADMIN_IP_ALLOWLIST` gets no IP-level protection. There is no assertion, startup warning, or `DEBUG=False` check that enforces a non-empty allowlist.

**Recommendation:** In production settings (or at Django startup), emit a `logger.warning("SADMIN_IP_ALLOWLIST is empty — /sadmin/ is accessible from any IP")` when `DEBUG=False` and the list is empty. Optionally block startup entirely via a system check.

---

## Gaps (forward-looking, not current bugs)

| # | Item | Why needed | Effort |
|---|------|------------|--------|
| G1 | Password-reprompt for `impersonate_start` / `suspend_user` / `force_logout_all` | Defense-in-depth for high-impact SA verbs against unattended sessions | M |
| G2 | Parametrized access-control test covering all 11 HTML sadmin routes | Regression safety net; one missing decorator = silent privilege bypass | S |
| G3 | Startup `system check` warning when `SADMIN_IP_ALLOWLIST` is empty in non-debug mode | Operational safety net | S |
| G4 | Reason-length enforcement unit test | Proves the server-side length check (once added) is exercised | S |
| G5 | Guard against SA-to-SA impersonation in `impersonate_start` | Audit attribution clarity | S |
| G6 | `module`-level check for sadmin surface not applicable here | The sadmin console is explicitly outside the 22-module RBAC catalog; only the `is_superuser` flag gates it. Phase 1B: confirm the feedback submit endpoint (`/api/feedback/submit/`) is listed against the `personal.feedback_widget` module in the module catalog and that `effective_modules()` gates it for non-member users. | M |
| G7 | No test for `sadmin_logout` being callable by non-SA users | The logout surface-hide bug (Finding-4) is untested | S |
