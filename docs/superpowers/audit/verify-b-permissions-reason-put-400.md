# Adversarial Verify B — permissions: `reason` missing from PUT save → guaranteed 400

**Finding under test:** `{severity: critical, area: permissions, file: frontend/src/api/permissions.ts, line: 32, title: "reason field absent from every PUT save — guaranteed 400 on all real saves"}`

**Verdict: REAL (confirmed). Severity: critical (confirmed).**
**Confidence: 0.95.**

## What the code actually shows

The defect is real, but the *cited line/locus* is slightly mischaracterized. Line 32 of
`permissions.ts` is where `reason` IS present (declared optional). The actual bug is two-fold:
the only real caller omits `reason`, and the backend hard-requires it.

### 1. API client declares `reason` OPTIONAL (the masking type)
`frontend/src/api/permissions.ts:27-39`
```ts
  setGrants: (
    slug: string,
    userId: string,
    payload: {
      cells: Record<string, GrantState>;
      reason?: string;        // line 32 — OPTIONAL, so omitting it compiles cleanly
      event_id: string;
    },
  ) =>
    api.put<{ ok: true }>(
      `/api/permissions/orgs/${slug}/users/${userId}/grants/`,
      payload,
    ),
```
Because `reason?` is optional, TypeScript does not flag the caller that drops it. This is the
type-level mask the finding alludes to.

### 2. The ONLY real caller omits `reason`
`frontend/src/features/permissions/ModuleMatrixPage.tsx:95-98`
```ts
      permissionsApi.setGrants(orgSlug, userId, {
        cells,
        event_id: newEventId(),
      }),                       // no `reason` key at all
```
This is the Save handler (`saveRow` mutation) for the module-override matrix — the production
save path. It sends only `{cells, event_id}`.

### 3. Backend serializer REQUIRES `reason` (>=20 chars)
`backend/apps/permissions/serializers.py:95-110`
```py
class BulkGrantsCellsSerializer(serializers.Serializer):
    cells = serializers.DictField(...)
    reason = serializers.CharField(min_length=20, max_length=2000)   # line 106 — REQUIRED
    event_id = serializers.UUIDField(required=False)                 # line 110 — note: explicitly optional
```
`reason` has no `required=False` and no default, so DRF treats it as required. The contrast with
`event_id` (line 110, explicitly `required=False`) confirms this is intentional on the backend.

### 4. View rejects with 400 before the field is read
`backend/apps/permissions/views.py:221-228`
```py
        if isinstance(request.data, dict) and "cells" in request.data:
            ser = BulkGrantsCellsSerializer(data=request.data)
            ser.is_valid(raise_exception=True)   # <-- raises ValidationError -> HTTP 400 when reason absent
            payload = ser.validated_data
            ...
            reason = payload["reason"]
```
Since the matrix UI sends `cells`, this branch is taken. `is_valid(raise_exception=True)` returns
HTTP 400 (`{"reason": ["This field is required."]}`) whenever `reason` is missing — which is every
save the SPA matrix issues.

### 5. Defense-in-depth also blocks it at the service layer
`backend/apps/permissions/services/grants.py:151-154` re-checks `len(reason.strip()) < 20` and
raises `GrantValidationError`. So even if the serializer were loosened, the service layer would
still reject empty/short reasons (per B.17 audit-trail requirement). The model comment at
`models.py:132-135` documents this: "Mandatory at the service layer ... enforces >=20 chars."

## Impact
The module-override permission matrix Save button is non-functional in production: every save
returns 400 with a generic "This field is required" surfaced via the `onError` toast
(`ModuleMatrixPage.tsx:110-120`, "Save failed"). This is a core Phase-1A RBAC admin surface
(invariant 12, module RBAC). Critical severity is appropriate — the feature cannot work at all.

## Why the tests did not catch it
`frontend/src/features/permissions/__tests__/ModuleMatrixPage.test.tsx:100` ("Save calls PUT with
the merged cells map and an event_id") mocks `permissionsApi.setGrants` and only asserts `cells` +
`event_id` are sent — it never asserts `reason`, and never exercises the real backend serializer.
So the broken contract passes the unit suite. No contract/integration test binds the TS payload
shape to the DRF serializer.

## Notes on the finding's framing
- "reason field absent from every PUT save" — TRUE for the actual save call (ModuleMatrixPage),
  even though line 32 of permissions.ts is literally where `reason` is *declared*. The headline
  conflates the declaration site with the omission site; the substance is correct.
- "guaranteed 400 on all real saves" — TRUE; verified through serializer + view.
- The cleanest fix is to make the UI collect a reason (a modal prompt) and pass it through, OR
  (if a reason is genuinely not desired for module grants) relax both the serializer and service
  layer — but that would violate B.17, so the UI-prompt fix is the spec-aligned one.

## Evidence files
- frontend/src/api/permissions.ts:27-39
- frontend/src/features/permissions/ModuleMatrixPage.tsx:87-121 (save mutation; 95-98 is the omission)
- backend/apps/permissions/serializers.py:95-110
- backend/apps/permissions/views.py:210-246
- backend/apps/permissions/services/grants.py:151-154
- backend/apps/permissions/models.py:131-136
- frontend/src/features/permissions/__tests__/ModuleMatrixPage.test.tsx:100-127 (test gap)
