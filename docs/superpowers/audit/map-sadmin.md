# sadmin Structural Map

**Area:** `backend/apps/sadmin`
**Date:** 2026-06-04
**Status:** Phase 1A — implemented and running.

---

## Purpose

Custom Super-admin Django+Tailwind+HTMX console mounted at `/sadmin/`.
Intentionally replaces Django's default `/admin/` (which is in INSTALLED_APPS but NOT url-mounted).
Provides platform-level observability, user/org lifecycle control, feedback triage, audit log browsing,
and three JSON verbs for programmatic console actions.
The public feedback-submit widget (`POST /api/feedback/submit/`) is also implemented in this app.

---

## Key Files

| File | Role |
|---|---|
| `models.py` | Three models: Feedback, UsageEvent, KPISnapshot |
| `middleware.py` | IP allowlist for /sadmin/* paths |
| `decorators.py` | `@superadmin_required` — anonymous→302, non-SA→404 |
| `serializers.py` | DRF serializers for feedback submit + SA JSON verbs |
| `urls.py` | All sadmin URL patterns (HTML + /sadmin/api/ JSON) |
| `apps.py` | AppConfig: label="sadmin" |
| `views/auth.py` | Login / logout HTML form views |
| `views/dashboard.py` | Dashboard + HTMX KPI partial |
| `views/orgs.py` | Org list, detail, verb (approve/reject/suspend/unsuspend) |
| `views/users.py` | User list, detail, verb (suspend/unsuspend/force_logout/force_pw_reset/unlock/impersonate_start/stop) |
| `views/feedback.py` | Feedback list + triage (HTML) + public submit (DRF APIView) |
| `views/audit.py` | Audit log search |
| `views/superadmin.py` | JSON API wrappers: bulk_email, system_health, archive_feedback |
| `views/_helpers.py` | `render_sadmin()` (impersonation context auto-merge), `render_verb_result()` |
| `views/__init__.py` | Re-exports all view callables |
| `services/superadmin_verbs.py` | 13 SA verbs: approve/reject/suspend/unsuspend org, suspend/unsuspend/force_logout/force_pw_reset/unlock/impersonate_start/stop user, bulk_email, system_health |
| `services/feedback.py` | submit_feedback, triage_feedback, archive_feedback, redact_body, redact_email |
| `services/kpi.py` | compute_kpi_snapshot (idempotent upsert), compute_metrics_live, latest_snapshot |
| `services/usage.py` | emit_usage — fire-and-forget telemetry |
| `services/__init__.py` | Module doc only, no imports |
| `management/commands/snapshot_kpi.py` | `manage.py snapshot_kpi` — nightly KPI rollup |
| `migrations/0001_initial.py` | Creates sadmin_feedback, sadmin_usage_event, sadmin_kpi_snapshot |
| `templates/sadmin/_base.html` | Shell layout (Tailwind CDN + HTMX CDN + Chart.js CDN + impersonation banner) |
| `templates/sadmin/login.html` | Standalone login page |
| `templates/sadmin/dashboard.html` | Dashboard with HTMX 30s KPI auto-refresh |
| `templates/sadmin/_kpi_cards.html` | KPI card partial (total_users, active_users_7d, orgs_active, feedback_open) |
| `templates/sadmin/_impersonate_banner.html` | Red banner with stop-impersonation POST form |
| `templates/sadmin/orgs/list.html` | Org table with search + status filter |
| `templates/sadmin/orgs/detail.html` | Org detail with HTMX verb buttons |
| `templates/sadmin/users/list.html` | User table with search + status filter |
| `templates/sadmin/users/detail.html` | User detail with all 6 verb buttons |
| `templates/sadmin/feedback/list.html` | Feedback inbox with inline triage form |
| `templates/sadmin/audit/search.html` | Audit log search (event_type, actor email, org_id) |
| `templates/sadmin/_pagination.html` | Shared pagination partial |
| `templates/sadmin/_verb_result.html` | HTMX swap target for verb POST results |
| `tests/` | 9 test files covering access control, IP allowlist, impersonation, feedback triage, feedback submit, PII redaction, force-logout rate alarm, superadmin verbs, superadmin API verbs, KPI snapshot |

---

## Models

### Feedback (`sadmin_feedback`)
- UUID v7 PK.
- `submitted_by` FK to AUTH_USER_MODEL — nullable (anonymous submissions + SET_NULL on user delete).
- `category`: bug | feature_request | complaint | praise | other.
- `status`: pending | triaged | resolved | wontfix.
- `triaged_by` FK — nullable.
- `internal_notes` TextField — never exposed to submitter.
- `body` is PII-redacted at INSERT time (B.11).
- Index on `(status, created_at)`.

### UsageEvent (`sadmin_usage_event`)
- UUID v7 PK. Append-only telemetry.
- `user` FK nullable. `organization_id` UUIDField (raw, not FK).
- `event_type` max_length=64. `payload` JSONField.
- Index on `(event_type, created_at)`.

### KPISnapshot (`sadmin_kpi_snapshot`)
- UUID v7 PK. `snapshot_date` unique (idempotent upsert key).
- `metrics` JSONField. Updated nightly by `snapshot_kpi` cron or on demand.

---

## Endpoints / Routes

All HTML views under `/sadmin/` are gated by `@superadmin_required`.
The middleware (`SadminIPAllowlistMiddleware`) adds a network-level IP guard when `SADMIN_IP_ALLOWLIST` is set.

### HTML views (Django+Tailwind+HTMX)

| Method | URL | View | Description |
|---|---|---|---|
| GET/POST | `/sadmin/login/` | `sadmin_login` | Public — SA bootstrap login |
| POST | `/sadmin/logout/` | `sadmin_logout` | SA logout (requires auth) |
| GET | `/sadmin/` | `dashboard` | Platform overview + KPI cards + recent feedback/usage |
| GET | `/sadmin/kpis/` | `dashboard_kpis` | HTMX KPI partial (refreshed every 30s) |
| GET | `/sadmin/orgs/` | `orgs_list` | Org table (name/slug search, status filter, paged 25) |
| GET | `/sadmin/orgs/<uuid>/` | `orgs_detail` | Org detail + verb panel + memberships |
| POST | `/sadmin/orgs/<uuid>/<verb>/` | `org_verb` | Verbs: approve, reject, suspend, unsuspend |
| GET | `/sadmin/users/` | `users_list` | User table (email search, status filter, paged 25) |
| GET | `/sadmin/users/<uuid>/` | `users_detail` | User detail + verb panel + memberships + audit log |
| POST | `/sadmin/users/<uuid>/<verb>/` | `user_verb` | Verbs: suspend, unsuspend, force_logout_all, force_password_reset, unlock_account, impersonate_start |
| POST | `/sadmin/impersonate/stop/` | `impersonate_stop` | End impersonation session |
| GET | `/sadmin/feedback/` | `feedback_list` | Feedback inbox (status + category filter, paged 25) |
| POST | `/sadmin/feedback/<uuid>/triage/` | `feedback_triage` | Set feedback status + internal notes (HTMX) |
| GET | `/sadmin/audit/` | `audit_search` | Audit log search (event_type, actor email, org UUID) |

### JSON API views (under `/sadmin/api/`)

| Method | URL | View | Description |
|---|---|---|---|
| POST | `/sadmin/api/bulk-email/` | `bulk_email_api` | Draft a bulk-email (Phase 1A: audit only, no SMTP send) |
| GET | `/sadmin/api/system-health/` | `system_health_api` | DB/Redis/table-count health probe |
| POST | `/sadmin/api/feedback/<uuid>:archive/` | `archive_feedback_api` | Archive a feedback row |

### Public DRF endpoint (not under /sadmin/)

| Method | URL | View | Description |
|---|---|---|---|
| POST | `/api/feedback/submit/` | `FeedbackSubmitView` | Public feedback widget; IsAuthenticated; throttled 10/hr/user |

---

## Observations / Findings

### CRITICAL

**CRIT-1 — `@csrf_exempt` on two privileged POST endpoints**
`backend/apps/sadmin/views/superadmin.py:47,97`
```python
@superadmin_required
@require_POST
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:
```
Both `/sadmin/api/bulk-email/` and `/sadmin/api/feedback/<uuid>:archive/` have `@csrf_exempt` applied alongside `@superadmin_required`. These are state-changing operations (draft a bulk-email audit row, archive feedback). The exemption was likely added to allow `application/json` POSTs from the console JS, but the `_base.html` already configures HTMX to send `X-CSRFToken` via the `meta[name="csrf-token"]` header AND the `hx-headers` body attribute. CSRF protection should not be stripped — it should be allowed to work via the standard header mechanism. An attacker who can trick an SA into visiting a malicious page can CSRF-trigger a bulk-email draft (which emits an audit row and counts recipients). Removing `@csrf_exempt` from both views is the fix; DRF's `SessionAuthentication` already does CSRF enforcement for `APIView` but these are plain Django views.

### HIGH

**HIGH-1 — `feedback_submit` throttle scope not registered in `DEFAULT_THROTTLE_RATES`**
`backend/apps/sadmin/views/feedback.py:115` defines `scope = "feedback_submit"` with `rate = "10/hour"`.
`backend/fixture/settings/base.py:164–169` only registers `anon`, `user`, and `signup` in `DEFAULT_THROTTLE_RATES`. DRF's `ScopedRateThrottle` reads the rate from settings via the scope key. `UserRateThrottle` (the parent class here) reads `DEFAULT_THROTTLE_RATES[self.scope]`. If the `feedback_submit` key is missing, DRF silently falls back to `None` — disabling the throttle entirely in production. The test `test_rate_limit_kicks_in_at_eleventh_call` passes in the test suite only if the test runner uses the hardcoded `rate = "10/hour"` class attribute (which `UserRateThrottle` subclass does honour via the `rate` class attribute). However, adding `"feedback_submit": "10/hour"` to `DEFAULT_THROTTLE_RATES` is still the canonical pattern and avoids confusion.

**HIGH-2 — Open redirect in `/sadmin/login/` `next` parameter**
`backend/apps/sadmin/views/auth.py:51`
```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```
The `next` query parameter is accepted without validation. An attacker can craft `https://sadmin.fixture.doxaed.com/sadmin/login/?next=https://evil.com` and after a successful SA login the browser is redirected off-domain. Fix: validate that `next_url` is a safe internal path (use `django.utils.http.url_has_allowed_host_and_scheme`).

**HIGH-3 — `django.contrib.admin` in INSTALLED_APPS but not URL-mounted**
`backend/fixture/settings/base.py:27` includes `"django.contrib.admin"` in DJANGO_APPS.
The urls.py comment explicitly says Django Admin is disabled (v1Users.md §1.5), and indeed no `admin.site.urls` path is wired. However, keeping `django.contrib.admin` in INSTALLED_APPS means: (a) Django generates admin migration dependencies and admin-specific DB tables; (b) `admin.site` is still technically accessible if wired by accident in a future PR; (c) admin ModelAdmin registrations from third-party packages (axes, waffle) might be silently discovered. Either remove `django.contrib.admin` entirely from INSTALLED_APPS (and accept that `django.contrib.messages` / `django.contrib.auth` are still present), or add a comment + test asserting no admin URL is wired.

**HIGH-4 — `_delete_sessions_for_user` iterates ALL sessions — full table scan**
`backend/apps/sadmin/services/superadmin_verbs.py:223–234`
```python
for session in Session.objects.iterator(chunk_size=500):
    data = session.get_decoded()
    if str(data.get("_auth_user_id", "")) == target_id:
        session.delete()
```
The Django session table has no index on the decoded user_id (it is stored serialised inside the `session_data` BLOB). At scale this scans and decodes every row. At 10k+ active sessions this becomes a blocking O(N) operation inside a `@transaction.atomic` block on the SA's request thread. Recommendation: use `django-session-manager` or an alternative session backend that stores user_id as a column, or at minimum run the delete in a background task.

### MEDIUM

**MED-1 — Reason length "≥20 chars" enforced only in template UI, not in view/service**
`backend/apps/sadmin/templates/sadmin/orgs/detail.html:31`: `placeholder="Reason (≥20 chars)"` is UI-only guidance.
`backend/apps/sadmin/views/orgs.py:63`: `reason = (request.POST.get("reason") or "").strip()` — no minimum-length check.
A direct POST to `/sadmin/orgs/<uuid>/suspend/` (bypassing the browser UI) can supply a 0-char reason. The v1Users.md §1.6 requirement ("Reason ≥20 chars") should be validated at the view or service layer, not just the placeholder text.

**MED-2 — `_delete_sessions_for_user` called twice for suspend_user (double scan)**
`backend/apps/sadmin/services/superadmin_verbs.py:185`
```python
user.is_active = False
user.save(update_fields=["is_active"])
_delete_sessions_for_user(user.id)
```
`suspend_user` explicitly calls `_delete_sessions_for_user`. The `force_logout_all` verb also calls it. If an operator presses "Suspend" they only get one scan, which is correct. But the comment in `suspend_user` says "suspend + force-logout sessions" meaning these are intentionally linked. This is fine logically — it's a documentation clarity note — but the full table scan risk (HIGH-4) applies doubly here.

**MED-3 — Tailwind CDN and HTMX CDN loaded from the internet in _base.html**
`backend/apps/sadmin/templates/sadmin/_base.html:9–11`
```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
```
The comment acknowledges this: "B.21 hardening: swap for compiled CSS for prod". The sadmin console on the VPS at `sadmin.fixture.doxaed.com` would need internet connectivity to load every page. This is a security concern (supply-chain attack via CDN) and an availability concern (sadmin unusable if CDNs are unreachable). Additionally, HTMX is pinned to 1.9.12 which may have security advisories by the time this goes to production. The fix is vendoring the assets or using a compiled build step before deploying.

**MED-4 — No test for the full org-verb cycle from the HTML layer**
The test suite covers service-layer verbs (`test_superadmin_verbs.py`) and the JSON API verbs (`test_superadmin_api_verbs.py`), but there is no HTTP test for `POST /sadmin/orgs/<uuid>/approve|reject|suspend|unsuspend/`. The `org_verb` view is untested at the HTTP layer.

**MED-5 — impersonation does NOT actually change request.user**
`backend/apps/sadmin/services/superadmin_verbs.py:344–346`
```python
request.session["impersonating_user_id"] = str(target_user.id)
request.session["impersonating_started_at"] = timezone.now().isoformat()
```
The session stores the impersonated user's ID but nothing in the request cycle substitutes `request.user` with the impersonated user for subsequent API calls. The impersonation banner is purely decorative — API calls made while "impersonating" still act as the SA. This may be intentional for Phase 1A (read-only impersonation preview), but it is not documented as a deliberate limitation and the UI verb label "Impersonate" implies full impersonation. Should be clarified or implemented.

**MED-6 — `services/__init__.py` exports nothing — cross-module imports fragile**
`backend/apps/sadmin/services/__init__.py` is a docstring-only module. All consumers do:
```python
from apps.sadmin.services import superadmin_verbs
from apps.sadmin.services.feedback import ...
```
This is fine but the `__init__.py` docstring lists the four sub-services as "Public surfaces" without exporting them. Any future renaming of a sub-module breaks all imports without a lint error. Low risk today but worth exporting symbols explicitly.

**MED-7 — `emit_usage` is defined but never called by any Phase 1A code**
`backend/apps/sadmin/services/usage.py:18`
`grep emit_usage` returns only the definition and the `__init__.py` docstring. No Phase 1A code calls `emit_usage(...)`. The `UsageEvent` table exists and the service function is implemented, but telemetry is wired to nothing. The dashboard shows "Recent usage events" but the list will always be empty until callers are added.

### LOW

**LOW-1 — `hx-swap="outerHTML"` on feedback triage form replaces the entire row**
`backend/apps/sadmin/templates/sadmin/feedback/list.html:46`
```html
<form hx-post="..." hx-swap="outerHTML" class="space-y-1">
```
On a successful triage, HTMX replaces the entire `<form>` element (not the `<tr>`) with the `_verb_result.html` partial, which leaves the `<td>` cells in the table orphaned. The UX will show a success banner floating inside the table cell. Should use `hx-target` pointing to a named target outside the form, as the other verb forms do (`hx-target="#user-status-banner"`).

**LOW-2 — Login page does not enforce the `sadmin/*` path protection for `/sadmin/login/` itself**
`backend/apps/sadmin/middleware.py:62`
```python
if path.startswith("/sadmin/") or path == "/sadmin":
```
`/sadmin/login/` starts with `/sadmin/` so IP allowlist also blocks the login page. This is intentional (the comments acknowledge it) but means that if `SADMIN_IP_ALLOWLIST` is set and the SA is away from their allowed IP, they cannot even reach the login page to know why they're blocked — they see a 404 with no explanation. This is documented as by-design (§1.5 surface hiding) but should be noted in operational runbooks.

**LOW-3 — `dashboard_kpis` HTMX endpoint counts Feedback/Users/Orgs on every 30s refresh with no caching**
`backend/apps/sadmin/views/dashboard.py:43–52`
The 30-second HTMX polling calls `compute_metrics_live()` which issues 5–7 DB COUNT queries on every refresh. The dashboard comment explains the live-count rationale (replacing stale KPISnapshot), but even a 10-second cache on the live result would prevent unnecessary load. At Phase 1A scale this is negligible, but worth noting before the platform scales.

**LOW-4 — No UI for KPISnapshot history**
`backend/apps/sadmin/models.py:142` — KPISnapshot is produced nightly but the dashboard only shows today's live metrics. There is no view to browse historical snapshots or chart trends. The `_kpi_cards.html` partial includes `snapshot` context but only uses `metrics` (the live dict). The `snapshot` variable is passed but unused in the current template.

**LOW-5 — `sadmin_login` does not check `deleted_at` on the user before accepting login**
`backend/apps/sadmin/views/auth.py:37`
```python
if user is None or not user.is_active or not user.is_superuser:
```
The `is_active` check covers the common case, but a soft-deleted SA (`deleted_at` is set but `is_active` may still be True if deletion doesn't deactivate) could log in. The `@superadmin_required` decorator does check `deleted_at` for all post-login views, but the login view itself does not gate on `deleted_at`. If `deleted_at` is set but `is_active` remains True, the SA can authenticate at the login form. This is low risk today (soft-deleted SAs are unlikely) but inconsistent with the decorator check.

**LOW-6 — Chart.js loaded in `_base.html` but no chart is rendered in any current template**
`backend/apps/sadmin/templates/sadmin/_base.html:11`
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
```
No template uses a `<canvas>` element or Chart.js API. Dead dependency adding ~200KB of JS load on every sadmin page.

### INFO

**INFO-1 — `bulk_email` is Phase 1A draft-only (no SMTP send)**
`backend/apps/sadmin/services/superadmin_verbs.py:400`
Comment: "Phase 1A: just record a 'drafted' audit; actual send is deferred." The UI button and the audit row exist, but the email is never sent. Operators may be confused if they use this in Phase 1A expecting delivery.

**INFO-2 — `tournaments_in_progress` KPI metric is hardcoded 0**
`backend/apps/sadmin/services/kpi.py:139`
```python
metrics.setdefault("tournaments_in_progress", 0)
```
This is correct Phase 1A behaviour (tournaments not built yet) but the key should be removed or surfaced as "N/A" in the dashboard until Phase 1B lands, so the operator does not see a permanently-zero metric and assume the data is correct.

**INFO-3 — `system_health` does not check `channels` / Redis layer health**
`backend/apps/sadmin/services/superadmin_verbs.py:445–449`
The health probe checks the cache backend (LocMemCache in dev), not the Channels layer. In production, when Channels moves to channels-redis, `system_health` will still report Redis "ok" via the cache probe even if the Channels Redis connection is down. A second probe should check `get_channel_layer().group_add(...)` or a ping.

**INFO-4 — 2FA is not enforced for sadmin login**
`backend/apps/sadmin/views/auth.py` performs standard username/password auth only. v1Users.md B.12 mandates 2FA for Org Owners; no equivalent mandate is stated for Super-admins, but a single credential compromise could give platform-wide access. Worth an explicit design decision (currently the only protection beyond the password is IP allowlist).

**INFO-5 — `force_password_reset` emits audit even when the underlying service fails**
`backend/apps/sadmin/services/superadmin_verbs.py:284–299`
```python
try:
    from apps.accounts.services.password_reset import request_password_reset
    request_password_reset(user.email, request=request)
except Exception:
    logger.exception("force_password_reset: underlying service failed")
# ... audit emitted unconditionally after the try/except
emit_audit(...event_type="force_password_reset_issued"...)
```
If the password-reset service fails (email backend misconfigured, token creation error), the audit row still says "force_password_reset_issued" but no reset token was actually sent. An SA reading the audit log would believe the reset was issued when it was not.

---

## Gaps

| # | Gap | Priority |
|---|---|---|
| G-1 | No HTTP-layer tests for `org_verb` view (approve/reject/suspend/unsuspend via POST). Service layer tested; URL layer untested. | High |
| G-2 | `emit_usage` is a dead letter — no Phase 1A caller. UsageEvent table will be empty indefinitely. | Medium |
| G-3 | `feedback_submit` throttle scope `"feedback_submit"` not registered in `DEFAULT_THROTTLE_RATES` in settings. | High |
| G-4 | `@csrf_exempt` on `bulk_email_api` and `archive_feedback_api` — CSRF removed on privileged write endpoints. | Critical |
| G-5 | Open redirect via `?next=` in `/sadmin/login/` — no host/scheme validation. | High |
| G-6 | Impersonation is session-label-only; `request.user` is not substituted. The impersonation verb does nothing functionally beyond setting a session key and emitting an audit row. | Medium |
| G-7 | Chart.js CDN loaded on every sadmin page; no charts exist anywhere in the templates. | Low |
| G-8 | KPISnapshot history has no browse UI. `snapshot` context passed to `_kpi_cards.html` but never rendered. | Low |
| G-9 | `manage.py snapshot_kpi` is implemented but there is no cron/systemd timer wiring documented or deployed. | Medium |
| G-10 | `force_password_reset` audit row is emitted unconditionally even when the token/email fails. | Medium |
