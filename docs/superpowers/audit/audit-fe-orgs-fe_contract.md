# Audit: fe-orgs — API Contract

**Scope:** `frontend/src/features/orgs/` + `frontend/src/api/orgs.ts`
**Lens:** api/*.ts calls hit real routes; request/response shapes match types/*.ts + serializers; non-2xx handling; loading/empty/error states present.
**Date:** 2026-06-04

---

## Summary

Seven findings. Three are **critical/high** and will produce runtime failures in the happy path: the `acceptInvitation` response shape mismatch means the redirect after invite-accept never fires; the invitation list shape means the invitation panel always renders zero rows for pending invites (they show as non-pending via `effective_status`); and the `PATCH /api/orgs/{uuid}/` permission gate silently blocks co-organizers and game-coordinators who the frontend allows to save settings. The remaining four are medium/low cleanup items.

---

## Findings

### F-1 — CRITICAL: `acceptInvitation` response shape is completely wrong

**File:** `frontend/src/api/orgs.ts:83`
**Evidence:**
```ts
// FE expects:
acceptInvitation: (token: string) =>
  api.post<{ org_slug: string; membership: Membership }>(
    "/api/orgs/invitations/accept/",
    { token },
  ),
```
Backend view (`backend/apps/organizations/views.py:482-484`):
```python
return Response(
    OrganizationMembershipSerializer(membership).data,
    status=status.HTTP_200_OK,
)
```
`OrganizationMembershipSerializer` fields are `id, user, organization, role, is_org_owner, is_active, created_at, removed_at` — a **flat membership object**, not `{ org_slug, membership }`. There is no `org_slug` anywhere in that response.

**Why it matters:** `InviteAcceptPage.tsx:46` does `const res = await orgsApi.acceptInvitation(token); setOrgSlug(res.org_slug)`. `res.org_slug` will be `undefined` at runtime. The success branch (`state === "ok" && orgSlug`) never renders and the "Go to organization" button never appears. Users are stuck on the accept page with no redirect.

**Recommendation:** Either (a) add `org_slug` (the accepting membership's org slug) to the backend `acceptInvitation` response — add a `org_slug = serializers.SerializerMethodField()` field to the view's serializer or create a dedicated response serializer; or (b) strip `{ org_slug, membership }` wrapper from the FE and destructure `membership.organization` (UUID), then look up the org slug from the user's re-bootstrapped memberships in `refreshMe()`.

---

### F-2 — HIGH: Invitation list serializer shape mismatches `InvitationListItem` — roles/status/invited_by_email all wrong

**File:** `frontend/src/api/orgs.ts:43-53` vs `backend/apps/organizations/serializers.py:160-184`

The FE `InvitationListItem` type expects:
```ts
{ id, email, roles: string[], status: "pending"|"accepted"|"expired"|"revoked", expires_at, invited_by_email, token? }
```

The backend `AdminInvitationSerializer` (used by both list and create endpoints) returns:
```python
fields = ["id", "organization", "email", "role",   # ← singular "role", not "roles"
          "status", "effective_status", "expires_at",
          "accepted_at", "revoked_at", "created_at",
          "invited_by"]   # ← FK UUID, not email string
```

Three concrete mismatches:
1. **`roles` vs `role`**: Backend sends `role` (single string). FE reads `invitation.roles` (array). `InvitationsListPanel.tsx:137` does `(invitation.roles ?? []).map(…)` — renders zero badges silently.
2. **`invited_by_email` absent**: FE type declares `invited_by_email: string`; backend sends `invited_by` (UUID of FK). No email is ever surfaced.
3. **`status` vs `effective_status`**: Backend has `status` (raw DB value) + `effective_status` (computed, may show `expired` for overdue-pending rows). FE filters `InvitationsListPanel.tsx:69` with `i.status === "pending"` — reads the raw `status`, so expired-but-DB-pending rows still appear as pending. This is benign now but will drift once the sweep cron runs.
4. **`token` never returned on list**: FE type marks `token?` optional; `AdminInvitationSerializer` never includes `token_hash` in list responses (correct — don't expose hash), but the copy-link affordance in the panel (`InvitationsListPanel.tsx:114`) is gated on `invitation.token`, which will always be `undefined` from list responses. Only the create response should ever surface a token — this is by design but worth noting the panel's copy button will never be shown from list responses.

**Why it matters:** Role badges never render in the invitation list panel. `invited_by_email` is missing so the inviter column is blank.

**Recommendation:** On the backend, either (a) add a `roles` `SerializerMethodField` that wraps `role` into a one-element list, or (b) migrate the model to store multiple roles per invitation. Add `invited_by_email = serializers.SerializerMethodField()` that returns `self.invited_by.email if self.invited_by else None`. On the FE, update `InvitationListItem` to reflect `role: string` until the backend ships `roles[]`.

---

### F-3 — HIGH: PATCH `/api/orgs/{uuid}/` silently 403s for co-organizers and game-coordinators

**File:** `frontend/src/features/orgs/OrgSettingsPage.tsx:140-151` vs `backend/apps/organizations/views.py:203-210`

Frontend permission check:
```ts
const isAdminish = (membership?.roles ?? []).some(
  (r) => r === "admin" || r === "co_organizer" || r === "game_coordinator" || r === "owner",
);
const canEdit = isOrgOwner || isAdminish || effectiveModules.has(REQUIRED_MODULE);
```
Backend `PATCH` check:
```python
if not OrganizationMembership.objects.filter(
    user=request.user, organization=org, is_active=True,
    role=MembershipRole.ADMIN,         # ← only "admin" allowed
).exists():
    raise PermissionDenied("Admin role required.")
```

A co-organizer or game-coordinator with the `org.settings` module granted will pass the FE gate, see the settings form, fill it out, and receive a 403 on submit. The error toast shows `"Could not save settings"` with no indication the role was the problem.

**Why it matters:** Misleading UX; co-organizers granted `org.settings` module should legitimately be able to edit settings per the module-RBAC design, but the backend only checks `role=admin`.

**Recommendation:** On the backend, extend the PATCH guard to also check `IsOrgOwner` or `HasModule("org.settings")` (matching the FE's gating logic). Or align the FE to only show the form to `admin`-role holders.

---

### F-4 — MEDIUM: `transferOwnership` response type is `{ ok: true }` but backend returns `OrganizationSerializer`

**File:** `frontend/src/api/orgs.ts:108`
```ts
api.post<{ ok: true }>(`/api/orgs/${slug}/ownership/transfer/`, payload)
```
Backend (`backend/apps/organizations/views.py:660`):
```python
return Response(OrganizationSerializer(org).data)
```
The actual response is a full `OrganizationSerializer` payload (id, slug, name, status, …). The FE discards the response body in `OwnershipTransferModal.tsx` (the `onSuccess` handler doesn't use the result at all), so this causes no visible bug today. But the type lie will mislead future readers and break if someone adds `result.ok` gating.

**Why it matters:** Type-unsafe, silent divergence; future callers may try `result.ok` and get `undefined`.

**Recommendation:** Change the FE return type to `Organization` (already defined in `api/orgs.ts`) and import the correct type. No backend change needed.

---

### F-5 — MEDIUM: `InviteCreateModal` sends a `message` field the backend silently ignores

**File:** `frontend/src/features/orgs/InviteCreateModal.tsx:48, 99-103`

The form schema includes:
```ts
message: z.string().max(500).optional().or(z.literal(""))
```
But `orgsApi.createInvitation` only forwards `{ email, roles, event_id }`:
```ts
orgsApi.createInvitation(orgSlug, {
  email: values.email,
  roles: values.roles,
  event_id: newEventId(),
  // message is not passed
})
```
The `AdminInvitationCreateSerializer` (`backend/apps/organizations/serializers.py:187-210`) has no `message` field either. The message field in the form collects user input and immediately discards it — the textarea is purely cosmetic.

**Why it matters:** Users see a "Message (optional)" field and believe it is emailed to the invitee, but it never reaches the backend email. This is a user-facing lie.

**Recommendation:** Either (a) add `message` to `AdminInvitationCreateSerializer`, forward it to the `send_mail` call in `invitation_svc.create_invitation`, and forward it from the FE; or (b) remove the `message` field from the form until it is implemented.

---

### F-6 — LOW: `OrgMembersListView` (UUID route) uses wrong serializer — dead code risk

**File:** `backend/apps/organizations/views.py:356`
```python
class OrgMembersListView(ListAPIView):
    serializer_class = OrganizationMembershipSerializer   # ← flat membership shape
```
The FE hits the **slug** route (`/api/orgs/${slug}/members/`) handled by `OrgMembersBySlugView`, which correctly uses `OrgMemberDetailSerializer`. The UUID route (`/api/orgs/<uuid>/members/`) uses the wrong serializer and would return `{ id, user, organization, role, … }` (flat membership, not aggregated user rows). The FE `OrgMember` type would not match if anything ever hits that UUID route.

**Why it matters:** Low risk today because the FE never hits the UUID route directly, but the route is registered and documented via OpenAPI. If any integration or script calls the UUID route, the response shape will differ from the slug route unexpectedly.

**Recommendation:** Change `OrgMembersListView.serializer_class` to `OrgMemberDetailSerializer` and override `get` to do the same user-aggregation logic as `OrgMembersBySlugView.get`. Or deprecate the UUID route and make it proxy to the slug view.

---

### F-7 — LOW: `InviteAcceptPage` missing `React` import for JSX component type annotation

**File:** `frontend/src/features/orgs/InviteAcceptPage.tsx:1, 21`

```ts
// No React import
export function InviteAcceptPage(): React.ReactElement {
```
The file uses `React.ReactElement` as a return type annotation but has no `import * as React from "react"` or `import React from "react"`. In the current Vite+TS config with `jsx: "react-jsx"` the JSX transform is automatic, but the bare `React.ReactElement` type reference still requires the React namespace to be imported. Other files in the feature folder consistently import React (e.g., `OrgSettingsPage.tsx:1`: `import * as React from "react"`).

**Why it matters:** TypeScript will error on `React.ReactElement` if the namespace is not in scope. Currently compiles only because `tsconfig` may have `"jsx": "react-jsx"` with global React injection or because the dist is pre-built, but this is fragile.

**Recommendation:** Add `import * as React from "react";` at line 1 of `InviteAcceptPage.tsx`.

---

## Gaps (forward-looking)

| # | Area | Missing | Needed for | Effort | Blocking |
|---|------|---------|-----------|--------|----------|
| G-1 | Accept invite | Backend response needs `org_slug` | Redirect after accept works | S | Yes |
| G-2 | Invitation list | Backend `AdminInvitationSerializer` needs `roles[]` + `invited_by_email` fields | Invitation panel shows correct data | S | Yes |
| G-3 | Org settings PATCH | Backend must extend permission check beyond `role=admin` | Module-gated co-organizers can save settings | S | Yes |
| G-4 | Invite form | `message` field either wired end-to-end or removed | No UX deception | S | No |
| G-5 | Pagination | No UI for next-page when member/invitation list exceeds page size | Large orgs | M | No |
| G-6 | Invitation resend | No resend verb in `orgsApi` or UI | Expired-but-pending invites can't be refreshed | M | No |
| G-7 | PATCH response cache | `OrgBrandingPage` and `OrgSettingsPage` share query key `["org", orgSlug, "detail"]` — a settings save correctly updates the cache but branding page reads the same cache; if branding ever adds write support the cache key will need a namespace | Future branding write | L | No |
