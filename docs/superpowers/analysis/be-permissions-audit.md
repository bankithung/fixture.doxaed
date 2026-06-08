# Subsystem analysis — Backend · permissions + audit

> Scope: `backend/apps/permissions` and `backend/apps/audit`. Read against
> CLAUDE.md (invariants 5, 12) and the canonical spec `v1Users.md` (Appendix
> A.2/A.3/A.4, B.2/B.3/B.4/B.5/B.16/B.17). This is ground-truth for a
> planned full restructuring.

## Purpose

These two apps together implement **Layer 1 of the two-layer RBAC** described
in CLAUDE.md ("Module visibility governs *surfaces*; the PRD §3.2 verb matrix
governs *fine-grained verbs*") plus the **platform-wide audit trail**.

- `permissions` owns: a static **module catalog** (23 rows), **per-(user, org)
  override grants**, the `effective_modules()` resolver (multi-role union +
  override layer, cached), the reusable **scope-filter** base classes for
  multi-tenancy, the `HasModule` DRF permission class, and the SPA-facing
  module-override **matrix** endpoint.
- `audit` owns: the **append-only `AuditEvent` log**, the canonical
  `emit_audit()` service (the *only* sanctioned write path), the DB-level
  append-only trigger (invariant 5), and the cursor-paginated org-scoped audit
  feed.

They are tightly intertwined: every grant mutation in `permissions` emits one
`AuditEvent`; the audit list view is itself gated by a `permissions` module.

## File-by-file roles

### permissions
- `apps.py` — `PermissionsConfig`, **`label = "permissions_app"`** (deliberate;
  avoids clashing with `django.contrib.auth`'s `permissions` label). Every
  `Meta.app_label`, migration dep, and FK string (`"permissions_app.module"`)
  uses this label.
- `__init__.py` — module docstring; sets `default_app_config`.
- `models.py` — `GrantState` (TextChoices: `default`/`grant`/`deny`), `Module`,
  `MembershipModuleGrant`.
- `scope.py` — `ScopedQuerySet` (`scoped_for_user`, `module_gated`,
  `_user_org_ids`) + `ScopedManager`. The sanctioned multi-tenancy filter.
- `permissions.py` — `HasModule(module_code)` **class factory** returning a
  `BasePermission` subclass; resolves the org context via several fallbacks.
- `services/resolver.py` — `effective_modules`, `has_module`, cache helpers
  (`cache_key`, `invalidate_cache`), private `_user_active_roles`,
  `_base_modules_for_roles`, `_apply_overrides`.
- `services/grants.py` — `set_grant`, `bulk_set_grants`, `clear_grants`,
  `GrantValidationError`, `MIN_REASON_LEN = 20`. All write paths.
- `services/matrix.py` — `build_matrix(org)` for the SPA override matrix UI.
- `services/__init__.py` — re-exports the public service surface.
- `serializers.py` — `ModuleSerializer`, `GrantRowSerializer`,
  `GrantInputSerializer`, `BulkGrantsSerializer`, `BulkGrantsCellsSerializer`,
  `EffectiveModulesSerializer`, matrix serializers.
- `views.py` — `ModuleCatalogView`, `MyEffectiveModulesView`, `UserGrantsView`
  (+ `UserGrantsBySlugView`, `MyModulesBySlugView`), `MatrixView`.
- `urls.py` — routes mounted at `/api/permissions/`.
- `management/commands/load_modules.py` — idempotent upsert of `modules.json`.
- `fixtures/modules.json` — the catalog **source of truth** (23 entries).
- `migrations/0001_initial.py` — `Module` + `MembershipModuleGrant` tables.
- `tests/` — resolver (default / multi-role / grant-override / deny-over-union /
  caching), permission-matrix (parametrized over fixture × roles), matrix API,
  scope queryset, module-gated queryset, fixture-loads, grant-audit.

### audit
- `apps.py` — `AuditConfig`, `label = "audit"`.
- `models.py` — `ActorRole` (TextChoices, the locked B.5 taxonomy incl.
  `system`), `AuditEvent`, plus a `serialize_payload()` **stub**.
- `services.py` — `emit_audit(**kwargs)` (canonical write) and
  `emit_audit_on_commit(**kwargs)`.
- `serializers.py` — `AuditEventSerializer`, `AuditEventListResponseSerializer`.
- `views.py` — `OrgAuditListView` + cursor helpers (`_encode_cursor`,
  `_decode_cursor`, `_parse_iso8601`, `_resolve_org_by_slug_or_uuid`).
- `urls.py` — `/api/audit/orgs/<slug>/`.
- `migrations/0001_initial.py` — `audit_event` table + 3 indexes.
- `migrations/0002_audit_append_only.py` — **the append-only trigger** (RunSQL).
- `tests/` — `test_append_only.py` (trigger fires for ORM + raw SQL; insert
  still works), `test_audit_list_view.py` (admin sees rows, cross-org isolation,
  module gate, pagination).

## Data model

### `Module` (`db_table=permissions_module`)
- `id` UUID v7 PK; `code` (unique, ≤64, e.g. `tournament.editor`); `name`;
  `description`; `category` (db-indexed; `org_scoped`/`tournament_scoped`/
  `match_scoped`/`personal`); **`default_for_roles`** JSON list of role
  strings; `created_at`. Ordering: `[category, code]`.
- **The catalog is data, not code.** Roles → default modules live entirely in
  `default_for_roles` columns populated from `modules.json`.

### `MembershipModuleGrant` (`db_table=permissions_membership_module_grant`)
- `id` UUID v7; `user` FK (CASCADE); `organization` FK (CASCADE); `module` FK
  (**PROTECT** — catalog rows can't be deleted while grants reference them);
  `state` (GrantState); `granted_by` FK (SET_NULL); `reason` TextField (blank
  allowed at DB level, ≥20 chars enforced at the service layer); `created_at`/
  `updated_at`.
- **Unique constraint** `unique_grant_per_user_org_module` on
  `(user, organization, module)` + index on `(user, organization)`.
- **Keyed on (user, org), NOT on `OrganizationMembership`** — this is the
  2026-05-02 audit fix (Appendix A.4): the old keying let a `deny` be silently
  bypassed when a second active role re-granted the same module via the Layer-1
  union. The new key makes overrides a single source of truth regardless of how
  many roles the user holds.

### `AuditEvent` (`db_table=audit_event`)
- `id` UUID v7; `idempotency_key` (unique, nullable).
- Actor: `actor_user` FK (SET_NULL, `related_name="+"`), `actor_role`
  (ActorRole), `deleted_user_handle`, `impersonating_user_id`.
- Scope: `organization_id`/`tournament_id`/`match_id` (raw UUIDs, **not FKs**,
  each db-indexed).
- Target: `event_type`, `target_type`, `target_id` (all indexed).
- Body: `payload_before`/`payload_after` JSONB, `reason`, `ip_address`,
  `user_agent`, `created_at` (indexed).
- Indexes: `(organization_id, -created_at)`, `(target_type, target_id,
  -created_at)`, `(actor_user, -created_at)`. **No `Meta.ordering`** by design —
  `created_at` + the time-ordered UUID v7 PK give natural order and stable
  cursors.

Relationship note: scope IDs are deliberately **denormalized UUID columns**, so
`AuditEvent` does not FK into tenant tables and survives target deletion.

## Core algorithms / services (file:function, step-by-step)

### `effective_modules(user, organization)` — `services/resolver.py:effective_modules`
1. Guard: anon/`is_authenticated`-false → `frozenset()`; missing user_id or
   org_id → `frozenset()`.
2. Build cache key `effective_modules:{user_id}:{org_id}`; return cached
   `frozenset` on hit (TTL 300s).
3. `_user_active_roles(user, org)` — distinct `role` values from active
   `OrganizationMembership` rows (local import to dodge circular import).
4. `_base_modules_for_roles(roles)` — scan **all** `Module` rows; add `code`
   when `role_set ∩ module.default_for_roles` is non-empty. Empty roles → empty.
5. `_apply_overrides(base, user, org)` — read this user/org's grant rows;
   `grant`→add, `deny`→discard, `default`→no-op.
6. `cache.set(...)`, return `frozenset`.
- `has_module(user, org, code)` = membership test on the result.
- **Resolution order = base union THEN overrides**, so a single `deny` row wins
  over any number of roles that would have granted it (verified by
  `test_resolver_grant_overrides_role_default_deny.py`).

### Grant writes — `services/grants.py`
All three share: validate `reason` length ≥ 20 (`GrantValidationError`
otherwise), run inside `transaction.atomic()`, call
`invalidate_cache(user.id, org.id)`, and `emit_audit(event_type=
"module_grant_changed", target_type="membership_module_grant", ...)` with
before/after `{state, module_code}` payloads.
- `set_grant(...)` — validate state + resolve module (instance or code);
  compute `prior_state` (DEFAULT if no row); `state=default` **collapses to row
  deletion**; otherwise `update_or_create`. **Always emits one audit row** (even
  on a no-op set). Returns the row (or `None` when cleared).
- `bulk_set_grants(grants=[(code,state)...])` — per pair: skip emit when
  `prior_state == state` (**no-op suppression**), else apply + emit. One audit
  row per *changed* module. `invalidate_cache` once at the end.
- `clear_grants(...)` — delete every override row for (user, org), emit one
  `module_grant_changed` audit row per deletion (after→`default`); returns count.

### `emit_audit(...)` — `audit/services.py:emit_audit`
1. Idempotency: if `idempotency_key` provided and a row already exists, return
   it (no new row).
2. Derive `ip`/`ua` from `request.META` when a request is passed (X-Forwarded-
   For first hop, else REMOTE_ADDR; UA truncated to 255).
3. Coerce `actor_role` (enum or str) to its `.value`.
4. `AuditEvent.objects.create(...)` inside the **caller's** transaction.
- `emit_audit_on_commit(**kwargs)` defers via `transaction.on_commit`; the
  docstring steers callers to the inline form so audit + state change are atomic.

### Append-only enforcement — `audit/migrations/0002_audit_append_only.py`
PL/pgSQL function `audit_event_append_only()` `RAISE EXCEPTION ... USING
ERRCODE='42501'`, wired to `BEFORE UPDATE` and `BEFORE DELETE` row triggers.
**Triggers fire even for the Postgres superuser**, so dev (which connects as
`postgres`) is also protected; prod is told to additionally connect as a
non-superuser and `REVOKE UPDATE/DELETE` (documented in `fixture/settings/
prod.py` `DATABASE_URL` note — provisioning, not in this migration). Verified by
`test_append_only.py` (ORM save/delete + raw SQL all raise; INSERT still works).

### Scope filters — `permissions/scope.py`
- `_user_org_ids(user)` — active `OrganizationMembership` org ids (empty for
  anon).
- `scoped_for_user(user)` — anon→`.none()`, superuser→unmodified, else
  `.filter(organization_id__in=org_ids)`.
- `module_gated(user, code)` — per accessible org, keep those where
  `effective_modules(user, org)` contains `code` (hand-rolled loop, "small N"
  comment). Superuser bypass; anon→`.none()`.

### Matrix — `services/matrix.py:build_matrix(org)`
Single-pass: serialize 23 modules; build `role → set(default codes)`; aggregate
active memberships → `user_id → roles`; **one** bulk query for all grant rows;
per member produce `cells` (override state per code) + `role_defaults` (bool per
code). Note: it **recomputes the base set itself** rather than calling
`effective_modules` (it shows the layered breakdown, not the resolved set).

### Audit cursor pagination — `audit/views.py:OrgAuditListView.get`
Filter by `organization_id`; optional `actor_id`/`event_type`/`from`/`to`;
order `-created_at, -id`; cursor = base64 of `"<iso>|<uuid>"`, applied as
`Q(created_at__lt=ts) | Q(created_at=ts, id__lt=id)`; fetch `limit+1` to compute
`has_more`/`next_cursor`. `limit` clamped to `[1, 200]`, default 50.

## API / endpoint surface

permissions (`/api/permissions/`):
- `GET modules/` — full catalog (`IsAuthenticated`).
- `GET me/modules/?org={uuid}` — caller's effective set.
- `GET|PUT orgs/{org_uuid}/users/{user_uuid}/grants/` — admin-only
  (`IsOrgAdminOrOwner`); PUT accepts `grants=[{module,state}]` **or** SPA
  `cells={code:state}` (cells wins if both present); replies with `grants` +
  recomputed `effective_modules`.
- Slug aliases: `GET orgs/{slug}/me/modules/`,
  `GET|PUT orgs/{slug}/users/{user_uuid}/grants/`,
  `GET orgs/{slug}/grants/matrix/` (admin-only matrix). URL order matters: the
  matrix path is declared before the catch-all slug patterns.

audit (`/api/audit/`):
- `GET orgs/{slug}/` — cursor-paginated org audit feed; gated by
  `HasModule("org.audit_log")`. Read-only (no write surface).

Exported library API (consumed by other apps):
`apps.audit.services.emit_audit` / `emit_audit_on_commit`;
`apps.permissions.services.{effective_modules, has_module, set_grant,
bulk_set_grants, clear_grants}`; `apps.permissions.permissions.HasModule`;
`apps.permissions.scope.{ScopedQuerySet, ScopedManager}`.

## Invariants that must be preserved

1. **Audit is append-only at the DB level** (invariant 5). The trigger must
   survive any restructuring; a mutating migration on `audit_event` must fail.
2. **`emit_audit()` is the only write path** for `AuditEvent` (B.4: service
   call, not signals). ~30 call sites across the platform depend on its kwargs.
3. **Resolution order = role-union THEN overrides**; a `deny` must beat any
   multi-role union (the A.4 audit-fix bug).
4. **Grants keyed on (user, org, module)** — never re-key to membership rows.
5. **Every grant mutation emits exactly one audit row per changed module** with
   before/after `{state, module_code}` (B.17); no-op bulk pairs emit nothing.
6. **Reason ≥ 20 chars** enforced at the service layer for all grant writes.
7. **App label is `permissions_app`** — renaming breaks migrations + FK strings.
8. **23 modules** (`test_load_modules_creates_23_rows`, matrix returns 23). The
   `default_for_roles` per-role mapping is canonical (invariant 12; the full
   `test_permission_matrix` parametrizes fixture × roles).
9. **Catalog FK is PROTECT** — a referenced module can't be deleted.
10. **Cross-org isolation**: scope filters + the audit view filter strictly on
    org; anon→empty, superuser→bypass.
11. **`load_modules` is idempotent** (upsert on `code`, never deletes).
12. **Effective set is a `frozenset` of module codes**, cached for 5 min and
    invalidated on every grant write.

## Dependencies / coupling

Outgoing (these apps depend on):
- `apps.accounts` — `uuid7`, `AUTH_USER_MODEL`/`User`.
- `apps.organizations` — `Organization`, `OrganizationMembership`,
  `MembershipRole`, `OrgStatus`; and `IsOrgAdminOrOwner` (imported by both
  permissions views and used to gate grant management). All resolver/scope
  reads of memberships are **local imports** to avoid circular import.
- Django cache backend (locmem dev / Redis prod) for the resolver cache.

Incoming (who depends on these):
- **`emit_audit` callers (~30 files)**: tournaments, accounts (login/2FA/
  password reset/signup), teams, organizations (lifecycle/invitation/ownership/
  slug/workspace), sadmin, forms, matches (events/scoring/lineups/state/
  incidents), disputes. This is the single most coupled symbol in the subsystem.
- `effective_modules`/`has_module`/`HasModule`/scope classes consumed by
  `accounts.serializers`, `organizations.{scope,permissions,views}`,
  `audit.views`. Note `organizations` has its **own** `scope.py`
  (`ScopedQuerySetMixin`/`OrgScopedQuerySet`) — a parallel pattern (see smells).
- The catalog (`modules.json`) is the source of truth the frontend matrix UI
  and the verb matrix both read against.

## Tech debt / smells / duplication

- **Module-count drift in docstrings.** Code/tests assert 23; multiple
  docstrings still say "22" (`models.py` `Module`, both `conftest.py`
  `loaded_modules`, `matrix.py` shapes). `modules.json` has 23. Cosmetic but
  misleading.
- **Cache invalidation is single-process only.** `invalidate_cache` just
  `cache.delete`s; cross-worker Redis pub/sub (Appendix B.3) is a documented
  TODO at every call site. Multi-ASGI-worker prod could serve stale module sets
  for up to 5 min.
- **`set_grant` always emits an audit row, even when state is unchanged**,
  whereas `bulk_set_grants` suppresses no-ops — inconsistent semantics for "the
  same change."
- **`set_grant` returns `None` when clearing** (state=default), an awkward
  union return type; callers must null-check.
- **`target_id` fabrication.** When a grant is cleared, `set_grant`/
  `bulk_set_grants` pass `uuid.uuid4()` as the audit `target_id` (the row no
  longer exists) — a synthetic, non-correlatable id. `clear_grants` correctly
  uses the real row id.
- **`bulk_set_grants` is not idempotent.** The PUT accepts `event_id` but the
  serializer comment + Phase-1A note say it is ignored; replaying a matrix PUT
  re-emits audit rows for any cell that differs.
- **Two scope implementations.** `permissions/scope.py` (`ScopedManager`/
  `ScopedQuerySet`) vs `organizations/scope.py` (`ScopedQuerySetMixin`) vs the
  bespoke `tournaments/scope.py::accessible_tournaments` referenced in CLAUDE.md.
  Three parallel "scope" abstractions; the permissions one appears **unused by
  production models** (tests instantiate `ScopedQuerySet(model=Organization)`
  directly and even monkeypatch around `organization_id` vs `id`).
- **`module_gated` N+1 in spirit** — per-org `effective_modules` loop; mitigated
  only by the cache and a "small N" comment.
- **`scope.py` superuser bypass returns `self`** (the unfiltered base), not a
  copy — fine for QuerySets but subtle.
- **Two PUT body shapes** in `UserGrantsView.put` (`grants` vs `cells`) branched
  in the view; some duplication; "cells wins" is implicit.
- **`serialize_payload()` in `audit/models.py` is a stub** — UUID/datetime
  normalization for payloads is unimplemented; payloads rely on callers passing
  JSON-safe dicts.
- **Audit serializer `actor_email_at_time` is not a true historical snapshot**
  (reads the live FK email; falls back to `deleted_user_handle`). B.11 PII
  redaction is mentioned in the docstring but **not implemented** in the
  serializer.
- **`HasModule` as a class factory** generates a new permission class per call;
  works with DRF but is unusual and hampers static analysis.
- **`AuditEvent.actor_role` has no DB default**; a bad caller could write an
  invalid role string (choices not enforced at DB).

## Restructuring seams & risks

- **Seam: `emit_audit` is the platform-wide write boundary.** Any restructure
  should preserve its keyword signature (or provide a shim). Consider a typed
  event-name registry/enum (today `event_type` is a free string with ~25+
  distinct values scattered across callers) — a high-value, low-risk
  consolidation that makes the audit taxonomy enforceable.
- **Seam: the resolver is pure and well-factored** (`_user_active_roles` /
  `_base_modules_for_roles` / `_apply_overrides`). It can be moved or
  re-cached behind a stable `effective_modules` facade. Risk: the cache key
  format and `frozenset` return type are depended on by tests and callers.
- **Risk: append-only trigger + migrations.** The trigger lives in raw SQL in
  one migration. Any restructure that renames the table, changes the role model,
  or squashes migrations must re-create the trigger and keep the `42501`
  errcode contract (tests assert `"append-only"` or `"42501"` in the message).
  Migrations are also blocked while a tournament is `live` (deploy pre-flight).
- **Opportunity: unify the three scope abstractions.** The permissions
  `ScopedManager`/`ScopedQuerySet` looks like the intended canonical pattern
  but is effectively unused in production; consolidating onto one (and actually
  wiring tenant models to it) would remove the hand-rolled
  `.filter(organization__in=...)` smell the docstring warns about.
- **Opportunity: make grant writes idempotent** using the accepted `event_id`
  (wire it into `emit_audit`'s `idempotency_key`) to align with invariant 3.
- **Risk: denormalized scope UUIDs on `AuditEvent`.** No FKs means no DB-level
  referential integrity; a restructure that "normalizes" these would break the
  survive-deletion guarantee and the cross-org filter performance (the
  `(organization_id, -created_at)` index is the hot path).
- **Risk: the matrix recomputes role-defaults independently of the resolver.**
  If the resolution rules change, two code paths must change in lockstep
  (`resolver._base_modules_for_roles` and `matrix.build_matrix`). Folding the
  matrix onto a shared "explain" helper would remove this duplication.
- **Low risk: docstring/count cleanup (22→23)** can be done freely; tests
  already pin 23.
