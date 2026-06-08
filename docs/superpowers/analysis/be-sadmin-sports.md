# Backend Subsystem Analysis — sadmin console + sports catalog

**Scope:** `backend/apps/sadmin` (super-admin console) + `backend/apps/sports` (read-only sports metadata catalog). Read against `CLAUDE.md`, `v1Users.md` (§1.5–1.8, Appendix B), and the test suites. This is ground-truth for a planned full restructuring.

---

## 1. Purpose

Two loosely-related Phase-1A apps mounted server-side (Django templates, not the React SPA):

- **`apps.sadmin`** — the *only* admin surface in v1.0. The default Django admin at `/admin/` is intentionally disabled (`fixture/urls.py` docstring); the platform owner operates through a bespoke **Django + Tailwind (CDN) + HTMX** console at `/sadmin/`. It provides: an operational dashboard (live KPIs), org + user management with audited "verbs", impersonation (banner-only in 1A), a feedback inbox, an audit-log search, a public feedback-submit JSON API, and three JSON "ops" endpoints. It owns three observability models (`Feedback`, `UsageEvent`, `KPISnapshot`).
- **`apps.sports`** — a platform-level, **not org-scoped**, read-only catalog of sports the platform plans to support (59 seed rows). It is Phase-1B *prep*: every row is metadata (`status=planned`/`coming_soon`); per-sport plugin apps (`apps.sports.<code>`) arrive later. Football is the seeded `coming_soon` vertical slice.

---

## 2. File-by-file roles

### sadmin
- `models.py` — `Feedback`, `UsageEvent`, `KPISnapshot` (+ `FeedbackCategory`/`FeedbackStatus`/`SportStatus`-style TextChoices). UUID v7 PKs; `db_table` names `sadmin_*`.
- `decorators.py` — `superadmin_required`: anonymous → 302 to `sadmin:login?next=`; authenticated-but-not-SA (or inactive / soft-deleted) → **404** (surface-hide). This is the per-view auth gate for the whole console.
- `middleware.py` — `SadminIPAllowlistMiddleware` (B.15). For `/sadmin/*` paths, if `settings.SADMIN_IP_ALLOWLIST` is non-empty and client IP isn't in it → `Http404`. No-op when unset. Helpers `_client_ip` (X-Forwarded-For first hop, else REMOTE_ADDR) and `_ip_in_allowlist` (CIDR or single-IP, via `ipaddress`).
- `urls.py` — `app_name="sadmin"`; HTML routes (login/logout, dashboard, dashboard_kpis, orgs list/detail/verb, users list/detail/verb, impersonate_stop, feedback list/triage, audit search) + 3 JSON routes under `/sadmin/api/` (bulk-email, system-health, feedback `:archive` colon-verb).
- `serializers.py` — DRF serializers for JSON surfaces only (`FeedbackSubmit*`, `BulkEmail*`, `SystemHealth*`, `FeedbackArchive*`). HTML console views do **not** use these.
- `views/` — one module per area: `auth.py`, `dashboard.py`, `audit.py`, `orgs.py`, `users.py`, `feedback.py` (HTML triage + the DRF `FeedbackSubmitView`), `superadmin.py` (3 JSON ops endpoints), `_helpers.py` (impersonation context + `render_sadmin`/`render_verb_result`). `__init__.py` re-exports for URL wiring.
- `services/` — `superadmin_verbs.py` (the verbs), `feedback.py` (submit/triage/archive + PII redaction), `kpi.py` (`compute_metrics_live` / `compute_kpi_snapshot` / `latest_snapshot`), `usage.py` (`emit_usage` fire-and-forget telemetry).
- `management/commands/snapshot_kpi.py` — nightly idempotent KPI rollup.
- `templates/sadmin/` — `_base.html` (Tailwind+HTMX+Chart.js via CDN), `_impersonate_banner.html`, `_verb_result.html` (HTMX swap target), `_kpi_cards.html`, `_pagination.html`, `login.html`, plus `dashboard.html`, `orgs/`, `users/`, `feedback/`, `audit/` pages.

### sports
- `models.py` — `Sport` + `SportStatus` / `SportCategory` TextChoices. UUID v7 PK; unique `code` slug (doubles as future plugin app suffix); `db_table="sports_sport"`; default ordering `display_order, name`.
- `views.py` — `SportListView` (`GET /api/sports/`, `AllowAny`, `pagination_class=None`, optional `?status=`/`?category=` filters validated against the enums) + `SportDetailView` (`GET /api/sports/<code>/`, lookup by `code`).
- `serializers.py` — `SportSerializer`, all fields `read_only`.
- `urls.py` — `app_name="sports"`, list + detail.
- `management/commands/load_sports.py` — idempotent upsert of `fixtures/sports.json` keyed by `code`; validates category/status against enums (falls back with a warning); never deletes.
- `fixtures/sports.json` — 59 sport rows.

---

## 3. Data model

**`sadmin_feedback`** — `id`(uuid7 PK); `submitted_by` FK→User `SET_NULL` (nullable: anonymous + survives submitter soft-delete); `category`/`status` (TextChoices); `subject`(200)/`body`(text, **PII-redacted at INSERT**); `triaged_by` FK→User `SET_NULL`; `triaged_at`/`resolved_at`; `internal_notes` (SA-only, never shown to submitter); `created_at`(indexed)/`updated_at`. Index `(status, created_at)`.

**`sadmin_usage_event`** — append-only firehose. `id`; `user` FK `SET_NULL`; `organization_id` (bare UUID, **not** an FK — deliberately denormalized); `event_type`(64); `payload` JSONB; `created_at`(indexed). Index `(event_type, created_at)`.

**`sadmin_kpi_snapshot`** — `id`; `snapshot_date` **unique** (idempotency key); `metrics` JSONB; `created_at`. Ordered `-snapshot_date`.

**`sports_sport`** — `id`(uuid7); `code` (unique SlugField, lowercase ASCII); `name`; `category`/`status` (indexed); `description`; `indigenous_to` (free text, not FK); `is_team_sport`/`is_individual_sport` (bool, redundant with `category`); `python_module_path` (future plugin dotted path); `icon`; `display_order` (default 1000); timestamps. Indexes on `status` and `category`.

**Relationships:** Feedback/UsageEvent → User (loose, SET_NULL). No org FKs anywhere here — `UsageEvent.organization_id` and audit's `organization_id` are bare UUIDs by design. The console *reads* `apps.accounts.User`, `apps.organizations.Organization`, `apps.audit.AuditEvent` but owns no relations to them.

---

## 4. Core algorithms / services (file:function, step-by-step)

**Access gate — `decorators.py::superadmin_required`.** Reads `request.user`; if not authenticated → `HttpResponseRedirect(reverse('sadmin:login') + ?next=request.path)`; else if `not is_superuser` OR `is_active is False` OR `deleted_at is not None` → `Http404`; else call the view. Every console view stacks `@superadmin_required` then `@require_GET`/`@require_POST`.

**IP gate — `middleware.py::SadminIPAllowlistMiddleware.__call__`.** Only acts on `/sadmin/*` (or exact `/sadmin`); if allowlist set and `_ip_in_allowlist(_client_ip(request), allowlist)` is False → raise `Http404`. Trusts the first `X-Forwarded-For` hop unconditionally (see smells).

**The 13 SA verbs — `services/superadmin_verbs.py`.** Each is `@transaction.atomic`, mutates state, and emits **one** audit row inline via `apps.audit.services.emit_audit` (B.4: never via signals), with `actor_role=SUPER_ADMIN`, optional `reason`, and `impersonating_user_id=_impersonating_id(request)`. The verbs:
1. `approve_org` — thin delegate → `apps.organizations.services.lifecycle.approve_org` (that service owns the transition + the `org_approved` audit; verb must NOT double-emit).
2. `reject_org` — thin delegate → lifecycle.reject_org (→ ARCHIVED, audited w/ reason).
3. `suspend_org` — try-delegate to lifecycle.suspend_org; **inline fallback** sets `status=SUSPENDED`, `suspended_at`, `suspended_reason`, emits `org_suspended`.
4. `unsuspend_org` — symmetric to (3); inline fallback emits `org_unsuspended`.
5. `suspend_user` — `is_active=False` + `_delete_sessions_for_user`; B.21 rate-alarm (warn >50/hr); emits `user_suspended`.
6. `unsuspend_user` — `is_active=True`; emits `user_unsuspended`.
7. `force_logout_all` — `_delete_sessions_for_user`; B.21 alarm (warn >20/hr); emits `user_force_logged_out` with `sessions_deleted`.
8. `force_password_reset` — best-effort call to `apps.accounts.services.password_reset.request_password_reset` (swallows exceptions); emits `force_password_reset_issued`.
9. `unlock_account` — best-effort `axes.utils.reset(username=email)`; emits `user_unlocked`.
10. `impersonate_start` — writes `session['impersonating_user_id']` + `impersonating_started_at`; emits `impersonation_started` (with `impersonating_user_id=target.id`). **Does not swap `request.user`.**
11. `impersonate_stop` — pops the session keys; emits `impersonation_stopped`.
12. `bulk_email` — Phase 1A: counts recipients (`User.filter(deleted_at__isnull=True, is_active=True)` + `target_filter` kwargs), emits `bulk_email_drafted`; **no SMTP send**. Returns `{recipients, subject, body}`.
13. `system_health` — read-only probe (no audit): `SELECT 1` (db), cache set/get round-trip (redis), table counts (users/audit_events/organizations). Returns a dict.

Supporting helpers: `_bump_rate_counter` (cache.add+incr with ValueError fallback), `_impersonating_id` (session→UUID), `_delete_sessions_for_user` (iterates **every** `Session` row, decodes, matches `_auth_user_id` — O(all sessions), see smells).

**Feedback — `services/feedback.py`.** `redact_body` runs 4 regexes (emails, JWTs, 32+ hex, `password|otp|recovery_code = …`) → `[REDACTED]` (applied at INSERT). `redact_email` returns full email for SA viewers, else `j***@domain`. `submit_feedback` — idempotency: if `event_id` matches a prior `feedback_submitted` audit's `idempotency_key`, return the existing row (by `target_id`); else create (redacting body) + emit `feedback_submitted` with `actor_role=SYSTEM`, `idempotency_key=event_id`. `triage_feedback` — validates status (raises `ValueError`), sets status/triaged_by/triaged_at/(resolved_at if RESOLVED)/notes, emits `feedback_triaged`. `archive_feedback` — forces RESOLVED, appends `\n[archived]` to notes, emits `feedback_archived` (reason="archived").

**KPI — `services/kpi.py`.** `compute_metrics_live` returns a dict of counts across users (total/active_7d/suspended), orgs (total/pending/active/suspended), feedback (open/resolved_7d), plus `tournaments_in_progress=0` placeholder and `snapshot_date`. Each block try/excepts with `setdefault` fallbacks so a missing sibling app can't break it. `compute_kpi_snapshot` calls `compute_metrics_live`, pops `snapshot_date`, and `update_or_create(snapshot_date=...)` → idempotent. `latest_snapshot` reads the newest row. **DEFECT-Q:** the dashboard now computes live every request (`dashboard.py::_dashboard_metrics`) because the persisted snapshot was always stale (no nightly cron in dev).

**Public feedback API — `views/feedback.py::FeedbackSubmitView`** (`POST /api/feedback/submit/`, `IsAuthenticated`, `FeedbackSubmitThrottle` 10/hr). Validates body; composes `message + "Page: <url>" + "[screenshot attached]"` (screenshot data URI presence flagged, not stored); pre-checks idempotency to choose 200 vs 201; calls `submit_feedback`; on service exception returns 500.

**Sports — `load_sports.handle`** reads json array, validates each entry's category/status against enums (warn+fallback), `update_or_create(code=…, defaults=…)` inside one `transaction.atomic`. **`SportListView.get_queryset`** filters by validated `?status`/`?category`.

---

## 5. API / endpoint surface

**HTML console (`/sadmin/`, all `@superadmin_required`):**
- `GET/POST login/` (public-ish, see invariants), `POST logout/`
- `GET ""` dashboard, `GET kpis/` (HTMX 30s poll → `_kpi_cards.html`)
- `GET orgs/`, `GET orgs/<uuid>/`, `POST orgs/<uuid>/<verb>/` (approve|reject|suspend|unsuspend)
- `GET users/`, `GET users/<uuid>/`, `POST users/<uuid>/<verb>/` (suspend|unsuspend|force_logout_all|force_password_reset|unlock_account|impersonate_start), `POST impersonate/stop/`
- `GET feedback/`, `POST feedback/<uuid>/triage/`
- `GET audit/`

**JSON ops (`/sadmin/api/`, `@superadmin_required`, `@csrf_exempt` on the two POSTs):**
- `POST api/bulk-email/`, `GET api/system-health/`, `POST api/feedback/<uuid>:archive/` (AIP-136 colon verb)

**Public API (root urls):** `POST /api/feedback/submit/` (`feedback-submit`).

**Sports API (`/api/sports/`, `AllowAny`, unpaginated):** `GET /api/sports/`, `GET /api/sports/<code>/`.

---

## 6. Invariants that MUST be preserved

1. **Surface-hide:** non-SA → 404 (never 403/redirect); anonymous → 302 to login. Login is the only intentionally-public `/sadmin/` URL. Inactive/soft-deleted SAs are rejected. (Tests: `test_access_control.py`.)
2. **IP allowlist:** non-allowlisted IP → 404; empty/unset list = no-op. (`test_ip_allowlist.py`.)
3. **One audit row per verb, emitted inline (B.4), `actor_role=super_admin`, correct `target_type`/`target_id`.** Delegating verbs must NOT double-emit (`test_superadmin_verbs.py::test_sadmin_approve_calls_lifecycle_service` asserts count==1).
4. **B.11 PII redaction at INSERT** — DB never stores raw emails/tokens in feedback bodies.
5. **Idempotency:** repeat `event_id` on feedback submit returns the existing row (200, single Feedback + single audit).
6. **Login session fixation defense:** `session.cycle_key()` after `django_login` (`auth.py`).
7. **KPI snapshot idempotent per `snapshot_date`** (unique constraint + `update_or_create`); `compute_metrics_live` must never persist a row.
8. **Telemetry never breaks callers** (`emit_usage` swallows everything).
9. **Impersonation is audit-tagged:** `impersonating_user_id` stamped on audit rows; banner shows when session key set; `impersonate_stop` clears it.
10. **Sports catalog is read-only, public, platform-level (not org-scoped); `load_sports` idempotent and non-destructive; `code` unique + lowercase slug.**
11. **B.21 alarms log only (do not block) in Phase 1A** (thresholds 20/hr force-logout, 50/hr suspend).

---

## 7. Dependencies & coupling

**Outgoing (sadmin →):**
- `apps.accounts.models` (`User`, `uuid7`) — read for lists/detail/KPI/bulk-email; `uuid7` is the PK factory for all three models.
- `apps.audit` (`emit_audit`, `ActorRole`, `AuditEvent`) — **heavy**: every verb + feedback action emits inline; audit search & user-detail read `AuditEvent`; feedback idempotency reads audit by `idempotency_key`/`target_id` (cross-table coupling — feedback identity is recovered *through* the audit log).
- `apps.organizations` — models (`Organization`, `OrgStatus`) for lists/KPI; `services.lifecycle.{approve,reject,suspend,unsuspend}_org` delegated to (with try/except-fallback for suspend/unsuspend).
- `apps.accounts.services.password_reset`, `axes.utils.reset`, `django.contrib.sessions`, `django.core.cache` — best-effort optional integrations.
- Project settings: `SADMIN_IP_ALLOWLIST` (used), template context processor `request`/`auth`, `MIDDLEWARE` registration (`base.py` line 81, **last** in the chain — after axes/waffle/htmx).

**Incoming (→ sadmin):**
- `fixture/urls.py` mounts `/sadmin/` + `/api/feedback/submit/` (imports `FeedbackSubmitView` at module top).
- `services/usage.py::emit_usage` is the platform-wide telemetry entry point (other apps call it).
- `snapshot_kpi` management command (cron).

**sports coupling:** depends only on `apps.accounts.models.uuid7`; mounted at `/api/sports/` in `fixture/urls.py`. Nothing else imports it yet (Phase-1B plugins will via `python_module_path`).

---

## 8. Tech debt / smells / duplication

- **`SADMIN_HOST` is dead config.** Defined in `base.py:211` + `.env.example`, but **never read anywhere in code** (grep-confirmed). The task brief's "SADMIN_HOST gating" does not exist; gating is purely `superadmin_required` + IP middleware. Either wire host-gating or delete the setting.
- **Impersonation is banner-only (no real impersonation).** `impersonate_start` only writes a session key + audit; **no middleware/auth-backend swaps `request.user`** (grep-confirmed: nothing outside sadmin/audit reads `impersonating_user_id`). The SA continues operating as themselves; B.19 "act as user" is not actually implemented — a latent surprise for anyone expecting true impersonation.
- **`_delete_sessions_for_user` is O(all sessions)** — iterates every `Session` row and decodes each. Fine at 1A scale; will not scale and is the hot path for both `suspend_user` and `force_logout_all`.
- **Feedback identity recovered via the audit log.** Idempotency joins `Feedback.pk` to `AuditEvent.target_id` filtered by `idempotency_key`. There is no `event_id`/idempotency column on `Feedback` itself, so the audit table is load-bearing for correctness — coupling that violates separation and is fragile if audit retention/partitioning changes.
- **`@csrf_exempt` on `bulk_email_api` / `archive_feedback_api`.** Justified-ish (session-gated, SA-only) but inconsistent with the HTML console (which uses CSRF tokens) and with invariant 15 (CSRF in a custom header). The public `FeedbackSubmitView` relies on DRF SessionAuth CSRF instead.
- **CDN dependencies in `_base.html`** (Tailwind play CDN, htmx@1.9.12, Chart.js) — flagged in-template as "swap for compiled CSS for prod"; an external-network + supply-chain dependency, and Tailwind CDN is explicitly not for production.
- **Two parallel design systems.** The console is hand-rolled Tailwind with hardcoded palette classes (`bg-slate-900`, `border-emerald-300`, `bg-red-600`) — deliberately divorced from the SPA token system in `CLAUDE.md`. Acceptable as an internal tool, but zero reuse.
- **`is_team_sport`/`is_individual_sport` booleans duplicate `category`** (`team`/`individual`) — three sources of truth for one fact; drift risk.
- **`org_verb`/`user_verb` are string-dispatch if/elif ladders** catching bare `Exception` and surfacing `str(exc)` straight to the UI — error leakage + no structured verb registry; reason-length (≥20 char, §1.6) is claimed "enforced at view layer" in a docstring but is **not actually enforced** in `orgs.py`/`users.py`.
- **No multi-tenancy isolation tests** for this app (correctly, since it's the cross-tenant SA surface) — but `UsageEvent.organization_id` / audit `organization_id` are unvalidated bare UUIDs.
- **`apps.py` sets `default_auto_field = BigAutoField`** while every model uses explicit uuid7 PKs — harmless but misleading.

---

## 9. Restructuring seams & risks

**Clean seams (low risk):**
- **Verb service layer (`superadmin_verbs.py`) is already the seam.** Views are thin dispatchers; the JSON-ops and HTML paths both call the same functions. A verb *registry* (name → callable + required-reason + min-reason-length + rate-key) would collapse the if/elif ladders in `orgs.py`/`users.py`/`superadmin.py` into one table-driven dispatcher and let you enforce the §1.6 reason rule uniformly.
- **`compute_metrics_live` is the single KPI source of truth** (dashboard + snapshot + cron share it). Extending KPIs (tournaments/matches in 1B) is a one-function change.
- **Sports catalog is a self-contained, read-only, additive surface.** Adding write paths / per-sport plugins via `python_module_path` is greenfield; the `load_sports` upsert pattern mirrors `load_modules`. Safe to restructure independently.
- **Auth gate is a single decorator** — swapping to a class-based mixin or DRF permission is mechanical.

**Risks / things to fix-while-restructuring:**
- **Decide impersonation:** either implement true `request.user` swap (an auth middleware reading `impersonating_user_id` + re-gating + nested-impersonation guard) or rename the feature to "audit-context tagging". Any 1B work assuming real impersonation will break.
- **Decouple feedback idempotency from the audit table** by adding an `idempotency_key`/`event_id` column to `Feedback` (then the audit join becomes optional). This touches a migration + `submit_feedback` + the view pre-check.
- **Session-purge perf:** replace the full-table scan with a session backend that indexes by user (or a `user → session_keys` set in cache) before scale.
- **CSRF consistency + CDN removal** are prerequisites for any "prod-hardening" pass.
- **Audit append-only invariant (PRD #5):** any restructuring that batches/edits audit rows must respect the DB-level UPDATE/DELETE denial — verbs emit one row each; keep that.
- **Middleware ordering:** `SadminIPAllowlistMiddleware` runs last; if restructuring adds earlier middleware that short-circuits `/sadmin/*`, the IP gate could be bypassed — keep it ahead of view execution but aware of auth.

**Ambiguities flagged:** (a) §1.6 says "13 verbs" — the implementation has exactly 13 distinct callables (4 org + 5 user + 2 impersonate + bulk_email + system_health), but only ~11 emit audit rows (system_health is read-only, impersonate_stop pairs with start); the "13" count is by callable, not by audit event-type. (b) The reason ≥20-char rule is documented but unenforced. (c) `SADMIN_HOST` intent is unknown — it may be a planned-but-unbuilt host-segregation gate.
