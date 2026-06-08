# Flow: RBAC resolution (modules + verbs + scope)

End-to-end trace of how the Fixture Platform decides *which surfaces a user sees*
(module RBAC), *which actions they may perform* (PRD §3.2 verb matrix), and
*which tenants' data they can touch* (multi-tenancy scope) — across the Django
backend and the React/Vite SPA.

## Diagram-in-prose

```
modules.json (catalog)  ──load_modules──▶  Module rows (default_for_roles)
                                                  │
OrganizationMembership(role) ──┐                  │
MembershipModuleGrant(state)  ─┴─▶ effective_modules(user, org)  ──▶ frozenset[str]
                                       │  (cached 5 min)
        ┌──────────────────────────────┼───────────────────────────────┐
        ▼ (server enforcement)          ▼ (server scope)                 ▼ (client hydration)
  HasModule / IsOrgAdminOrOwner   ScopedQuerySet.module_gated      MeSerializer.get_memberships
        │                          accessible_tournaments()         → membership.effective_modules
        ▼                                │                                 │
  endpoint 403/404               404 (no-leak) then 403            computeNavItems / dashboardCards
                                  via can_manage_tournament         ProtectedRoute
```

RBAC is **two independent layers** (CLAUDE.md invariant 12): module visibility
governs *surfaces*; the verb matrix governs *fine-grained actions*. Multi-tenancy
scope is orthogonal and is resolved **first** at every endpoint so existence is
never leaked.

## Ordered walkthrough

### 1. Module catalog (source of truth)
`backend/apps/permissions/fixtures/modules.json` lists 23 modules (the docstring
in `apps/permissions/__init__.py` and `models.py` calls it "22 + the registration
form builder = 23"; `forms` is the 23rd). Each entry has `code`, `category`,
`description`, and `default_for_roles` (a list of `MembershipRole` string values).
The catalog is upserted into the `Module` table by
`apps/permissions/management/commands/load_modules.py::Command.handle` (idempotent
on `code`, never deletes). `Module` (`apps/permissions/models.py`) uses
`app_label = "permissions_app"` to avoid colliding with `django.contrib.auth`'s
`permissions` label.

### 2. Per-user overrides
`apps/permissions/models.py::MembershipModuleGrant` is a tri-state override
(`GrantState.DEFAULT|GRANT|DENY`) **keyed on `(user, organization, module)`** with
`UniqueConstraint unique_grant_per_user_org_module`. The keying decision is the
load-bearing audit fix (2026-05-02, Appendix A.4): keying on `OrganizationMembership`
let a `deny` be silently bypassed when a second active role re-granted the module
via the Layer-1 union. The DB allows `reason` blank; the **service layer** enforces
`>= 20` chars.

### 3. The resolver — `effective_modules()`
`apps/permissions/services/resolver.py::effective_modules(user, organization)` is
the single resolution authority:
1. `_user_active_roles` — distinct `role` values from active
   `OrganizationMembership` rows for `(user, org)`.
2. `_base_modules_for_roles` — scans the catalog once; a module is in the base set
   if `role_set ∩ module.default_for_roles` is non-empty (multi-role **union**).
3. `_apply_overrides` — for each `MembershipModuleGrant` row: `GRANT` adds, `DENY`
   discards, `DEFAULT` no-ops. Deny is applied *after* the union, so it always wins
   (confirmed by `tests/test_resolver_grant_overrides_role_default_deny.py`).
4. Returns a `frozenset[str]` of module codes, cached under
   `effective_modules:{user_id}:{org_id}` for 300 s (`tests/test_resolver_caching.py`).
`has_module(user, org, code)` is the boolean convenience wrapper.

### 4. Server-side surface enforcement
`apps/permissions/permissions.py::HasModule(code)` is a **class factory** returning
a `BasePermission` subclass. `has_permission` short-circuits `True` for superusers,
resolves the org via `view.get_organization()` → `view.organization` →
`kwargs['org_uuid']` → `request.org_context`, then calls `has_module`. Fails closed
(returns `False`) when the org can't be resolved.

A subtlety worth flagging for the restructure: the actual permissions endpoints
(`apps/permissions/views.py`) deliberately gate on `IsOrgAdminOrOwner` (role), **not**
`HasModule("org.member_directory")`. This is DEFECT-J: co-organizer/game-coordinator
hold `org.member_directory` by default, so a module gate would wrongly let them manage
the override matrix. v1Users.md §2 reserves the override-grant verb to Admin
(`tests/test_matrix.py::test_matrix_get_forbidden_for_non_admin_roles`). So `HasModule`
exists and is exported but the canonical admin surfaces use the role class.

### 5. The PRD verb matrix layer
There is **no central verb table**; the §3.2 verb matrix is enforced inline at
endpoints by role predicates. The tournament-scoped layer is
`apps/tournaments/permissions.py::can_manage_tournament(user, tournament)` — True
for an active tournament admin/co-organizer **or** an active org admin/owner of the
workspace. Endpoints in `apps/tournaments/views.py` apply it after the scope check:
e.g. `TournamentInvitationCreateView.post`, `TournamentSettingsView.patch`,
`TournamentMembersView` mutations all do `_get_tournament_or_404(...)` then
`if not can_manage_tournament(...): raise PermissionDenied`. `_settings_payload`
even computes a `can_edit` flag (`can_edit_rules(t) and can_manage_tournament(...)`)
so the client can pre-gate the edit verb.

### 6. Multi-tenancy scope
Two mechanisms enforce invariant 2 (org isolation):
- **Generic:** `apps/permissions/scope.py::ScopedQuerySet` — `scoped_for_user`
  (rows in orgs with any active membership; superuser bypass; anon → `.none()`)
  and `module_gated(user, code)` (loops accessible orgs, keeps those whose
  `effective_modules` contains the code). This is "THE ONLY sanctioned way to
  filter by org."
- **Tournament-specific:** `apps/tournaments/scope.py::accessible_tournaments(user)`
  — union of tournaments in orgs where the user is an active org **admin** and
  tournaments where they hold an active `TournamentMembership`, excluding
  `deleted_at`.

### 7. Endpoint enforcement — 404 vs 403 ordering
The order is invariant and load-bearing.
`apps/tournaments/views.py::_get_tournament_or_404` first fetches the row, then
checks `accessible_tournaments(user).filter(id=...).exists()`; if not accessible it
raises `NotFound` (**404, no existence leak**). Only *after* access is confirmed do
endpoints check the verb predicate and raise `PermissionDenied` (**403**). So an
outsider sees 404 (resource hidden); an insider lacking the verb sees 403.

### 8. Client hydration bridge
`apps/accounts/serializers.py::MeSerializer.get_memberships` is the cross-boundary
bridge. For each org the user is active in, it aggregates roles into one entry and
calls `effective_modules(user, org)`, attaching the resolved list as
`membership.effective_modules`. `GET /api/accounts/me/` therefore ships the server's
resolved module sets to the SPA — the client never recomputes them.

### 9. Frontend nav gating
`frontend/src/features/layout/computeNavItems.ts` is a pure function. `resolveContext`
finds the membership by slug and reads `membership.effective_modules`;
`computeTournamentNav` shows the `forms` nav item only when `hasModule("forms")`.
Members/Audit are shown to everyone in context — the *page* enforces manager-only
(403 → friendly state), per `__tests__/computeNavItems.test.ts`.
`frontend/src/features/orgs/dashboardCards.ts::computeDashboardCards` gates cards on
the same `effective_modules` with a role-only fallback when modules are empty
(mid-load). The override-matrix card stays role-only (admin-tier).

### 10. ProtectedRoute + matrix UI
`frontend/src/features/layout/ProtectedRoute.tsx` gates on auth/bootstrap state, not
modules: not-bootstrapped → spinner; `requires2FA` → challenge; no user → login;
zero-membership non-superuser → `/orgs` (with an `ORG_OPTIONAL_PATHS` allowlist to
avoid a redirect loop). The admin matrix UI
(`features/permissions/ModuleMatrixPage.tsx` + `GrantCell.tsx`) reads
`permissionsApi.matrix(slug)` (`api/permissions.ts` →
`/api/permissions/orgs/{slug}/grants/matrix/`, served by `views.py::MatrixView` →
`services/matrix.py::build_matrix`) and writes via `setGrants` (PUT) →
`services/grants.py::bulk_set_grants`.

## Subsystems crossed
permissions (catalog/resolver/grants/scope) · organizations (memberships/roles) ·
tournaments (scope/permissions/views) · accounts (`/me` hydration) · audit
(`emit_audit` on grant writes) · frontend layout + orgs + permissions features.

## Invariants this flow depends on
- **Deny applied after union** — `MembershipModuleGrant` keyed on `(user, org, module)`
  is the single source of truth; deny must win regardless of role count (Appendix A.4).
- **404-before-403** — scope resolves first; existence never leaks (invariant 2).
- **Catalog is the only source of `default_for_roles`** — `modules.json` ↔ resolver ↔
  matrix ↔ client all key off the same codes.
- **Server is authoritative; client gating is convenience** — `effective_modules` runs
  only on the server; the SPA consumes the result via `/me`.
- **Reason >= 20 chars + one audit row per changed module** (B.17), enforced in
  `services/grants.py`, not the DB.
- **Cache coherence** — every grant write calls `invalidate_cache(user.id, org.id)`.

## Failure modes
- **Stale cache across workers.** `invalidate_cache` deletes only the local/shared
  backend entry; the Redis pub/sub cross-worker invalidation (Appendix B.3) is a
  documented TODO at `resolver.py::invalidate_cache` and `grants.py`. A grant change
  can be stale for up to 300 s on other ASGI workers in prod.
- **`/me` staleness.** `effective_modules` is materialised into `membership.effective_modules`
  at login/bootstrap; a mid-session grant change is not reflected until `/me` is
  re-fetched. The client gate then disagrees with the server until refresh
  (UI hides/shows wrong, but server still enforces — fail-safe, not fail-open).
- **Client/server module-code drift.** Codes are duplicated in
  `computeNavItems.ts` (`MODULE_FORMS`), `dashboardCards.ts` (`MODULES`), and
  `modules.json`; a rename in one place silently breaks gating. The comments
  explicitly say "must match" / "should stay in sync."
- **Module-vs-role gate confusion (DEFECT-J).** Gating an admin surface on a module
  that co-organizers hold by default over-grants. The fix was to switch to
  `IsOrgAdminOrOwner`; future endpoints can re-introduce the bug.
- **Cache invalidation timing vs transaction.** `invalidate_cache` is called inside
  the `transaction.atomic()` block in `set_grant`/`bulk_set_grants`, before commit —
  a concurrent read after invalidation but before commit could re-populate the cache
  with the pre-write value. Should arguably be an `on_commit` hook.

## Restructuring seams (clean re-architecture points)
- **Make the catalog typed + shared.** Generate the module-code enum for both Python
  and TS from `modules.json` (the SPA already runs `gen:types`); eliminate the three
  hand-kept code lists.
- **Centralise the verb matrix.** Replace inline `can_manage_tournament` calls with a
  declarative `(role, verb, scope) → allow` table mirroring the module catalog, so the
  PRD §3.2 matrix is data-driven and parametrically testable like the module matrix.
- **Move cache invalidation to `transaction.on_commit`** and finish the Redis pub/sub
  contract (Appendix B.3) so multi-worker prod is coherent.
- **Push a `can` capability map into `/me`.** Today `/me` ships `effective_modules`;
  also ship resolved per-tournament verbs so the client stops re-deriving manager-ness
  from roles and stays in lockstep with the server.
- **Unify scope.** `accessible_tournaments` and `ScopedQuerySet.scoped_for_user` use
  different membership semantics (org-admin-only vs any-active-membership); a single
  scope resolver would remove the divergence.
