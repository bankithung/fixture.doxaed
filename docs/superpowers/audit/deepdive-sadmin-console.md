# Deep-Dive: Super-Admin Console Security (Pass 2)

Scope: `backend/apps/sadmin/` — every view, verb, decorator, middleware, and
service reachable from `/sadmin/*` and the public `/api/feedback/submit/`
endpoint. Traced full call paths and reasoned about exploitability. This is a
second, deeper pass beyond audit pass 1.

Method: Read + Grep across `apps/sadmin/`, `fixture/settings/base.py`,
`fixture/urls.py`, and cross-app services it calls. Every finding cites
`file:line` with quoted evidence. Confidence marked per finding.

Surface inventory (URL → view → @superadmin_required? → CSRF? → method):

| URL | View | gate | CSRF | method |
|-----|------|------|------|--------|
| `/sadmin/login/` | `sadmin_login` | none (public, by design) | enforced | GET/POST |
| `/sadmin/logout/` | `sadmin_logout` | none | enforced | POST |
| `/sadmin/` | `dashboard` | yes | enforced | GET |
| `/sadmin/kpis/` | `dashboard_kpis` | yes | enforced | GET |
| `/sadmin/orgs/` | `orgs_list` | yes | enforced | GET |
| `/sadmin/orgs/<id>/` | `orgs_detail` | yes | enforced | GET |
| `/sadmin/orgs/<id>/<verb>/` | `org_verb` | yes | enforced | POST |
| `/sadmin/users/` | `users_list` | yes | enforced | GET |
| `/sadmin/users/<id>/` | `users_detail` | yes | enforced | GET |
| `/sadmin/users/<id>/<verb>/` | `user_verb` | yes | enforced | POST |
| `/sadmin/impersonate/stop/` | `impersonate_stop` | yes | enforced | POST |
| `/sadmin/feedback/` | `feedback_list` | yes | enforced | GET |
| `/sadmin/feedback/<id>/triage/` | `feedback_triage` | yes | enforced | POST |
| `/sadmin/audit/` | `audit_search` | yes | enforced | GET |
| `/sadmin/api/bulk-email/` | `bulk_email_api` | yes | **@csrf_exempt** | POST |
| `/sadmin/api/system-health/` | `system_health_api` | yes | n/a (GET) | GET |
| `/sadmin/api/feedback/<id>:archive/` | `archive_feedback_api` | yes | **@csrf_exempt** | POST |
| `/api/feedback/submit/` (root) | `FeedbackSubmitView` | IsAuthenticated (any user) | DRF SessionAuth | POST |

Good news first — what pass 2 confirms is correctly done:
- `@superadmin_required` is present on every HTML console view and every
  `/sadmin/api/` JSON verb (verified by reading each view file; the URL conf
  wires only these views). Decorator ordering is correct everywhere: the gate
  is the OUTERMOST decorator (e.g. `orgs.py:16-17`, `superadmin.py:45-47`), so
  `@require_POST`/`@csrf_exempt` run inside the auth gate, not before it.
- Login rejects non-superusers with a generic "Invalid credentials." and
  rejects inactive users (`auth.py:37`), avoiding enumeration.
- Session fixation defense via `cycle_key()` on login (`auth.py:41`).
- IP-allowlist returns 404 not 403 (`middleware.py:66`), preserving the
  surface-hide invariant.
- Search/filter inputs are passed only to the Django ORM via parametrized
  `__icontains` / exact lookups (`orgs.py:25`, `users.py:26`, `audit.py:25-27`,
  `feedback.py:61-64`) — **no SQL injection**; status/category filters are
  validated against `.values` allowlists before use.
- Feedback body PII redaction at INSERT (`services/feedback.py:84-89`).

---

## TOP / HIGH-SEVERITY FINDINGS

### FINDING 1 — CSRF protection DISABLED on two state-changing super-admin verbs (`@csrf_exempt`)
Severity: HIGH · Confidence: HIGH

`backend/apps/sadmin/views/superadmin.py:45-48` and `:95-98`:
```python
@superadmin_required
@require_POST
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:
...
@superadmin_required
@require_POST
@csrf_exempt
def archive_feedback_api(
    request: HttpRequest, feedback_id: uuid.UUID
) -> HttpResponse:
```

Both endpoints mutate state — `bulk_email_api` enumerates the entire user base
and writes a `bulk_email_drafted` audit row (and is the seam where Phase 1B
wires real SMTP send), and `archive_feedback_api` mutates a `Feedback` row and
writes an audit row. Both are explicitly `@csrf_exempt`.

Exploit path: the platform uses **session-cookie auth** (`base.py:152-155`,
DRF `SessionAuthentication` only; invariant #15 "session auth no-JWT").
`SESSION_COOKIE_SAMESITE = "Lax"` (`base.py:146`) blocks cross-site GET-driven
top-level navigations but **does NOT block cross-site POST** that a malicious
page issues via `fetch`/form with `credentials: include` is blocked by SameSite=Lax
for cross-site — however Lax still allows same-site sub-requests, and more
importantly these endpoints accept `Content-Type: application/json` parsed by
`_parse_json_body` (`superadmin.py:35-42`), and the regular HTML verbs
(`org_verb`, `user_verb`, `feedback_triage`) DO enforce CSRF, proving the
console is designed to rely on CSRF tokens. Disabling CSRF on exactly the two
JSON verbs is an inconsistency that removes the second factor of defense. With
SameSite=Lax the practical cross-origin exploit is narrowed, but: (a) any
same-site content-injection (e.g. a stored-XSS or an attacker-controlled page
on the same registrable domain / a subdomain that can set a request to the
apex) bypasses CSRF entirely here; (b) the project's own threat model treats
CSRF as required for every mutation (all sibling verbs enforce it). There is no
compensating control — no custom-header requirement, no Origin/Referer check in
these two views.

Impact: a super-admin tricked into loading a malicious same-site page (or via
a future subdomain takeover / XSS) can have feedback silently archived or, more
seriously once Phase 1B lands, a real bulk email blasted to the entire user
base under the SA's identity, all without a CSRF token.

Why it's wrong: the `@csrf_exempt` was almost certainly added because the
author assumed "JSON API ⇒ CSRF doesn't apply." That is false for
**cookie-authenticated** JSON endpoints. DRF's own `SessionAuthentication`
re-applies CSRF enforcement; bypassing it with `@csrf_exempt` on a Django FBV
strips that protection.

Fix: remove `@csrf_exempt` from both views. The SPA already reads the CSRF
cookie (`CSRF_COOKIE_HTTPONLY = False`, `base.py:149` — "JS reads token for
SPA + HTMX") and must send `X-CSRFToken`. If these are meant to be called by
the same SPA/HTMX front-end as the rest of the console, they need the token
just like `org_verb` etc.

---

### FINDING 2 — IP allowlist is trivially bypassable via spoofed `X-Forwarded-For`
Severity: HIGH · Confidence: HIGH

`backend/apps/sadmin/middleware.py:21-23`:
```python
def _client_ip(request: HttpRequest) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    return forwarded or request.META.get("REMOTE_ADDR") or None
```

`_client_ip` trusts the **client-supplied** `X-Forwarded-For` header
unconditionally and uses its first token as the source IP for the allowlist
check (`middleware.py:65`). An attacker simply sends
`X-Forwarded-For: 192.0.2.10` (any allowlisted value) and the
`SADMIN_IP_ALLOWLIST` (B.15, the network-level surface-hide control) is
defeated — the request is treated as originating from the allowlisted IP.

Confirmed there is **no** `SECURE_PROXY_SSL_HEADER`, no `USE_X_FORWARDED_HOST`,
and no trusted-proxy / number-of-proxies configuration anywhere in
`fixture/settings/base.py` (grep for `SECURE_PROXY_SSL_HEADER|USE_X_FORWARDED`
returns no settings hits). So nothing validates that the XFF header actually
came from the trusted reverse proxy. The CLAUDE.md production topology is
nginx/Caddy in front of Django — XFF is only trustworthy if Django takes the
**rightmost** trusted hop, not the leftmost client-controlled token. Taking
`split(",")[0]` is exactly the wrong end: the first token is the value the
external client put there.

Exploit path: `curl -H "X-Forwarded-For: <any allowlisted IP>" https://sadmin.../`.
The 404-hiding and the entire B.15 network control evaporate. The attacker
still needs SA credentials to get past `@superadmin_required`, but B.15's whole
purpose is defense-in-depth precisely for when credentials might leak.

Note the same anti-pattern is duplicated in `apps/audit/services.py:54` and
`apps/accounts/services/password_reset.py:41` — meaning audit-log "client IP"
and password-reset rate-limit IP are equally spoofable. For the sadmin scope,
the audit one matters: an attacker can forge the recorded source IP on every
audited super-admin action.

Fix: derive client IP from the rightmost untrusted hop given a configured
trusted-proxy count, or read a proxy-set header the app controls (e.g.
`X-Real-IP` set by nginx with `proxy_set_header` and the raw XFF discarded),
and only honor XFF when `REMOTE_ADDR` is itself a trusted proxy. Centralize in
one helper and reuse across the three call sites.

---

### FINDING 3 — Open redirect via the login `next` parameter (no host/scheme validation)
Severity: MEDIUM-HIGH · Confidence: HIGH

`backend/apps/sadmin/views/auth.py:51-52`:
```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```

The `next` query parameter is taken from the request and redirected to verbatim
after a successful super-admin login. There is **no** call to
`django.utils.http.url_has_allowed_host_and_scheme` (grep across the whole
backend returns zero uses anywhere). An attacker crafts
`/sadmin/login/?next=https://evil.example/phish` and, after the SA submits
valid credentials, the browser is 302-redirected to the attacker's site.

Compounding: the `@superadmin_required` decorator itself builds the login URL
with an **unencoded** `next` from `request.path`
(`decorators.py:32-33`):
```python
login_url = reverse("sadmin:login")
return HttpResponseRedirect(f"{login_url}?next={request.path}")
```
`request.path` is path-only so the decorator-built link is low risk, but the
login view will happily honor any externally-crafted `next` regardless of how
the SA arrived. Because this is the super-admin login, the redirect is an ideal
phishing primitive: the victim has just proven they hold the most privileged
credentials, and landing on an attacker page immediately after a legitimate
login is highly convincing for credential re-entry / OAuth-consent style
attacks.

Also note `next` is read from `request.GET` even on the POST branch
(`auth.py:51`), so the value survives the form submission via the form's query
string / action URL.

Fix:
```python
from django.utils.http import url_has_allowed_host_and_scheme
candidate = request.GET.get("next") or ""
if url_has_allowed_host_and_scheme(candidate, allowed_hosts={request.get_host()},
                                   require_https=request.is_secure()):
    next_url = candidate
else:
    next_url = reverse("sadmin:dashboard")
```

---

## ADDITIONAL FINDINGS

### FINDING 4 — No password re-prompt (B.18 re-auth) on ANY destructive super-admin verb
Severity: MEDIUM · Confidence: HIGH

`fixture/settings/base.py:215` defines `SENSITIVE_REAUTH_WINDOW_MINUTES = 5`
with the comment "B.18 password re-prompt window", but grep for
`SENSITIVE_REAUTH|reauth|reprompt|B\.18` across `apps/sadmin/` returns **no
matches**. None of the high-impact verbs — `impersonate_start`, `suspend_user`,
`force_logout_all`, `force_password_reset`, `suspend_org`, `reject_org`,
`bulk_email` — checks a recent-reauth timestamp before executing
(`views/users.py:70-116`, `views/orgs.py:57-84`, `views/superadmin.py:48`).

Impact: the locked B.18 control ("re-prompt password before sensitive actions")
is specified and even has a settings constant, but is entirely unimplemented in
the sadmin surface. A super-admin session that is hijacked (stolen cookie, an
unlocked laptop) can immediately impersonate any user, suspend accounts, force
password resets, or draft bulk email with no second factor. This is the control
that would have blunted Findings 1 and 3.

Fix: add a re-auth guard decorator that checks
`request.session["sensitive_reauth_at"]` against
`SENSITIVE_REAUTH_WINDOW_MINUTES` and redirects to a password-reprompt page;
apply to `user_verb`, `org_verb` (destructive verbs), `impersonate_start`, and
`bulk_email_api`. Set the timestamp on the reprompt POST.

### FINDING 5 — `bulk_email` performs ORM mass-assignment from attacker-influenced JSON keys (kwargs injection)
Severity: MEDIUM · Confidence: MEDIUM

`views/superadmin.py:60-73` reads `target_filter` from the JSON body and passes
it straight to the service; `services/superadmin_verbs.py:409-412`:
```python
if target_filter:
    for k, v in target_filter.items():
        qs = qs.filter(**{k: v})
```

The keys `k` are caller-controlled and splatted directly into `QuerySet.filter`.
This is not classic SQLi (ORM parametrizes values), but it is **ORM lookup
injection**: a caller can supply arbitrary field paths and lookups, e.g.
`{"org_memberships__user__email__icontains": "@"}` to traverse relations, or
crafted keys to probe/enumerate data through the recipient-count return value.
In Phase 1A the only effect is the returned `recipients` count and the audited
filter, but it is an oracle (boolean/count exfiltration over arbitrary fields,
including across relations) and becomes a recipient-selection injection once
Phase 1B wires real send. The view only validates that `target_filter` is a
dict (`superadmin.py:61-65`), never that its keys are in an allowlist.

Caveat on severity: reachable only by an authenticated super-admin, so this is
privilege-bounded; the risk is (a) it widens the blast radius of a hijacked SA
session, and (b) it sets a Phase-1B trap where the keys select real email
recipients. Confidence MEDIUM because exploitability today is limited to a
count oracle.

Fix: allowlist permitted filter keys (e.g. `{"is_active", "org_memberships__organization_id", "date_joined__gte"}`) and reject unknown keys with 400.

### FINDING 6 — Impersonation is banner-only in Phase 1A (no auth switch) — SAFE today, but a Phase-1B trap
Severity: INFO / LOW (today) · Confidence: HIGH

Traced the full impersonation path. `impersonate_start`
(`services/superadmin_verbs.py:332-358`) only writes
`request.session["impersonating_user_id"] = str(target_user.id)` and emits an
audit row. Grep for `impersonating_user_id` consumers shows it is read ONLY by
the banner helper (`views/_helpers.py:11-41`) and the verb service — **no
middleware or auth backend swaps `request.user`** to the impersonated identity.
So in Phase 1A impersonation grants no actual access; it is display-only. That
is the safe state and is correctly audited (`actor_role=super_admin`,
`impersonating_user_id` carried on the row).

Risk to flag for Phase 1B: when impersonation is made functional, the current
shape has gaps that must be closed BEFORE wiring it: (a) no guard prevents
impersonating another super-admin or oneself (`users.py:103-110` /
`superadmin_verbs.py:332` accept any `target_user`); (b) no max-duration / auto-
expiry is enforced — `impersonating_started_at` is stored
(`superadmin_verbs.py:346`) but never checked; (c) `impersonate_stop`
(`superadmin_verbs.py:361-383`) does not `cycle_key()`, so a future functional
impersonation would not get session-key separation on enter/exit. None of these
are exploitable while impersonation is display-only, hence INFO today.

### FINDING 7 — `org_verb` / `user_verb` swallow all exceptions into the HTTP response body
Severity: LOW · Confidence: HIGH

`views/orgs.py:81-82` and `views/users.py:113-114`:
```python
except Exception as exc:
    return render_verb_result(request, ok=False, message=str(exc))
```

A broad `except Exception` renders `str(exc)` straight into the response. For a
super-admin-only surface this is information disclosure of limited concern
(audience is the SA), but it can leak internal exception detail (e.g. DB
constraint text, import errors from the deferred sibling-service fallbacks in
`superadmin_verbs.py`) into the UI and, combined with Finding 1/2, into a
cross-site context. Low severity because the surface is privileged; flagged for
hygiene. Fix: log full exception server-side, return a generic message.

### FINDING 8 — Reason-length / "≥20 chars" precondition (§1.6) not enforced
Severity: LOW · Confidence: MEDIUM

`suspend_org` docstring claims "Reason >=20 chars per §1.6 (enforced at view
layer)" (`superadmin_verbs.py:96`), but `org_verb` only does
`reason = (request.POST.get("reason") or "").strip()` with **no length check**
(`views/orgs.py:63`); same for `user_verb` (`views/users.py:75`). The audit
trail can therefore record destructive actions (suspend/reject/force-reset)
with an empty reason, weakening the accountability guarantee the spec intends.
Fix: validate required-reason length in the view before dispatching the verb.

---

## NON-FINDINGS (checked, OK)

- **SQL injection in filters/search**: none. All user input reaches the ORM
  through parametrized lookups; enum filters are allowlist-validated
  (`orgs.py:26`, `feedback.py:61,63`). Org UUID filter is wrapped in
  `uuid.UUID()` with try/except (`audit.py:29-32`).
- **authz coverage**: `@superadmin_required` present on 100% of console +
  `/sadmin/api/` views; decorator is outermost; gate checks `is_superuser` AND
  `is_active` AND `deleted_at is None` (`decorators.py:34-39`).
- **Surface-hide**: non-SA → 404, anonymous → 302-login, consistently
  (`decorators.py:31-39`, tests `test_access_control.py`).
- **CSRF on HTML verbs**: enforced (no `@csrf_exempt` on `org_verb`,
  `user_verb`, `feedback_triage`, `sadmin_logout`).
- **Feedback PII**: redacted at insert (`services/feedback.py:84-89`); display
  redaction for non-SA viewers (`redact_email`, `feedback.py:36-53`).
- **Login enumeration**: generic error, inactive+non-super rejected
  (`auth.py:37`).
- **Session fixation**: `cycle_key()` on login (`auth.py:41`).

---

## SUMMARY TABLE

| # | Finding | Severity | File:line |
|---|---------|----------|-----------|
| 1 | `@csrf_exempt` on bulk-email + archive verbs | HIGH | `views/superadmin.py:47,97` |
| 2 | IP allowlist bypass via spoofed `X-Forwarded-For` | HIGH | `middleware.py:22` |
| 3 | Open redirect via login `next` (no host validation) | MED-HIGH | `views/auth.py:51-52` |
| 4 | No B.18 password re-prompt on any destructive verb | MED | settings `base.py:215` vs `apps/sadmin/*` (absent) |
| 5 | `bulk_email` ORM kwargs injection from JSON keys | MED | `services/superadmin_verbs.py:410-411` |
| 6 | Impersonation Phase-1B trap (no self/SA guard, no expiry, no cycle_key) | INFO today | `services/superadmin_verbs.py:332-383` |
| 7 | Broad `except` leaks `str(exc)` to response | LOW | `views/orgs.py:81`, `views/users.py:113` |
| 8 | Reason-length precondition (§1.6) unenforced | LOW | `views/orgs.py:63`, `views/users.py:75` |
