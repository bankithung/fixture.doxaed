# Adversarial Verify A — permissions: `reason` absent from every PUT save

**Finding (original):**
- severity: critical
- area: permissions
- file: `frontend/src/api/permissions.ts`, line 32
- title: "reason field absent from every PUT save — guaranteed 400 on all real saves"

**Verdict: REAL. Severity confirmed: CRITICAL.**
Confidence: high (0.95).

## Evidence chain (read in the real code)

### 1. Frontend API layer types `reason` as optional
`frontend/src/api/permissions.ts:26-39`
```ts
  /** Replace all grants for a single user. PUT shape locked by spec. */
  setGrants: (
    slug: string,
    userId: string,
    payload: {
      cells: Record<string, GrantState>;
      reason?: string;          // <-- line 32: optional, no default
      event_id: string;
    },
  ) =>
    api.put<{ ok: true }>(
      `/api/permissions/orgs/${slug}/users/${userId}/grants/`,
      payload,
    ),
```
`reason?` is optional, so omitting it type-checks fine.

### 2. The ONLY caller never sends `reason`
`frontend/src/features/permissions/ModuleMatrixPage.tsx:87-98` (the matrix "Save row" mutation — the sole call site of `setGrants`, confirmed by grep):
```ts
  const saveRow = useMutation({
    mutationFn: ({ userId, cells }: { userId: string; cells: Record<string, GrantState>; }) =>
      permissionsApi.setGrants(orgSlug, userId, {
        cells,
        event_id: newEventId(),
        // <-- no `reason` key
      }),
```
The payload contains only `cells` and `event_id`. `reason` is never assembled or passed from the UI (there is no reason input wired into the save path).

### 3. Backend routes the SPA's PUT to a serializer that REQUIRES `reason`
`backend/apps/permissions/views.py:219-228` (`UserGrantsView.put`, also reached via `UserGrantsBySlugView.put` -> `super().put(...)` at views.py:336-337):
```py
        if isinstance(request.data, dict) and "cells" in request.data:
            ser = BulkGrantsCellsSerializer(data=request.data)
            ser.is_valid(raise_exception=True)          # <-- 400 fires here
            payload = ser.validated_data
            ...
            reason = payload["reason"]
```
Because the SPA always sends `cells`, validation always uses `BulkGrantsCellsSerializer`.

`backend/apps/permissions/serializers.py:95-110`:
```py
class BulkGrantsCellsSerializer(serializers.Serializer):
    cells = serializers.DictField(child=serializers.ChoiceField(choices=GrantState.choices))
    reason = serializers.CharField(min_length=20, max_length=2000)   # <-- REQUIRED
    event_id = serializers.UUIDField(required=False)
```
`reason` has no `required=False` and no `allow_blank=True`, so DRF treats it as a mandatory field. A request without `reason` fails `is_valid(raise_exception=True)` and returns **HTTP 400** before any grant row is touched.

## Conclusion
Every save initiated from the module-override matrix UI omits `reason`; the backend unconditionally requires `reason` (>=20 chars) for the `cells` shape. Therefore **100% of real saves from the matrix UI return 400** and no module override can ever be persisted through the SPA. This breaks the per-user override layer (invariant #12, `MembershipModuleGrant`). The finding is accurate and the line cite (permissions.ts:32, the optional `reason?`) correctly pinpoints the frontend side of the contract mismatch. Critical severity is justified: a core RBAC admin feature is entirely non-functional.

Note: the existing frontend unit test (`ModuleMatrixPage.test.tsx:100` "Save calls PUT with the merged cells map and an event_id") asserts only `cells` + `event_id` and mocks `setGrants`, so it cannot catch this — the backend `reason` requirement is never exercised end-to-end.
