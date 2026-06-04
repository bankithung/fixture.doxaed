# Permissions App — Structural Map

**Area:** `backend/apps/permissions`
**Date:** 2026-06-04
**Spec refs:** v1Users.md Appendix A.2, A.3, A.4, B.2, B.3, B.16, B.17

---

## Purpose

RBAC layer 2 of the platform: the 22-module visibility catalog, the per-user override grant system, the `effective_modules()` resolver, the multi-tenancy `ScopedQuerySet`, and the DRF endpoints and `HasModule` permission-class factory that gate Phase 1A surfaces. Phase 1B apps (tournaments, matches, live, etc.) are expected to import these primitives.

---

## File Inventory

| File | Role |
|------|------|
| `models.py` | `Module` (22-row catalog) + `MembershipModuleGrant` (per-user override) |
| `apps.py` | `PermissionsConfig` — label `permissions_app` to avoid clash with `django.contrib.auth` |
| `scope.py` | `ScopedQuerySet` / `ScopedManager` — org-tenant filtering primitives |
| `permissions.py` | `HasModule(code)` — DRF permission-class factory |
| `serializers.py` | `ModuleSerializer`, `GrantRowSerializer`, `BulkGrantsSerializer`, `BulkGrantsCellsSerializer`, `EffectiveModulesSerializer`, `MatrixResponseSerializer` |
| `views.py` | All DRF views (see Endpoints section) |
| `urls.py` | 5 URL patterns mounted at `/api/permissions/` |
| `services/resolver.py` | `effective_modules()`, `has_module()`, `invalidate_cache()` |
| `services/grants.py` | `set_grant()`, `bulk_set_grants()`, `clear_grants()` — write paths with audit emit |
| `services/matrix.py` | `build_matrix()` — aggregate per-member × per-module view for matrix UI |
| `services/__init__.py` | Re-exports public API |
| `management/commands/load_modules.py` | `python manage.py load_modules` — upserts 22 modules from `fixtures/modules.json` |
| `fixtures/modules.json` | Source-of-truth for 22-module catalog |
| `migrations/0001_initial.py` | Creates `permissions_module` + `permissions_membership_module_grant` tables |

### Test files

| File | Coverage |
|------|----------|
| `tests/test_module_fixture_loads.py` | `load_modules` count=22, idempotency, code uniqueness |
| `tests/test_resolver_default.py` | Single-role default sets, no-membership, inactive membership |
| `tests/test_resolver_grant_override.py` | grant/deny/default states on resolver output |
| `tests/test_resolver_multi_role.py` | Union across roles, inactive role exclusion |
| `tests/test_resolver_grant_overrides_role_default_deny.py` | Deny wins over multi-role union (key audit-fix regression) |
| `tests/test_resolver_caching.py` | Cache hit, cache invalidation on write |
| `tests/test_grant_audit.py` | One AuditEvent per module changed; reason-length enforcement |
| `tests/test_module_gated_queryset.py` | `ScopedQuerySet.module_gated()` |
| `tests/test_scope_queryset.py` | `ScopedQuerySet.scoped_for_user()` |
| `tests/test_matrix.py` | Matrix endpoint shape, role-default cells, grant/deny overrides, admin-only gate, slug aliases |
| `tests/test_permission_matrix.py` | **Parametrized** across all 5 roles × 22 modules from fixture |
| `tests/conftest.py` | `_clear_cache` autouse, `loaded_modules` fixture |
| `tests/factories.py` | User, Org, OrgMembership, Module, MembershipModuleGrant factories |

---

## Models

### `Module`
- PK: UUID v7 (invariant 1 satisfied)
- Fields: `code` (unique, 64 char), `name`, `description`, `category`, `default_for_roles` (JSONField list of role strings), `created_at`
- No org FK — catalog is platform-global, not org-scoped
- Ordered by `category`, `code`; index on `category`

### `MembershipModuleGrant`
- PK: UUID v7
- Unique constraint: `(user, organization, module)` — one override per (user, org, module) regardless of how many role rows the user has
- Fields: `state` (GrantState tri-state: `default`/`grant`/`deny`), `granted_by` (nullable FK), `reason` (blank=True at DB; ≥20 chars enforced at service layer), `created_at`, `updated_at`
- Index: `(user, organization)`
- Module FK uses `PROTECT` (cannot delete a catalog module if any grant references it)

### `GrantState` choices
`default` / `grant` / `deny` — tri-state; `default` rows are collapsed to deletion at service layer

---

## Services

### `effective_modules(user, organization) -> frozenset[str]`
Algorithm (Appendix A.4):
1. Query all active `OrganizationMembership` rows → collect role strings
2. Union `Module.default_for_roles` across those roles → base set
3. Apply `MembershipModuleGrant` overrides: grant → add, deny → remove, default → no-op
4. Cache result under `effective_modules:{user.id}:{org.id}` TTL 5 min; invalidated on every grant write

### `set_grant() / bulk_set_grants() / clear_grants()`
- All atomic, all emit `module_grant_changed` AuditEvent per module changed
- `set_grant` collapses `state=default` to row-deletion (recommended pattern)
- `bulk_set_grants` skips no-op (prior state == new state) — no spurious audit row
- Invalidates resolver cache after commit

### `build_matrix(organization) -> dict`
- One-DB-round-trip-per-org aggregate (memberships + grants pre-fetched)
- Returns `{modules: [...22], members: [...per-user rows with cells + role_defaults]}`

---

## Endpoints

| Method | URL | Auth | Gate | View |
|--------|-----|------|------|------|
| GET | `/api/permissions/modules/` | IsAuthenticated | (none beyond auth) | `ModuleCatalogView` |
| GET | `/api/permissions/me/modules/?org={uuid}` | IsAuthenticated | (none beyond auth) | `MyEffectiveModulesView` |
| GET/PUT | `/api/permissions/orgs/{org_uuid}/users/{user_uuid}/grants/` | IsAuthenticated | `IsOrgAdminOrOwner` | `UserGrantsView` |
| GET | `/api/permissions/orgs/{slug}/me/modules/` | IsAuthenticated | (none beyond auth) | `MyModulesBySlugView` |
| GET/PUT | `/api/permissions/orgs/{slug}/users/{user_uuid}/grants/` | IsAuthenticated | `IsOrgAdminOrOwner` | `UserGrantsBySlugView` |
| GET | `/api/permissions/orgs/{slug}/grants/matrix/` | IsAuthenticated | `IsOrgAdminOrOwner` | `MatrixView` |

PUT `/grants/` accepts two body shapes: `{grants:[{module,state}],reason}` and `{cells:{code:state},reason,event_id?}`.

---

## Findings

### F-1 — CRITICAL: `effective_modules()` uses wrong default for `is_authenticated` guard

**File:** `backend/apps/permissions/services/resolver.py:113`
**Snippet:** `if user is None or not getattr(user, "is_authenticated", True):`
**Problem:** The default value for `getattr` is `True`, meaning if a user object without an `is_authenticated` attribute is passed, the guard evaluates to `not True = False` and the function proceeds to query DB instead of returning `frozenset()`. The correct fail-closed default is `False`. Every other guard in this codebase correctly uses `False`:
- `scope.py:55` — `getattr(user, "is_authenticated", False)`
- `scope.py:70` — `getattr(user, "is_authenticated", False)`
- `scope.py:89` — `getattr(user, "is_authenticated", False)`
- `permissions.py:41` — `getattr(user, "is_authenticated", False)`

**Why it matters:** In any code path (test helper, admin task, future service call) where a non-user object is passed, the resolver silently attempts DB queries with whatever that object is rather than failing closed. This is a security-relevant defect: at scale it means a caller that passes a wrong type gets data back instead of an empty set.
**Recommendation:** Change `True` to `False` at `resolver.py:113`.
**Severity:** critical

---

### F-2 — HIGH: Module-level docstring in `views.py` says wrong gate (`HasModule` instead of `IsOrgAdminOrOwner`)

**File:** `backend/apps/permissions/views.py:13-15`
**Snippet:**
```
The two `/orgs/{org_uuid}/users/{user_uuid}/grants/` endpoints are
admin-only — gated by HasModule("org.member_directory") since that's
the canonical "manage memberships" surface in v1Users.md.
```
**Problem:** The actual gate on both `UserGrantsView` (line 150) and `MatrixView` (line 354) is `IsOrgAdminOrOwner`, not `HasModule("org.member_directory")`. The decision to tighten from the HasModule gate to admin-only was intentional (documented inline at lines 143-147 and 347-351) but the module docstring was not updated.
**Why it matters:** Stale docstrings cause the next engineer to implement Phase 1B grant views under the wrong assumption, potentially shipping a regression.
**Recommendation:** Update the module-level docstring at lines 13-15 to say `IsOrgAdminOrOwner`.
**Severity:** high

---

### F-3 — HIGH: `UserGrantsView.get_organization()` silently returns `None` on bad UUID, masking 404 vs 403 ambiguity

**File:** `backend/apps/permissions/views.py:152-159`
**Snippet:**
```python
def get_organization(self):
    org_uuid = self.kwargs.get("org_uuid")
    try:
        return Organization.objects.filter(id=uuid.UUID(str(org_uuid))).first()
    except (ValueError, TypeError):
        return None
```
**Problem:** When the org UUID is malformed OR when the org simply doesn't exist, `get_organization()` returns `None`. `IsOrgAdminOrOwner` then sees `org=None` and returns 403. The client receives 403 for a non-existent resource when 404 is semantically correct.
**Why it matters:** `UserGrantsBySlugView.get` and `.put` at lines 324-336 call `super().get/put(request, org_uuid=slug, user_uuid=user_uuid)` — the parent's `get_organization()` is NOT called in the slug path (the subclass overrides it correctly), but the UUID-routed parent path is still affected.
**Recommendation:** In `UserGrantsView.get()` and `.put()`, explicitly call `self.get_organization()` and return 404 if it returns `None`, before DRF's permission check fires.
**Severity:** high

---

### F-4 — HIGH: `event_id` on `BulkGrantsCellsSerializer` is accepted but silently discarded — invariant 3 not honoured

**File:** `backend/apps/permissions/serializers.py:107-110`
**Snippet:**
```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```
**Problem:** Architectural invariant 3 states "Every mutation endpoint accepts a client-generated `event_id` with a unique DB constraint. Re-submitting returns the existing record (200, not 201)." The `event_id` field is parsed but never forwarded to the service layer or stored. A retry of the same PUT with the same `event_id` will re-run `bulk_set_grants()` and re-emit audit rows (though the no-op detection in `bulk_set_grants` prevents duplicate audit rows for unchanged state, the service call still executes). Phase 1A explicitly defers this but the deferral should be tracked.
**Why it matters:** If a frontend retries a bulk-grant PUT (network blip), it may silently re-apply grants and re-emit audit rows for modules whose state did change in between. Also, the standard `{grants:[...], reason}` body shape (`BulkGrantsSerializer`) does not even expose an `event_id` field.
**Recommendation:** Add an `event_id` field to `BulkGrantsSerializer` as well. Track both as Phase 1B items. At minimum, log a warning when `event_id` is provided but not processed.
**Severity:** high

---

### F-5 — MEDIUM: Cross-org isolation test for grants endpoints is missing

**Files:** `backend/apps/permissions/tests/test_matrix.py`, all other test files
**Problem:** There is a test that checks a user with NO membership gets 403 (`test_matrix_get_forbidden_for_member_with_no_role`). However there is no test asserting that an Admin of Org A cannot read or write grants for Org B. The `IsOrgAdminOrOwner` permission class checks the resolved org from the view, so the gate should work, but this is exactly the invariant-2 cross-org leak scenario the CLAUDE.md calls mandatory to test.
**Why it matters:** Invariant 2 requires CI tests asserting no cross-org leak via any DRF endpoint. The grants endpoints mutate sensitive RBAC state.
**Recommendation:** Add `test_admin_org_a_cannot_read_org_b_grants` and `test_admin_org_a_cannot_write_org_b_grants` to `test_matrix.py`.
**Severity:** medium

---

### F-6 — MEDIUM: `module_gated()` in `ScopedQuerySet` has O(N×M) DB query pattern with no batching

**File:** `backend/apps/permissions/scope.py:94-111`
**Snippet:**
```python
for org_id in org_ids:
    org = org_map.get(org_id)
    if org is None:
        continue
    if module_code in effective_modules(user, org):
        gated_ids.append(org_id)
```
**Problem:** Each call to `effective_modules(user, org)` may issue 2 DB queries (membership + grants) if the cache is cold. For a user in N orgs, that is up to 2N extra queries per `module_gated()` call. The comment acknowledges "small N ≤ 50" but the cache TTL is 5 minutes and is per-org so a cold path after a deploy hits all orgs in sequence.
**Why it matters:** Phase 1B will introduce `Tournament.objects.module_gated(user, "tournament.editor")` at the start of every tournament-list view. At moderate scale (20 orgs, cold cache), this is 40 extra DB round-trips per page load.
**Recommendation:** Pre-warm the resolver across all orgs before the loop, or accept this as a Phase 1B perf task and document it explicitly as a known cost.
**Severity:** medium

---

### F-7 — MEDIUM: `GrantRowSerializer` does not include `module` FK detail (only `module_code`)

**File:** `backend/apps/permissions/serializers.py:18-34`
**Problem:** `GrantRowSerializer` exposes `module_code` (denormalized from `module.code`) but not `module_name`, `module_category`, or `module_description`. The matrix endpoint returns a separate `modules` array with that data, but the standalone `GET /orgs/{org}/users/{user}/grants/` response only gives opaque codes — the frontend must cross-reference to display human labels.
**Why it matters:** Usability — the frontend must make a second call to `/api/permissions/modules/` or have the catalog pre-loaded to label the grants list.
**Recommendation:** Add `module_name`, `module_category` read-only fields to `GrantRowSerializer` (denormalized via `source="module.name"` etc.) or document the "must pre-load catalog" contract in the view docstring.
**Severity:** medium

---

### F-8 — MEDIUM: `ModuleCatalogView` exposes `default_for_roles` to all authenticated users — potential info-leak

**File:** `backend/apps/permissions/views.py:73-88`; `backend/apps/permissions/serializers.py:14`
**Snippet:** `fields = ["id", "code", "name", "description", "category", "default_for_roles"]`
**Problem:** `GET /api/permissions/modules/` is gated by `IsAuthenticated` only. Any user with a session can enumerate which roles get which modules by default, even if they have no membership in any org.
**Why it matters:** Low exploitability but leaks RBAC policy to any authenticated user including accounts created by an invite-only path that have no org membership. It also means a future attacker who compromises any account can enumerate the full permission surface.
**Recommendation:** Restrict to users who have at least one active org membership, or gate on a super-user/admin check. At minimum, exclude `default_for_roles` from the public field list and expose it only on the matrix endpoint which is already admin-only.
**Severity:** medium

---

### F-9 — LOW: `bulk_set_grants` issues one `_resolve_module(code)` DB query per module code per call — no batching

**File:** `backend/apps/permissions/services/grants.py:160-189`
**Problem:** In the loop over `grants`, each iteration calls `_resolve_module(module_code)` which does `Module.objects.get(code=module_code)`. For a 22-module bulk-update that is 22 individual `SELECT` statements.
**Why it matters:** Minor perf issue. Matrix PUT will typically submit all 22 modules at once.
**Recommendation:** Pre-fetch all referenced module codes in one `Module.objects.filter(code__in=[...])` before the loop.
**Severity:** low

---

### F-10 — LOW: `set_grant` emits audit with a random UUID as `target_id` when deleting (state=default)

**File:** `backend/apps/permissions/services/grants.py:119`
**Snippet:** `target_id=(row.id if row else uuid.uuid4()),`
**Problem:** When `state=default` causes row-deletion, `row` is `None` and `uuid.uuid4()` is used as the audit `target_id`. The audit row then references a non-existent entity. The same pattern appears in `bulk_set_grants` (line 193).
**Why it matters:** Audit rows should be meaningful — querying the audit log for a deleted grant by `target_id` returns nothing. Future audit tooling that tries to reconstruct history by `target_id` will fail for deletion events.
**Recommendation:** Store the original grant's `id` before deletion and use it as `target_id`.
**Severity:** low

---

### F-11 — LOW: `default_app_config` in `__init__.py` is deprecated in Django 3.2+

**File:** `backend/apps/permissions/__init__.py:18`
**Snippet:** `default_app_config = "apps.permissions.apps.PermissionsConfig"`
**Problem:** Django 3.2+ auto-discovers `AppConfig` subclasses; `default_app_config` is deprecated and ignored in Django 4+. The project is on Django 5.x.
**Why it matters:** No functional impact today, but it is stale boilerplate that will eventually raise a deprecation warning and confuses new contributors.
**Recommendation:** Remove the line. `apps.py` is auto-discovered because it subclasses `AppConfig`.
**Severity:** low

---

### F-12 — INFO: Cross-worker cache invalidation is documented as deferred (Phase 1B)

**Files:** `services/resolver.py:45-48`, `services/grants.py:110`
**Snippet:**
```python
# TODO (Appendix B.3): also publish to Redis pub/sub for cross-worker.
invalidate_cache(user.id, organization.id)
```
**Problem:** When the ASGI process count is > 1 (production), a grant write invalidates the cache only in the worker that handled the write. Other workers continue serving stale `effective_modules` for up to 5 minutes.
**Why it matters:** Production is a single-process ASGI deployment for Phase 1A so this is safe now. Phase 1B multi-worker deployment will require this before launch.
**Recommendation:** Track as a Phase 1B pre-flight item. Do not increase ASGI worker count beyond 1 until cross-worker invalidation lands.
**Severity:** info

---

### F-13 — INFO: `TournamentMembership` is referenced in CLAUDE.md but does not exist yet; module catalog pre-populates tournament-scoped modules

**Problem:** The locked product decision in the task description notes "invites are tournament-scoped via a NEW `TournamentMembership`". The 22-module catalog already includes `tournament.*` modules (editor, bracket_editor, schedule_editor, etc.) with `default_for_roles` arrays that reference org-level roles. Phase 1B needs to decide: are tournament-scoped modules resolved against `TournamentMembership` rows or still against `OrganizationMembership` rows? The current resolver only knows about `OrganizationMembership`.
**Why it matters:** If Phase 1B introduces `TournamentMembership` as a new membership model, the resolver at `services/resolver.py:53-64` (which calls `OrganizationMembership.objects.filter(...)`) must be extended or a second resolver added. The current module catalog `default_for_roles` arrays will need audit.
**Severity:** info

---

## Gaps

1. **No `PATCH /grants/` endpoint.** Only PUT (full replace) is exposed. Single-module atomic changes from the SPA require sending the entire grant set or using the service layer directly. Consider a PATCH endpoint that applies one `(module, state, reason)` change.

2. **No endpoint to delete all grants for a user (clear_grants).** The `clear_grants()` service function exists and is tested but is not exposed via any HTTP endpoint. Offboarding a user requires calling the service directly or issuing a PUT with all states set to `default`.

3. **No `DELETE /orgs/{slug}/users/{user_uuid}/grants/{grant_id}/` endpoint.** Fine-grained per-module deletion is only achievable via the bulk PUT with `state=default`.

4. **Parametrized permission-matrix test (`test_permission_matrix.py`) runs at module-load time.** `MATRIX_CELLS = _load_matrix_cells()` executes on import, reading `fixtures/modules.json` directly from disk. If the file is absent, collection fails. This should be wrapped in a try/except or made a pytest fixture.

5. **No admin interface.** `Module` and `MembershipModuleGrant` are not registered in Django admin. The sadmin console is the intended management surface but there is no admin registration.

6. **`ScopedManager` is not yet adopted by any Phase 1A model.** `Organization` itself does not use it (it is the root tenant, not scoped by another). Phase 1B models (`Tournament`, `Match`, etc.) must adopt it — no scaffold exists yet.

7. **No signal or hook for membership deactivation to invalidate cache.** If an `OrganizationMembership` is deactivated (is_active=False), the resolver cache for that user/org is NOT invalidated. The stale cache will serve the old effective modules for up to 5 minutes.

8. **`ModuleCatalogView` has no pagination.** The catalog is fixed at 22 entries (acceptable), but any code that calls `.get()` (not `.list()`) will error. Currently it's a `ListAPIView` so it returns a flat list — fine for 22 items, but not future-proof.

9. **`build_matrix()` has no upper-bound safety.** It loads all active members in one query and builds a Python dict in memory. For an org with 10,000+ members it will OOM. Phase 1A orgs are small, but a hard cap or pagination should be added before Phase 1B's expected org growth.
