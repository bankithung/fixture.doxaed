# Audit: permissions — FE↔BE Contract

**Lens:** Serializer output shape (names/types/nullability) vs frontend expectations; required-field validation; consistent error bodies; correct auth/permission classes; endpoints with no consumer / calls with no route.

**Scope:** `backend/apps/permissions/` — serializers, views, urls, services; `frontend/src/api/permissions.ts`; `frontend/src/types/user.ts`; `frontend/src/features/permissions/`.

---

## Findings

### F-1 [CRITICAL] `/api/permissions/modules/` returns wrong field names — `code`/`name`/`category` vs frontend's `key`/`label`/`scope`

**File:** `backend/apps/permissions/serializers.py:9-15` and `frontend/src/api/permissions.ts:10`

**Backend serializer output (ModuleSerializer):**
```python
fields = ["id", "code", "name", "description", "category", "default_for_roles"]
```

**Frontend type (ModuleDef in `frontend/src/types/user.ts:33-39`):**
```ts
export interface ModuleDef {
  key: string;      // ← backend sends "code"
  scope: ModuleScope; // ← backend sends "category" (e.g. "org_scoped" not "org")
  label: string;    // ← backend sends "name"
  description: string;
}
```

The frontend calls `permissionsApi.modules()` → `/api/permissions/modules/` and expects `ModuleDef[]`. The backend sends `Module[]` with `code`, `name`, `category`, `default_for_roles`. Every field the frontend reads silently resolves to `undefined`. The matrix endpoint is fine (uses `build_matrix()` / `_serialize_modules()` which manually maps to `key`/`scope`/`label`/`description`), but the standalone catalog endpoint is entirely broken.

**Evidence for category vs scope mismatch too:** modules.json stores `"category": "org_scoped"`, while the frontend expects `scope: "org"`. Even if the field were renamed, values differ.

**Recommendation:** Either (a) update `ModuleSerializer` to expose `key` (from `code`), `scope` (derived via `_scope_for(code)`), `label` (from `name`) to match the matrix serializer shape, or (b) deprecate the standalone catalog endpoint and use only the matrix aggregate. The cleanest fix is to update `ModuleSerializer` to match the matrix shape and use `SerializerMethodField` for `scope`.

**Confidence:** 100%

---

### F-2 [HIGH] `setGrants` PUT response shape mismatch: frontend expects `{ ok: true }`, backend returns `{ grants, effective_modules }`

**File:** `frontend/src/api/permissions.ts:36` and `backend/apps/permissions/views.py:262-268`

**Frontend:**
```ts
api.put<{ ok: true }>(...)
```

**Backend (UserGrantsView.put):**
```python
return Response({
    "grants": GrantRowSerializer(rows, many=True).data,
    "effective_modules": sorted(effective_modules(target_user, org)),
})
```

The frontend declares the PUT response as `{ ok: true }` but the backend returns a rich `{ grants: GrantRow[], effective_modules: string[] }` envelope. The `ok: true` is never sent. This doesn't cause a runtime crash (the response is received but the frontend doesn't use any field from it — it calls `qc.invalidateQueries` on success instead), but the type is wrong, future code using `data.ok` would silently get `undefined`, and any tooling / generated client relying on the declared return type will produce misleading types.

**Recommendation:** Change the frontend `api.put<{ ok: true }>(...)` to `api.put<{ grants: GrantRow[]; effective_modules: string[] }>(...)` and import the generated `GrantRow` type. Alternatively, use the richer response in `onSuccess` to perform a cache update without the extra `invalidateQueries` round-trip.

**Confidence:** 100%

---

### F-3 [HIGH] `reason` field is optional in the frontend PUT payload but required by the backend (min 20 chars)

**File:** `frontend/src/api/permissions.ts:32` vs `backend/apps/permissions/serializers.py:54` and `backend/apps/permissions/services/grants.py:151-154`

**Frontend `setGrants` payload type:**
```ts
payload: {
  cells: Record<string, GrantState>;
  reason?: string;   // ← optional
  event_id: string;
}
```

**Backend `BulkGrantsCellsSerializer`:**
```python
reason = serializers.CharField(min_length=20, max_length=2000)  # ← required, ≥20 chars
```

**Service layer:**
```python
if not reason or len(reason.strip()) < MIN_REASON_LEN:  # MIN_REASON_LEN = 20
    raise GrantValidationError(...)
```

The frontend type marks `reason` as optional. `ModuleMatrixPage.tsx` calls `setGrants` without ever passing `reason` (line 95-98 — only `cells` and `event_id` are passed). The backend will respond 400 with `{"reason": ["This field is required."]}`. The save will always fail. The UX has a Save button that silently 400s on click.

**Recommendation:** Make `reason` required in the frontend type; add a reason input to the per-row save flow in `ModuleMatrixPage` (a modal or an inline textarea before submitting). The backend spec is clear that every grant change must carry a reason for audit trail (B.17).

**Confidence:** 100%

---

### F-4 [HIGH] `UserGrantsView.get()` returns `{ grants, effective_modules }` but the OpenAPI/generated schema says `GrantRow[]`

**File:** `backend/apps/permissions/views.py:193-198` vs `frontend/src/types/api.generated.ts:2305`

**Backend GET response:**
```python
return Response({
    "grants": serialized,          # GrantRow[]
    "effective_modules": effective, # string[]
})
```

**Generated schema (`api.generated.ts:2305`):**
```ts
"application/json": components["schemas"]["GrantRow"][];
```

The `@extend_schema` decorator on `UserGrantsView.get` is:
```python
@extend_schema(responses={200: GrantRowSerializer(many=True)}, ...)
```
`GrantRowSerializer(many=True)` describes a list, but the actual response is an envelope `{ grants: ..., effective_modules: ... }`. The OpenAPI schema is wrong, causing the generated client to type the endpoint as a bare array when it is actually an object. Any consumer (admin UI, future tooling) that reads the generated types would deserialize incorrectly.

**Recommendation:** Change `@extend_schema(responses={200: GrantRowSerializer(many=True)})` to use an inline serializer or a dedicated response serializer that reflects the actual `{ grants, effective_modules }` envelope. Same fix needed for `UserGrantsBySlugView`.

**Confidence:** 100%

---

### F-5 [MEDIUM] `GrantRowSerializer.granted_by` is a raw UUID (FK id), not an email or name — but the frontend `MembershipModuleGrant` type declares `set_by_user_id`

**File:** `backend/apps/permissions/serializers.py:30` vs `frontend/src/types/user.ts:107`

**Backend `GrantRowSerializer`:**
```python
fields = [..., "granted_by", ...]  # ForeignKey → serialized as UUID PK
```

**Frontend `MembershipModuleGrant` type:**
```ts
export interface MembershipModuleGrant {
  user_id: string;
  module_key: string;   // ← backend sends "module_code"
  state: Exclude<GrantState, "default">;
  reason?: string;
  set_by_user_id: string;  // ← backend sends "granted_by"
  set_at: string;          // ← backend sends "created_at" or "updated_at"
}
```

Three field-name mismatches in the hand-written `MembershipModuleGrant` FE type: `module_key` vs `module_code`, `set_by_user_id` vs `granted_by`, `set_at` vs `created_at`/`updated_at`. This type is not currently used as a query result type anywhere in the code (the matrix endpoint uses `ModuleMatrixRow`), but it exists in `user.ts` and will cause silent failures if anyone imports it for grants display.

**Recommendation:** Align `MembershipModuleGrant` in `user.ts` to match the backend's `GrantRow` schema: rename fields to `module_code`, `granted_by`, `created_at`, `updated_at`. Or delete the type and use the generated `GrantRow` from `api.generated.ts` directly.

**Confidence:** 95%

---

### F-6 [MEDIUM] `MyEffectiveModulesView` (query-param form) and `MyModulesBySlugView` (slug-path form) both exist — but frontend only calls the slug form; the query-param form is unused

**File:** `backend/apps/permissions/urls.py:22` (`/api/permissions/me/modules/?org=<uuid>`) vs `frontend/src/api/permissions.ts:13` (calls `/api/permissions/orgs/${slug}/me/modules/`)

`MyEffectiveModulesView` (`/api/permissions/me/modules/?org={uuid}`) is routed and documented in the OpenAPI schema but the frontend API client never calls it — it calls the slug-alias path instead. The UUID-based path is effectively dead code from a frontend perspective (though it may be used by scripts/tests). The generated schema shows both paths (`permissions_me_modules_retrieve` and `permissions_orgs_me_modules_retrieve`), causing operationId duplication and a confusing API surface.

**Recommendation:** Deprecate or remove `MyEffectiveModulesView` if it has no non-frontend consumers; retain only the slug-routed alias. If it must remain for back-compat, mark it `deprecated=True` in `@extend_schema`.

**Confidence:** 90%

---

### F-7 [MEDIUM] `ModuleCatalogView` has no frontend consumer

**File:** `backend/apps/permissions/urls.py:21` (`/api/permissions/modules/`) and `frontend/src/api/permissions.ts:10`

`permissionsApi.modules()` is declared in the API client but is never called from any component or hook in the frontend source. `ModuleMatrixPage` uses `permissionsApi.matrix()` which bundles the module catalog in the same response. The standalone `/api/permissions/modules/` endpoint is not consumed by the SPA. It would only be useful if the frontend needed the catalog without the member data, but no such usage exists.

Additionally, the field names are wrong (see F-1), so if it were ever called, it would silently return useless data.

**Recommendation:** Either remove `permissionsApi.modules()` from the API client or add a comment documenting its intended use case (e.g., a future Tournament editor that needs just the module catalog). Fix the field names regardless (F-1).

**Confidence:** 95%

---

### F-8 [MEDIUM] `UserGrantsView` / `UserGrantsBySlugView` — `get_organization()` returns `None` silently instead of 404, so wrong org_uuid gives 404 for org but no useful error for `get_target_user()` on invalid UUID

**File:** `backend/apps/permissions/views.py:152-165`

```python
def get_organization(self):
    try:
        return Organization.objects.filter(id=uuid.UUID(str(org_uuid))).first()
    except (ValueError, TypeError):
        return None  # ← swallows bad UUID, later returns 404 via the guard
```

```python
def get_target_user(self):
    user_uuid = self.kwargs.get("user_uuid")
    return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
    # ← uuid.UUID(str(user_uuid)) raises ValueError if bad format — 
    #   but user_uuid comes from <uuid:user_uuid> Django URL converter
    #   so this is actually safe
```

The bigger issue: if `org_uuid` is a valid UUID but the org doesn't exist, the view returns `{"detail": "Organization not found."}` with 404. But if `org_uuid` is an invalid string that slips through (e.g., via direct HTTP call bypassing Django's `<uuid:>` converter), `get_organization()` returns `None` and the 404 response body correctly appears. This is safe, but the inconsistency — `get_organization()` using `.first()` (returning `None`) vs `get_target_user()` using `get_object_or_404` — is a readability/consistency issue.

**Recommendation:** Unify to use `get_object_or_404` for both, or at minimum add a note comment. No runtime impact for correctly-formed URLs.

**Confidence:** 80%

---

### F-9 [LOW] `event_id` in `BulkGrantsCellsSerializer` is explicitly documented as "currently ignored" — client sends it, backend silently drops it — idempotency guarantee is absent

**File:** `backend/apps/permissions/serializers.py:110`

```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B...)
event_id = serializers.UUIDField(required=False)
```

The frontend sends `event_id` on every PUT (`frontend/src/features/permissions/ModuleMatrixPage.tsx:97-98`), and the test asserts it is present and non-empty (`ModuleMatrixPage.test.tsx:126`). But the backend drops it. A double-click or React StrictMode double-mount can produce two concurrent PUTs that both succeed, leaving the grant table in a non-deterministic final state. Phase 1A intentionally deferred this, but the FE already relies on the guarantee.

**Recommendation:** Track this as a known gap to implement the global `event_id` idempotency table in Phase 1B as planned. No hotfix needed, but the test asserting `event_id` is present should also verify the backend honors it once Phase 1B ships.

**Confidence:** 95%

---

### F-10 [LOW] `GrantRowSerializer` marks all fields `read_only_fields = fields` including `id`, `granted_by` — but `granted_by` is nullable and serialized as a UUID; nullability not reflected in generated type

**File:** `backend/apps/permissions/serializers.py:33-34` and `frontend/src/types/api.generated.ts:947`

```python
granted_by = models.ForeignKey(..., null=True, blank=True, ...)
```

Generated type:
```ts
readonly granted_by: string | null;  // ← correctly nullable in generated type
```

The generated type is actually correct here (the OpenAPI output does reflect `null`). No code fix needed, included for completeness. The hand-written `MembershipModuleGrant.set_by_user_id` in `user.ts` does NOT reflect nullability (see F-5).

**Confidence:** 100%

---

## Gaps (forward-looking, not current bugs)

| # | Area | Missing | Needed for |
|---|------|---------|-----------|
| G-1 | `setGrants` / Phase 1B | `event_id` idempotency not implemented at service layer | Preventing double-save on slow connections or React StrictMode re-invocations |
| G-2 | `ModuleMatrixPage` | No `reason` input UI — save always 400s | Making the Save Row button functional |
| G-3 | `UserGrantsView` / `UserGrantsBySlugView` | No `PATCH` — only full-replace `PUT` | Incremental per-module override from a detail panel without resending all 22 cells |
| G-4 | Cross-worker cache invalidation | `invalidate_cache` only deletes from local cache backend; `TODO` comment at `services/resolver.py:45-49` | Correct behavior when Django runs multi-process/multi-worker (production ASGI) |
| G-5 | `permissions/modules/` standalone catalog | Field names broken (F-1); no FE consumer | If a future feature needs just the catalog without member data |
| G-6 | `HasModule` org resolution via `view.kwargs["org_uuid"]` | Does not handle slug-routed views where kwarg is `slug` not `org_uuid` | Any future view that uses `HasModule` with slug-only URL patterns |
