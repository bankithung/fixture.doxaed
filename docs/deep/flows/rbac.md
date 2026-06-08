# Flow: RBAC resolution + multi-tenancy enforcement

Detailed, source-verified trace of how the Fixture Platform decides:

1. **Which tenants' data a user can touch** (multi-tenancy / org isolation).
2. **Which surfaces a user sees** (module RBAC — `effective_modules`).
3. **Which actions a user may perform** (PRD §3.2 / v1Users.md verb matrix — role predicates).

…across the Django (ASGI/DRF) backend and the React/Vite SPA. Every claim cites
`file::symbol` + line range and was verified against source on 2026-06-08.

RBAC is **two independent layers** (CLAUDE.md invariant 12): module visibility
governs *surfaces*; the verb matrix governs *fine-grained actions*. Multi-tenancy
scope is **orthogonal and resolved first** at every tenant endpoint so existence is
never leaked (404-before-403).

---

## Participant cast (concrete modules/files)

| Participant | File / symbol |
| --- | --- |
| SPA fetch wrapper | `frontend/src/api/client.ts::apiFetch` |
| Auth store | `frontend/src/features/auth/authStore.ts::useAuthStore` |
| Route gate | `frontend/src/features/layout/ProtectedRoute.tsx::ProtectedRoute` |
| Nav builder (pure) | `frontend/src/features/layout/computeNavItems.ts` |
| Dashboard cards (pure) | `frontend/src/features/orgs/dashboardCards.ts::computeDashboardCards` |
| Matrix UI | `frontend/src/features/permissions/ModuleMatrixPage.tsx` |
| Permissions API client | `frontend/src/api/permissions.ts::permissionsApi` |
| DRF auth/perm defaults | `backend/fixture/settings/base.py` (`REST_FRAMEWORK`, sessions/CSRF) |
| `/me` hydration | `backend/apps/accounts/serializers.py::MeSerializer.get_memberships` |
| Module-gate perm class | `backend/apps/permissions/permissions.py::HasModule` |
| Org-role perm classes | `backend/apps/organizations/permissions.py::IsOrgAdminOrOwner` et al. |
| Resolver (authority) | `backend/apps/permissions/services/resolver.py::effective_modules` |
| Generic org scope | `backend/apps/permissions/scope.py::ScopedQuerySet` |
| Tournament scope | `backend/apps/tournaments/scope.py::accessible_tournaments` |
| Tournament verb predicate | `backend/apps/tournaments/permissions.py::can_manage_tournament` |
| Tenant endpoints | `backend/apps/tournaments/views.py` (`_get_tournament_or_404`, …) |
| Grant write service | `backend/apps/permissions/services/grants.py` |
| Matrix read service | `backend/apps/permissions/services/matrix.py::build_matrix` |
| Catalog model | `backend/apps/permissions/models.py` (`Module`, `MembershipModuleGrant`) |
| Audit sink | `backend/apps/audit/services.py::emit_audit` |
| Cache | `django.core.cache` (locmem dev / Redis prod), keyed by resolver |

---

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor U as User (browser)
    participant SPA as authStore.ts / ProtectedRoute.tsx
    participant CL as api/client.ts::apiFetch
    participant DRF as DRF (SessionAuthentication + IsAuthenticated)
    participant ME as accounts/serializers.py::MeSerializer
    participant RES as permissions/services/resolver.py::effective_modules
    participant CACHE as django cache (locmem/Redis)
    participant DB as Postgres (OrganizationMembership / Module / MembershipModuleGrant)
    participant NAV as computeNavItems.ts / dashboardCards.ts

    rect rgb(235,245,255)
    note over U,DB: A. Bootstrap — hydrate identity + resolved module sets
    U->>SPA: app load (main.tsx → bootstrap())
    SPA->>CL: authApi.me()  (GET /api/accounts/me/)
    CL->>DRF: fetch credentials:"include" (session cookie)
    DRF->>DRF: SessionAuthentication → request.user; IsAuthenticated
    DRF->>ME: MeSerializer(user).data
    ME->>DB: _active_memberships(user) (is_active=True, select_related org)
    loop per distinct org (roles aggregated)
        ME->>RES: effective_modules(user, org)
        RES->>CACHE: cache.get("effective_modules:{uid}:{oid}")
        alt cache hit
            CACHE-->>RES: frozenset[str]
        else cache miss
            RES->>DB: _user_active_roles(user, org)
            RES->>DB: _base_modules_for_roles → Module.default_for_roles (union)
            RES->>DB: _apply_overrides → MembershipModuleGrant (grant adds / deny discards)
            RES->>CACHE: cache.set(key, frozenset, 300s)
        end
        RES-->>ME: frozenset[str]
    end
    ME-->>DRF: {memberships:[{..., effective_modules:[...]}], is_superuser, ...}
    DRF-->>CL: 200 JSON  (401 if anon)
    CL-->>SPA: User
    SPA->>NAV: computeWorkspaceNav / computeDashboardCards(user, slug)
    NAV-->>U: gated sidebar + cards (client convenience only)
    end

    rect rgb(245,235,255)
    note over U,DB: B. Tenant read — 404-before-403 isolation (e.g. tournament detail)
    U->>CL: open /tournaments/:id
    CL->>DRF: GET /api/tournaments/{id}/...  (IsAuthenticated)
    DRF->>DB: _get_tournament_or_404: fetch row (deleted_at IS NULL)
    DRF->>DB: accessible_tournaments(user).filter(id).exists()
    alt not accessible
        DRF-->>U: 404 NotFound("tournament_not_found")  (no existence leak)
    else accessible
        DRF->>DB: can_manage_tournament(user, t)  (verb layer)
        alt lacks verb
            DRF-->>U: 403 PermissionDenied("not_tournament_manager")
        else
            DRF-->>U: 200 payload (+ can_edit flag for client pre-gate)
        end
    end
    end

    rect rgb(235,255,235)
    note over U,DB: C. Override-grant write — admin edits the module matrix
    U->>SPA: ModuleMatrixPage save row
    SPA->>CL: permissionsApi.setGrants(slug,userId,{cells,event_id,reason})
    CL->>DRF: PUT /api/permissions/orgs/{slug}/users/{uid}/grants/  (X-CSRFToken)
    DRF->>DRF: IsAuthenticated + IsOrgAdminOrOwner (role gate, NOT HasModule)
    DRF->>DB: BEGIN transaction.atomic()
    loop per changed (module, state) cell
        DRF->>DB: update_or_create / delete MembershipModuleGrant
        DRF->>DB: emit_audit("module_grant_changed") — IN-TXN, append-only
    end
    DRF->>CACHE: invalidate_cache(uid, oid)  (cache.delete, still inside txn)
    DRF->>DB: COMMIT
    DRF-->>SPA: 200 {grants, effective_modules}
    SPA->>SPA: qc.invalidateQueries(["permissions","matrix",slug]) → refetch
    note over SPA: /me NOT auto-refetched — client effective_modules stale ≤ until next /me
    end
```

---

## Ordered walkthrough

### A. Bootstrap — identity + resolved module sets shipped to the SPA

**A1.** On app load, `main.tsx` calls `useAuthStore.bootstrap()`
(`frontend/src/features/auth/authStore.ts::bootstrap`, lines 44-61). It calls
`authApi.me()` and on success sets `{user, bootstrapped:true}`; a **401** sets
`{user:null, bootstrapped:true}` (anonymous, not an error). This is the only place
identity is fetched; the SPA never recomputes RBAC.

**A2.** `apiFetch` (`frontend/src/api/client.ts::apiFetch`, lines 31-86) sends every
request with `credentials:"include"` (Django session cookie, line 69) and, for
unsafe verbs, attaches `X-CSRFToken` from `getCsrfToken()` (lines 59-62). This is
the **session-auth + CSRF contract** (CLAUDE.md invariant 15). Backend side:
`backend/fixture/settings/base.py` sets `SESSION_COOKIE_HTTPONLY=True` /
`SAMESITE="Lax"` (lines 152-154), `CSRF_COOKIE_HTTPONLY=False` so JS can read the
token (line 157), and `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES =
[SessionAuthentication]` with `DEFAULT_PERMISSION_CLASSES = [IsAuthenticated]`
(lines 160-166).

**A3.** `GET /api/accounts/me/` serializes via
`backend/apps/accounts/serializers.py::MeSerializer`. `get_memberships`
(lines 143-175) is the **cross-boundary bridge**: it pulls active
`OrganizationMembership` rows (`_active_memberships`, lines 134-140,
`is_active=True`), aggregates multiple role rows into one per-org entry
(lines 148-163), then for each org calls
`effective_modules(user, org)` and attaches the resolved list as
`entry["effective_modules"]` (lines 167-174). Resolution failure is swallowed to
`[]` (try/except, lines 169-172) — fail-safe (hide), never fail-open.

**A4.** The resolver `backend/apps/permissions/services/resolver.py::effective_modules`
(lines 107-132) is the **single resolution authority**:
- Cache check first: `cache.get(cache_key)` (lines 121-124); key is
  `effective_modules:{user_id}:{org_id}` (`cache_key`, lines 37-39); TTL 300 s
  (`CACHE_TTL_SECONDS`, line 34).
- `_user_active_roles(user, org)` — distinct `role` from active
  `OrganizationMembership` (lines 53-64).
- `_base_modules_for_roles(roles)` — one scan over the 23-row `Module` catalog;
  a module is in the base set when `role_set ∩ module.default_for_roles ≠ ∅`
  (lines 67-86). **Multi-role = union.**
- `_apply_overrides(base, user, org)` — reads `MembershipModuleGrant` for
  `(user, org)`; `GRANT` → `add`, `DENY` → `discard`, `DEFAULT` → no-op
  (lines 89-104). **Deny is applied after the union, so deny always wins.**
- Returns `frozenset[str]`; `cache.set(...)` writes it back (lines 130-131).
- `has_module(user, org, code)` is the boolean wrapper (lines 135-137).

**A5.** The SPA now drives gating from the hydrated `user.memberships[].effective_modules`:
- `frontend/src/features/layout/computeNavItems.ts::resolveContext` (lines 54-64)
  finds the membership by slug and reads `effective_modules`;
  `computeTournamentNav` (lines 124-168) shows the `forms` nav item only when
  `hasModule("forms")` (lines 140-147). Members/Audit nav items are shown to
  everyone in context (lines 148-165) — the **page** enforces manager-only.
- `frontend/src/features/orgs/dashboardCards.ts::computeDashboardCards`
  (lines 105-229) gates cards on the same `effective_modules`, with a **role-only
  fallback** when `modules.length === 0` (mid-load) (lines 111-118). The
  "Module overrides" card is gated role-only on admin/owner (lines 150-160),
  deliberately **not** on a module, to mirror the backend role gate (DEFECT-J fix).

**Idempotency point.** A is read-only and naturally idempotent. Re-fetching `/me`
re-resolves; identical inputs → identical `frozenset` (cache makes repeat calls
cheap). No client `event_id` involved.

### B. Tenant read — multi-tenancy enforcement (404-before-403)

**B1.** Any tournament endpoint passes DRF default `IsAuthenticated` first
(`TournamentListCreateView`, `backend/apps/tournaments/views.py` line 40).

**B2.** **Scope resolves first.** `_get_tournament_or_404(user, tournament_id)`
(`backend/apps/tournaments/views.py`, lines 62-71) fetches the row filtered on
`deleted_at__isnull=True` (lines 64-68), then checks
`accessible_tournaments(user).filter(id=tournament_id).exists()`. If the row is
missing **or** not accessible it raises `NotFound("tournament_not_found")`
(lines 69-70) → **404, no existence leak** (CLAUDE.md invariant 2).

**B3.** `accessible_tournaments(user)` (`backend/apps/tournaments/scope.py`,
lines 19-32) is the tournament scope authority: union of
- tournaments in orgs where the user is an **active org ADMIN**
  (`OrganizationMembership` `is_active=True, role=ADMIN`, lines 22-24), and
- tournaments where the user holds an **active `TournamentMembership`**
  (`status=ACTIVE`, lines 25-27),
filtered to `deleted_at__isnull=True`, `.distinct()` (lines 28-32). Anonymous →
`Tournament.objects.none()` (lines 20-21).

**B4.** **Verb layer runs only after access is confirmed.** Mutating/admin
endpoints then call `can_manage_tournament(user, tournament)` and raise
`PermissionDenied("not_tournament_manager")` on failure → **403** (e.g.
`TournamentInvitationCreateView.post` lines 83-85; `TournamentSettingsView.patch`
lines 133-135; `TournamentMemberDetailView` lines 211-213; `TournamentAuditView`
lines 298-300). `can_manage_tournament` (`backend/apps/tournaments/permissions.py`,
lines 17-36) is True for an active tournament `admin`/`co_organizer`
(`_MANAGE_ROLES`, lines 11-14) **or** an active org `ADMIN` of the workspace
(lines 31-36). So: **outsider → 404; insider lacking the verb → 403.**

**B5.** `TournamentSettingsView` precomputes a client pre-gate flag:
`_settings_payload` sets `can_edit = can_edit_rules(t) and can_manage_tournament(user, t)`
(`backend/apps/tournaments/views.py`, lines 109-116), so the SPA can disable the
edit affordance before the server round-trip. This is convenience only — the PATCH
re-checks server-side.

**B6.** The **generic** org-scope mechanism for non-tournament tenant models is
`backend/apps/permissions/scope.py::ScopedQuerySet`:
`scoped_for_user(user)` returns rows in orgs with **any active membership**
(superuser bypass; anon → `.none()`, lines 64-75); `module_gated(user, code)`
narrows further by looping accessible orgs and keeping those whose
`effective_modules` contains the code (lines 77-111). Note the **semantic
divergence**: `accessible_tournaments` keys on org-ADMIN-only vs
`scoped_for_user` keys on any-active-membership (a known restructuring seam).

**Idempotency point.** B is read-only / idempotent. (Mutating tenant endpoints
that pass through `_get_tournament_or_404` take a client `event_id` per CLAUDE.md
invariant 3, e.g. `TournamentInvitationCreateView` forwards
`event_id=ser.validated_data.get("event_id")`, line 94 — replay returns the
existing record.)

### C. Override-grant write — admin edits the module override matrix

**C1.** The matrix UI loads via `permissionsApi.matrix(slug)`
(`frontend/src/api/permissions.ts`, lines 21-24) →
`GET /api/permissions/orgs/{slug}/grants/matrix/` →
`backend/apps/permissions/views.py::MatrixView` (lines 340-371). `MatrixView` is
gated `[IsAuthenticated, IsOrgAdminOrOwner]` (line 354) — **role gate, not a module
gate**: v1Users.md §2 reserves the override-grant verb to Admin (the docstring,
lines 348-351, citing line 736). It builds the payload via
`backend/apps/permissions/services/matrix.py::build_matrix` (lines 59-153):
for every active member it emits role-default truth (`role_defaults`) plus the
explicit override state per module (`cells`) — the layered breakdown, deliberately
**not** the resolved `frozenset` (the resolver is not called here; docstring
lines 10-13).

**C2.** The admin saves a row: `ModuleMatrixPage`'s `saveRow` mutation
(`frontend/src/features/permissions/ModuleMatrixPage.tsx`, lines 91-125) calls
`permissionsApi.setGrants(slug, userId, {cells, event_id})` (lines 99-102).
`event_id` is minted client-side via `newEventId()` (`crypto.randomUUID()`,
lines 20-24). `permissionsApi.setGrants` (`frontend/src/api/permissions.ts`,
lines 27-39) PUTs to `/api/permissions/orgs/{slug}/users/{userId}/grants/`.

**C3.** Server: `UserGrantsBySlugView.put` (`backend/apps/permissions/views.py`,
lines 336-337) delegates to `UserGrantsView.put` (lines 210-269), gated
`[IsAuthenticated, IsOrgAdminOrOwner]` (line 150). It accepts **two body shapes**
— if `"cells"` is present it uses `BulkGrantsCellsSerializer`
(`{cells, reason, event_id?}`), else `BulkGrantsSerializer`
(`{grants:[{module,state}], reason}`); if both, `cells` wins (lines 221-235).
It then calls `bulk_set_grants(...)` (lines 238-246).

**C4.** **Transaction boundary.**
`backend/apps/permissions/services/grants.py::bulk_set_grants` (lines 135-213):
- Validates `reason` length **≥ 20 chars** before opening the txn
  (`MIN_REASON_LEN = 20`, lines 25-26; check lines 151-154) — the DB allows blank
  `reason`, so this is the **service-layer** B.17 enforcement.
- Opens `with transaction.atomic()` (line 159).
- Per `(module_code, state)`: validates state, resolves the `Module`, reads the
  prior state; **skips unchanged rows (no audit row)** (lines 169-173); else
  `update_or_create` (or `delete` when state collapses to `DEFAULT`, lines 175-190);
  then `emit_audit("module_grant_changed", payload_before/after)` (lines 192-209).
- After the loop, `invalidate_cache(user.id, organization.id)` (line 211) —
  **inside the atomic block, before COMMIT** (see failure modes).
- `set_grant` (single, lines 53-132) and `clear_grants` (lines 216-268) follow the
  same shape: atomic block, one audit row per changed module, in-txn
  `invalidate_cache`.

**C5.** **Audit is in-transaction, append-only, NOT on_commit.**
`emit_audit` (`backend/apps/audit/services.py`, lines 24-78) does
`AuditEvent.objects.create(...)` "inside the current transaction" (docstring line 41;
create line 61). A sibling `emit_audit_on_commit` exists (lines 80-87) but the grant
service uses the synchronous `emit_audit`, so the audit row and the grant row commit
or roll back **atomically together**. Append-only is enforced at the DB role level
(CLAUDE.md invariant 5), not in this service.

**C6.** Response: the view re-queries grant rows and recomputes
`effective_modules(target_user, org)` for the response body (lines 253-269) — note
this read happens **after** the service returned and cache was invalidated, so it
re-resolves fresh from the DB.

**C7.** Client post-write: `saveRow.onSuccess` clears the row's pending edits,
toasts, and `qc.invalidateQueries(["permissions","matrix",slug])` to refetch the
matrix (lines 103-113). On error it **keeps** edits so the user never silently
loses input (lines 114-124). The retry policy skips 403/404 (lines 81-87).

**Idempotency point (partial).** A client `event_id` is sent and accepted by
`BulkGrantsCellsSerializer` (`event_id` field, lines 108-110 of
`serializers.py`) **but is currently ignored at the service layer** — the comment
states bulk-grant idempotency lands in Phase 1B with the global event_id table.
Today idempotency is *effectively* achieved by `update_or_create` keyed on the
unique `(user, organization, module)` constraint
(`MembershipModuleGrant.Meta.constraints`,
`backend/apps/permissions/models.py` lines 145-150): replaying the same cells
converges to the same rows, but unchanged-state replays emit **no** audit row
(the `prior_state == state` skip, grants.py lines 169-173), so a true network
retry is harmless.

---

## Transaction boundaries / `transaction.on_commit` points

- **Reads (A, B):** no explicit transactions; resolver reads are wrapped only by
  DRF's per-request autocommit. `cache.set` in `effective_modules` (resolver.py
  line 131) is **not** transactional.
- **Grant writes (C):** `transaction.atomic()` in `set_grant` (grants.py line 84),
  `bulk_set_grants` (line 159), `clear_grants` (line 235). Grant row(s) + audit
  row(s) commit atomically.
- **`emit_audit` is in-transaction** (audit/services.py line 61), **not**
  `on_commit` — the audit trail rolls back with a failed grant write. (Contrast:
  `apps/matches` and `apps/fixtures` publish to WS/SSE via `transaction.on_commit`;
  the RBAC flow has **no** `on_commit` hook.)
- **`invalidate_cache` runs INSIDE the atomic block, before COMMIT**
  (grants.py lines 111, 211, 266) — a documented hazard (below); arguably should
  be `transaction.on_commit(lambda: invalidate_cache(...))`.

## Idempotency points

- **`/me` & reads** — naturally idempotent; cache makes repeats cheap (resolver.py
  lines 121-131).
- **Grant upsert** — `update_or_create` on the unique `(user, org, module)`
  constraint (models.py lines 145-150) makes replays converge; unchanged-state
  replays emit no audit row (grants.py lines 169-173).
- **`event_id`** — accepted on the PUT body (serializers.py lines 108-110) but
  **not yet honored server-side** (Phase 1B TODO). Client mints it via
  `crypto.randomUUID()` (ModuleMatrixPage.tsx lines 20-24).
- **`load_modules` command** — catalog upsert via `update_or_create` on `code`,
  never deletes (idempotent; `management/commands/load_modules.py` `handle`,
  lines 62-66) — the catalog is the source of truth for `default_for_roles`.

## Client ↔ server contracts this flow depends on

1. **Session cookie + `X-CSRFToken`** on unsafe verbs (`api/client.ts` lines 59-69;
   backend `REST_FRAMEWORK` SessionAuthentication + CSRF settings, base.py
   lines 152-166). Same-origin SPA, no JWT (invariant 15).
2. **`GET /api/accounts/me/`** → `{id, email, is_superuser, last_active_org_slug,
   memberships:[{org_id, org_slug, org_name, roles[], is_org_owner,
   effective_modules[]}], ...}` (`MeSerializer.Meta.fields` lines 109-121;
   `MembershipSummarySerializer` fields lines 87-92). The SPA consumes
   `effective_modules` verbatim — never recomputes.
3. **`GET /api/permissions/orgs/{slug}/grants/matrix/`** → `{modules:[{key, scope,
   label, description}], members:[{user_id, user_email, user_full_name, roles[],
   cells:{code:state}, role_defaults:{code:bool}}]}` (`build_matrix`
   matrix.py lines 59-153; `MatrixResponseSerializer` serializers.py lines 88-92).
4. **`PUT /api/permissions/orgs/{slug}/users/{uid}/grants/`** — body **either**
   `{cells:{code:state}, reason(≥20), event_id?}` **or** `{grants:[{module,state}],
   reason(≥20)}`; `cells` wins if both (views.py lines 221-235). Response
   `{grants:[GrantRow], effective_modules:[str]}` (lines 262-269).
   `state ∈ {default, grant, deny}` (`GrantState`, models.py lines 27-40).
5. **`GET /api/permissions/orgs/{slug}/me/modules/`** → `{modules:[str]}`
   (`MyModulesBySlugView.get` views.py lines 295-300).
6. **`GET /api/permissions/modules/`** → catalog `ModuleDef[]` (views.py
   `ModuleCatalogView` lines 73-88; `ModuleSerializer` serializers.py lines 9-15).
7. **URL ordering contract** — the matrix slug route must precede the catch-all
   `{slug}/users/...` so a slug literally named "grants" can't shadow it
   (`urls.py` lines 29-46, explicit comment).
8. **Module-code list parity** — the codes in `computeNavItems.ts`
   (`MODULE_FORMS`, line 23), `dashboardCards.ts` (`MODULES`, lines 48-56), and
   `fixtures/modules.json` (23 entries) must stay in sync (no codegen today).
9. **HTTP status semantics** — 404 = not in scope (hidden), 403 = in scope but
   lacks verb, 401 = unauthenticated. The SPA branches on these (matrix retry
   skips 403/404, ModuleMatrixPage.tsx lines 81-87; bootstrap treats 401 as anon,
   authStore.ts lines 50-53).

## Parity / invariants this flow depends on

- **Deny-after-union** — `MembershipModuleGrant` keyed on `(user, org, module)`
  (models.py lines 84-99, 145-150); deny wins regardless of role count
  (the 2026-05-02 audit fix, models.py docstring lines 6-16).
- **404-before-403** — scope resolves first; existence never leaks
  (`_get_tournament_or_404` views.py lines 62-71; invariant 2).
- **Server authoritative; client gating is convenience** — `effective_modules`
  runs only server-side; the SPA consumes the materialized result. Client/server
  disagreement on a stale `/me` is fail-safe (UI hides/shows wrong, server still
  enforces).
- **Catalog is the only source of `default_for_roles`** — `modules.json` ↔ resolver
  ↔ matrix ↔ client all key off the same 23 codes.
- **Reason ≥ 20 chars + one audit row per changed module** — enforced in
  `grants.py` (lines 151-154, 192-209), not the DB.
- **Two-layer model** — module visibility (`HasModule`) governs surfaces; the verb
  matrix (`can_manage_tournament`, `IsOrgAdminOrOwner`) governs actions
  (invariant 12).

## Known hazards / failure modes (verified in source)

- **Cache invalidation before COMMIT.** `invalidate_cache` is called inside the
  atomic block (grants.py lines 111, 211, 266). A concurrent read after the delete
  but before COMMIT can re-populate the cache with the pre-write value, leaving a
  stale entry up to 300 s. Should be `transaction.on_commit`.
- **Single-process cache invalidation only.** `invalidate_cache` deletes only the
  local/shared backend entry; cross-worker Redis pub/sub is a TODO
  (resolver.py lines 42-50). Multi-worker prod can serve stale module sets ≤ 300 s.
- **`/me` staleness.** `effective_modules` is materialized at bootstrap; a
  mid-session grant change isn't reflected until `/me` is re-fetched
  (authStore `refreshMe`, lines 159-166, is not auto-triggered by a grant write).
- **`event_id` accepted but ignored** on the grant PUT (serializers.py lines
  108-110) — true idempotency relies on the unique constraint + unchanged-skip,
  not on `event_id`, until Phase 1B.
- **Scope-semantics divergence** — `accessible_tournaments` (org-ADMIN-only) vs
  `ScopedQuerySet.scoped_for_user` (any-active-membership) can disagree for
  non-admin members; a unified scope resolver is a restructuring seam.
- **`HasModule` exists but admin RBAC surfaces gate on role** (DEFECT-J):
  `UserGrantsView`/`MatrixView` use `IsOrgAdminOrOwner`, not
  `HasModule("org.member_directory")`, because co-organizer/game-coordinator hold
  that module by default (views.py docstrings lines 139-148, 340-352).
