# Adversarial Verify B — organizations/members UUID-routed serializer shape

## Finding under review
- severity: high
- area: organizations/members
- file: `backend/apps/organizations/views.py:356`
- title: UUID-routed members endpoint returns `OrganizationMembershipSerializer` — incompatible shape with slug route

## Verdict
- **is_real: TRUE** (the divergent-shape technical claim is confirmed)
- **corrected_severity: low** (downgraded from high — no live break; latent contract inconsistency only)

## Evidence (read from real code)

### 1. UUID route → OrganizationMembershipSerializer
`backend/apps/organizations/urls.py:64-68`
```python
path(
    "<uuid:uuid>/members/",
    views.OrgMembersListView.as_view(),
    name="org-members-list",
),
```
`backend/apps/organizations/views.py:349-356`
```python
class OrgMembersListView(ListAPIView):
    ...
    serializer_class = OrganizationMembershipSerializer   # line 356
```
`OrganizationMembershipSerializer` fields (serializers.py:139-152):
`id, user, organization, role, is_org_owner, is_active, created_at, removed_at`
— one row **per membership**, `user` is a raw FK UUID, singular `role`.

### 2. Slug route → OrgMemberDetailSerializer (different shape)
`backend/apps/organizations/urls.py:99-103`
```python
path(
    "<str:slug>/members/",
    views.OrgMembersBySlugView.as_view(),
    name="org-members-by-slug",
),
```
`backend/apps/organizations/views.py:516,549` returns `OrgMemberDetailSerializer`.
`OrgMemberDetailSerializer` fields (serializers.py:116-131):
`id, user_id, email, full_name, roles[], is_org_owner, joined_at, is_active`
— one row **per user** (aggregated), with `email`/`full_name`/plural `roles`.

The two shapes are genuinely incompatible for the same logical resource
`/api/orgs/{...}/members/`. Core technical claim CONFIRMED.

## Why severity is downgraded to low

The frontend never hits the UUID-routed members endpoint:
- `frontend/src/api/orgs.ts:71-72` — `members: (slug: string) => api.get<MembersResponse>(\`/api/orgs/${slug}/members/\`)` always sends a **slug**.
- `frontend/src/features/orgs/MemberDirectoryPage.tsx:260-262` — `orgSlug` is the route param from `/o/:orgSlug/members` and is matched against `m.org_slug`, so it is always a slug, never a UUID.
- Django's `<uuid:uuid>` converter only matches UUID-shaped values; a slug falls through to `OrgMembersBySlugView`, so the SPA always receives the aggregated `OrgMemberDetailSerializer` shape it types (`OrgMember`).

So there is no live, reachable break in current operation. The UUID route is
labelled "UUID, canonical" (urls.py:63) but is effectively dormant for this
resource.

Residual (real but low) risk — contract inconsistency / foot-gun:
- Two documented endpoints for the same resource return divergent shapes
  (OpenAPI: `frontend/src/types/api.generated.ts:427` slug route and `:505`
  uuid route describe different responses).
- Any future caller, external API consumer, or copy-pasted UUID URL hitting
  `/api/orgs/{UUID}/members/` silently gets the per-membership shape (no
  `email`/`full_name`/`roles[]`), which would break a frontend that assumes the
  aggregated shape. This is a maintainability / API-contract concern, not a
  high-severity functional defect.

confidence: 0.9
