# Audit: fe-permissions — API Contract
**Area:** `frontend/src/features/permissions` + `frontend/src/api/permissions.ts`
**Lens:** API calls hit real routes; request/response shapes match types and serializers; non-2xx handling; loading/empty/error states.
**Date:** 2026-06-04

---

## Summary

4 real findings (1 critical, 2 high, 1 medium) and 3 gaps. The matrix GET and its types are well aligned. The main hazard is a silent 400 on every save: the frontend never sends the mandatory `reason` field, guaranteeing a backend validation error on every real PUT.

---

## Findings

### F-1 — CRITICAL: `reason` field is absent from every PUT save

**File:** `frontend/src/api/permissions.ts:31-32`
**Evidence:**
```ts
payload: {
  cells: Record<string, GrantState>;
  reason?: string;   // optional, never populated
  event_id: string;
}
```
`ModuleMatrixPage.tsx:95-97` calls `permissionsApi.setGrants(orgSlug, userId, { cells, event_id: newEventId() })` — no `reason` passed.

**Backend requirement** (`backend/apps/permissions/serializers.py:106`):
```python
reason = serializers.CharField(min_length=20, max_length=2000)
```
Required (not `required=False`), minimum 20 chars. The service layer also re-validates:
```python
# grants.py:151-154
if not reason or len(reason.strip()) < MIN_REASON_LEN:
    raise GrantValidationError(...)
```

**Why it matters:** Every real click of "Save row" will receive a `400 Bad Request` `{"reason": ["This field is required."]}`. The toast will surface `"Save failed"` but the error detail shown is `e.payload.detail` — however DRF field errors on `reason` arrive as `{"reason": ["..."]}`, not `{"detail": "..."}`, so the toast will fall back to the `e.message` (`"HTTP 400"`) giving a confusing user experience.

**Recommendation:** Either (a) add a mandatory reason textarea to the save flow (a modal or inline field that becomes required when a row is dirty), or (b) if a silent reason is acceptable for the v1 matrix UI, make `reason` optional in `BulkGrantsCellsSerializer` (the serializer must be updated, not just the frontend). Option (a) is the spec-compliant path per B.17.

---

### F-2 — HIGH: `permissionsApi.modules()` return type is wrong (`ModuleDef[]` vs backend `Module[]`)

**File:** `frontend/src/api/permissions.ts:10`
**Evidence:**
```ts
modules: () => api.get<ModuleDef[]>("/api/permissions/modules/"),
```
`ModuleDef` (`types/user.ts:33-39`) expects `{ key, scope, label, description }`.

**Backend `ModuleSerializer`** (`backend/apps/permissions/serializers.py:14`):
```python
fields = ["id", "code", "name", "description", "category", "default_for_roles"]
```
The catalog endpoint returns `code`, `name`, `category`, `default_for_roles` — NOT `key`, `scope`, or `label`. The matrix endpoint (`_serialize_modules()` in `services/matrix.py:46-55`) is a DIFFERENT path that does remap to `{key, scope, label, description}`.

Any caller of `permissionsApi.modules()` that expects `mod.key` or `mod.label` will get `undefined` at runtime.

**Mitigating factor:** No component currently calls `permissionsApi.modules()` (see Finding F-4), so this is a latent bug rather than an immediate runtime crash.

**Recommendation:** Either (a) correct the return type to `components["schemas"]["Module"][]` (i.e. `{id, code, name, description, category, default_for_roles}`), or (b) create a dedicated serializer that returns `{key, scope, label, description}` and register it under `/api/permissions/modules/`. The OpenAPI generated type `components["schemas"]["Module"]` at `api.generated.ts:1031` confirms the real shape.

---

### F-3 — HIGH: `setGrants` PUT response typed as `{ ok: true }` but backend returns a different shape

**File:** `frontend/src/api/permissions.ts:36`
**Evidence:**
```ts
api.put<{ ok: true }>(
  `/api/permissions/orgs/${slug}/users/${userId}/grants/`,
  payload,
),
```

**Actual backend response** (`backend/apps/permissions/views.py:260-268`):
```python
return Response({
    "grants": GrantRowSerializer(rows, many=True).data,
    "effective_modules": sorted(effective_modules(target_user, org)),
})
```
Returns `{grants: GrantRow[], effective_modules: string[]}`. The frontend ignores this (`onSuccess` does not use `_data`), so there is no runtime crash today, but the TypeScript type is wrong and any future consumer of the response will get `undefined` fields.

**Recommendation:** Define a `BulkGrantsResponse` interface matching `{grants: GrantRow[], effective_modules: string[]}` and use it as the generic; or if the response is intentionally unused, add a comment noting the mismatch so a future refactor doesn't silently misuse it.

---

### F-4 — MEDIUM: `permissionsApi.myModules()` and `permissionsApi.modules()` are dead API methods

**File:** `frontend/src/api/permissions.ts:10-14`
**Evidence:**
```ts
modules: () => api.get<ModuleDef[]>("/api/permissions/modules/"),
myModules: (slug: string) =>
  api.get<{ modules: string[] }>(`/api/permissions/orgs/${slug}/me/modules/`),
```
A global grep across `frontend/src` finds zero call sites for either method. The matrix endpoint bundles module metadata inline so the separate catalog call is not needed. `myModules` is superseded by the `effective_modules` array on the `MeSerializer` response (surfaced at bootstrap).

**Why it matters:** Dead code invites drift — the type mismatch in `modules()` (Finding F-2) will never surface in a type-check run because nothing calls it. If a future feature wires up these calls, they will silently misbehave.

**Recommendation:** Either remove both methods from `permissionsApi` or add a `// TODO: used by <upcoming feature>` comment. If they stay, fix the `ModuleDef[]` type on `modules()`.

---

### F-5 — INFO: `GrantCell` uses `role="switch"` for a 3-state control (a11y mismatch)

**File:** `frontend/src/features/permissions/GrantCell.tsx:84-86`
**Evidence:**
```tsx
<button
  type="button"
  role="switch"
  aria-checked={state === "grant"}
```
`role="switch"` is a WAI-ARIA binary toggle: `aria-checked` is either `true` or `false`. The component has three states (`default`, `grant`, `deny`) and cycles through all three. Screen readers will announce only the binary `aria-checked`, hiding the `deny` state from assistive technology users.

**Why it matters:** WCAG 2.1 AA (Invariant 13) requires that all state is exposed via accessibility tree. A `deny` cell looks identical to a `default` cell to screen readers.

**Recommendation:** Use `role="button"` with a full `aria-label` (already composed and rich) plus `aria-pressed` omitted, or use a 3-segment `<radiogroup>` pattern. The label itself is complete (`"alice@example.com — Org settings: denied (override)"`) — it's the role that's wrong.

---

## Gaps (forward-looking)

| # | Item | Missing | Effort | Blocking |
|---|------|---------|--------|---------|
| G-1 | Reason UI for save | Backend requires ≥20-char reason on every grant write. The matrix page has no text input for this. Until added, every save is a guaranteed 400. | M | Yes (F-1 above) |
| G-2 | Field-error display in save toast | `onError` in `ModuleMatrixPage.tsx:110-120` reads `e.payload.detail` but DRF field errors (including the `reason` 400) arrive as `{reason: ["..."]}`, not `{detail: "..."}`. The toast will show `"HTTP 400"` instead of the field message. A helper that extracts field errors from `e.payload` should be added. | S | No |
| G-3 | `event_id` idempotency is accepted but not enforced | `BulkGrantsCellsSerializer` accepts `event_id` (line 110: `required=False`) but the grants service ignores it entirely. The comment says "Phase 1B". Until this lands, duplicate rapid saves can create duplicate audit rows. No frontend guard either. | L | No |
