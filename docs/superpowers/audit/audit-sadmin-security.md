# Security Audit — apps/sadmin

**Scope:** `backend/apps/sadmin/` (all Python source, templates, migrations, tests).
**Lens:** Broken access control / IDOR, injection (raw SQL / ORM / command / template),
hardcoded secrets, weak crypto, auth/session flaws, CSRF gaps, DRF mass-assignment /
over-exposed fields (PII / hashes), SSRF, missing rate limits, 404-vs-403 info leak,
token entropy/hashing.
**Date:** 2026-06-04

---

## Findings

### F-01 — HIGH · CSRF exemption on two authenticated mutation endpoints

**File:** `backend/apps/sadmin/views/superadmin.py:47,97`

```python
@superadmin_required
@require_POST
@csrf_exempt           # <-- F-01
def bulk_email_api(request: HttpRequest) -> HttpResponse:
    ...

@superadmin_required
@require_POST
@csrf_exempt           # <-- F-01
def archive_feedback_api(request: HttpRequest, feedback_id: uuid.UUID) -> HttpResponse:
    ...
```

**Why it matters:** `@csrf_exempt` completely removes the CSRF check from these two
mutation endpoints. The `@superadmin_required` gate is a session-cookie gate, which
means a cross-origin attacker who can trick a logged-in super-admin into visiting a
malicious page can fire authenticated POST requests to `/sadmin/api/bulk-email/` and
`/sadmin/api/feedback/<uuid>:archive/` without supplying any CSRF token. This undoes
the CSRF protection that the `_base.html` template painstakingly wires up for all HTMX
forms. Both endpoints are destructive (bulk-email draft records an audit row; archive
mutates feedback status).

**Recommendation:** Remove both `@csrf_exempt` decorators. The HTMX front-end already
sends `X-CSRFToken` via the `htmx:configRequest` listener in `_base.html` for every
hx-post call. For the JSON API endpoints, the Django `CsrfViewMiddleware` is on the
stack; the session-cookie + CSRF-token-in-header pairing Django uses for DRF
(`SessionAuthentication`) enforces CSRF automatically when `csrf_exempt` is absent.
If a non-browser caller genuinely needs token-free access, it should use a separate
service credential, not a blanket exemption on a session-auth endpoint.

---

### F-02 — HIGH · Unvalidated open redirect on `?next=` after sadmin login

**File:** `backend/apps/sadmin/views/auth.py:51-52`

```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```

**Why it matters:** The value of `?next=` is taken verbatim from the query string and
used as the redirect target. An attacker can craft a URL like
`https://fixture.doxaed.com/sadmin/login/?next=https://evil.example.com` and if the
super-admin clicks it and signs in, the browser is redirected to the attacker's
domain. Because the sadmin login URL is intentionally public (the only public page
under `/sadmin/`), the link can be shared and looks legitimate. Note that the IP
allowlist (`SADMIN_IP_ALLOWLIST`) only helps if it is configured; it is empty by default.

**Recommendation:** Validate `next_url` before redirect. Use Django's built-in
`url_has_allowed_host_and_scheme(next_url, allowed_hosts=request.get_host())` guard:

```python
from django.utils.http import url_has_allowed_host_and_scheme
next_url = request.GET.get("next") or ""
if not url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()}):
    next_url = reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```

---

### F-03 — HIGH · Arbitrary ORM filter injection via `target_filter` in bulk-email

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:409-411`

```python
if target_filter:
    for k, v in target_filter.items():
        qs = qs.filter(**{k: v})   # <-- arbitrary ORM lookup
```

**Why it matters:** The `bulk_email` service accepts a free-form dict from the request
body (via `_parse_json_body` → no schema validation on keys) and feeds every key/value
directly into `qs.filter(**{k: v})`. A super-admin can supply any ORM field path
including traversals and lookups, e.g.:

```json
{"password__startswith": "$argon2id$"}
```

This allows timing-based inference of password hash prefixes, or accessing related
objects via traversal (`org_memberships__organization__name__contains`), effectively
bypassing the intended "filter by user attributes" scope. Because each added filter
returns a count, an adversary with super-admin access can binary-search the hash
prefix character-by-character.

The serializer (`BulkEmailRequestSerializer.target_filter`) uses
`serializers.DictField(child=serializers.CharField(...))` but is never actually invoked
on this path — the view uses `_parse_json_body` and passes the raw dict directly.

**Recommendation:**
1. Define an explicit allowlist of permitted filter keys (e.g., `{"is_active", "date_joined__gte", "date_joined__lte"}`).
2. Validate `target_filter` keys against the allowlist before passing to the ORM.
3. Never allow traversal into password or token fields.

---

### F-04 — MEDIUM · Unauthenticated IP spoofing via X-Forwarded-For for allowlist bypass

**File:** `backend/apps/sadmin/middleware.py:22`

```python
forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
return forwarded or request.META.get("REMOTE_ADDR") or None
```

**Why it matters:** The middleware unconditionally trusts the first entry in
`X-Forwarded-For` for IP allowlist decisions. Without configuring Django's
`SECURE_PROXY_SSL_HEADER` / `USE_X_FORWARDED_HOST` and setting the correct number of
trusted proxies (e.g., via `django-ipware` with `IPWARE_TRUSTED_PROXY_COUNT`), an
attacker sitting behind the real proxy can spoof the leftmost IP by injecting a fake
`X-Forwarded-For: 192.0.2.1, <real-client>` header, bypassing the allowlist and
reaching the (otherwise unauthenticated) login page. In environments where the VPS is
behind Caddy as the sole trusted reverse proxy, this is exploitable if no upstream
strips the header.

**Recommendation:** Replace the ad-hoc split with `django-ipware`'s
`get_client_ip(request)` configured with `IPWARE_TRUSTED_PROXY_COUNT = 1` (number of
known proxy hops), so client-injected `X-Forwarded-For` entries are discarded.
Alternatively, use Django's built-in `SECURE_PROXY_SSL_HEADER` and configure nginx/Caddy
to strip and re-write the header before forwarding.

---

### F-05 — MEDIUM · `_delete_sessions_for_user` scans entire session table in process memory

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:222-234`

```python
for session in Session.objects.iterator(chunk_size=500):
    try:
        data = session.get_decoded()
    except Exception:
        continue
    if str(data.get("_auth_user_id", "")) == target_id:
        session.delete()
        deleted += 1
```

**Why it matters:** This is not a security vulnerability in the classic sense but has
a direct security consequence: if the session table grows large (many users), the loop
runs for a long time in-band (inside the `@transaction.atomic`-wrapped `force_logout_all`
and `suspend_user` verbs). During that window the user's sessions still exist and can be
used for authentication. On a busy platform, a targeted user could complete sensitive
actions in the gap. Additionally, `session.delete()` inside a long-running atomic block
holds a row-level lock on each deleted session row, causing contention for concurrent
requests. This is also already flagged as a known scalability issue (Phase 1B will need
Redis-backed sessions), but the security implication — logout not being instantaneous —
deserves an explicit note.

**Recommendation:** Index sessions by `_auth_user_id` or use a custom session backend
that provides `Session.objects.filter(user_id=...)`. Short-term: run the loop outside
the atomic block (session deletion can be eventually consistent; the user's `is_active`
being set to `False` is the effective gate). Long-term: switch to Redis-backed sessions
(planned) which allow atomic key-based invalidation.

---

### F-06 — MEDIUM · Three CDN-loaded scripts with no Subresource Integrity (SRI)

**Files:**
- `backend/apps/sadmin/templates/sadmin/_base.html:9-11`
- `backend/apps/sadmin/templates/sadmin/login.html:7`

```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
```

**Why it matters:** The sadmin console is a high-privilege surface. A compromised or
BGP-hijacked CDN could serve malicious JavaScript to the authenticated super-admin,
enabling session token theft, XSS-triggered CSRF token exfiltration, or keylogging of
the sadmin forms. The template comment acknowledges this as a development shortcut:
`{# Tailwind via CDN for dev (B.21 hardening: swap for compiled CSS for prod). #}`.
However, there is no guard preventing these CDN tags from shipping to production.

**Recommendation:** Before going to production:
1. Bundle Tailwind CSS via the CLI (remove CDN tag entirely).
2. Self-host htmx and chart.js, or add `integrity="sha384-..."` + `crossorigin="anonymous"` SRI attributes.
3. Add a Content-Security-Policy header that restricts `script-src` to `'self'`.
A middleware or template tag that enforces SRI/CSP would prevent the pattern from
regressing.

---

### F-07 — MEDIUM · `impersonation_started_at` stored in the session but never enforced

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:346-347`

```python
request.session["impersonating_user_id"] = str(target_user.id)
request.session["impersonating_started_at"] = timezone.now().isoformat()
```

**Why it matters:** A timestamp is written to the session when impersonation begins
but is never read anywhere in the codebase. If the sadmin session is left open (30-day
cookie TTL), the impersonation has no expiry: `impersonate_stop` is the only
termination path, and it requires a deliberate UI action. An unattended logged-in
browser with an active impersonation session gives indefinite read access to the
impersonated user's context.

**Recommendation:** Read `impersonating_started_at` on every request (e.g., in
`_helpers.impersonation_context` or a new `SadminImpersonationTimeoutMiddleware`) and
auto-stop impersonation after a configurable TTL (e.g., 1 hour). Add a test that
verifies the auto-stop fires.

---

### F-08 — LOW · Reason field on suspension/rejection verbs has no minimum-length enforcement

**File:** `backend/apps/sadmin/views/users.py:75-95` and `orgs.py:63-74`

```python
reason = (request.POST.get("reason") or "").strip()
# ... passed directly to superadmin_verbs.suspend_user(... reason=reason ...)
```

**Why it matters:** The service-layer docstring says `"Reason ≥20 chars per §1.6
(enforced at view layer)"` (see `superadmin_verbs.py:96`). The view layer does not
enforce this constraint. An empty string is accepted, silently written to the audit
row, and creates a compliance gap — suspension audit rows without a reason are
meaningless for accountability. This is a policy bypass, not a direct security risk,
but it weakens the audit trail that the PRD treats as non-optional.

**Recommendation:** Add `if len(reason) < 20: return render_verb_result(request, ok=False, message="Reason must be at least 20 characters.")` in both `user_verb` and `org_verb` for the `suspend` and `reject` verb branches.

---

### F-09 — LOW · `sadmin:logout` is accessible without prior authentication check

**File:** `backend/apps/sadmin/views/auth.py:57-70`

```python
@require_POST
def sadmin_logout(request: HttpRequest) -> HttpResponse:
    user = request.user if request.user.is_authenticated else None
    if user is not None and user.is_superuser:
        emit_audit(...)
    django_logout(request)
    return HttpResponseRedirect(reverse("sadmin:login"))
```

**Why it matters:** The logout view is not decorated with `@superadmin_required`, which
is intentional (you must be able to log out even as a regular user who somehow reached
the path). However, an anonymous POST to `/sadmin/logout/` is accepted and calls
`django_logout(request)` on an anonymous session, which is a no-op but wastes a DB
write cycle and makes the logout route a low-value CSRF / DoS target against sessions.
The CSRF token prevents cross-site exploitation, but the endpoint responds to any POST
from a client that has a valid CSRF cookie, including regular non-sadmin users.

**Recommendation:** This is low severity because the CSRF token is present in the base
template's logout form. It is acceptable as-is; optionally add a guard that short-circuits
for non-superuser sessions (`if not (user and user.is_superuser): return HttpResponseRedirect(reverse("sadmin:login"))`).

---

### F-10 — LOW · `_verb_result.html` renders `message` from `str(exc)` — potential info leak

**File:** `backend/apps/sadmin/views/users.py:114` / `orgs.py:82` / `feedback.py:97`

```python
return render_verb_result(request, ok=False, message=str(exc))
```

**Why it matters:** Bare exception messages from service-layer calls (e.g., from
`apps.organizations.services.lifecycle`, `axes.utils.reset`) are surfaced directly in
the HTMX partial that the super-admin browser sees. Django auto-escapes the string so
there is no XSS risk for the SA. However, if the exception message includes internal
details (file paths, SQL table names, model fields) these are visible to the super-admin.
Given the super-admin is a trusted operator this is low risk, but verbose internal
errors are generally undesirable even for privileged users.

**Recommendation:** Catch specific exception types from known service calls and return
human-readable messages; log the full exception server-side at ERROR level. Use a
catch-all `except Exception` that logs but returns a generic "An error occurred" message.

---

### F-11 — INFO · `screenshot_data_uri` field allows 5 MB payload per feedback submission

**File:** `backend/apps/sadmin/serializers.py:31-34`

```python
screenshot_data_uri = serializers.CharField(
    max_length=5_000_000,  # ~3.7 MB worth of base64 — generous cap.
    required=False,
    allow_blank=True,
)
```

**Why it matters:** The field is throttled (10/hr/user) and the data URI is explicitly
NOT persisted (`has_screenshot = bool(data.get("screenshot_data_uri"))` — only presence
is recorded). However, 5 MB × 10 × number_of_concurrent_users can still create a
bandwidth / memory spike on the ASGI worker during validation. This is a
capacity/DoS-adjacent concern rather than a confidentiality risk.

**Recommendation:** Consider reducing `max_length` to a value appropriate for a
thumbnail (e.g., 500 KB / ~375 000 chars) or implementing true size validation at the
view layer before deserialization (check `Content-Length` or stream body size). Add a
note documenting why the value is safe given the throttle.

---

### F-12 — INFO · IP allowlist is a no-op by default in development and potentially in production

**File:** `backend/fixture/settings/base.py:78`

```python
SADMIN_IP_ALLOWLIST = env.list("SADMIN_IP_ALLOWLIST", default=[])
```

**File:** `backend/apps/sadmin/middleware.py:63-66`

```python
allowlist = getattr(settings, "SADMIN_IP_ALLOWLIST", None) or []
if allowlist:
    if not _ip_in_allowlist(_client_ip(request), allowlist):
        raise Http404
```

**Why it matters:** The allowlist is opt-in; if the operator forgets to set
`SADMIN_IP_ALLOWLIST` in the production `.env`, the sadmin surface is reachable from
any IP. There is no deployment-time check or startup warning that alerts the operator
to this condition. Combined with F-01 (CSRF bypass) and F-02 (open redirect), an
un-restricted internet-facing sadmin login page materially increases the attack surface.

**Recommendation:** Add a startup check (e.g., in `apps.sadmin.apps.SadminConfig.ready()`)
that emits a `warnings.warn` or `logger.warning` if `DEBUG=False` and
`SADMIN_IP_ALLOWLIST` is empty. Include this in the deployment checklist.

---

## Gaps (forward-looking, not current vulnerabilities)

| # | Item | Missing | Blocking | Effort |
|---|------|---------|----------|--------|
| G-01 | Sadmin login brute-force protection | `axes.backends.AxesStandaloneBackend` is in `AUTHENTICATION_BACKENDS` and `axes.middleware.AxesMiddleware` is on the stack, so `authenticate()` in `sadmin_login` IS covered. However, there are no tests confirming the sadmin path is locked out (the existing lockout tests target the DRF API login). Add a test for sadmin login lockout. | No | S |
| G-02 | Impersonation TTL not enforced | The `impersonating_started_at` timestamp written at `superadmin_verbs.py:347` is never consumed. Without a TTL, impersonation sessions persist until the super-admin manually stops them or the 30-day session expires. | No | S |
| G-03 | No CSP header on sadmin responses | No `Content-Security-Policy` header is set anywhere. With three CDN scripts (F-06), a compromised CDN delivers arbitrary JS to the sadmin session. A strict CSP (`default-src 'self'`) would block this. | No | M |
| G-04 | No rate limit on sadmin login endpoint | The sadmin login view has no Django-level throttle (beyond axes brute-force lockout). A distributed attack from many IPs below the per-IP axes threshold is unconstrained. Consider adding `django-ratelimit` on `sadmin_login` (e.g., 20/min/IP). | No | S |
| G-05 | `bulk_email` send is fully deferred | The Phase 1A `bulk_email_drafted` audit row records recipient counts computed via an ORM query (`qs.count()`), but no actual email is sent. When Phase 1B wires the SMTP send, the current `target_filter` ORM-injection risk (F-03) becomes a direct mass-email abuse vector. Fix F-03 before implementing the actual send. | Yes (Phase 1B) | M |
| G-06 | No test for open-redirect on `?next=` | The existing access-control tests do not verify that an external `next=` URL is rejected. Add a test: `POST /sadmin/login/` with valid credentials and `?next=http://evil.example.com`, assert redirect destination is the dashboard, not the external URL. | No | S |
| G-07 | `screenshot_data_uri` body is allocated in memory | DRF's `CharField` validation reads the entire request body into memory. At `max_length=5_000_000`, 100 concurrent malicious authenticated users (throttled to 10/hr but distributed) can hold ~500 MB in ASGI worker memory simultaneously. | No | M |
