# fe-permissions area map

**Area:** `frontend/src/features/permissions/` + `frontend/src/api/permissions.ts`
**Audit date:** 2026-06-04
**Status:** Phase 1A — fully implemented, wired, and tested.

---

## Purpose

Implements the per-user module override matrix (v1Users.md Appendix B.16): a sticky-header table where org admins can flip per-user module access to `grant` / `deny` / `default` (role-derived). Also exports `ConflictOfInterestBanner`, a reusable soft-warning UI primitive for actions with conflicts of interest.

---

## Key files

| File | Role |
|------|------|
| `frontend/src/features/permissions/ModuleMatrixPage.tsx` | Full-page component; owner of all query + mutation state. |
| `frontend/src/features/permissions/GrantCell.tsx` | Atomic 3-state toggle (default / grant / deny). |
| `frontend/src/features/permissions/ConflictOfInterestBanner.tsx` | Reusable soft-warning banner with audit-acknowledgement checkbox. |
| `frontend/src/api/permissions.ts` | DRF client façade (`permissionsApi`): `modules`, `myModules`, `matrix`, `setGrants`. |
| `frontend/src/types/user.ts` | `GrantState`, `ModuleDef`, `ModuleMatrixRow`, `ModuleMatrixResponse`, `MembershipModuleGrant`. |
| `frontend/src/features/permissions/__tests__/GrantCell.test.tsx` | Unit tests: click cycle, keyboard (Space/Enter), aria-label, aria-checked. |
| `frontend/src/features/permissions/__tests__/ModuleMatrixPage.test.tsx` | Integration tests: render, dirty-state, save PUT payload, optimistic update, error-retain, reset, 403 gating, empty-state. |

---

## Models / Types

Defined in `frontend/src/types/user.ts`:

- **`GrantState`** (`line 100`): `"default" | "grant" | "deny"` — 3-state per-cell enum.
- **`ModuleDef`** (`line 33`): `{ key, scope: ModuleScope, label, description }` — mirrors `matrix.py _serialize_modules`.
- **`ModuleScope`** (`line 31`): `"org" | "tournament" | "match" | "platform"`.
- **`ModuleMatrixRow`** (`line 111`): `{ user_id, user_email, user_full_name, roles, cells: Record<string, GrantState>, role_defaults: Record<string, boolean> }`.
- **`ModuleMatrixResponse`** (`line 127`): `{ modules: ModuleDef[], members: ModuleMatrixRow[] }`.
- **`MembershipModuleGrant`** (`line 102`): front-end mirror of the DB grant row (defined but currently unused — no component reads it directly; the matrix aggregate makes it redundant for the matrix UI).

---

## Endpoints / Routes

### Frontend route
`/o/:orgSlug/permissions` → `<ModuleMatrixPage />` (registered in `frontend/src/App.tsx` line 141, protected by `<ProtectedRoute>`).

Route builder: `routes.orgPermissions(slug)` (`frontend/src/lib/routes.ts` line 27).

### API calls (`frontend/src/api/permissions.ts`)

| Method | Client call | Backend URL | Backend view |
|--------|-------------|-------------|--------------|
| GET | `permissionsApi.modules()` | `/api/permissions/modules/` | `ModuleCatalogView` |
| GET | `permissionsApi.myModules(slug)` | `/api/permissions/orgs/{slug}/me/modules/` | `MyModulesBySlugView` |
| GET | `permissionsApi.matrix(slug)` | `/api/permissions/orgs/{slug}/grants/matrix/` | `MatrixView` |
| PUT | `permissionsApi.setGrants(slug, userId, payload)` | `/api/permissions/orgs/{slug}/users/{user_uuid}/grants/` | `UserGrantsBySlugView` |

---

## Observations / Findings

### F-01 — `reason` field is optional on the frontend but required (min 20 chars) on the backend [HIGH]

**File:** `frontend/src/api/permissions.ts:32`
```ts
reason?: string;
```
**File:** `backend/apps/permissions/serializers.py:106`
```python
reason = serializers.CharField(min_length=20, max_length=2000)
```
The `BulkGrantsCellsSerializer` enforces `reason` as a required field with a minimum 20-character constraint. The frontend `setGrants` payload type marks `reason` as optional and the `ModuleMatrixPage` never collects or sends it. Every save from the matrix UI will hit a backend 400 validation error unless the backend also allows an empty/omitted reason for this path.

**Why it matters:** Any save from `ModuleMatrixPage` will fail with a 400 (`reason` missing or too short) — the entire matrix save flow is broken for the happy path in production.

**Recommendation:** Either (a) add a `reason` textarea to the per-row Save flow (a modal or inline input) and send it, or (b) on the backend, make `reason` optional (`required=False`, `allow_blank=True`) for the `BulkGrantsCellsSerializer` path (audit trail is preserved via `GrantValidationError`/`bulk_set_grants` which already receives a `reason` arg that can be `None`).

---

### F-02 — `event_id` idempotency is stubbed / non-functional [MEDIUM]

**File:** `backend/apps/permissions/serializers.py:110`
```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```
The frontend sends an `event_id` on every `setGrants` call (invariant #3 — idempotent writes). The backend accepts and silently ignores it. A network retry will execute the mutation twice.

**Why it matters:** Invariant #3 requires that re-submitting with the same `event_id` returns the existing record (200, not a double-write). The current behavior violates this for grant mutations.

**Recommendation:** Implement the `event_id` dedup table in Phase 1B as planned. Until then, document the known gap explicitly in the serializer rather than leaving it as a comment only.

---

### F-03 — `permissionsApi.modules()` and `permissionsApi.myModules()` are exported but never called [LOW]

**File:** `frontend/src/api/permissions.ts:10-14`
```ts
modules: () => api.get<ModuleDef[]>("/api/permissions/modules/"),
myModules: (slug: string) =>
  api.get<{ modules: string[] }>(`/api/permissions/orgs/${slug}/me/modules/`),
```
Neither `permissionsApi.modules()` nor `permissionsApi.myModules()` are referenced anywhere in the frontend codebase. The matrix endpoint already returns the full module catalog in one round-trip, so `modules()` is redundant for current use. `myModules()` may be intended for module-gating guards elsewhere (e.g., hiding nav items based on effective modules) but is not wired up.

**Why it matters:** `myModules()` backing the effective-module guard is part of the RBAC surface-visibility layer (v1Users.md §§2-7 + Appendix A.2). If this guard is not called, all nav items are shown regardless of effective modules, defeating the module-gating layer.

**Recommendation:** Wire `permissionsApi.myModules()` into a module-gating hook (e.g., `useEffectiveModules(orgSlug)`) and use it to conditionally render nav items. If the current design is that effective_modules comes from the `GET /api/accounts/me/` memberships array instead, remove the dead `myModules()` entry to avoid confusion.

---

### F-04 — `ConflictOfInterestBanner` has no unit tests [LOW]

**File:** `frontend/src/features/permissions/ConflictOfInterestBanner.tsx` — no corresponding test file in `__tests__/`.

The banner is used in `OwnershipTransferModal` and is a WCAG 2.1 AA surface (uses `role="alert"`, `aria-live`). It has no dedicated test covering: initial unacknowledged state, checkbox toggle, `aria-live` announcement.

**Why it matters:** Given the audit-logging requirement (backend must log the acknowledgement), a regression in the checkbox rendering or `onChangeAcknowledged` prop could silently break the acknowledgement handshake.

**Recommendation:** Add `__tests__/ConflictOfInterestBanner.test.tsx` covering the checkbox toggle and ARIA attributes.

---

### F-05 — `aria-checked` on `GrantCell` is semantically inaccurate for a 3-state control [LOW]

**File:** `frontend/src/features/permissions/GrantCell.tsx:85`
```tsx
aria-checked={state === "grant"}
```
The button uses `role="switch"` which is semantically a binary on/off toggle. With 3 states (default, grant, deny), `aria-checked={state === "grant"}` maps both `default` and `deny` to `false`, making them indistinguishable to assistive technology. The `deny` state is a negative explicit override but sounds identical to `default` to a screen-reader user.

**Why it matters:** WCAG 2.1 AA (invariant #13). A visually impaired admin cannot reliably distinguish `deny` from `default` via the switch role alone. The `aria-label` does include the state text (line 79), which partially compensates.

**Recommendation:** Consider `role="button"` with a fully descriptive `aria-label` (already rich on line 79) instead of `role="switch"`, or use `aria-pressed` with a tristate (`true` / `false` / `"mixed"`) to represent `grant` / `deny` / `default` respectively.

---

### F-06 — `MembershipModuleGrant` type defined in `types/user.ts` but never consumed in the UI [INFO]

**File:** `frontend/src/types/user.ts:102-109`
```ts
export interface MembershipModuleGrant {
  user_id: string;
  module_key: string;
  state: Exclude<GrantState, "default">;
  ...
}
```
This type mirrors the raw DB grant row. The matrix aggregate endpoint already surfaces grant state inside `ModuleMatrixRow.cells`, so this type is currently unused. It may have been scaffolded in anticipation of a per-user grant detail panel.

**Why it matters:** Dead type adds cognitive overhead. If a future per-user detail view is planned, it should be noted.

**Recommendation:** Either add a comment documenting the intended future use, or remove until needed.

---

### F-07 — `newEventId()` is duplicated in two files [INFO]

**Files:**
- `frontend/src/features/permissions/ModuleMatrixPage.tsx:24-28`
- `frontend/src/features/orgs/OwnershipTransferModal.tsx:29-33`

Identical function bodies. Not a bug but indicates a missing shared utility.

**Recommendation:** Extract to `frontend/src/lib/eventId.ts` and import from both sites.

---

### F-08 — Module scope `"platform"` rendered as-is from backend but derived via `_scope_for()` heuristic [INFO]

**File:** `backend/apps/permissions/services/matrix.py:31-43`
```python
_SCOPE_OVERRIDES: dict[str, str] = {
    "personal": "platform",
}
```
The backend derives scope from the module code prefix (`personal.*` → `platform`). The frontend `SCOPE_ORDER` includes `"platform"` (`ModuleMatrixPage.tsx:30-35`) and will render a "Platform" scope band if any modules have that scope. This coupling is implicit — adding a new code prefix that the frontend doesn't know about will fall into the "forward-compat leftover" bucket silently.

**Why it matters:** Low risk now (22 modules fixed); higher risk when the catalog grows in Phase 1B.

**Recommendation:** Document the scope derivation contract in both the frontend `SCOPE_ORDER` constant and the backend `_SCOPE_OVERRIDES` dict so they stay in sync.

---

## Gaps (not implemented / partially implemented)

| Gap | Severity | Notes |
|-----|----------|-------|
| `reason` field not collected in save flow | HIGH | Backend 400 on every save. |
| `event_id` idempotency not enforced by backend | MEDIUM | Invariant #3 not fulfilled for grant mutations. |
| `permissionsApi.myModules()` not wired to a module-gating hook | MEDIUM | Module-visibility layer (RBAC surface gating) is absent. |
| No `ConflictOfInterestBanner` unit tests | LOW | WCAG regression risk. |
| `GrantCell` ARIA tristate semantics not fully correct | LOW | `role="switch"` cannot express 3 states correctly. |
| `MembershipModuleGrant` type unused | INFO | Dead scaffolding. |
| `newEventId()` duplicated | INFO | DRY cleanup. |
| No `<test>` for "only admins see the Permissions nav link" | MEDIUM | Module-gating integration test is absent entirely from the frontend. |
