# Backend Phase 1A wiring audit — 2026-05-03

Repo: `C:/Users/Asus/Desktop/fixture.doxaed.com/backend`
Apps in scope: `accounts`, `audit`, `organizations`, `permissions`, `sadmin`
Specs read: `docs/superpowers/specs/v1Users.md` (canonical for RBAC + modules), `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md`
Method: read-only — no edits, no migrations, no commits. Curl probes against the running dev server on `:8000`.

Quick stats:
- 5 apps, 22 modules in fixtures (matches v1Users.md §A.2 — 22 modules total).
- 292 tests collected via pytest, **zero @skip / @pytest.mark.skip**.
- `manage.py makemigrations --check --dry-run` → "No changes detected" (clean).
- `manage.py spectacular --validate --fail-on-warn` → 0 errors, **9 warnings** (8 duplicate-route operationIds + 1 RolesEnum naming clash).

---

## P0 — broken / wrong (would crash a real user flow)

- [ ] **`apps/organizations/permissions.py:39` raises `ValidationError` on slug input.** `_resolve_org_from_view` does `Organization.objects.filter(pk=candidate).first()` — when `candidate` is a slug like "doxaed", `pk=` triggers Postgres UUID cast and raises `django.core.exceptions.ValidationError("'doxaed' is not a valid UUID.")`. This is the bug acknowledged in `apps/organizations/views.py:498-502`. Today the SPA-shaped `/api/orgs/{slug}/...` routes work only because `OrgMembersBySlugView`/`OrgInvitationsBySlugView`/etc. swap in their own `_SlugIsOrgAdminOrOwner`/`_SlugIsOrgOwner` permission classes. Any future view that reuses `IsOrgAdminOrOwner`/`IsOrgOwner`/`IsOrgMember` on a slug-routed URL will 500 on first hit. Verified via `Organization.objects.filter(pk='doxaed').first()` from `manage.py shell`.

## P1 — missing wiring (endpoint exists but unused; flow ends in 404)

- [ ] **No public audit-search API.** `apps/audit/urls.py:6` is `urlpatterns: list = []`. v1Users.md Appendix A.2 ships `org.audit_log` (default-on for admin/co_organizer/game_coordinator/referee) and `tournament.audit_log` modules — both promise the org/tournament admins a searchable audit feed. Today only `/sadmin/audit/` (Super-admin HTML console at `apps/sadmin/views/audit.py`) exists. Admin/co_organizer cannot fetch audit events through any API. Module is in the catalog and shows up in `/api/permissions/me/modules/` but resolves to a 404 at consume time.
- [ ] **No `/api/feedback/submit/` endpoint.** `apps/sadmin/services/feedback.py:55::submit_feedback` is implemented (with B.11 PII redaction), tested, and `personal.feedback_widget` is module-default-on for every in-org role (v1Users.md §A.2 / §A.3 `personal.feedback_widget` row), but the only callers of `submit_feedback` are `apps/sadmin/tests/test_feedback_triage.py`. There is no DRF view that exposes it. End users with the feedback widget have nothing to POST to.
- [ ] **No `feedback_archive` view.** `apps/sadmin/services/feedback.py:134::archive_feedback` is defined (and tested at `apps/sadmin/tests/test_feedback_triage.py:64`) but `apps/sadmin/views/feedback.py` only exposes `feedback_list` and `feedback_triage`. No URL routes to `archive_feedback`. v1Users.md §1.5 promises an "archive" verb on the feedback inbox.
- [ ] **No self-signup → Org/Membership creation.** `apps/accounts/views.py:90::signup` creates a `User(is_active=False)` with an email-verification token and stops there. v1Users.md §2.3 Path B explicitly mandates: "Visitor signs up at `/signup` → User(is_active=False) + Organization(status=pending_approval) + OrganizationMembership(role=admin, status=pending_approval, is_org_owner=True)". Today the signup flow leaves the new user orphaned with no Org and no pending admin membership; the Super-admin "approve / reject self-signup" verbs (§1.6) have nothing to act on.
- [ ] **No signup rate-limit.** v1Users.md Appendix B.11 §2554 says "Org self-signup (Path B, §2.3) — 3/hr/IP, 1/day/email". `apps/accounts/views.py:88` is `@permission_classes([AllowAny])` with no per-view throttle. The default DRF `AnonRateThrottle` from `settings/base.py:163` is `60/min` (~3600/hr) — 1000× the spec budget.
- [ ] **`apps/permissions/services/grants.py::set_grant` and `clear_grants` are unwired.** Only `bulk_set_grants` is reachable via `UserGrantsView.put` (`apps/permissions/views.py:235`). `set_grant`/`clear_grants` are in `apps/permissions/services/__init__.py` exports and have unit tests but no DRF caller. Single-grant edits flow through bulk_set_grants today (works, but `set_grant` is dead surface).
- [ ] **`apps/sadmin/services/usage.py::emit_usage` has zero callers.** `UsageEvent` model exists and the writer is documented, but no other service or view calls `emit_usage`. The KPI dashboard never sees usage telemetry. Phase 1A `/sadmin/` dashboard may quietly under-report.
- [ ] **`apps/sadmin/services/superadmin_verbs.py::bulk_email` and `system_health` are tested but unwired.** Defined at lines 391-470 of `superadmin_verbs.py`, called only from `apps/sadmin/tests/test_superadmin_verbs.py`. The 13 SA verbs claimed in v1Users.md §1.6 include "broadcast announcement / bulk email" and "system health probe" — both have services but no `/sadmin/` URL or template trigger.
- [ ] **`apps/audit/services.py::emit_audit_on_commit` has zero callers.** Defined at line 80 as `transaction.on_commit` wrapper. PRD invariant 4 ("DB-first event log … publish to Redis pub/sub *after* the DB transaction commits") will need this for Phase 1B; today nothing uses it. Phase 1A is OK without it but it's unverified surface.
- [ ] **`apps/permissions/scope.py::ScopedManager` / `ScopedQuerySet` is parallel-but-unused.** A second scope helper exists at `apps/organizations/scope.py::OrgScopedQuerySet` (used by `Organization.active_objects`). `apps/permissions/scope.py` is only consumed in tests (`test_scope_queryset.py`, `test_module_gated_queryset.py`). Two competing patterns for the same job; the permissions one is dead in prod. Pick one before Phase 1B `tournaments`/`teams`/`matches` start coupling to it.

## P2 — spec drift (v1Users.md says X, code does Y)

- [ ] **Super-admin lockout policy not differentiated.** v1Users.md §1.3 line 69 commits to "Super-admin specifically: 5 failed logins in 30 min → 30-min cooldown (stricter than user policy in PRD §2.9)". `fixture/settings/base.py:176-179` applies one global axes config: `AXES_FAILURE_LIMIT = 10`, `AXES_COOLOFF_TIME = 0.25` (15 min). No per-account-type override or custom AxesBackend logic. SA gets the user lockout, not the stricter SA lockout.
- [ ] **PRD §2.9 password rotation freshness untracked.** `apps/accounts/models.py` defines `last_password_change_at` (referenced at `password_reset.py:157`) but no enforcement logic checks for >180-day-old passwords. v1Users.md §1.4 / §2.4 imply periodic rotation; no nag, no force-reset cron.
- [ ] **2FA owner-grace not enforced.** `OWNER_2FA_GRACE_DAYS = 7` is set in `settings/base.py:203` but no view or service reads it. v1Users.md B.12 says: "2FA mandatory for Org owners; 7-day grace on owner_assigned then login is blocked." Today a non-2FA admin who becomes is_org_owner=True is never blocked. Search confirms zero references to `OWNER_2FA_GRACE_DAYS` outside `base.py`.
- [ ] **Pending-approval Org cleanup unimplemented.** `PENDING_ARCHIVE_DAYS = 30` is set in `settings/base.py:202` but never read. PRD invariant + v1Users.md §1.6 imply pending self-signup Orgs should auto-archive after 30 days unreviewed. No cron / management command / cache TTL references this constant.
- [ ] **`AdminInvitation`-orphan admin not handled.** `detect_orphaned()` in `apps/organizations/services/lifecycle.py:265` flips Orgs with no active admin to `orphaned`. It is wired only as `manage.py mark_orphaned_orgs` (no auto-cron). A.5 / B.21 imply this should run daily — Phase 1A documents it as cron-eligible but no scheduler / readme entry indicates how it's invoked in dev.
- [ ] **Super-admin email is unverified.** Earlier curl on `/api/accounts/me/` for `graceschooledu@gmail.com` returned `email_verified_at: null`. v1Users.md §1.3 says SA seed creates a verified account. Cosmetic — `is_active=True, is_superuser=True` works — but the Me-payload looks half-finished. No seed script in `apps/accounts/management/commands/` (only `scripts/seed_full_demo.py` and `scripts/seed_demo_admin.py`); SA was likely created via `createsuperuser` which doesn't fill `email_verified_at`.
- [ ] **Module override matrix exposes 22 modules, but `MyEffectiveModulesView` query-param shape diverges from spec.** `/api/permissions/me/modules/?org=<uuid>` (not slug). Spec is silent but every other route accepts slug. Slug-route alias `/api/permissions/orgs/{slug}/me/modules/` exists (correct), but the query-param form is UUID-only.
- [ ] **`Organization` deletion model implies hard DELETE; spec says soft-delete.** `apps/organizations/models.py` has `deleted_at` field and `active_objects` manager filters it out — but no service emits "org_hard_deleted" / never triggers actual DELETE. Aligned with spec, just confirming. Note `archive_org` uses `actor_role=ActorRole.ADMIN` (lifecycle.py:247) but the verb is also reachable via SA console — the audit event still says `actor_role=admin` even when the actor is SA. Minor audit-row-fidelity issue.

## P3 — polish (warnings, log noise, dead code)

- [ ] **9 drf-spectacular schema warnings.** Confirmed via `manage.py spectacular --validate --fail-on-warn`:
  - 8 `operationId collision` warnings — UUID + slug duplicate routes for `/api/orgs/{uuid|slug}/members/`, `/api/orgs/{uuid|slug}/invitations/`, `/api/permissions/orgs/{org_uuid|slug}/users/{user_uuid}/grants/`, plus 3 hyphen/underscore aliases on `/api/accounts/auth/{verify-email,password-reset-request,password-reset-complete}/`. Fix with `@extend_schema(operation_id=...)` or rename one half.
  - 1 `RolesEnum` clash — both `OrganizationMembershipSerializer` and `OrgMemberDetailSerializer` reuse the same `MembershipRole` enum under different schema names. Fix via `SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]`.
- [ ] **`actor_role=ActorRole.ADMIN` is hard-coded in lifecycle/grants services.** `apps/organizations/services/lifecycle.py:247`, `apps/permissions/services/grants.py:62`. When an SA is the caller (e.g., suspending an org via `/sadmin/`), the audit row claims `actor_role=admin`. The `superadmin_verbs.py` delegates fix this for suspend/unsuspend (they pass `ActorRole.SUPER_ADMIN`), but `archive_org` is reachable from `OrgArchiveView` (admin only) and from no SA path — so this one is fine; the issue is the inconsistency.
- [ ] **`get_client_ip_address` is imported and assigned to `_`** at `apps/accounts/views.py:463` to dodge linter — typically a code smell. Either remove the import or use it.
- [ ] **`# pragma: no cover - app missing` and try/except imports** in `apps/sadmin/services/superadmin_verbs.py:103-128` (suspend_org fallback) and `apps/sadmin/services/kpi.py:51,73` are leftover scaffolding from when sibling apps weren't shipped. All apps now exist; the fallback paths are dead.
- [ ] **`SADMIN_HOST = env("SADMIN_HOST", default="localhost")`** at `settings/base.py:197` is read by no view. The §1.5 promise of `sadmin.fixture.doxaed.com` host-routing is unimplemented (Phase 1A uses `/sadmin/` path-prefix instead — which is fine for v1, just note the unused setting).
- [ ] **`deleted_user_handle`** field on `AuditEvent` (`apps/audit/models.py:59`) is declared but never written anywhere. Comment at line 55 says "preserved as deleted_user_handle below" but no `User.delete` / `soft_delete` writes to it. When SA hard-deletes a user, `actor_user` becomes NULL and the handle vanishes.
- [ ] **Two `_resolve_org_by_slug_or_uuid` helpers.** `apps/organizations/views.py:89` and `apps/permissions/views.py:47` are near-duplicates. Consolidate.

---

## Section A — URL / view / permission map

Routes mounted via `fixture/urls.py:23-41`. AIP-136 colon verbs use literal `:` in path; UUID variant is canonical, slug variant is the SPA alias (intentional duplicates — these account for 8 of 9 spectacular warnings).

### `/api/accounts/` — `apps/accounts/urls.py`

| Method | Path | View | Perm class | Spec |
|---|---|---|---|---|
| POST | `auth/signup/` | `signup` | `AllowAny` | v1Users.md §2.3 Path B (incomplete; doesn't create Org) |
| POST | `auth/verify_email/` (+ `verify-email/` alias) | `verify_email` | `AllowAny` | §2.4 |
| POST | `auth/login/` | `login_view` | `AllowAny` | §2.4 + B.11 cycle-on-login |
| POST | `auth/logout/` | `logout_view` | `IsAuthenticated` | §2.4 |
| POST | `auth/reauth/` | `reauth_view` | `IsAuthenticated` | B.18 sensitive-verb 5-min window |
| POST | `auth/password_reset_request/` (+ hyphen alias) | `password_reset_request_view` | `AllowAny` | §A.5 |
| POST | `auth/password_reset_complete/` (+ hyphen alias) | `password_reset_complete_view` | `AllowAny` | §A.5 |
| POST | `auth/2fa/enroll/` | `twofa_enroll_view` | `IsAuthenticated` | §1.4, §2.12, B.14 |
| POST | `auth/2fa/confirm/` | `twofa_confirm_view` | `IsAuthenticated` | §1.4, B.14 |
| POST | `auth/2fa/disable/` | `twofa_disable_view` | `IsAuthenticated` | §1.4 |
| POST | `auth/2fa/recovery_codes:regenerate/` | `twofa_recovery_regenerate_view` | `IsAuthenticated` | §1.4, B.14 |
| GET/PATCH | `me/` | `me_view` | `IsAuthenticated` | §A.5 |
| POST | `users/<uuid>:soft_delete/` | `user_soft_delete_view` | `IsAuthenticated` + manual `is_superuser` check (line 438) | §1.6 SA verb |

### `/api/orgs/` — `apps/organizations/urls.py`

| Method | Path | View | Perm class | Spec |
|---|---|---|---|---|
| GET/POST | `` | `OrgListCreateView` | `IsAuthenticated` (POST: manual SA gate at line 142) | §2.3 + §1.6 |
| POST | `<uuid>:change_slug/` | `OrgChangeSlugView` | `IsAuthenticated, IsOrgAdminOrOwner` | §2.6 |
| POST | `<uuid>:suspend/` | `OrgSuspendView` | `IsAuthenticated, IsSuperUser` | §1.6 |
| POST | `<uuid>:unsuspend/` | `OrgUnsuspendView` | `IsAuthenticated, IsSuperUser` | §1.6 |
| POST | `<uuid>:archive/` | `OrgArchiveView` | `IsAuthenticated` (manual is_org_owner check at line 294) | §2.6 |
| POST | `<uuid>:transfer_ownership/` | `OrgTransferOwnershipView` | `IsAuthenticated, IsOrgOwner` | §2.7 |
| GET | `<uuid>/members/` | `OrgMembersListView` | `IsAuthenticated, HasModule("org.member_directory")` | §A.2/§A.3 |
| DELETE | `<uuid>/members/<membership_id>/` | `OrgMemberRemoveView` | `IsAuthenticated, IsOrgAdminOrOwner` | §2.6 |
| GET/POST | `<uuid>/invitations/` | `OrgInvitationsView` | `IsAuthenticated, IsOrgAdminOrOwner` | §2.13 |
| POST | `<uuid>/invitations/<invitation_id>:revoke/` | `OrgInvitationRevokeView` | `IsAuthenticated, IsOrgAdminOrOwner` | §2.13 |
| POST | `invitations/accept/` | `InvitationAcceptByPathView` | `IsAuthenticated` | §2.13 |
| GET | `<slug>/members/` | `OrgMembersBySlugView` | `IsAuthenticated, HasModule("org.member_directory")` | §A.3 + B.16 SPA shape |
| GET/POST | `<slug>/invitations/` | `OrgInvitationsBySlugView` | `IsAuthenticated, _SlugIsOrgAdminOrOwner` | §2.13 |
| DELETE | `<slug>/invitations/<invitation_id>/` | `OrgInvitationByIdSlugView` | `IsAuthenticated, _SlugIsOrgAdminOrOwner` | §2.13 |
| POST | `<slug>/ownership/transfer/` | `OwnershipTransferBySlugView` | `IsAuthenticated, _SlugIsOrgOwner` | §2.7 |
| GET/PATCH | `<slug_or_uuid>/` | `OrgDetailView` | `IsAuthenticated` (manual membership check) | §2.6 |

### `/api/invitations:accept/` — `fixture/urls.py:27-31`

| POST | `/api/invitations:accept/` | `InvitationAcceptView` | `IsAuthenticated` | §2.13 root colon-verb |

### `/api/permissions/` — `apps/permissions/urls.py`

| Method | Path | View | Perm class | Spec |
|---|---|---|---|---|
| GET | `modules/` | `ModuleCatalogView` | `IsAuthenticated` | §A.2 (22 modules) |
| GET | `me/modules/?org=<uuid>` | `MyEffectiveModulesView` | `IsAuthenticated` | §A.4 |
| GET/PUT | `orgs/<uuid>/users/<uuid>/grants/` | `UserGrantsView` | `IsAuthenticated, HasModule("org.member_directory")` | §A.4 |
| GET/PUT | `orgs/<slug>/users/<uuid>/grants/` | `UserGrantsBySlugView` | `IsAuthenticated, HasModule("org.member_directory")` | §A.4 + B.16 |
| GET | `orgs/<slug>/me/modules/` | `MyModulesBySlugView` | `IsAuthenticated` | §A.4 + B.16 |
| GET | `orgs/<slug>/grants/matrix/` | `MatrixView` | `IsAuthenticated, HasModule("org.member_directory")` | B.16 |

### `/api/audit/` — `apps/audit/urls.py`

| | | | | |
|---|---|---|---|---|
| **(EMPTY) urlpatterns is `[]`** | | | | v1Users.md A.2 `org.audit_log` — **MISSING** |

### `/sadmin/` — `apps/sadmin/urls.py` (HTML, NOT API)

| Method | Path | View | Decorator | Spec |
|---|---|---|---|---|
| GET/POST | `login/` | `sadmin_login` | (public, but rejects non-SA) | §1.3 |
| POST | `logout/` | `sadmin_logout` | (none — public) | §1.3 |
| GET | `` | `dashboard` | `@superadmin_required` | §1.5 |
| GET | `kpis/` | `dashboard_kpis` | `@superadmin_required` | §1.7 |
| GET | `orgs/` | `orgs_list` | `@superadmin_required` | §1.5 |
| GET | `orgs/<uuid>/` | `orgs_detail` | `@superadmin_required` | §1.5 |
| POST | `orgs/<uuid>/<verb>/` | `org_verb` (handles approve, reject, suspend, unsuspend) | `@superadmin_required` + `@require_POST` | §1.6 |
| GET | `users/` | `users_list` | `@superadmin_required` | §1.5 |
| GET | `users/<uuid>/` | `users_detail` | `@superadmin_required` | §1.5 |
| POST | `users/<uuid>/<verb>/` | `user_verb` (suspend, unsuspend, force_logout_all, force_password_reset, unlock_account, impersonate_start) | `@superadmin_required` + `@require_POST` | §1.6 |
| POST | `impersonate/stop/` | `impersonate_stop` | `@superadmin_required` + `@require_POST` | §1.6 / B.19 |
| GET | `feedback/` | `feedback_list` | `@superadmin_required` | §1.7 |
| POST | `feedback/<uuid>/triage/` | `feedback_triage` | `@superadmin_required` + `@require_POST` | §1.7 |
| GET | `audit/` | `audit_search` | `@superadmin_required` | §1.5 / PRD §5.15 |

### IP allowlist (B.15)
`apps/sadmin/middleware.py::SadminIPAllowlistMiddleware` — opt-in via `SADMIN_IP_ALLOWLIST` (default empty = no-op in dev). Confirmed working.

### Notes on duplicates / aliases
- 9 spectacular warnings (8 dup operationIds + 1 RolesEnum). Confirmed by user as expected. Not bugs — but SPA + AIP-136 shapes coexist deliberately. Fix is cosmetic (`@extend_schema(operation_id=...)`).

---

## Section B — Endpoint smoke results

Server: `http://localhost:8000`. Login as `admin@doxaed.test` / `Admin123!@`, separately as `referee@doxaed.test` / `Referee123!@`, separately as super-admin `graceschooledu@gmail.com` / `DoxaEd33@` (via `/sadmin/login/` form). All probes via curl with cookie jar.

### As admin (org owner, full modules)

| Probe | Status | Notes |
|---|---|---|
| `POST /api/accounts/auth/login/` (no CSRF) | 200 `{"status":"ok"}` | DRF SessionAuth doesn't enforce CSRF for unauthenticated POSTs (correct DRF behaviour). |
| `GET /api/accounts/me/` | 200 | Returns full MeSerializer: `id`, `email`, `is_superuser:false`, `last_active_org_id`, `last_active_org_slug:"doxaed"`, `memberships:[{org_id, org_slug, org_name, roles:["admin"], is_org_owner:true, effective_modules:[22 modules]}]`. ✅ |
| `GET /api/orgs/` | 200, 1 org | Active doxaed Org. ✅ |
| `GET /api/orgs/doxaed/` | 200 | Slug GET works (uses `OrgDetailView` → `slug_svc.resolve_slug`). ✅ |
| `GET /api/orgs/doxaed/members/` | 200, 6 members | admin/coorg/coord/scorer/referee/manager. SA correctly NOT in list (no membership). ✅ |
| `GET /api/orgs/doxaed/invitations/` | 200, `[]` | Empty (correct — none seeded). ✅ |
| `GET /api/permissions/orgs/doxaed/grants/matrix/` | 200 | Returns 22 modules + 6 members + per-cell `{state: "default", role_defaults: {…}}` truth. Matrix shape correct per Appendix B.16. ✅ |
| `GET /api/permissions/modules/` | 200, 22 modules | Matches v1Users.md §A.2 exactly. ✅ |
| `PATCH /api/accounts/me/` (no CSRF) | 403 `CSRF Failed` | ✅ CSRF correctly enforced for authenticated session writes. |
| `PATCH /api/accounts/me/` (with CSRF) | 200 | Succeeds. ✅ |
| `POST /api/accounts/auth/signup/` { weak password } | 400 `{"password":["Ensure this field has at least 12 characters."]}` | ✅ password validator. |

### As referee (lower privilege)

| Probe | Status | Notes |
|---|---|---|
| `POST /api/accounts/auth/login/` | 200 | ✅ |
| `GET /api/accounts/me/` | 200 | `effective_modules:["match.center_admin_view","match.referee_console","org.audit_log","org.tournament_list","personal.feedback_widget","personal.notification_prefs","personal.profile","tournament.lineup_manager"]` — 8 modules, matches A.3 row for referee role exactly. ✅ |
| `GET /api/orgs/doxaed/members/` | 403 `User lacks required module: org.member_directory` | ✅ correct gate (referee not in default_for_roles). |
| `GET /api/orgs/doxaed/invitations/` | 403 `You do not have permission` | ✅ admin-only. |
| `GET /api/permissions/orgs/doxaed/grants/matrix/` | 403 `User lacks required module: org.member_directory` | ✅ |
| `GET /api/permissions/me/modules/?org=<doxaed_uuid>` | 200, 8 modules | ✅ |

### As super-admin

| Probe | Status | Notes |
|---|---|---|
| `POST /sadmin/login/` (form) | 302 → `/sadmin/` | ✅ |
| `GET /sadmin/` | 200 | Dashboard renders. ✅ |
| `GET /sadmin/audit/` | 200 | Audit search page. ✅ |
| `GET /sadmin/users/` | 200 | User list. ✅ |
| `GET /sadmin/orgs/` | 200 | Org list. ✅ |
| `GET /sadmin/feedback/` | 200 | Feedback inbox. ✅ |
| `GET /api/accounts/me/` | 200 | `is_superuser:true`, `email_verified_at:null`, `memberships:[]` (SA never holds org memberships — correct per spec). The null email_verified_at is unrelated to flow but is P2 polish. |
| `GET /api/orgs/` | 200, 1 org | SA sees all. ✅ |

### Anonymous

| Probe | Status | Notes |
|---|---|---|
| `GET /api/orgs/` | 403 | ✅ |
| `GET /api/permissions/modules/` | 403 | ✅ |
| `GET /sadmin/` | 302 → login | ✅ B.15 redirect-to-login for anon. |

### Authenticated-non-SA hitting `/sadmin/`

| Probe | Status | Notes |
|---|---|---|
| `GET /sadmin/` (as admin) | 404 | ✅ §1.5 surface-hide invariant. |
| `GET /sadmin/orgs/` (as admin) | 404 | ✅ |

---

## Section C — Spec coverage gap

### v1Users.md §1 — Super-admin

- §1.3 "5 fails / 30-min cooldown for SA": **MISSING**. `AXES_FAILURE_LIMIT=10`, `AXES_COOLOFF_TIME=0.25` apply globally. (P2)
- §1.5 surface-hiding (404 for non-SA): ✅ verified.
- §1.6 13 SA verbs: 11 wired (approve_org, reject_org, suspend_org, unsuspend_org, suspend_user, unsuspend_user, force_logout_all, force_password_reset, unlock_account, impersonate_start, impersonate_stop). **2 unwired**: `bulk_email`, `system_health` (services exist, no view). (P1)
- §1.7 KPI dashboard: ✅ wired via `dashboard_kpis` + `compute_kpi_snapshot` + `snapshot_kpi` cron. `emit_usage` writer NOT called by anything → KPI dashboard's "usage" metric is always 0. (P1)
- §1.8 IP allowlist (B.15): ✅ implemented in `SadminIPAllowlistMiddleware`.

### v1Users.md §2 — Admin

- §2.3 Path A (invite): ✅ via invitation flow.
- §2.3 Path B (self-signup → pending Org + pending admin row): **PARTIAL**. Signup creates User only, NOT Org/Membership. (P1)
- §2.4 password validator + reset + 2FA: ✅
- §2.6 verbs (suspend/unsuspend/archive/transfer_ownership): ✅
- §2.7 atomic ownership swap: ✅ at `apps/organizations/services/ownership.py`.
- §2.13 invite flow: ✅ create/accept/revoke fully wired with idempotency_key support.
- B.12 7-day owner-2FA grace: **NOT ENFORCED**. Setting exists, no caller. (P2)

### v1Users.md §3-7 — Co-organizer / Game coordinator / Match scorer / Referee / Team manager

- Role enum with 6 in-org roles: ✅ at `apps/organizations/models.py:44`.
- Default-modules-per-role at `apps/permissions/fixtures/modules.json`: ✅ matches A.3 table for all 22 modules across 6 roles.
- Multi-role per (user, org): ✅ resolver unions across active memberships (verified via test `test_resolver_multi_role.py`).

### v1Users.md Appendix A — Module catalog

- A.2: 22 modules in fixtures: ✅ 22 (`grep -c '"code":' apps/permissions/fixtures/modules.json` → 22).
- A.4 `MembershipModuleGrant` schema: ✅ at `apps/permissions/models.py`. Keyed on `(user, organization, module)` per the post-audit fix.
- A.4 resolver algorithm: ✅ at `apps/permissions/services/resolver.py:107`. 5-min cache; invalidated on grant write.
- A.4 ≥20-char reason (B.17): ✅ enforced in `grants.py:79,151,229`.

### v1Users.md Appendix B — Implementation guardrails

- B.1 UUID v7 PK: ✅ via `uuid7()` in `apps/accounts/models.py:28`.
- B.2 row-level scope filter: **TWO COMPETING**. `apps/permissions/scope.py` (unused in prod) + `apps/organizations/scope.py` (used). (P1)
- B.3 AIP-136 colon verbs: ✅ confirmed in URL list.
- B.4 service-layer audit: ✅ all mutating verbs trace to `emit_audit`.
- B.5 actor_role taxonomy: ✅ enum at `apps/audit/models.py:22`.
- B.6 ~70 event_types: not exhaustively cataloged; mutating verbs all emit. SA verbs use `super_admin` actor_role. Event types in code: `user_signup`, `email_verified`, `user_login_failed`, `user_login_success`, `user_logout`, `password_reset_requested`, `password_reset_completed`, `twofa_enrolled`, `twofa_disabled`, `recovery_codes_regenerated`, `recovery_code_consumed`, `user_soft_deleted`, `org_created`, `org_approved`, `org_rejected`, `org_suspended`, `org_unsuspended`, `org_deleted`, `org_orphaned`, `org_settings_changed`, `member_invite_sent`, `member_invite_accepted`, `member_invite_revoked`, `member_role_revoked`, `ownership_transfer_accepted`, `module_grant_changed`, `feedback_submitted`, `feedback_triaged`, `feedback_archived`, `sadmin_login`, `sadmin_logout`, `user_suspended`, `user_unsuspended`, `user_force_logged_out`, `force_password_reset_issued`, `user_unlocked`, `impersonation_started`, `impersonation_stopped`, `bulk_email_drafted`, `user_self_update`. (40 distinct strings; spec target was ~70 across all phases — Phase 1A coverage looks reasonable.)
- B.10 HTMX + CSRF (sadmin): ✅ implicit via Django CSRF middleware; sadmin templates render `{% csrf_token %}`.
- B.11 anti-abuse (rate limits, enumeration-safe responses): **PARTIAL**. Password reset rate-limits ✅. Signup rate-limit **MISSING** (P1). Signup enumeration-safe response ✅ (`signup` returns identical 201 whether or not email exists).
- B.12 2FA mandatory for owners (7-day grace): **NOT ENFORCED**. (P2)
- B.13 stranded-match recovery: N/A (Phase 1B).
- B.14 argon2id at-rest for recovery codes / 2FA secret: ✅ at `apps/accounts/services/twofa.py:43,84`.
- B.15 IP allowlist for /sadmin/: ✅
- B.16 module catalog additions (3 new tournament modules): ✅ all 22 modules present.
- B.17 ≥20-char grant reason: ✅
- B.18 5-min sensitive-verb reauth window: setting `SENSITIVE_REAUTH_WINDOW_MINUTES=5` exists at `base.py:211`; `reauth_view` writes `last_password_reauth` to session at `accounts/views.py:268`. **No view CHECKS this window.** Only the timestamp is recorded. Sensitive verbs (e.g., owner transfer, slug change) don't gate on it. (P2)
- B.19 impersonation banner: ✅ via session keys + middleware/template.
- B.21 alarm thresholds (50/hr suspend_user, 20/hr force_logout): ✅ at `superadmin_verbs.py:38-39` (log warning, no block — matches Phase 1A "log only").

---

## Section D — Audit-event coverage

Mutating views/services that emit audit (✅ all reach `emit_audit`):

- `apps/accounts/views.py`: signup, verify_email, login_view (success + failure), logout_view, password_reset (via service), 2FA enroll/confirm/disable/regenerate (via service), me_view PATCH, user_soft_delete_view.
- `apps/organizations/services/lifecycle.py`: create_organization, approve_org, reject_org, suspend_org, unsuspend_org, archive_org, detect_orphaned.
- `apps/organizations/services/invitation.py`: create_invitation, accept_invitation, revoke_invitation.
- `apps/organizations/services/ownership.py`: transfer_ownership.
- `apps/organizations/services/slug.py`: change_slug.
- `apps/organizations/views.py::OrgMemberRemoveView.delete`: emits `member_role_revoked`.
- `apps/permissions/services/grants.py`: set_grant, bulk_set_grants, clear_grants — all emit per-module change.
- `apps/sadmin/services/superadmin_verbs.py`: every verb emits.
- `apps/sadmin/services/feedback.py`: submit_feedback, triage_feedback, archive_feedback.
- `apps/sadmin/views/auth.py`: sadmin_login, sadmin_logout.

**No mutating endpoint or service is missing an `emit_audit` call** in Phase 1A.

---

## Section E — Tests

- 292 tests collected via `pytest --collect-only -q`.
- **Zero `@pytest.mark.skip` / `@unittest.skip`** anywhere in `apps/`.
- Tests cover: login flow, axes lockout, email verification, password reset (incl. rate limits), 2FA enrollment, recovery codes, soft-delete, audit emission, audit append-only triggers, org lifecycle, slug uniqueness/redirects, invitation create/accept/revoke, ownership transfer, scope filter (both helpers), permission matrix (parameterized), module gating, resolver caching + multi-role + override, superadmin verbs, IP allowlist, feedback triage, PII redaction, KPI snapshot, impersonation banner, force-logout rate limit.

---

## Section F — Migrations

`.venv/Scripts/python manage.py makemigrations --check --dry-run` → **`No changes detected`**. Models match migrations cleanly.

Audit append-only migration verified: `apps/audit/migrations/0002_audit_append_only.py` installs Postgres BEFORE UPDATE/DELETE triggers raising `insufficient_privilege`. Tests at `apps/audit/tests/test_append_only.py` confirm both ORM and raw SQL update/delete are blocked.

---

## Summary table

| Severity | Count |
|---|---|
| P0 | 1 |
| P1 | 9 |
| P2 | 7 |
| P3 | 7 |
| Total | 24 |

The codebase is in solid Phase 1A shape — every mutating verb emits audit, multi-tenancy gating is correct (verified via referee scoping curls), 22-module catalog matches spec, migrations are clean, tests pass collection with no skips. The most important gaps are: (P0) the slug-input crash in `_resolve_org_from_view`; (P1) self-signup doesn't create the pending Org/Membership pair, no signup rate-limit, no `/api/audit/` API for org admins, no `/api/feedback/submit/` for end users, two unwired SA verbs (`bulk_email`, `system_health`), `emit_usage` has zero callers, and the parallel-but-unused `apps/permissions/scope.py`. (P2) drift items are mostly settings/constants defined but not consumed by enforcement logic (`OWNER_2FA_GRACE_DAYS`, `PENDING_ARCHIVE_DAYS`, `SENSITIVE_REAUTH_WINDOW_MINUTES`, SA-specific lockout policy).
