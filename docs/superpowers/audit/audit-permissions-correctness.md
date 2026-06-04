# Permissions App — Correctness & Logic Bug Audit

**Date:** 2026-06-04
**Scope:** `backend/apps/permissions/` — wrong conditionals, off-by-one, races, queryset filters, missing transaction.atomic / on_commit, serializer↔model mismatch, wrong HTTP status, None handling.

---

## Findings

---

### FINDING 1 — CRITICAL: Wrong `getattr` default flips anonymous-user guard

**File:** `backend/apps/permissions/services/resolver.py:113`

**Evidence:**
```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

**Why it matters:**
The default value for `getattr` is `True`. If `user` is some object that lacks the `is_authenticated` attribute entirely (e.g., a custom mock, a service-account stub, or anything that is not `None` but also not a Django `User`/`AnonymousUser`), `getattr(user, "is_authenticated", True)` returns `True`, meaning the guard expression evaluates to `not True = False`, so the condition is NOT triggered and the function proceeds as if the user is authenticated. This is the inverse of the intended safety-default. Every other guard in the same codebase correctly uses `False`:

- `permissions.py:41`: `getattr(user, "is_authenticated", False)`
- `scope.py:55`: `getattr(user, "is_authenticated", False)`
- `scope.py:70`: `getattr(user, "is_authenticated", False)`
- `scope.py:89`: `getattr(user, "is_authenticated", False)`

**Recommendation:**
Change `True` → `False`:
```python
if user is None or not getattr(user, "is_authenticated", False):
    return frozenset()
```

**Confidence:** High

---

### FINDING 2 — HIGH: `set_grant` returns `None` on `state=DEFAULT` but callers may not expect it

**File:** `backend/apps/permissions/services/grants.py:132`

**Evidence:**
```python
    return row  # row is None when state == GrantState.DEFAULT
```

The docstring says "Returns the persisted MembershipModuleGrant row." When `state=DEFAULT` (the "delete" path) `row` is set to `None` (lines 93–96). Callers that do `row = set_grant(...)` and then unconditionally access `row.id` or `row.state` will raise `AttributeError`.

**Why it matters:**
`emit_audit` within the same `transaction.atomic` block at line 118 already handles `None` via `(row.id if row else uuid.uuid4())`, so that part is safe. However, external callers (views, tests, future Phase 1B code) that call `set_grant(..., state="default")` and then access `.id`/`.state` on the result will crash silently. The return type annotation is `MembershipModuleGrant` (not `Optional`), so type checkers will not flag incorrect usage.

**Recommendation:**
Update the return type to `MembershipModuleGrant | None` and update the docstring. Add `# Returns None when state == "default"` at the call site or raise a dedicated `GrantDeleted` sentinel. At minimum, align the type annotation:
```python
) -> MembershipModuleGrant | None:
```

**Confidence:** High

---

### FINDING 3 — HIGH: `audit` emission NOT deferred via `on_commit` — audit row written before transaction commits

**File:** `backend/apps/permissions/services/grants.py:84,113` (and lines 192, 247)

**Evidence:**
```python
with transaction.atomic():
    ...
    emit_audit(...)  # inline, inside transaction
```

`emit_audit` writes an `AuditEvent` row inside the same `transaction.atomic()` block. If the outer transaction is subsequently rolled back (e.g., by a higher-level `atomic()` that wraps the grant write), the audit row is also rolled back. This is not wrong per se and actually guarantees atomicity with the mutation — both succeed or both fail together. HOWEVER, architectural invariant #4 states: "Every state-changing action publishes to Redis pub/sub *after* the DB transaction commits (`transaction.on_commit`)." The audit row is the system of record and the project uses `emit_audit_on_commit` (at `audit/services.py:80`) for the on-commit pattern. The grants service uses the synchronous `emit_audit` instead.

The audit service has a `emit_audit_on_commit` helper. The grants service correctly does NOT use it (the sync path is correct for shared atomicity). This is fine for correctness, but cache invalidation (`invalidate_cache`) at line 111 IS called inside the `atomic()` block — which means if the outer caller wraps this in its own `atomic()` that later rolls back, the cache is already invalidated but the DB row change is rolled back, leaving a stale (now empty) cache for up to 5 minutes.

**Why it matters:**
`invalidate_cache` (which calls `cache.delete()`) is not transactional. If an outer `atomic()` wraps `set_grant` and rolls back, the grant row is gone but the cache is already cleared — the next `effective_modules()` call will recompute from DB (which is now back to the pre-call state). So the cache is now consistent with the (rolled-back) DB state. This is actually correct. However, the inverse race — cache delete fires, then DB commit races with another request that repopulates cache — is a concern at scale. This is a known Phase 1B gap (Appendix B.3).

**Recommendation:**
Move `invalidate_cache` to `transaction.on_commit` to avoid clearing the cache for a transaction that has not yet committed:
```python
transaction.on_commit(lambda: invalidate_cache(user.id, organization.id))
```
Apply this in all three functions (`set_grant`, `bulk_set_grants`, `clear_grants`). This is the correct TOCTOU-safe pattern per invariant #4.

**Confidence:** Medium-High

---

### FINDING 4 — HIGH: `bulk_set_grants` — N+1 queries inside `transaction.atomic`, no `select_for_update`

**File:** `backend/apps/permissions/services/grants.py:159-210`

**Evidence:**
```python
with transaction.atomic():
    for module_code, state in grants:
        ...
        existing = MembershipModuleGrant.objects.filter(
            user=user, organization=organization, module=module_obj
        ).first()
        ...
        row, _ = MembershipModuleGrant.objects.update_or_create(...)
```

For N modules in the bulk payload, the code issues: 1 `Module.objects.get` + 1 `MembershipModuleGrant.objects.filter().first()` + 1 `MembershipModuleGrant.objects.update_or_create` per module = 3N queries. For a full 22-module matrix update this is 66 queries. More critically, the read (`filter().first()`) and the write (`update_or_create`) are not protected by `select_for_update`, so two simultaneous PUT requests for the same (user, org) can both read `existing=None` and both try to `create` the row, hitting the `unique_grant_per_user_org_module` constraint and raising `IntegrityError` at the DB level (which would turn into an unhandled 500).

**Why it matters:**
Concurrent SPA submissions (user double-clicks "Save") can race on the same (user, org, module) triple. The DB constraint will catch duplicate creates, but the error bubbles as an unhandled `IntegrityError` rather than a graceful 409/200.

**Recommendation:**
Add `select_for_update()` to the read within the loop (PostgreSQL will serialize the two transactions):
```python
existing = MembershipModuleGrant.objects.select_for_update().filter(
    user=user, organization=organization, module=module_obj
).first()
```
Also consider pre-fetching all relevant `Module` rows and all existing grant rows before the loop to reduce to O(1) queries.

**Confidence:** Medium

---

### FINDING 5 — MEDIUM: `MyEffectiveModulesView` does NOT check soft-delete on org lookup

**File:** `backend/apps/permissions/views.py:128`

**Evidence:**
```python
org = Organization.objects.filter(id=org_uuid).first()
```

The slug-routing helper `_resolve_org_by_slug_or_uuid` correctly filters `deleted_at__isnull=True` (lines 66, 69). But `MyEffectiveModulesView.get()` at line 128 uses a plain `filter(id=org_uuid)` with no soft-delete guard. A user can call `GET /api/permissions/me/modules/?org=<soft-deleted-org-uuid>` and get a 200 with an effective module set computed against a deleted org.

**Why it matters:**
Soft-deleted orgs should be invisible. Returning effective modules for a deleted org is a data-correctness error and could expose information (e.g., confirming that a UUID corresponds to a real org even after deletion).

**Recommendation:**
```python
org = Organization.objects.filter(id=org_uuid, deleted_at__isnull=True).first()
```

**Confidence:** High

---

### FINDING 6 — MEDIUM: `UserGrantsView.get_organization` does NOT check soft-delete

**File:** `backend/apps/permissions/views.py:156-159`

**Evidence:**
```python
def get_organization(self):
    ...
    return Organization.objects.filter(id=uuid.UUID(str(org_uuid))).first()
```

Same soft-delete omission as Finding 5. The UUID-routed `UserGrantsView` (`GET /PUT /api/permissions/orgs/{org_uuid}/users/{user_uuid}/grants/`) resolves the org without the `deleted_at__isnull=True` guard.

**Recommendation:**
```python
return Organization.objects.filter(id=uuid.UUID(str(org_uuid)), deleted_at__isnull=True).first()
```

**Confidence:** High

---

### FINDING 7 — MEDIUM: Audit target_id is a random `uuid.uuid4()` when row is deleted — breaks audit traceability

**File:** `backend/apps/permissions/services/grants.py:118`

**Evidence:**
```python
target_id=(row.id if row else uuid.uuid4()),
```

When `state == GrantState.DEFAULT` and an existing row is deleted, `row` is `None` and a fresh random UUID is generated for `target_id`. The audit row therefore has a `target_id` that does not correspond to any DB row (the grant row was just deleted). Looking up `target_id` in the audit log will return nothing — the audit row is orphaned and the historical chain is broken.

**Why it matters:**
The PRD mandates append-only audit with full traceback. An auditor querying "what happened to grant row `<uuid>`" will not find this audit row. Reverse: querying the audit row's `target_id` in any table produces no match.

**Recommendation:**
Capture the `row_id` before deleting (as `clear_grants` correctly does), and pass that preserved UUID:
```python
# In set_grant, inside the `if state == GrantState.DEFAULT:` branch:
prior_row_id = existing.id if existing else None
if existing:
    existing.delete()
row = None

# Then:
target_id=(prior_row_id or uuid.uuid4()),
```
`clear_grants` (lines 242–244) already does this correctly and is the pattern to follow.

**Confidence:** High

---

### FINDING 8 — MEDIUM: `bulk_set_grants` also uses `uuid.uuid4()` for deleted-row audit target_id

**File:** `backend/apps/permissions/services/grants.py:196`

**Evidence:**
```python
target_id=(row.id if row else uuid.uuid4()),
```

Same problem as Finding 7, in `bulk_set_grants`. When `state=DEFAULT` the existing row is deleted and `row=None`, so a random UUID is written.

**Recommendation:**
Same fix as Finding 7 — capture `existing.id` before `existing.delete()`.

**Confidence:** High

---

### FINDING 9 — LOW: `BulkGrantsCellsSerializer` accepts `event_id` but the service layer silently ignores it — idempotency promise is unfulfilled

**File:** `backend/apps/permissions/serializers.py:107-110`

**Evidence:**
```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```

The SPA matrix UI sends `event_id` expecting idempotent replay behavior (invariant #3). The field is accepted, validated, and then thrown away. A double-submit (network retry) will execute `bulk_set_grants` twice: because the second call sees `prior_state == state` for each module, no audit rows are emitted and no DB changes happen (idempotent by coincidence). But this is accident, not contract — if the first request partially fails mid-loop, the retry genuinely changes state on already-applied rows, which is wrong.

**Recommendation:**
Log or raise a `NotImplementedError` warning in non-production environments rather than silently accepting a field whose contract is not implemented. Alternatively, document clearly in the API spec that `event_id` is accepted but not yet enforced.

**Confidence:** Medium

---

### FINDING 10 — LOW: `GrantRowSerializer` exposes `granted_by` as a raw FK UUID — leaks user ID without name/email

**File:** `backend/apps/permissions/serializers.py:26-34`

**Evidence:**
```python
fields = [
    "id",
    "module_code",
    "state",
    "reason",
    "granted_by",   # FK → User UUID only
    "created_at",
    "updated_at",
]
```

`granted_by` is a `ForeignKey` field. DRF's `ModelSerializer` will serialize it as a bare UUID (the PK). The SPA matrix UI that shows "granted by whom" gets a UUID, not a human-readable label. This is a UX serializer mismatch.

**Recommendation:**
Add a `granted_by_email = serializers.EmailField(source="granted_by.email", read_only=True, allow_null=True)` field or use `SlugRelatedField(slug_field="email")`.

**Confidence:** Medium (UX issue more than correctness, but the matrix UI needs this)

---

## Gaps (forward-looking, not bugs today)

| # | Area | Current State | Missing | Needed For | Effort |
|---|------|---------------|---------|------------|--------|
| G1 | Cross-worker cache invalidation | Single-process safe via shared cache backend | Redis pub/sub `effective_modules_invalidate` channel (Appendix B.3) | Multi-process ASGI / Phase 1B live | M |
| G2 | `event_id` idempotency for bulk grants | `event_id` accepted, not enforced | Global event_id uniqueness table + replay-200 response | Invariant #3 / Phase 1B | M |
| G3 | `select_for_update` in `set_grant` single-row path | No row lock on read-then-write | Serialize concurrent grant writes | High-traffic orgs | S |
| G4 | `HasModule` permission: `get_organization` silently returns `None` on exception | Swallows all exceptions in `_resolve_organization` | Should distinguish `DoesNotExist` from other errors | Debugging permission denials | S |
| G5 | No test for `MyEffectiveModulesView` with soft-deleted org | Finding 5 — missing test coverage | Assert 404 for deleted-org UUID | Regression prevention | S |
| G6 | `BulkGrantsSerializer` has no `event_id` field but `BulkGrantsCellsSerializer` does | Two request shapes diverge on idempotency surface | Either unify or explain the divergence | API consistency | S |
| G7 | `MatrixView` org resolution passes through `_resolve_org_by_slug_or_uuid` → silent `None` becomes `Http404` but permission check `IsOrgAdminOrOwner` runs first and resolves org independently via `_resolve_org_from_view` — two resolution paths for one request | Potential slug/UUID mismatch if one path resolves and the other doesn't | Unify to single resolution helper | Future robustness | S |
