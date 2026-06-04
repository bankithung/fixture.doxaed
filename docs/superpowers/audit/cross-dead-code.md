# Cross-Cutting Audit: Dead / Unwired Code

Scope: Phase 1A backend (`backend/apps/*`, `backend/fixture/*`) and frontend
(`frontend/src/*`). Excludes `backend/.venv` and `frontend/node_modules`.
Method: Read/Grep/Glob only. Every finding is cited `file:line` with a quoted
snippet and verified to have no production caller (tests noted where relevant).
Date: 2026-06-04.

Definition of "dead code" here: a symbol/file that is defined and exported but
has **no production caller** — i.e. not wired into any URLconf, route, view,
model manager, middleware, settings consumer, or imported by any non-test
module. Items that are *tested but never wired into a runtime path* are called
out as "test-only / unwired" with reduced severity, because they are real
liabilities (give false confidence) but are not strictly orphaned.

---

## Backend findings

### B1. `require_recent_password_reauth` decorator — implemented, never applied (security gap)
- **Severity:** high
- **File:** `backend/apps/accounts/decorators.py:23`
- **Evidence:**
  ```python
  def require_recent_password_reauth(within_minutes: int | None = None):
      """DRF view decorator. 403s with {"detail": "password_reauth_required"} ..."""
  ```
  Grep for callers (non-definition, non-test) returns **zero** results.
  The *write* side exists — `apps/accounts/views.py:284`
  `request.session["last_password_reauth"] = timezone.now().isoformat()` —
  and the setting `SENSITIVE_REAUTH_WINDOW_MINUTES = 5` exists
  (`backend/fixture/settings/base.py:215`), but no view is decorated with it.
- **Why it matters:** v1Users.md Appendix B.18 (quoted in the decorator's own
  docstring) *requires* sensitive verbs (suspend, impersonate, transfer
  ownership, force-disable 2FA, delete Org) to re-prompt for password. The
  enforcement primitive is fully built and the session marker is written on
  reauth, but the gate is never connected — so every "sensitive verb" currently
  ships with the reauth requirement silently unenforced. This is dead code *and*
  an unmet security invariant.
- **Recommendation:** Apply `@require_recent_password_reauth()` to the sensitive
  verb views (`OrgSuspendView`, `OrgTransferOwnershipView`, `OrgArchiveView`,
  `twofa_disable_view`, sadmin impersonate/suspend verbs) or, if intentionally
  deferred, delete the decorator + `SENSITIVE_REAUTH_WINDOW_MINUTES` and remove
  the B.18 claim from "done" until wired.

### B2. `emit_audit_on_commit` — defined, zero references anywhere
- **Severity:** medium
- **File:** `backend/apps/audit/services.py:80`
- **Evidence:**
  ```python
  def emit_audit_on_commit(**kwargs):
      """Defer audit emission until transaction commit. ..."""
      transaction.on_commit(lambda: emit_audit(**kwargs))
  ```
  `grep -rn emit_audit_on_commit apps/` returns only this definition — no
  caller, not even a test.
- **Why it matters:** Invariant #4 ("Redis publish only in
  `transaction.on_commit`") implies an on-commit audit/event helper. This one
  was built to satisfy that shape but is completely unused; every real caller
  uses the inline `emit_audit()`. Dead surface that misleads readers into
  thinking on-commit auditing is in play.
- **Recommendation:** Delete, or wire it where post-commit emission is actually
  required (Phase 1B live/event-log paths). Until then it is pure dead code.

### B3. `apps/organizations/scope.py` — `ScopedQuerySetMixin` / `OrgScopedQuerySet` never imported
- **Severity:** medium
- **File:** `backend/apps/organizations/scope.py:21` and `:53`
- **Evidence:**
  ```python
  class ScopedQuerySetMixin: ...
  class OrgScopedQuerySet(ScopedQuerySetMixin, models.QuerySet): ...
  ```
  `grep -rn` shows these names appear **only** inside `scope.py` itself (class
  bodies + docstring example). No model, manager, view, or test imports them.
  The org models use bespoke managers instead
  (`apps/organizations/models.py:69` `OrganizationManager(models.Manager)`,
  `:80` `OrganizationMembershipManager`).
- **Why it matters:** This is the multi-tenancy scope primitive for invariant #2
  ("default managers filter by accessible orgs"). It is dead, and a *second*,
  live implementation exists at `apps/permissions/scope.py`. Two competing
  scope primitives invites future contributors to wire the wrong one.
- **Recommendation:** Delete `apps/organizations/scope.py` and consolidate on
  `apps/permissions/scope.py` (or vice-versa), then document the single canonical
  scope helper. Note B4 below before deleting the permissions one.

### B4. `permissions/scope.py` `ScopedQuerySet` / `ScopedManager` — test-only, no production model uses it
- **Severity:** medium
- **File:** `backend/apps/permissions/scope.py:38` (`ScopedQuerySet`), `:114` (`ScopedManager`)
- **Evidence:** Non-test production importers = none. References outside the
  definition file are: `apps/permissions/__init__.py` (docstring prose only, not
  a code import) and 8 test references
  (`apps/permissions/tests/test_scope_queryset.py`,
  `test_module_gated_queryset.py`). No model assigns `objects = ScopedManager()`;
  all four managed models use hand-rolled managers
  (`apps/accounts/models.py:91`, `apps/organizations/models.py:145,146,197`).
- **Why it matters:** v1Users.md Appendix B.2's reusable scope-filter pattern is
  implemented and unit-tested but **plugged into nothing**. The tests pass
  against synthetic in-test models, giving false confidence that tenant scoping
  is enforced via this primitive when in fact production relies on bespoke
  managers. This is a tested-but-unwired liability, not strictly orphaned (hence
  medium, not low).
- **Recommendation:** Either adopt `ScopedManager` on the real tenant-scoped
  models (preferred for invariant #2 uniformity) or relabel it explicitly as
  Phase 1B scaffolding and exclude it from "scope enforcement is done" claims.

### B5. Four sadmin DRF serializers defined but never used
- **Severity:** low
- **File:** `backend/apps/sadmin/serializers.py:56` `BulkEmailRequestSerializer`,
  `:68` `BulkEmailResponseSerializer`, `:76` `SystemHealthResponseSerializer`,
  `:84` `FeedbackArchiveResponseSerializer`
- **Evidence:** `grep -rn` shows each appears **only** at its own class
  definition. The endpoints they were written for
  (`apps/sadmin/views/superadmin.py` — `bulk_email_api`, `system_health_api`,
  `archive_feedback_api`) are plain Django views that return raw `JsonResponse`
  and never import these serializers:
  ```python
  # superadmin.py:74
  return JsonResponse({"recipients": ..., "subject": ..., "body": ...}, status=200)
  ```
- **Why it matters:** Dead serializers drift from the actual JSON shapes the
  views emit (no schema contract enforced), and they bloat the module. Only
  `FeedbackSubmitSerializer` / `FeedbackSubmitResponseSerializer` (used in
  `views/feedback.py`) are live.
- **Recommendation:** Delete the four, or convert the three `/sadmin/api/` views
  to DRF `APIView`s with `@extend_schema(request=..., responses=...)` so the
  serializers carry their weight and the OpenAPI schema documents them.

### B6. `emit_usage` writer never called → `UsageEvent` is read-only-with-no-producer
- **Severity:** medium
- **File:** `backend/apps/sadmin/services/usage.py:18`
- **Evidence:**
  ```python
  def emit_usage(...) -> UsageEvent | None:
      ... UsageEvent.objects.create(...)
  ```
  `grep -rn emit_usage` across the whole backend returns only the definition,
  its docstring/log line, and a one-line mention in
  `apps/sadmin/services/__init__.py:9`. No view/middleware/command/signal calls
  it. Yet the dashboard *reads* the table:
  `apps/sadmin/views/dashboard.py:36`
  `"recent_usage": UsageEvent.objects.order_by("-created_at")[:5]`.
- **Why it matters:** The telemetry feature is half-wired — the dashboard's
  "recent usage" panel will always be empty because nothing ever produces a
  `UsageEvent`. `emit_usage` is dead code; the reader is effectively a dead
  panel. (`UsageEvent` is only otherwise touched by a test factory.)
- **Recommendation:** Either call `emit_usage(...)` at the real telemetry points
  (login, org/tournament create, etc.) or remove the writer + the dashboard
  "recent usage" read until Phase 1B wires it.

### B7. `clear_grants` service — exported and tested, no production caller
- **Severity:** low
- **File:** `backend/apps/permissions/services/grants.py:216`
- **Evidence:** References are: definition, re-export in
  `apps/permissions/services/__init__.py:10,17`, and a test
  (`apps/permissions/tests/test_grant_audit.py:152`). No view calls it — the
  matrix UI path uses `bulk_set_grants` / `set_grant`
  (`apps/permissions/views.py`).
- **Why it matters:** Legit, tested service API with no runtime entry point.
  Low risk but worth flagging — if the "clear all grants for a user" verb is a
  product requirement it is currently unreachable from any endpoint.
- **Recommendation:** Add the missing endpoint/verb, or accept it as an
  intentionally-public service API (document as such).

### B8. Two settings flags defined but never read
- **Severity:** low
- **File:** `backend/fixture/settings/base.py:201` `SADMIN_HOST`,
  `:206` `PENDING_ARCHIVE_DAYS`
- **Evidence:**
  ```python
  SADMIN_HOST = env("SADMIN_HOST", default="localhost")
  PENDING_ARCHIVE_DAYS = 30
  ```
  `grep -rn` for each across `fixture/`, `apps/`, `scripts/` returns only the
  definition line. `SADMIN_HOST` is not used to gate the sadmin surface (that's
  done by `SADMIN_IP_ALLOWLIST` middleware, `apps/sadmin/middleware.py`).
  `PENDING_ARCHIVE_DAYS` (30) is never consumed — `archive_org`
  (`apps/organizations/services/lifecycle.py:227`) is a manual verb with no
  time-based auto-purge sweep, and `detect_orphaned` (`:265`) uses no day
  threshold.
- **Why it matters:** Orphan config implies behavior that does not exist
  (host-based sadmin routing; a 30-day pending-archive purge). Misleads ops.
- **Recommendation:** Remove both, or implement the host check / scheduled
  archive sweep they imply. Also note `SENSITIVE_REAUTH_WINDOW_MINUTES:215` is
  only read by the dead decorator in B1 — it becomes live or dead with B1.

---

## Frontend findings

### F1. `features/roles/routes.tsx` (`roleRoutes`) — entire file unused
- **Severity:** medium
- **File:** `frontend/src/features/roles/routes.tsx:19`
- **Evidence:**
  ```tsx
  export const roleRoutes: RouteObject[] = [
    { path: "/o/:orgSlug/scoring", element: <ScorerLandingPage /> },
    ... { path: "/me", ... }, { path: "/me/notifications", ... },
  ];
  ```
  `grep -rn roleRoutes` returns **only** this definition. The file's own
  docstring says it is "Spread into the protected `<AppShell>` route block in
  App.tsx by the AppShell agent (B6)" — but `App.tsx:124-156` hand-codes these
  exact same five `<Route>`s inline and never imports `roleRoutes`.
- **Why it matters:** The route table is duplicated. Any future role route added
  to `roleRoutes` (the file that *claims* to own them) will silently never
  render, because App.tsx is the real source of truth. Classic split-brain dead
  config.
- **Recommendation:** Either spread `roleRoutes` into App.tsx (delete the inline
  duplicates) or delete `routes.tsx` and keep App.tsx authoritative.

### F2. `features/layout/OrgComingSoonPage.tsx` — never imported (dead duplicate)
- **Severity:** low
- **File:** `frontend/src/features/layout/OrgComingSoonPage.tsx:16`
- **Evidence:** `export function OrgComingSoonPage()` — `grep -rn
  OrgComingSoonPage` returns only the definition. App.tsx instead routes
  `ComingSoonPage` from `@/features/errors/ComingSoonPage`
  (`App.tsx:30`, used at `:173`). The file's docstring even claims it is "used
  for tournaments / branding / audit / settings / notifications" — none of which
  route to it.
- **Why it matters:** Two near-identical "coming soon" components; the
  org-scoped one is dead. Maintenance hazard / confusion.
- **Recommendation:** Delete `OrgComingSoonPage.tsx`, or route it for the
  org-scoped placeholders and retire the errors-folder one for those paths.

### F3. `features/orgs/OwnershipTransferModal.tsx` — never imported; transitively kills `ConflictOfInterestBanner`
- **Severity:** medium
- **File:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:41`
  (`export function OwnershipTransferModal`)
- **Evidence:** `grep -rn OwnershipTransferModal` (excluding its own file)
  returns nothing — no page renders it. `OrgSettingsPage.tsx` has **zero**
  references to "transfer" or "ownership" (the logical host). Because this modal
  is the **only** importer of `ConflictOfInterestBanner`
  (`frontend/src/features/permissions/ConflictOfInterestBanner.tsx`, imported at
  `OwnershipTransferModal.tsx:16`), that banner is **transitively dead** too.
- **Why it matters:** A complete ownership-transfer UI (modal + COI banner) was
  built but never surfaced — the backend endpoints exist
  (`OrgTransferOwnershipView`, `OwnershipTransferBySlugView`) so this is a
  shipped-but-unreachable feature, not just stray code. Users cannot transfer
  ownership from the SPA at all.
- **Recommendation:** Wire `OwnershipTransferModal` into `OrgSettingsPage` (the
  spec'd home for it) — that revives both files — or delete both if the feature
  is deferred.

### F4. `types/generated.ts` — production-dead, imported only by its own test
- **Severity:** low
- **File:** `frontend/src/types/generated.ts` (e.g. `:24` `export type ApiUser = Schemas["Me"]`)
- **Evidence:** `grep -rn types/generated` returns exactly one importer:
  `frontend/src/types/__tests__/generated-types.test.ts:20`. No production
  module imports it. The app uses hand-written `types/api.ts` and re-derives
  `Schemas` independently in `api/orgs.ts:6` and `types/user.ts:13`.
- **Why it matters:** An entire file of "ergonomic" type aliases exists solely
  to be exercised by a test that validates aliases nothing consumes — dead
  production code propped up by a test. The file's own docstring admits it is a
  placeholder until `MeSerializer` is widened.
- **Recommendation:** Delete `types/generated.ts` + its test, or actually adopt
  the generated aliases in `api/*` and `types/user.ts` and drop the duplicated
  hand-rolled `Schemas` derivations.

### F5. `routes.notFound` helper — unused (and points at a non-existent path)
- **Severity:** low
- **File:** `frontend/src/lib/routes.ts:10`
- **Evidence:** `notFound: () => "/404"` — `grep -rn "notFound"` (excluding the
  `NotFound` component name and tests) returns only this definition line. No
  caller. There is also no `/404` route in `App.tsx` (the catch-all is `*`), so
  even if called it would mis-navigate.
- **Why it matters:** Dead route helper that, if ever used, would route to a path
  that does not exist. Minor.
- **Recommendation:** Remove `routes.notFound`.

### F6. Duplicate route-helper aliases (`profile`/`myProfile`, `profileNotifications`/`myNotifications`)
- **Severity:** info
- **File:** `frontend/src/lib/routes.ts:41-45`
- **Evidence:**
  ```ts
  profile: () => "/me",
  profileNotifications: () => "/me/notifications",
  myProfile: () => "/me",
  myNotifications: () => "/me/notifications",
  ```
  Both members of each pair are referenced at least once (`profile` 1×,
  `myProfile` 4×; `profileNotifications` 1×, `myNotifications` 3×), so neither is
  strictly dead — but they are redundant aliases for the same URLs.
- **Why it matters:** Not dead, just duplicative — flagged for consistency only.
  Two names for one route is a refactor smell, not a defect.
- **Recommendation:** Collapse to one canonical pair (`myProfile` /
  `myNotifications`) and update the two `profile*` call sites.

---

## Verified NOT dead (checked, ruled out — recorded to prevent re-flagging)

- `apps/sadmin/views/_helpers.py:11` `impersonation_context` — looks unused but
  is called internally by `render_sadmin` (`_helpers.py:46`); live.
- `apps/accounts/throttling.py:21` `SignupRateThrottle` — wired at
  `apps/accounts/views.py:89`.
- `apps/sadmin/middleware.py:51` `SadminIPAllowlistMiddleware` — wired in
  `settings/base.py:73`.
- `apps/audit/services.py:24` `emit_audit` — heavily used.
- `apps/sadmin/services/superadmin_verbs.py` verbs (approve/reject/suspend org,
  suspend/unsuspend user, force_logout_all, etc.) — all wired via
  `apps/sadmin/views/orgs.py` / `users.py`.
- All accounts/organizations/permissions serializers (except B5's four) are
  referenced by their views (directly or nested).
- All sadmin views are exported in `views/__init__.py` and routed in `urls.py`.
- Frontend: `feedbackApi`, `permissionsApi`, `auditApi`, `unwrapList`,
  `useOrgSwitcher`, all `components/ui/*`, `cn`, `getCsrfToken`, `t`, all auth
  pages, `ErrorPage` (used by `ErrorBoundary`) — all consumed.

---

## Gaps (limits of this audit)

1. **No static dead-code tooling run.** Findings are from manual Read/Grep. A
   `ruff --select F401,F811` (backend) and `ts-prune` / `knip` (frontend) pass
   would catch unused *local* imports/vars and unreferenced exports this
   symbol-level sweep does not exhaustively cover (e.g. per-file unused imports,
   unused TS type members). Recommend adding both to CI. Blocking: no.
2. **Template-referenced symbols not fully traced.** sadmin uses Django
   templates (`apps/sadmin/templates/`); a view/context value could be "used"
   only from a `.html` template. I spot-checked `impersonation_context` but did
   not exhaustively cross-reference every template variable against its Python
   producer. A few "read-but-never-written" model fields could hide there.
3. **Migrations not scanned for dead columns/models.** Orphaned DB
   columns/fields (model attributes defined but never read/written outside
   migrations) were out of scope; only `UsageEvent` surfaced incidentally (B6).
4. **Phase 1B intent ambiguity.** B3/B4 (scope primitives), B1
   (reauth decorator), F3 (ownership transfer) may be *deliberate* scaffolding
   staged ahead of wiring. They are reported as dead because nothing references
   them *today*; the fix may be "wire it" rather than "delete it." Confirm
   intent before deletion.
5. **`event_id` idempotency primitive (invariant #3) not audited here** for
   dead/partial wiring — belongs to a dedicated invariants audit, but B6's
   `emit_usage` and B2's `emit_audit_on_commit` suggest other invariant-shaped
   helpers may be similarly stubbed; worth a targeted invariant-by-invariant
   wiring check.
