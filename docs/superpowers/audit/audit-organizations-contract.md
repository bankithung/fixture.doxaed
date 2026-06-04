# Audit: Organizations — FE↔BE Contract

**Date:** 2026-06-04  
**Scope:** `backend/apps/organizations` serializers, views, and URL routes vs frontend `frontend/src/api/orgs.ts`, `frontend/src/features/orgs/**`, and `frontend/src/types/user.ts`.  
**Lens:** Serializer output shape (names/types/nullability) vs frontend expectations; required-field validation; consistent error bodies; auth/permission classes; endpoints with no consumer / calls with no route.

---

## Findings

---

### F-1 — CRITICAL: `acceptInvitation` response shape mismatch — redirect is permanently broken

**Severity:** critical  
**File (BE):** `backend/apps/organizations/views.py:470-485`  
**File (FE):** `frontend/src/api/orgs.ts:82-86` / `frontend/src/features/orgs/InviteAcceptPage.tsx:45-48`

**Evidence (BE):**
```python
# views.py:470-485 — InvitationAcceptView
return Response(
    OrganizationMembershipSerializer(membership).data,
    status=status.HTTP_200_OK,
)
```
`OrganizationMembershipSerializer` fields: `id, user, organization, role, is_org_owner, is_active, created_at, removed_at`. No `org_slug` field anywhere in this response.

**Evidence (FE):**
```ts
// api/orgs.ts:82-86
acceptInvitation: (token: string) =>
  api.post<{ org_slug: string; membership: Membership }>(
    "/api/orgs/invitations/accept/",
    { token },
  ),
// InviteAcceptPage.tsx:45-48
const res = await orgsApi.acceptInvitation(token);
setOrgSlug(res.org_slug);   // ← always undefined at runtime
```
And the success branch guard at `InviteAcceptPage.tsx:81`:
```tsx
state === "ok" && orgSlug  // always false → "Go to organization" button never renders
```

**Why it matters:** The post-accept redirect is completely broken. Users end up on the accept page with no way to proceed after a successful invite acceptance.

**Recommendation:** Add `org_slug` to the accept response. Options: (a) Create a dedicated `InvitationAcceptResponseSerializer` that includes `OrganizationMembershipSerializer` fields + `org_slug` from `membership.organization.slug` (requires a `select_related("organization")` or adds a `SerializerMethodField`); or (b) change the FE to call `refreshMe()` first and look up the slug from the freshly loaded memberships. Option (a) is cleaner because it avoids the timing dependency.

---

### F-2 — CRITICAL: UUID-routed invitation POST drops `roles[]` — silently picks wrong role

**Severity:** critical  
**File (BE):** `backend/apps/organizations/views.py:419-435`

**Evidence:**
```python
# OrgInvitationsView.post (UUID route) — views.py:424-430
inv, _plaintext = invitation_svc.create_invitation(
    org=org,
    email=ser.validated_data["email"],
    role=ser.validated_data["role"],   # ← KeyError if only `roles` sent
    invited_by=request.user,
    request=request,
)
```
The slug-routed `OrgInvitationsBySlugView.post` correctly passes both `role` and `roles`:
```python
# views.py:574-582
inv, _plaintext = invitation_svc.create_invitation(
    org=org,
    email=ser.validated_data["email"],
    role=ser.validated_data.get("role"),
    roles=ser.validated_data.get("roles"),
    ...
)
```
The FE always sends `{ email, roles: string[], event_id }` (an array, never the legacy `role` scalar). Against the UUID route: `ser.validated_data["role"]` uses dict access, not `.get()`, which raises `KeyError` when `role` is absent; the serializer validator `validate()` only sets a default if **neither** key is present, so a payload with only `roles` will not set `role` in `validated_data`, causing a `KeyError → 500`.

**Why it matters:** Any code path that ends up on the UUID-based `POST /api/orgs/{uuid}/invitations/` with the standard SPA payload crashes with a 500.

**Recommendation:** Mirror the slug-routed view: replace `ser.validated_data["role"]` with `ser.validated_data.get("role")` and pass both `role` and `roles` to the service.

---

### F-3 — HIGH: `AdminInvitationSerializer` does not expose `roles[]` or `token` — invitation list shape mismatches `InvitationListItem`

**Severity:** high  
**File (BE):** `backend/apps/organizations/serializers.py:160-184`  
**File (FE):** `frontend/src/api/orgs.ts:44-53` / `frontend/src/types/user.ts:136-145`

**Evidence (BE serializer fields):**
```python
fields = [
    "id", "organization", "email", "role",  # ← scalar "role", not a list
    "status", "effective_status", "expires_at",
    "accepted_at", "revoked_at", "created_at",
    "invited_by",  # ← UUID of user, not email string
]
```

**Evidence (FE `InvitationListItem`):**
```ts
export interface InvitationListItem {
  id: string;
  email: string;
  roles: string[];          // ← expects ARRAY, backend returns scalar "role"
  status: "pending" | ...;
  expires_at: string;
  invited_by_email: string; // ← expects EMAIL string, backend returns UUID
  token?: string;           // backend never returns token on list
}
```

**Evidence (FE `OrgInvitation`):**
```ts
export interface OrgInvitation {
  id: string;
  org_id: string;           // ← not in backend serializer
  email: string;
  roles: Role[];            // ← array, not scalar
  token?: string;           // only returned at create-time, never on list
  status: "pending" | ...;
  invited_by_email: string; // ← not in backend serializer
  expires_at: string;
}
```

Three mismatches:
1. BE: `role` (scalar string) — FE expects: `roles` (array of strings)
2. BE: `invited_by` (UUID or null) — FE expects: `invited_by_email` (email string)
3. BE: `organization` (UUID) — FE expects: `org_id` (UUID but under different key, and `OrgInvitation.org_id` is not in the list serializer at all)

The `InvitationsListPanel` tries `invitation.roles.map(...)` which will fail because `roles` is undefined (only `role` is present); it will throw or render nothing for the roles column.

**Recommendation:**  
(a) Rename `role` → `roles` in `AdminInvitationSerializer` and make it a `ListField` that wraps the scalar in a single-element list (or store multi-role invitations in Phase 1B). In practice, adding a `SerializerMethodField` that returns `[self.role]` preserves DB backward compat.  
(b) Add `invited_by_email = serializers.SerializerMethodField()` that returns `instance.invited_by.email if instance.invited_by else None`.  
(c) Clarify that `token` is only returned at creation time — document clearly and ensure the frontend handles absent `token` gracefully (it does, with `?` optional typing, so this is low risk).

---

### F-4 — HIGH: `OrgMembersListView` (UUID route) returns `OrganizationMembershipSerializer`, not `OrgMemberDetailSerializer` — different shape than slug route

**Severity:** high  
**File (BE):** `backend/apps/organizations/views.py:349-365`

**Evidence:**
```python
class OrgMembersListView(ListAPIView):
    serializer_class = OrganizationMembershipSerializer  # ← flat DB row
    permission_classes = [IsAuthenticated, HasModule("org.member_directory")]

    def get_queryset(self):
        return OrganizationMembership.objects.filter(
            organization=self.get_organization(), is_active=True
        )
```
The UUID route returns raw `OrganizationMembership` rows with shape `{id, user (UUID), organization (UUID), role, is_org_owner, is_active, created_at, removed_at}`.

The slug route (`OrgMembersBySlugView`, `views.py:502-549`) aggregates per-user and returns `OrgMemberDetailSerializer` shape: `{id, user_id, email, full_name, roles[], is_org_owner, joined_at, is_active}`.

The FE only calls `GET /api/orgs/{slug}/members/` (slug route) so the UUID route is never consumed. However the UUID route is still the canonical AIP-136 route. Any tooling, test, or future consumer that hits the UUID path gets completely different field names.

**Why it matters:** This is a bifurcated API surface. The UUID member list is orphaned (no consumer) and incompatible with the slug shape that the FE depends on. Future callers of the UUID route will receive `user` (a UUID) instead of `email`/`full_name`, and `role` (scalar) instead of `roles[]`.

**Recommendation:** Make `OrgMembersListView` also aggregate using the same per-user logic as `OrgMembersBySlugView`, using `OrgMemberDetailSerializer`. Or redirect consumers of the UUID route to the slug-aggregated endpoint.

---

### F-5 — HIGH: `transferOwnership` response shape mismatch — FE expects `{ ok: true }`, BE returns `OrganizationSerializer`

**Severity:** high  
**File (BE):** `backend/apps/organizations/views.py:323-341`  
**File (FE):** `frontend/src/api/orgs.ts:99-111`

**Evidence (BE):**
```python
return Response(OrganizationSerializer(org).data)
# returns: {id, slug, name, status, time_zone, created_at, archived_at, suspended_at, suspended_reason}
```

**Evidence (FE):**
```ts
transferOwnership: (...) =>
  api.post<{ ok: true }>(
    `/api/orgs/${slug}/ownership/transfer/`,
    payload,
  ),
```
The FE type says `{ ok: true }` but the backend returns an `OrganizationSerializer` object. There is no `ok` field in the actual response. `OwnershipTransferModal` doesn't read the response body after success (only calls `qc.invalidateQueries`), so this causes no visible bug today, but the type is wrong and any future consumer of the resolved value will be surprised.

**Recommendation:** Either (a) change `api.post<{ ok: true }>` to `api.post<Organization>` on the FE, or (b) have the BE return `{"ok": True}` for the transfer verb. Option (a) aligns with the already-generated `Organization` type.

---

### F-6 — MEDIUM: `AdminInvitationSerializer` `invited_by` field is a raw UUID (`PrimaryKeyRelatedField` default) — FE cannot display inviter name/email

**Severity:** medium  
**File (BE):** `backend/apps/organizations/serializers.py:183` (`"invited_by"` in field list)

**Evidence:** `AdminInvitation.invited_by` is a `ForeignKey(User, ...)`. With `ModelSerializer` and no explicit field declaration, DRF renders FK fields as the related object's PK (UUID). The frontend `InvitationListItem` type declares `invited_by_email: string` and the test fixture at `frontend/src/features/orgs/__tests__/InviteCreateModal.test.tsx:69` sets `invited_by_email: "owner@example.com"`, confirming the FE expects a string email, not a UUID.

**Recommendation:** Add `invited_by_email = serializers.SerializerMethodField()` to `AdminInvitationSerializer` and include it in `fields`. Keep `invited_by` as the UUID FK for programmatic use but add the human-readable field.

---

### F-7 — MEDIUM: `OrgListCreateView.post` is super-admin only — frontend has no self-serve org creation path yet

**Severity:** medium  
**File (BE):** `backend/apps/organizations/views.py:141-143`

**Evidence:**
```python
def post(self, request):
    if not request.user.is_superuser:
        raise PermissionDenied("Only super-admins can create organizations.")
```

**Why it matters:** The locked product decision says "self-serve signup, NO super-admin approval gate." Signup auto-provisions an org (handled in `apps/accounts`), but there is no FE surface for a logged-in user to create a second org. This is a gap rather than a contract bug, but it confirms the only creation path is through signup — not the `POST /api/orgs/` endpoint.

**Recommendation:** Document this intentional guard and ensure the FE never renders an "Create Organization" button that calls `POST /api/orgs/` directly (the FE does not — confirmed). Flag for Phase 1B if multi-org creation per user is needed.

---

### F-8 — MEDIUM: `OrgDetailView.patch` requires UUID — FE knows this and passes `orgQuery.data.id`, but error message is not user-friendly

**Severity:** medium  
**File (BE):** `backend/apps/organizations/views.py:198-200`

**Evidence:**
```python
def patch(self, request, slug_or_uuid: str):
    if not _is_uuid(slug_or_uuid):
        raise DRFValidationError("PATCH requires a UUID, not a slug.")
```
The FE `OrgSettingsPage.tsx:184` correctly reads `orgQuery.data.id` and patches by UUID:
```ts
return api.patch<OrgDetail>(`/api/orgs/${orgQuery.data.id}/`, values);
```
This is correct behavior — no runtime bug. However if `orgQuery.data` is null/undefined when the mutation fires (race condition or cache miss), the FE does `orgQuery.data.id` which throws; the component guards this with `if (!orgQuery.data) return Promise.reject(...)`, so it's safe.

**Recommendation:** No code change needed. Document that PATCH on the slug route is intentionally rejected.

---

### F-9 — MEDIUM: `OrgInvitationsBySlugView` `GET` returns `AdminInvitationSerializer` — `effective_status` is a computed property but tests against DB `status` only

**Severity:** medium  
**File (BE):** `backend/apps/organizations/serializers.py:167` / `backend/apps/organizations/models.py:322-328`

**Evidence:**
```python
# models.py:322-328 — AdminInvitation.effective_status property
@property
def effective_status(self) -> str:
    if self.status == InviteStatus.PENDING and self.is_expired():
        return InviteStatus.EXPIRED
    return self.status
```
```python
# serializers.py:167
effective_status = serializers.CharField(read_only=True)
```
The FE `InvitationsListPanel` filters `all.filter((i) => i.status === "pending")` (uses `status`, not `effective_status`). An invitation that is logically expired (TTL elapsed but DB row still `pending`) will appear in the panel as "pending" because `status` is still `"pending"` and `effective_status` (which would be `"expired"`) is ignored by the filter.

**Why it matters:** Expired invitations appear as pending in the UI, with active Revoke buttons, until the DB is swept. Clicking Revoke on an expired invite returns a 400.

**Recommendation:** Change the FE filter to use `effective_status` instead of `status`:
```ts
const pending = all.filter((i) => (i.effective_status ?? i.status) === "pending");
```
Also rename the FE `InvitationListItem.status` field to `effective_status` or add both fields to the type.

---

### F-10 — MEDIUM: UUID-routed `OrgInvitationsView` is missing `event_id` and `roles` forwarding — diverges from slug-routed counterpart

**Severity:** medium  
**File (BE):** `backend/apps/organizations/views.py:419-435`

**Evidence:** The UUID-routed `OrgInvitationsView.post` does not pass `event_id` to `create_invitation`:
```python
inv, _plaintext = invitation_svc.create_invitation(
    org=org,
    email=ser.validated_data["email"],
    role=ser.validated_data["role"],
    invited_by=request.user,
    request=request,
    # ← no event_id, no roles
)
```
The slug-routed `OrgInvitationsBySlugView.post` does:
```python
inv, _plaintext = invitation_svc.create_invitation(
    ...
    role=ser.validated_data.get("role"),
    roles=ser.validated_data.get("roles"),
    event_id=ser.validated_data.get("event_id"),
)
```
This means the UUID route violates invariant #3 (idempotent writes) — replays with the same `event_id` are not short-circuited.

**Recommendation:** Unify both views: extract a `_create_invitation_from_serializer(org, ser, invited_by, request)` helper and call it from both views.

---

### F-11 — LOW: `OrganizationSerializer` exposes `suspended_reason` as always-serialized empty string — frontend has no conditional display logic

**Severity:** low  
**File (BE):** `backend/apps/organizations/models.py:140` / `backend/apps/organizations/serializers.py:39`

**Evidence:**
```python
# model
suspended_reason = models.TextField(blank=True)  # defaults to ""
# serializer includes "suspended_reason" in fields
```
For non-suspended orgs, `suspended_reason` is `""`. The FE `OrgSettingsPage` type includes `suspended_reason: string` and renders the org name/timezone but never shows `suspended_reason`. There's no conditional "this org is suspended" banner in the settings page that would show the reason.

**Why it matters:** Low — no breakage. But if a user's org is suspended, they can still access settings with no indication of why the org is restricted.

**Recommendation:** Add a suspension-state warning banner to `OrgSettingsPage` that renders when `status === "suspended"` and shows `suspended_reason`.

---

### F-12 — LOW: `OrgChangeSlugView` (colon-verb) has no slug-routed FE path — FE displays slug read-only without a change UI

**Severity:** low  
**File (BE):** `backend/apps/organizations/urls.py:38-42`  
**File (FE):** `frontend/src/features/orgs/OrgSettingsPage.tsx:281-292`

**Evidence (BE):** Route exists at `POST /api/orgs/{uuid}:change_slug/` (`OrgChangeSlugView`).  
**Evidence (FE):** The settings form renders slug as a read-only `<Input>` with a tooltip "Slugs are immutable here. Contact a super-admin to rename an organization."

The route exists but there is no FE consumer. The FE copy is incorrect — org admins (not just super-admins) can use the colon-verb. The comment misleads users.

**Recommendation:** Either (a) build a slug-change modal that calls `POST /api/orgs/{uuid}:change_slug/` and is gated on `IsOrgAdminOrOwner`; or (b) update the help text to say "Contact an org admin" instead of "super-admin."

---

### F-13 — LOW: `OrgArchiveView` / `OrgSuspendView` / `OrgUnsuspendView` have no FE consumer at all

**Severity:** low  
**File (BE):** `backend/apps/organizations/urls.py:43-52`

**Evidence:** Colon-verb routes exist:
- `POST /api/orgs/{uuid}:suspend/` → `OrgSuspendView`
- `POST /api/orgs/{uuid}:unsuspend/` → `OrgUnsuspendView`
- `POST /api/orgs/{uuid}:archive/` → `OrgArchiveView`

No component in `frontend/src/features/orgs/**` or `frontend/src/api/orgs.ts` calls these endpoints.

**Why it matters:** These lifecycle verbs are super-admin only (suspend/unsuspend) or owner-only (archive). They are surfaced through the sadmin console, not the SPA. This is expected design — documenting it to prevent confusion.

**Recommendation:** Confirm these are sadmin-only surfaces. Add them to `frontend/src/api/orgs.ts` as no-op stubs with correct types if sadmin starts using the SPA API client; otherwise no action needed.

---

### F-14 — INFO: `OrgMembersBySlugView` returns the membership row `id` for the first membership row when a user holds multiple roles — `removeMember` will only remove that one row

**Severity:** info  
**File (BE):** `backend/apps/organizations/views.py:529-531`

**Evidence:** Aggregation loop:
```python
agg[r.user_id] = {
    "id": r.id,   # ← id of the FIRST matching row (earliest by created_at)
    ...
}
```
When `onRemove(m)` is called with this member, `orgsApi.removeMember(orgUuid, m.id)` deletes only that single membership row. If the user has `admin` + `co_organizer` memberships, only the admin row is deleted, leaving the co-organizer row active.

**Why it matters:** Multi-role member removal leaves orphaned rows. Low risk in v1 because the `single_org_per_admin_user` constraint means admin users typically hold only one active role per org, but the model supports multi-role and the aggregate shape misleads callers.

**Recommendation:** Either (a) return all membership `id`s as `membership_ids: string[]` and have the FE DELETE each; or (b) add a `DELETE /api/orgs/{slug}/members/{user_id}/` (by user, not membership row) that deactivates ALL active memberships for the user in that org in one call.

---

## Gaps (forward-looking)

| Item | Missing | Needed for | Effort | Blocking? |
|------|---------|-----------|--------|-----------|
| `acceptInvitation` response fix | `org_slug` in `OrganizationMembershipSerializer` or new response serializer | Invite-accept redirect | S | Yes |
| UUID invitation route — `roles[]` + `event_id` parity | Mirror slug-route logic in `OrgInvitationsView.post` | Invariant #3 compliance | S | Yes (500 today) |
| `AdminInvitationSerializer` — `roles` array + `invited_by_email` | Add SerializerMethodFields | `InvitationsListPanel` renders correctly | S | Yes (UI broken) |
| FE filter uses `status`, not `effective_status` | Change filter in `InvitationsListPanel.tsx` | Expired invites hidden from pending list | XS | No (cosmetic) |
| UUID members route shape alignment | Use `OrgMemberDetailSerializer` on UUID route too | Consistent API surface | S | No (slug route works) |
| Self-serve org creation UI | New "Create org" flow (Phase 1B) | Multi-org users | L | No |
| Slug-change UI in `OrgSettingsPage` | Modal + `POST :change_slug/` call | Org admin self-service | M | No |
| `transferOwnership` FE response type | Change `api.post<{ ok: true }>` to `api.post<Organization>` | Type correctness | XS | No |
| Suspension-state banner in `OrgSettingsPage` | Conditional card when `status === "suspended"` | UX for suspended orgs | S | No |
| Multi-role member removal | `membership_ids[]` or user-level DELETE route | Correct multi-role removal | M | No |
