# Adversarial Verify A — orgs/invite-accept: acceptInvitation response shape mismatch

**Finding (as given):** severity=critical, file `frontend/src/api/orgs.ts:83`,
"acceptInvitation response lacks org_slug; redirect always navigates to undefined."

**Verdict: REAL (response-shape mismatch confirmed) — but the finding's
description is imprecise on two points. Corrected severity: HIGH.**

## Evidence

### 1. Frontend declares the response as `{ org_slug, membership }`
`frontend/src/api/orgs.ts:82-86`:
```ts
acceptInvitation: (token: string) =>
  api.post<{ org_slug: string; membership: Membership }>(
    "/api/orgs/invitations/accept/",
    { token },
  ),
```
So the FE type does **declare** `org_slug` (the finding's literal phrasing "lacks
org_slug" is wrong about the FE *type*; the truth is the **backend response** lacks it).

### 2. Consumer reads `res.org_slug` and gates the redirect on it
`frontend/src/features/orgs/InviteAcceptPage.tsx:45-49`:
```ts
const res = await orgsApi.acceptInvitation(token);
setOrgSlug(res.org_slug);
await refreshMe();
setState("ok");
```
Render branch `InviteAcceptPage.tsx:81-89`:
```tsx
) : state === "ok" && orgSlug ? (
  ...
  <Button onClick={() => navigate(routes.orgDashboard(orgSlug))}>
```
`routes.orgDashboard` (`frontend/src/lib/routes.ts:25`) expects a **slug**:
`/o/${encodeURIComponent(slug)}/dashboard`.

### 3. Backend returns a FLAT membership object — no `org_slug`, no `membership` wrapper
Route `/api/orgs/invitations/accept/` → `InvitationAcceptByPathView`
(`backend/apps/organizations/views.py:621-625`) which subclasses
`InvitationAcceptView` (`views.py:461-485`):
```python
return Response(
    OrganizationMembershipSerializer(membership).data,
    status=status.HTTP_200_OK,
)
```
`OrganizationMembershipSerializer` (`backend/apps/organizations/serializers.py:139-152`)
fields = `["id","user","organization","role","is_org_owner","is_active","created_at","removed_at"]`.
- There is **no `org_slug`** field.
- There is **no `membership`** wrapper key (the body IS the membership object).
- `organization` is a FK (`models.py:177`), so it serializes as the org **UUID**
  (`organization_id`), not a slug.

## Runtime impact (corrected)
`res.org_slug` is `undefined` at runtime. Because the success UI is gated on
`state === "ok" && orgSlug` (`InviteAcceptPage.tsx:81`), `orgSlug` stays falsy,
so:
- The success message and "Go to organization" button branch **never render**.
- `navigate(...)` is therefore **never reached**, so it does NOT actually
  navigate to `/o/undefined/dashboard` as the finding asserts. The real symptom
  is a **dead-end success state**: invite accepted, session cycled
  (`refreshMe()` ran), but the user is left on a screen that has fallen through
  to the default "Accept invite" branch with no confirmation or redirect path.

(If a future refactor removed the `&& orgSlug` guard, it WOULD navigate to
`/o/undefined/dashboard` — so the finding's literal claim is latent, not current.)

## Severity assessment
- Real, user-facing breakage of the invite-accept happy path (a core Phase 1A
  flow per v1Users §2.13). Account chassis is claimed production-ready, so a
  broken accept redirect is significant.
- Downgraded from **critical** to **HIGH**: it is not a security/data-integrity
  or cross-org-leak issue; it is a contract mismatch breaking one screen's
  post-accept UX. The accept itself (membership creation, session cycle)
  succeeds server-side. No invariant (#1–#15) is violated; org isolation is intact.

## Fix direction (for reference, not applied)
Either (a) widen the backend accept view to return
`{"org_slug": membership.organization.slug, "membership": <serialized>}`, or
(b) change the FE type + `InviteAcceptPage` to read the flat membership and
resolve the slug via `refreshMe()`/`last_active_org_slug`. Option (a) matches
the existing FE contract with least churn. Also note `Membership` type is
`Schemas["OrganizationMembership"]` (`orgs.ts:20`), which has no `org_slug`
either, so even the nested shape would need a backend change.

**Confidence: high** (every link in the chain read directly: FE caller, FE
consumer, route helper, URL→view binding, view response, serializer fields).
