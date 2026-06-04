# Cross-cutting audit — Invariant 12 (Permission-matrix RBAC)

**Scope:** Whole backend + frontend (excl. `backend/.venv`, `frontend/node_modules`).
**Invariant under test (inv-12):** 22-module catalog loaded; `MembershipModuleGrant`
override layer; default-deny resolver (`effective_modules`); parametrized matrix
tests exist; modules govern surface visibility, row-level matrix governs verbs.
**Date:** 2026-06-04
**Verdict:** Invariant 12 is **substantially IMPLEMENTED and well-tested for Phase 1A.**
The 22-module catalog, `(user, organization, module)` override model, default-deny
union resolver, DRF `HasModule` gate, scoped/module-gated querysets, the B.16 matrix
endpoint, and a fully parametrized `(role × module)` matrix test all exist and are
wired into real endpoints. Findings below are mostly correctness hardening + Phase-1B
prep gaps; none of the 1A pieces *block* Phase 1B. No critical RBAC bypass found.

---

## Findings

### F1 — Resolver `is_authenticated` guard defaults to **True** (fail-open for malformed user objects)
- **Severity:** medium
- **Category:** correctness / default-deny invariant
- **File:** `backend/apps/permissions/services/resolver.py:113`
- **Evidence:**
  ```python
  if user is None or not getattr(user, "is_authenticated", True):
      return frozenset()
  ```
- **Why it matters:** inv-12 is "default-deny." Every *other* guard in the codebase
  defaults the `is_authenticated` getattr to **False** (fail-closed) —
  `permissions.py:41` (`getattr(user, "is_authenticated", False)`),
  `scope.py:55` and `scope.py:70` (`getattr(..., False)`),
  `organizations/permissions.py:80` (`False`). Only the resolver defaults to **True**.
  A user-like object missing the attribute would be treated as authenticated and get a
  resolved module set. In practice `request.user` is always a Django `User`/`AnonymousUser`
  (which have the attribute), so exploitability is low, but it is an inconsistency that
  violates the fail-closed convention and could bite a future call site that passes a
  partial/mock user.
- **Recommendation:** Change the default to `False`:
  `if user is None or not getattr(user, "is_authenticated", False):`.

### F2 — `HasModule` org-resolution swallows all exceptions and silently denies (and `IsOrgAdminOrOwner` fail-OPENs when org unresolved)
- **Severity:** medium
- **Category:** RBAC robustness / inconsistent fail posture
- **Files:**
  - `backend/apps/permissions/permissions.py:61-65` — `HasModule.get_organization()` path:
    ```python
    if hasattr(view, "get_organization"):
        try:
            return view.get_organization()
        except Exception:
            return None
    ```
    (returns `None` → `has_permission` returns False → fail-closed, OK)
  - `backend/apps/organizations/permissions.py:85-89` — `_OrgMembershipPermission`:
    ```python
    org = _resolve_org_from_view(view)
    if org is None:
        # Resource-level views without an org slug pass through here ...
        return True
    ```
- **Why it matters:** The two permission families have **opposite** fail postures when the
  org can't be resolved. `HasModule` fails **closed** (deny). `IsOrgAdminOrOwner` /
  `IsOrgMember` fail **open** (allow, deferring to queryset-layer filtering). The
  override-management views (`UserGrantsView`, `MatrixView`,
  `views.py:150` / `views.py:354`) rely on `IsOrgAdminOrOwner` for the admin-only gate.
  For these views the org *is* always in `kwargs` (`org_uuid` or `slug`), so the
  fail-open branch is not currently reached — but it is a latent foot-gun: if a future
  route mounts `MatrixView`/`UserGrantsView` without an org kwarg, the admin gate
  silently disappears and any authenticated user passes the permission check.
- **Recommendation:** For the override-management views, do **not** depend on the
  fail-open base class. Either (a) make `IsOrgAdminOrOwner` fail-closed when an org
  kwarg is present but unresolvable, or (b) have these specific views assert
  `get_organization() is not None` before serving. Add a regression test:
  "MatrixView with no resolvable org → 403/404, never 200."

### F3 — Grant-write idempotency (`event_id`) accepted but ignored — violates inv-3 on an RBAC mutation path
- **Severity:** medium
- **Category:** idempotent-writes invariant (inv-3) intersecting RBAC writes
- **Files:**
  - `backend/apps/permissions/serializers.py:108-110`:
    ```python
    # event_id is accepted for idempotency but currently ignored at the
    # service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
    # with the global event_id table).
    event_id = serializers.UUIDField(required=False)
    ```
  - `backend/apps/permissions/views.py:221-246` — `event_id` is parsed from `cells`
    body but never passed to `bulk_set_grants`.
  - `backend/apps/permissions/services/grants.py:135-213` — `bulk_set_grants` has no
    `event_id` parameter and no unique-constraint replay check.
  - `frontend/src/api/permissions.ts:33` — frontend **always sends** `event_id`,
    implying a contract the backend does not honor.
- **Why it matters:** inv-3 says *all* writes are idempotent via a client `event_id` +
  unique DB constraint (replay → 200, not duplicate). A double-submit of the override
  matrix PUT (network retry, double-click) re-runs the upserts. The upserts themselves
  are `update_or_create` (so no duplicate rows) **but** each replay emits **fresh audit
  rows** for any cell whose state actually changed between calls, and the "no-op skip"
  only protects identical resubmits. The idempotency contract is therefore not truly
  enforced at the RBAC write boundary.
- **Recommendation:** Either (a) thread `event_id` through `bulk_set_grants` and short-
  circuit on replay against the planned global event-id table (Phase 1B), or (b) drop
  `event_id` from the frontend payload until honored, to avoid a misleading contract.
  Track as a Phase-1B prep gap (see Gaps G1).

### F4 — Cross-worker cache invalidation deferred → stale RBAC decisions possible under multi-process ASGI
- **Severity:** medium
- **Category:** correctness under production topology (intersects inv-4 / inv-11)
- **Files:**
  - `backend/apps/permissions/services/resolver.py:42-50` (`invalidate_cache` TODO):
    ```python
    TODO (Appendix B.3): publish to Redis pub/sub channel
    `effective_modules_invalidate` so other ASGI workers also drop
    their local-mem cache. Phase 1A is single-process safe ...
    ```
  - `backend/fixture/settings/base.py:191-196` — cache backend is **LocMemCache**:
    ```python
    CACHES = { "default": { "BACKEND": "django.core.cache.backends.locmem.LocMemCache", ... } }
    ```
  - `backend/fixture/settings/base.py:186-188` — `InMemoryChannelLayer`.
- **Why it matters:** `effective_modules` caches the resolved set for 5 min
  (`resolver.py:34, 131`). With `LocMemCache`, each gunicorn/uvicorn worker has its **own**
  cache. A grant change calls `cache.delete()` only in the worker that served the PUT;
  other workers keep serving the stale (more-permissive or more-restrictive) module set
  for up to 5 minutes. On the single-process dev server this is invisible, which is
  exactly why it slips. This is the same root cause as the known LocMem/InMemory issue,
  but here it has a **direct RBAC-correctness consequence**: a `deny` override may not
  take effect immediately across all workers.
- **Recommendation:** Move `CACHES["default"]` to `django-redis` (shared) for prod, OR
  implement the deferred pub/sub invalidation. Until then, document that a single worker
  is required for correct RBAC, or shorten/disable the TTL. Add to prod settings work.

### F5 — `module_gated()` queryset helper resolves `effective_modules` per-org in a Python loop (N cache/DB hits) and has zero direct test of the `.filter()` output
- **Severity:** low
- **Category:** performance + test coverage
- **Files:**
  - `backend/apps/permissions/scope.py:98-111` — per-org Python loop calling
    `effective_modules` once per accessible org.
  - `backend/apps/permissions/tests/test_module_gated_queryset.py:36-54` — the test
    builds a `ScopedQuerySet` but then **asserts on `effective_modules` directly**, not on
    the rows returned by `qs.module_gated(...)`. The actual `.filter(organization_id__in=...)`
    narrowing is never asserted against real rows (the comment even says
    "monkey-patch to filter by id" but doesn't).
- **Why it matters:** The headline behavior of `module_gated` — that it returns only rows
  whose org grants the module — is asserted only indirectly. A regression that, e.g.,
  inverts the membership test or filters on the wrong field would not be caught. Perf is
  acceptable at stated N (<50 orgs/user) but degrades once Phase-1B tenanted models call
  this on hot list endpoints.
- **Recommendation:** Add a test using a real org-tenanted model (Phase 1B will provide
  `Tournament`; for now a lightweight test model or the existing pattern) that asserts the
  **returned rows** are exactly the org-X rows. Consider batching the resolver lookups.

### F6 — Frontend duplicates module-code constants instead of importing a single source of truth
- **Severity:** low
- **Category:** maintainability / drift risk (inv-12 "catalog is source of truth")
- **File:** `frontend/src/features/layout/computeNavItems.ts:18-24`:
  ```js
  // Duplicated here (rather than imported from features/orgs) to keep this
  // pure helper module-isolated; the source-of-truth list is in
  // features/orgs/dashboardCards.ts and the two should stay in sync.
  const MODULE_ORG_MEMBER_DIRECTORY = "org.member_directory";
  ```
- **Why it matters:** Module codes are hard-coded in at least two frontend places and the
  backend fixture. If a code is renamed in `modules.json`, the nav gate silently breaks
  (no compile error — strings). inv-12 designates the catalog as the single source of
  truth; the FE has no generated/imported binding to it.
- **Recommendation:** Generate a TS const map of module codes from `modules.json` (or the
  `/api/permissions/modules/` response) and import it everywhere; delete the literals.

### F7 — `team_manager` nav surface gated by role-string, not by a module (catalog gap)
- **Severity:** low
- **Category:** spec/catalog completeness vs inv-12 "modules govern surface visibility"
- **Files:**
  - `frontend/src/features/layout/computeNavItems.ts:133-145`:
    ```js
    // Team workspace: no Appendix A.2 module exists
    // (`tournament.team_manager_workspace` is unspecified). Spec gap ...
    if (roles.includes("team_manager")) { ... }
    ```
  - Catalog `backend/apps/permissions/fixtures/modules.json` — no
    `tournament.team_manager_workspace` (or equivalent) entry; 22 modules confirmed.
- **Why it matters:** inv-12 says module catalog governs surface visibility; this one
  surface is gated on the raw role string, so a per-user override could not grant/deny the
  Team workspace the way it can for every other surface. It is a localized, acknowledged
  gap, not a leak.
- **Recommendation:** When Phase 1B teams land, add a module for the team-manager
  workspace and switch the gate to `hasModule(...)`.

### F8 — `MatrixView` / `UserGrantsView` admin-only gate diverges from the documented `HasModule("org.member_directory")` docstrings (stale comments)
- **Severity:** info
- **Category:** documentation accuracy
- **Files:**
  - `backend/apps/permissions/views.py:13-15` module docstring still says the grants
    endpoints are "gated by HasModule('org.member_directory')" —
    the actual classes gate on `IsOrgAdminOrOwner` (`views.py:150`, `views.py:354`),
    which is the correct/intended posture (tested in
    `tests/test_matrix.py:283-362`, the DEFECT-J regression).
- **Why it matters:** The module-level docstring contradicts the class-level docstrings
  and the code. A future maintainer reading the top of the file could re-introduce the
  weaker member-directory gate.
- **Recommendation:** Fix the module docstring to state the admin-only (`IsOrgAdminOrOwner`)
  gate.

### F9 — "5 locked roles" in the task brief vs **6** `MembershipRole` values in code (verify intent)
- **Severity:** info
- **Category:** spec-vs-code reconciliation
- **File:** `backend/apps/organizations/models.py:44-52` — six values:
  `admin, co_organizer, game_coordinator, match_scorer, referee, team_manager`.
- **Why it matters:** The task brief's product decision references "the 5 locked roles,"
  but the enum and the entire matrix (catalog `default_for_roles`, parametrized tests)
  are built on **6**. The matrix test (`test_permission_matrix.py:33`) parametrizes over
  `MembershipRole` dynamically, so it stays correct regardless of count — but the brief's
  "5" appears to be a miscount (likely excluding `admin` as the owner role, or merging
  two). Not a defect; flagging so the discrepancy is resolved in the plan, not silently.
- **Recommendation:** Confirm whether the intended count is 5 or 6 and align the brief/
  spec with the code (which is internally consistent at 6).

---

## What is correct (verified, not assumed)

- **22-module catalog loaded.** `fixtures/modules.json` contains exactly 22 entries
  (counted: 5 `org.*`, 10 `tournament.*`, 4 `match.*`, 3 `personal.*`). `load_modules`
  upserts idempotently (`management/commands/load_modules.py:52-67`); tests assert
  `count() == 22` and idempotency (`test_module_fixture_loads.py:11-22`).
- **`MembershipModuleGrant` override model** keyed on `(user, organization, module)` with a
  `UniqueConstraint` (`models.py:144-149`; migration
  `migrations/0001_initial.py:119-124`) — matches the documented A.4 audit fix
  (per-(user,org) keying, not per-membership).
- **Default-deny union resolver.** `effective_modules` returns `frozenset()` for no/inactive
  membership (`test_resolver_default.py:37-55`), unions role defaults
  (`resolver.py:67-86`), applies grant/deny overrides (`resolver.py:89-104`); `deny` wins
  over multi-role union (`test_resolver_grant_overrides_role_default_deny.py`).
- **Parametrized matrix test exists** — `test_permission_matrix.py` parametrizes every
  `(role × module)` cell from the fixture and asserts resolver agreement (the inv-12
  "permission matrix suite" called for in CLAUDE.md). Plus B.16 matrix-endpoint tests
  (`test_matrix.py`), grant-audit tests, caching tests, scope-isolation tests.
- **DRF gate wired into real endpoints.** `HasModule("org.member_directory")`
  (organizations `views.py:357, 511`) and `HasModule("org.audit_log")`
  (audit `views.py:103`); super-user bypass present and fail-closed for anon
  (`permissions.py:39-50`).
- **Cross-org isolation in matrix/grants.** `build_matrix` filters memberships and grant
  rows by the single `organization` (`services/matrix.py:89-110`); resolver and scope
  helpers filter by org throughout — no cross-org leak found on the RBAC paths.
- **Audit on every override change** (`services/grants.py` emits one
  `module_grant_changed` row per changed module; `test_grant_audit.py`).
- **App-label collision avoided** — `label = "permissions_app"` (`apps.py:7`) dodges the
  `django.contrib.auth` "permissions" clash; app registered in
  `settings/base.py:48-55`.

---

## Gaps (Phase-1B prep / does 1A block 1B?)

**Bottom line: Phase 1A does NOT block Phase 1B for inv-12.** The resolver, override
model, gate, and scoped querysets are designed to be consumed by future tenanted models
(`scope.py` docstring shows the exact integration pattern for `Tournament`). Prep gaps:

- **G1 — Idempotent RBAC writes not enforced (event_id ignored).**
  *Current state:* `event_id` accepted in serializer + sent by FE, dropped at service
  layer (`serializers.py:108`, `views.py:221`, `grants.py`). *Missing:* global
  `event_id` unique table + replay short-circuit. *Needed for:* inv-3 compliance on all
  writes; lands with Phase-1B "global event_id table." *Blocking:* no. *Effort:* M.

- **G2 — Production cache + channel layer not Redis-backed.**
  *Current state:* `LocMemCache` + `InMemoryChannelLayer` (`base.py:186-196`); cross-
  worker invalidation is a TODO (`resolver.py:42-50`). *Missing:* `django-redis` cache
  and `channels-redis` layer + the deferred pub/sub invalidation (Appendix B.3). *Needed
  for:* correct RBAC under multi-worker prod ASGI (F4) and inv-4/inv-11 live transport.
  *Blocking:* not for 1A correctness on single process; **must** be fixed before any
  multi-worker prod deploy. *Effort:* M.

- **G3 — No module exists for the team-manager workspace surface.**
  *Current state:* gated by role string (F7). *Missing:* a `tournament.team_*` module in
  the catalog. *Needed for:* inv-12 "modules govern surface visibility" once Phase-1B
  teams ship. *Blocking:* no. *Effort:* S.

- **G4 — `module_gated()` queryset narrowing has no direct row-level test (F5).**
  *Current state:* indirect assertion only. *Missing:* a test against a real org-tenanted
  model asserting returned rows. *Needed for:* trustworthy reuse when Phase-1B list
  endpoints call `module_gated`. *Blocking:* no. *Effort:* S.

- **G5 — Verb-level row matrix (PRD §3.2) not yet present.**
  *Current state:* the **module** layer (surface visibility) is fully built and tested.
  inv-12 also calls for a **row-level verb matrix** parametrized over PRD §3.2
  (`apps/permissions/tests/test_module_matrix.py` is referenced in CLAUDE.md but the
  *verb* matrix is Phase-1B-coupled since most verbs act on tournaments/matches).
  *Missing:* the §3.2 verb permission layer + its parametrized test. *Needed for:* full
  inv-12 ("modules govern surface; §3.2 governs fine-grained verbs"). *Blocking:* no —
  it is inherently Phase-1B (verbs target 1B resources). *Effort:* L.
