# Audit: Project-level FE↔BE Contract

**Date:** 2026-06-04  
**Scope:** Serializer output shape vs frontend expectations; required-field validation; consistent error bodies; correct auth/permission classes; endpoints with no consumer / calls with no route.  
**Files examined:** `backend/apps/organizations/`, `backend/apps/accounts/`, `backend/apps/permissions/`, `frontend/src/api/`, `frontend/src/types/`, `frontend/src/features/orgs/`, `frontend/src/features/permissions/`

---

## Findings

### CRITICAL

---

#### F1 — `acceptInvitation` response shape mismatch: backend returns flat membership, FE expects `{ org_slug, membership }`

**Severity:** critical  
**File:** `frontend/src/api/orgs.ts:83` / `backend/apps/organizations/views.py:484`

**Backend** (`InvitationAcceptView.post`):
```python
return Response(
    OrganizationMembershipSerializer(membership).data,
    status=status.HTTP_200_OK,
)
```
Returns a flat object: `{id, user, organization, role, is_org_owner, is_active, created_at, removed_at}`.

**Frontend** (`orgs.ts:83`):
```typescript
acceptInvitation: (token: string) =>
  api.post<{ org_slug: string; membership: Membership }>(
    "/api/orgs/invitations/accept/",
    { token },
  ),
```
Expects a nested object with `org_slug` at top level and the membership nested under `.membership`.

**InviteAcceptPage.tsx:47** then immediately reads:
```typescript
const res = await orgsApi.acceptInvitation(token);
setOrgSlug(res.org_slug);  // ← always undefined at runtime
```
Result: `orgSlug` is always `undefined`, so the success path renders with `orgSlug=null` and the "Go to organization" button either errors or navigates to a broken URL.

**Recommendation:** Either (a) wrap the backend response to `{"org_slug": org.slug, "membership": serialized_data}` or (b) update the frontend to extract `org_slug` from `res.organization` by a secondary lookup. Option (a) is simpler and non-breaking.

---

#### F2 — `createInvitation` returns `AdminInvitationSerializer` (no `token`, no `roles`, no `org_id`), but `OrgInvitation` FE type expects all three

**Severity:** critical  
**File:** `frontend/src/types/user.ts:136` / `backend/apps/organizations/serializers.py:160` / `backend/apps/organizations/views.py:432`

**Backend serializer `AdminInvitationSerializer`** fields:
```python
fields = ["id", "organization", "email", "role", "status", "effective_status",
          "expires_at", "accepted_at", "revoked_at", "created_at", "invited_by"]
```
Note: `role` (singular, UUID-string FK), NO `token` field, NO `roles` (plural), NO `org_id` field.

**Frontend `OrgInvitation` type:**
```typescript
export interface OrgInvitation {
  id: string;
  org_id: string;       // ← "organization" is UUID, but key is "organization", not "org_id"
  email: string;
  roles: Role[];        // ← backend sends "role" (singular, single string), not "roles" (array)
  token?: string;       // ← backend never returns plaintext token in any serializer field
  status: "pending" | "accepted" | "revoked" | "expired";
  invited_by_email: string;  // ← backend sends "invited_by" (a UUID FK), not an email string
  expires_at: string;
}
```
Three fields in the FE type are completely absent from the backend response:
- `roles` → backend sends `role` (singular)
- `token` → backend NEVER includes the plaintext token (it is emailed only; the service returns it as second element of the tuple but the view discards it)
- `org_id` → backend sends `organization` (a UUID)
- `invited_by_email` → backend sends `invited_by` (a UUID)

The `SentView` in `InviteCreateModal.tsx:247` reads `invitation.token` which will always be `undefined` at runtime since the token is never included in `AdminInvitationSerializer`. The user sees empty token and copy link fields.

**Recommendation:**  
1. Add a `token` (write-once, returned only on creation) field to `AdminInvitationSerializer` or a dedicated create-response serializer.  
2. Either rename `organization` to `org_id` in the serializer OR update the FE type to use `organization`.  
3. Rename `role` → `roles` in the serializer (return as `[role]` one-element list) OR change the FE type to `role: string`.  
4. Add `invited_by_email` as a SerializerMethodField OR update FE to not require it (it is not rendered in `InvitationListItem`'s row display other than nowhere visible).

---

### HIGH

---

#### F3 — `InvitationListItem.invited_by_email` field never provided by backend

**Severity:** high  
**File:** `frontend/src/api/orgs.ts:50` / `backend/apps/organizations/serializers.py:183`

`InvitationListItem` (used by `InvitationsListPanel`) declares `invited_by_email: string` but `AdminInvitationSerializer` only outputs `invited_by` (a UUID). Although this field is not rendered in the current `InvitationRow` component (it is declared but not read in JSX), any future use will be `undefined`. TypeScript gives false confidence that the field exists.

**Recommendation:** Either add `invited_by_email = SerializerMethodField()` to `AdminInvitationSerializer`, or remove `invited_by_email` from `InvitationListItem` and replace with `invited_by: string` (UUID).

---

#### F4 — `setGrants` PUT endpoint returns `{grants: [...], effective_modules: [...]}` but frontend expects `{ ok: true }`

**Severity:** high  
**File:** `frontend/src/api/permissions.ts:36` / `backend/apps/permissions/views.py:262`

**Backend** (`UserGrantsView.put`):
```python
return Response({
    "grants": GrantRowSerializer(rows, many=True).data,
    "effective_modules": sorted(effective_modules(target_user, org)),
})
```

**Frontend** (`permissions.ts:36`):
```typescript
api.put<{ ok: true }>(
  `/api/permissions/orgs/${slug}/users/${userId}/grants/`,
  payload,
),
```
The frontend asserts the return type as `{ ok: true }` but the backend returns a rich envelope. The `ModuleMatrixPage.tsx` calls `permissionsApi.setGrants(...)` (line 95) and after `onSuccess` only invalidates the query without reading `_data`, so the data mismatch is currently harmless. However:
- The OpenAPI generated type `operations["permissions_orgs_users_grants_update"]` (line 2325) says the response is `GrantRow[]` (array), which also contradicts the actual backend envelope `{grants: [...], effective_modules: [...]}`.
- Both the generated types AND the frontend type declaration are wrong.

**Recommendation:** Update `setGrants` return type to match actual envelope `{grants: GrantRow[], effective_modules: string[]}`. Update OpenAPI annotation in `UserGrantsView.put` `@extend_schema` to document the real response. After updating, the FE can use the returned effective_modules to avoid a round-trip refetch.

---

#### F5 — `BulkGrantsSerializer.reason` has `min_length=20` but frontend does not enforce this minimum, causing silent 400s

**Severity:** high  
**File:** `backend/apps/permissions/serializers.py:54` / `frontend/src/features/permissions/ModuleMatrixPage.tsx:95`

**Backend:**
```python
reason = serializers.CharField(min_length=20, max_length=2000)
```

**Frontend** (`permissionsApi.setGrants` in `permissions.ts:32`): `reason?: string` — completely optional, no minimum length. In `ModuleMatrixPage.tsx`, `setGrants` is called without a `reason` field at all (line 95–98). This means every save action will receive a 400 `reason: This field is required` / `Ensure this field has at least 20 characters` from the backend, causing the toast to show "Save failed" on every attempt.

**Recommendation:**  
1. Either make `reason` optional on the backend (`required=False, allow_blank=True, min_length=0`) OR  
2. Add a required reason input (min 20 chars) to the Save row flow in `ModuleMatrixPage`.  
Option 1 is more defensible for a matrix UI; option 2 is more audit-friendly.

---

#### F6 — UUID-routed members endpoint (`/api/orgs/{uuid}/members/`) returns `OrganizationMembershipSerializer` but slug-routed (`/api/orgs/{slug}/members/`) returns `OrgMemberDetailSerializer` — FE only calls slug route but OpenAPI schema for `orgs_members_list_2` (UUID route) shows `OrganizationMembership[]`

**Severity:** high  
**File:** `backend/apps/organizations/views.py:349–365` vs `views.py:502–549` / `frontend/src/api/orgs.ts:72`

UUID-routed `OrgMembersListView` (line 356) uses `OrganizationMembershipSerializer` — fields: `{id, user, organization, role, is_org_owner, is_active, created_at, removed_at}`. Slug-routed `OrgMembersBySlugView` (line 503) returns an aggregated `OrgMemberDetailSerializer` — fields: `{id, user_id, email, full_name, roles, is_org_owner, joined_at, is_active}`.

The FE (`orgsApi.members(slug)`) calls the slug route and expects `OrgMember` (which maps to `OrgMemberDetailSerializer`). This is correct at runtime. However:
- `orgs_members_list_2` in the generated OpenAPI types returns `OrganizationMembership[]` (correct for UUID route) — any tooling that generates a client from the spec for the UUID route will get the wrong shape.
- The UUID-routed `OrgMembersListView` also lacks the aggregation logic (returns raw per-membership rows, not per-user), so a developer using the UUID endpoint directly would get multiple rows for the same user.

The UUID route (`/api/orgs/{uuid}/members/`) is inconsistent with the slug route and is probably vestigial. It has no FE consumer.

**Recommendation:** Align the UUID-routed `OrgMembersListView` to return `OrgMemberDetailSerializer` with the same aggregation, or deprecate the UUID route. At minimum, update the `@extend_schema` annotation to reflect the actual return shape.

---

### MEDIUM

---

#### F7 — `OrgMemberDetail.id` semantics ambiguity: FE `removeMember` uses `OrgMember.id` as `membershipId` but that `id` is the first membership row's PK, not reliable after aggregation

**Severity:** medium  
**File:** `frontend/src/api/orgs.ts:94` / `backend/apps/organizations/views.py:528`

`OrgMembersBySlugView` aggregates rows per user; when a user has multiple roles, `agg[r.user_id]["id"]` is set to `r.id` from the *first* matching membership row (line 532). If a user has roles `[admin, co_organizer]`, the returned `id` is whichever row comes first in `order_by("created_at")`.

`MemberDirectoryPage` calls `orgsApi.removeMember(orgUuid, m.id)` — passing this ambiguous `id` to `DELETE /api/orgs/{uuid}/members/{membership_id}/`. This removes only the first-found membership row, leaving the other role memberships active. The user appears removed from the directory but retains partial access.

**Recommendation:** Change `OrgMembersBySlugView` to return `membership_ids: string[]` (all membership row IDs for that user) and add a bulk-remove endpoint, OR change the remove endpoint to remove all memberships for a (org, user) pair by `user_id` rather than by membership primary key.

---

#### F8 — `OrganizationSerializer.suspended_reason` is always a non-null string but generated type marks it as `readonly suspended_reason: string` (no `| null`) — client cannot distinguish "never suspended" from "suspended with empty reason"

**Severity:** medium  
**File:** `backend/apps/organizations/serializers.py:39` / `frontend/src/types/api.generated.ts:1073`

Django model field `suspended_reason = models.TextField(blank=True, default="")` returns empty string `""` when never suspended. The generated type declares it as `string` (never null). This is technically correct, but:
- The FE cannot tell from the serializer alone whether the org is or was ever suspended.
- `suspended_at` (`string | null`) is the proper sentinel; but `suspended_reason` being `""` vs a real reason is a silent data-quality gap.

**Recommendation:** No code change required, but add a comment in `OrganizationSerializer` that `suspended_reason` is `""` when `suspended_at` is `null`. Low priority.

---

#### F9 — `ModuleDef.key` in FE type uses `key` but `ModuleSerializer` uses `code` — FE reads `m.key` but module catalog endpoint returns `code`

**Severity:** medium  
**File:** `frontend/src/types/user.ts:36` / `backend/apps/permissions/serializers.py:14` / `frontend/src/features/permissions/ModuleMatrixPage.tsx:357`

**Backend `ModuleSerializer`** fields: `["id", "code", "name", "description", "category", "default_for_roles"]` — there is NO `key` field.

**FE `ModuleDef`** interface:
```typescript
export interface ModuleDef {
  key: string;   // ← not present in backend response
  scope: ModuleScope;
  label: string;
  description: string;
}
```
`MatrixModuleSerializer` (the response shape from `/api/permissions/orgs/{slug}/grants/matrix/`) does emit `key` and `scope` and `label` (lines 70–76), so the matrix endpoint response is consistent with `ModuleDef`. However, the standalone **module catalog endpoint** (`GET /api/permissions/modules/`) uses `ModuleSerializer` which has `code`, NOT `key`, and `category`, NOT `scope`, and `name`, NOT `label`.

`permissionsApi.modules()` is typed as returning `ModuleDef[]` but gets `Module` (code/name/category). Any code that calls `permissionsApi.modules()` and reads `.key`, `.scope`, or `.label` will get `undefined`.

Currently `permissionsApi.modules()` is not called in any rendered component — it is an API method with no consumer in the codebase — so this is a latent bug rather than an active crash. But the type mismatch will cause silent failures when it is wired up.

**Recommendation:** Either (a) rename `ModuleSerializer` fields to match `MatrixModuleSerializer` (add `key` alias for `code`, `scope` computed from `category`, `label` alias for `name`) OR (b) create a separate `ModuleCatalogSerializer` that returns the `ModuleDef`-compatible shape. Also add a FE consumer for `permissionsApi.modules()` (currently dead endpoint on the FE).

---

#### F10 — `AdminInvitation.role` is a single `RoleEnum` but FE `InvitationListItem.roles` is `string[]` — list endpoint shape discrepancy

**Severity:** medium  
**File:** `frontend/src/api/orgs.ts:47` / `backend/apps/organizations/serializers.py:172`

`InvitationListItem` (used in `InvitationsListPanel`) declares `roles: string[]` (plural), but `AdminInvitationSerializer` outputs `role: RoleEnum` (singular). The `InvitationRow` component reads `invitation.roles ?? []` (line 137) — at runtime `roles` is `undefined` so it falls back to `[]`, rendering no role badges on any invitation row.

This is a consequence of the backend storing only one role per invitation (the highest from the submitted list). The FE's `InvitationListItem` was designed for multi-role but the backend never emits `roles`.

**Recommendation:** Add `roles = SerializerMethodField()` to `AdminInvitationSerializer` that returns `[self.instance.role]`, or update `InvitationListItem.roles` to `role: string` and fix the render accordingly.

---

#### F11 — `OrgInvitation.org_id` key mismatch with `AdminInvitationSerializer.organization`

**Severity:** medium  
**File:** `frontend/src/types/user.ts:138` / `backend/apps/organizations/serializers.py:171`

`AdminInvitationSerializer` outputs `organization` (UUID), but `OrgInvitation` type declares `org_id`. This means `OrgInvitation.org_id` is always `undefined` at runtime. Currently the `SentView` component does not read `org_id`, so this does not cause an active crash, but it is type drift that will mislead future developers.

**Recommendation:** Either rename `organization` to `org_id` in `AdminInvitationSerializer` (breaking), or update `OrgInvitation.org_id` to `organization` (non-breaking, just a rename in the TS type).

---

### LOW

---

#### F12 — `OrganizationUpdateSerializer.name` and `time_zone` have no `required=True` equivalent on the FE `OrgSettingsPage` — empty `PATCH {}` silently succeeds

**Severity:** low  
**File:** `backend/apps/organizations/serializers.py:68` / `frontend/src/features/orgs/OrgSettingsPage.tsx`

`OrganizationUpdateSerializer` accepts `PATCH` with both fields optional. Sending `PATCH {}` returns 200 with the unchanged org. This is by design for `partial=True`, but the FE should validate at least one field is present before calling. Currently `OrgSettingsPage` (not examined in detail) may submit an empty patch on unchanged form save — harmless but wasteful.

**Recommendation:** Add client-side dirty-check: only call PATCH when at least one field has changed.

---

#### F13 — `signup` backend returns only `{status: "pending_verification"}` (no `user` or `org` data) but `authApi.signup()` is typed as returning `{ user: User }`

**Severity:** low  
**File:** `frontend/src/api/auth.ts:56` / `backend/apps/accounts/views.py:148`

**Backend `signup` view** returns `Response({"status": "pending_verification"}, status=201)` — no `user` object.

**Frontend** (`auth.ts:56`):
```typescript
signup: (payload: SignupPayload) =>
  api.post<{ user: User }>("/api/accounts/auth/signup/", payload),
```
The type says the response has `user: User`, but the actual response has `status: "pending_verification"`. No component currently reads the `user` field from the signup response (SignupPage just uses success to navigate), so this is a silent type lie rather than a runtime crash.

**Recommendation:** Change `api.post<{ user: User }>` to `api.post<{ status: string }>` to match the actual response shape.

---

#### F14 — `permissionsApi.modules()` has no frontend consumer — dead API method

**Severity:** low  
**File:** `frontend/src/api/permissions.ts:10`

```typescript
modules: () => api.get<ModuleDef[]>("/api/permissions/modules/"),
```
`permissionsApi.modules()` is declared but never called anywhere in the SPA (grep confirms no usages). The `/api/permissions/modules/` endpoint is live and functional on the backend but has no frontend consumer.

**Recommendation:** Either wire the endpoint into the module override UI as a fallback/initial-load, or remove the dead method to reduce confusion.

---

#### F15 — `OrgMembersListView` (UUID route) gated by `HasModule("org.member_directory")` but returns `OrganizationMembershipSerializer` (wrong shape) — any client using the UUID route gets wrong data without error

**Severity:** low (already captured in F6, listed here for completeness)  
**File:** `backend/apps/organizations/views.py:353–365`

```python
class OrgMembersListView(ListAPIView):
    serializer_class = OrganizationMembershipSerializer   # ← flat memberships, not aggregated OrgMemberDetail
    permission_classes = [IsAuthenticated, HasModule("org.member_directory")]
```
No frontend calls this endpoint, so no active runtime impact. But it is inconsistent with its slug twin and will confuse anyone who hits it directly.

---

### INFO

---

#### I1 — `OrganizationSerializer.slug` is both in `fields` and NOT in `read_only_fields` — PATCH to `{slug: "new"}` would silently pass slug validation and update the slug without triggering `SlugRedirect` logic

**Severity:** info  
**File:** `backend/apps/organizations/serializers.py:30,41` / `backend/apps/organizations/views.py:212`

`OrganizationUpdateSerializer` only allows `name` and `time_zone`. However `OrganizationSerializer.slug` is writable (not in `read_only_fields`), and it is the serializer used by `OrgDetailView.patch`. The view calls `OrganizationUpdateSerializer` for validation (lines 211–219) and then only writes `name` / `time_zone`, so the slug cannot be changed via PATCH even though the base serializer would allow it. Confirmation: `OrgDetailView.patch` uses `OrganizationUpdateSerializer`, not `OrganizationSerializer`, for input. No vulnerability, but the loose field on `OrganizationSerializer` is confusing.

**Recommendation:** Add `slug` to `read_only_fields` in `OrganizationSerializer` to prevent accidental write-through if the serializer is ever re-used in a PUT/PATCH context.

---

#### I2 — `RoleEnum` and `RolesEnum` are identical in the generated OpenAPI schema — naming collision from `drf-spectacular`

**Severity:** info  
**File:** `frontend/src/types/api.generated.ts:1164,1174`

Both enums have identical values and are generated as separate types. This is the known drf-spectacular operationId/enum collision mentioned in the known issues list. No runtime impact but increases generated type noise.

---

## Gaps (forward-looking)

| # | Item | Missing | Needed for |
|---|------|---------|------------|
| G1 | Token in invitation create response | No mechanism to return the one-shot plaintext token from `AdminInvitationSerializer`; the service discards it in the view | `SentView` invitation-share UX |
| G2 | `org_slug` in invite-accept response | Backend returns flat `OrganizationMembership`; FE needs `org_slug` to redirect post-accept | `InviteAcceptPage` success redirect |
| G3 | `reason` min-length UX for grants PUT | 20-char backend minimum has no FE enforcement; every save from `ModuleMatrixPage` will 400 | Module override matrix |
| G4 | Multi-role invitation storage | Backend stores one role (highest); spec intent is multi-role. `AdminInvitation.role` is singular FK | Full v1Users.md §2.13 compliance |
| G5 | `ModuleDef` shape alignment | `/api/permissions/modules/` returns `{code, name, category}` but FE expects `{key, label, scope}` | `permissionsApi.modules()` wire-up |
| G6 | Member remove by user_id | Remove only first membership row; multi-role users retain partial access | Correct member removal |
| G7 | All Phase 1B endpoints | No tournament, match, fixture, live, notification, or dispute endpoints exist | Phase 1B product features |
