# Audit: fe-roles — API contract lens

**Date:** 2026-06-04
**Scope:** `frontend/src/features/roles/` + the API modules it depends on (`api/auth.ts`, `api/permissions.ts`, `api/orgs.ts`, `api/client.ts`) and the backend routes/serializers they hit.
**Lens:** Do api/*.ts calls hit real routes? Do request/response shapes match types + serializers? Is non-2xx handling present? Are loading/empty/error states handled?

---

## Findings

### F1 — CRITICAL: `permissionsApi.modules()` response shape mismatch — catalog fields don't match frontend type

**File:** `frontend/src/api/permissions.ts:10` + `frontend/src/types/user.ts:34-38`
**Evidence:**
```ts
// permissions.ts:10
modules: () => api.get<ModuleDef[]>("/api/permissions/modules/"),

// types/user.ts — ModuleDef expects:
export interface ModuleDef {
  key: string;
  scope: ModuleScope;
  label: string;
  description: string;
}
```
**Backend (`backend/apps/permissions/serializers.py:9-15`):**
```python
class ModuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Module
        fields = ["id", "code", "name", "description", "category", "default_for_roles"]
```
`GET /api/permissions/modules/` returns `{ id, code, name, description, category, default_for_roles }`. The frontend type expects `{ key, scope, label, description }`. Fields `key`, `scope`, and `label` are absent from the catalog response; `code`, `name`, and `category` are present but unused by the type. This endpoint is NOT called by any component in the roles feature folder directly, but is part of `permissionsApi` which is imported in `ModuleMatrixPage.tsx`. The matrix endpoint (`/api/permissions/orgs/{slug}/grants/matrix/`) uses `MatrixModuleSerializer` which DOES return `key, scope, label, description`, so the matrix path is aligned. The standalone catalog endpoint is the broken one.

**Recommendation:** Either update `ModuleSerializer` to return `key` (aliased from `code`), `scope` (aliased from `category`), and `label` (aliased from `name`), OR update `permissionsApi.modules()` to map the raw fields to `ModuleDef`. Since the matrix endpoint's `MatrixModuleSerializer` already uses the correct shape, align `ModuleSerializer` to match.
**Confidence:** 0.97

---

### F2 — HIGH: `permissionsApi.setGrants` omits required `reason` field — backend rejects silently

**File:** `frontend/src/api/permissions.ts:27-39`
**Evidence:**
```ts
setGrants: (
  slug: string,
  userId: string,
  payload: {
    cells: Record<string, GrantState>;
    reason?: string;        // <-- optional in FE type
    event_id: string;
  },
)
```
**Backend (`backend/apps/permissions/serializers.py:95-111`):**
```python
class BulkGrantsCellsSerializer(serializers.Serializer):
    cells = ...
    reason = serializers.CharField(min_length=20, max_length=2000)  # REQUIRED, min 20 chars
    event_id = serializers.UUIDField(required=False)
```
The backend serializer marks `reason` as required with `min_length=20`. The frontend type marks it `reason?` (optional). The `ModuleMatrixPage.tsx` call at line 95-98 never passes `reason`:
```ts
permissionsApi.setGrants(orgSlug, userId, {
  cells,
  event_id: newEventId(),
  // reason is not passed
})
```
Every save from the matrix UI will receive a 400 from the backend (`reason` is required, must be >= 20 chars). The error is surfaced via toast (line 110-118 of `ModuleMatrixPage.tsx`) so the failure is visible, but the feature is entirely non-functional as shipped.

**Recommendation:** Add a `reason` input field to the `ModuleMatrixPage` save flow (or per-row modal), make `reason` required (non-optional) in `permissionsApi.setGrants`, and validate min-length=20 client-side before submitting.
**Confidence:** 0.99

---

### F3 — HIGH: `permissionsApi.setGrants` response type claims `{ ok: true }` — backend returns grant rows

**File:** `frontend/src/api/permissions.ts:36`
**Evidence:**
```ts
api.put<{ ok: true }>(
  `/api/permissions/orgs/${slug}/users/${userId}/grants/`,
  payload,
),
```
**Backend (`backend/apps/permissions/views.py:261-268`):**
```python
return Response(
    {
        "grants": GrantRowSerializer(rows, many=True).data,
        "effective_modules": sorted(effective_modules(target_user, org)),
    }
)
```
The backend returns `{ grants: GrantRow[], effective_modules: string[] }`, not `{ ok: true }`. The `ModuleMatrixPage` discards the response body (the `onSuccess` callback at line 99 ignores `_data`) and instead invalidates the query to re-fetch, so there is no runtime breakage today. However, the type lie means any future consumer that tries to read `res.ok` will get `undefined`, not `true`.

**Recommendation:** Update the `setGrants` return type to `{ grants: GrantRow[]; effective_modules: string[] }` and remove the `{ ok: true }` fiction.
**Confidence:** 0.95

---

### F4 — HIGH: `authApi.signup` response type claims `{ user: User }` — backend returns `{ status: "pending_verification" }`

**File:** `frontend/src/api/auth.ts:55-56`
**Evidence:**
```ts
signup: (payload: SignupPayload) =>
  api.post<{ user: User }>("/api/accounts/auth/signup/", payload),
```
**Backend (`backend/apps/accounts/views.py:148`):**
```python
return Response({"status": "pending_verification"}, status=status.HTTP_201_CREATED)
```
The backend never returns a `user` object from signup — it returns `{ status: "pending_verification" }` with HTTP 201. `SignupPage.tsx` ignores the return value (`await authApi.signup(...)` with no consumer of the resolved value), so there is no runtime crash. But the type is wrong; a future caller reading `.user` will get `undefined`, not a `User`.

**Recommendation:** Correct the return type to `api.post<{ status: string }>`.
**Confidence:** 0.99

---

### F5 — HIGH: `authStore.bootstrap` only catches HTTP 401 — but `GET /api/accounts/me/` returns HTTP 403 when unauthenticated (known issue b)

**File:** `frontend/src/features/auth/authStore.ts:50-53`
**Evidence:**
```ts
} catch (e) {
  if (e instanceof ApiError && e.status === 401) {
    set({ user: null, isLoading: false, bootstrapped: true });
    return;
  }
```
The `/api/accounts/me/` endpoint uses `@permission_classes([IsAuthenticated])` with DRF default behavior that returns 403 (not 401) for unauthenticated session requests (`backend/apps/accounts/views.py:417`). When the SPA boots unauthenticated, `bootstrap()` receives a 403, falls through to the generic error branch (lines 53-60), and sets `error = "HTTP 403"` while still setting `bootstrapped: true`. Any page that reads `authStore.error` will display an error banner on the `/login` route — the premature-error-banner bug referenced in the known issues list.

Note: `ApiError.isUnauthenticated` getter (`types/api.ts:35-44`) does handle 403 with `"authentication credentials"` in `detail`, but `bootstrap` never calls that getter; it hardcodes `e.status === 401`.

**Recommendation:** Change the bootstrap guard to `e instanceof ApiError && (e.status === 401 || e.isUnauthenticated)` so DRF's 403-not-authenticated response is treated as an anonymous session, not an error.
**Confidence:** 0.98

---

### F6 — MEDIUM: `authApi.login` response type includes `user?: User` — backend login never returns a user object

**File:** `frontend/src/api/auth.ts:24-28`
**Evidence:**
```ts
export interface LoginResponse {
  requires_2fa?: boolean;
  user?: User;
}
```
**Backend (`backend/apps/accounts/views.py:253`):**
```python
return Response({"status": "ok"})
```
The backend returns `{ status: "ok" }` on success, or `{ requires_2fa: true }` on TOTP gate. The `user` key is never present. `authStore.login` (line 83) handles this correctly with a fallback:
```ts
const user = res.user ?? (await authApi.me());
```
So the double-fetch path (`authApi.me()`) always fires after successful login, adding one extra round-trip. This is by-design in a comment ("Either response carried the user or we re-fetch"), but the type is misleading: `user` will always be `undefined`, so the `??` branch always executes.

**Recommendation:** Remove `user?` from `LoginResponse`; the type should be `{ requires_2fa?: boolean }`. The post-login `/me` refetch is the correct pattern; document it explicitly.
**Confidence:** 0.93

---

### F7 — MEDIUM: `redirectByRole.ts` treats `is_org_owner` boolean AND checks `roles.includes("owner")` — but `owner` is not a valid `MembershipRole` TextChoices value

**File:** `frontend/src/features/roles/redirectByRole.ts:39`
**Evidence:**
```ts
const isOwner = m.is_org_owner === true || roles.includes("owner");
```
**Backend (`backend/apps/organizations/models.py`, via `backend/apps/accounts/serializers.py:90`):**
`MembershipSummarySerializer.roles` is `ListField(child=CharField())` — it lists role string values. `is_org_owner` is a separate boolean. The backend `MembershipRole` TextChoices (confirmed by `frontend/src/types/user.ts:24` referencing `Schemas["RoleEnum"]`) does not include `"owner"` as a role value; ownership is conveyed only via `is_org_owner`. The `roles.includes("owner")` branch is dead code / defensive for a value that will never appear. It is harmless but may cause confusion if a future role named `owner` is added with different semantics.

**Recommendation:** Remove `|| roles.includes("owner")` and rely solely on `m.is_org_owner === true`. Add a comment citing the backend source for clarity.
**Confidence:** 0.88

---

### F8 — MEDIUM: `MyProfilePage` PATCH mutation passes `name.trim()` but no `event_id` — idempotency invariant violated

**File:** `frontend/src/features/roles/MyProfilePage.tsx:61`
**Evidence:**
```ts
const saveName = useMutation({
  mutationFn: (newName: string) => authApi.patchMe({ name: newName }),
```
**Architectural invariant #3:** "Every mutation endpoint accepts a client-generated `event_id` (UUID) with a unique DB constraint. Re-submitting returns the existing record (200, not 201)."
`PATCH /api/accounts/me/` does not currently enforce `event_id` (the `MeSerializer` does not expose the field), but the invariant states this applies to *all writes*. When the backend adds `event_id` validation (Phase 1B hardening), this call will break. The frontend never generates or sends one.

**Recommendation:** Add `event_id: crypto.randomUUID()` to the `patchMe` payload now so the pattern is established. Update `PatchMePayload` in `auth.ts` and `MeSerializer` to accept the optional field.
**Confidence:** 0.78

---

### F9 — LOW: `RoleLandingShell` feedback link falls back to `routes.orgDashboard(orgSlug)` with `?feedback=1` — but `orgSlug` can be empty string

**File:** `frontend/src/features/roles/RoleLandingShell.tsx:130-133`
**Evidence:**
```tsx
<Link
  to={`${routes.orgDashboard(orgSlug)}?feedback=1`}
  ...
>
```
`orgSlug` is destructured from `useParams` with default `""`. If the shell is ever rendered outside an `:orgSlug` param route (e.g. in a future standalone profile route), the link resolves to `/o/dashboard?feedback=1` which is a 404. The three role landing pages are only ever mounted at `/o/:orgSlug/...` routes (verified in `routes.tsx`), so this is not currently reachable, but it is fragile.

**Recommendation:** Assert `orgSlug` is non-empty before rendering the feedback link, or accept `orgSlug` as a required prop rather than reading it from `useParams` inside the shell.
**Confidence:** 0.82

---

### F10 — LOW: Test for `redirectByRole` slug-encoding asserts `encodeURIComponent("acme & sons")` but `routes.ts` uses the same encoding — test may silently pass even if encoding breaks

**File:** `frontend/src/features/roles/__tests__/redirectByRole.test.ts:170-176`
**Evidence:**
```ts
it("encodes org slug in produced paths", () => {
  expect(
    pickLandingPathForUser(userWithRoles(["match_scorer"], { slug: "acme & sons" })),
  ).toBe(`/o/${encodeURIComponent("acme & sons")}/scoring`);
});
```
`routes.orgScoring` in `routes.ts:36` applies `encodeURIComponent` to the slug. The test assertion uses `encodeURIComponent` too, so both sides encode. This is correct, but if someone removes the encoding from `routes.ts`, the test would still pass because both sides use the raw `encodeURIComponent` call. Better: hardcode the expected string `/o/acme%20%26%20sons/scoring` so any future regression in the encoder is caught.

**Recommendation:** Replace the `encodeURIComponent(...)` call in the assertion with the literal encoded string `"/o/acme%20%26%20sons/scoring"`.
**Confidence:** 0.85

---

### F11 — INFO: Role landing pages (Scorer / Referee / TeamManager) make zero API calls — no loading/empty/error states needed

**Files:** `ScorerLandingPage.tsx`, `RefereeLandingPage.tsx`, `TeamManagerLandingPage.tsx`
These are intentional Phase 1A stubs. They render entirely from static copy and do not fetch any backend data. Loading/empty/error states are not applicable. `RoleLandingShell` reads `orgSlug` from URL params only. No action required.

---

### F12 — INFO: `NotificationPrefsPage` makes zero API calls — no contract to audit

**File:** `frontend/src/features/roles/NotificationPrefsPage.tsx`
Pure static stub; no data fetching. No action required.

---

## Gaps (forward-looking)

| # | Area | Missing | Needed for | Effort | Blocking? |
|---|------|---------|------------|--------|-----------|
| G1 | `permissionsApi.modules()` | No TanStack Query hook wraps this endpoint; there is no `useModuleCatalog()` hook. If the standalone catalog is needed (e.g. for a future role-definition UI), it has no consumer-side caching layer. | Any UI that needs the raw module catalog independent of the matrix. | S | No |
| G2 | `setGrants` | No optimistic rollback. The `ModuleMatrixPage` keeps edits on error, but if the query is invalidated before the error surfaces (race condition), the optimistic state and server state can diverge silently. | Matrix save reliability | M | No |
| G3 | `MyProfilePage` | No TanStack Query; the page reads from `authStore` directly. If `authStore` state is stale (user updated in another tab), the profile reflects stale data until a full page reload. A `useQuery({ queryKey: ["me"], queryFn: authApi.me })` would self-correct. | Profile freshness | S | No |
| G4 | `redirectByRole.ts` | No handling for a user who holds roles across two orgs where one org is deleted/suspended mid-session. The fallback is always first-membership in array; a deleted org would generate a dangling slug link. | Multi-org edge cases | M | No |
| G5 | Role-guard routes | None of the three role landing pages verify that the requesting user actually holds the expected role for the `:orgSlug`. A `match_scorer` could navigate directly to `/o/acme/referee`. Phase 1A accepts this (pages are stubs), but Phase 1B must add role guards at the route level. | Phase 1B console security | L | Phase 1B |
| G6 | `authApi.patchMe` | `PatchMePayload` is `Partial<Pick<User, "name" | "last_active_org_id">>`. The backend `MeSerializer.read_only_fields` (line 122-132) confirms these are the only writable fields. But `last_active_org_id` must be a UUID; sending an empty string will cause a 400 (UUIDField validation). The FE type does not enforce `string | null` correctly — it widens to `string` from the `User` type. | Org-switcher reliability | S | No |
