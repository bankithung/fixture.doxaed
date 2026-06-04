# Adversarial Verify A — organizations `_OrgMembershipPermission` pass-through

**Finding (claimed):** high / organizations / `backend/apps/organizations/permissions.py:86`
"_OrgMembershipPermission silently passes through when org context cannot be resolved from URL kwargs" — claimed authorization bypass.

**Verdict: NOT REAL as an exploitable authorization bypass. Severity "high" is wrong. Reclassify as low / info (defense-in-depth code smell).**

## What the code actually does

`backend/apps/organizations/permissions.py`:
- L78-99 `_OrgMembershipPermission.has_permission`:
  - L80-81 deny if not authenticated.
  - L82-83 allow superuser.
  - L85 `org = _resolve_org_from_view(view)`.
  - L86-89: `if org is None: return True` (the cited pass-through). Comment L87-88: "Resource-level views without an org slug pass through here; object-level permission filters at the queryset layer."
  - L91-99: membership existence check (`user`, `organization=org`, `is_active=True`, `role__in=allowed_roles`, optional owner filter).
- L28-66 `_resolve_org_from_view` returns `None` only when (a) no org kwarg present (L43-44), or (b) a kwarg is present but matches no existing non-deleted org (UUID not found → L60; slug not found → L66).

## Why the pass-through is not exploitable

Every view that mounts `IsOrgAdminOrOwner` / `IsOrgOwner` is on a route that always supplies an org-resolving kwarg:
- `backend/apps/organizations/urls.py` L38-128: all admin/owner routes use `<uuid:uuid>`, `<str:slug>`, or `<str:slug_or_uuid>`.
- `backend/apps/permissions/views.py` L150, L354: routes carry `org_uuid` or `slug` — both read by `_resolve_org_from_view` (L37-42).

Therefore on these protected routes the resolver returns `None` ONLY when the referenced org does not exist (or is soft-deleted). In every such case the view body independently 404s before any data is touched:
- `backend/apps/organizations/views.py` L83-86 `_resolve_org` → `get_object_or_404(... deleted_at__isnull=True)`.
- L89-108 `_resolve_org_by_slug_or_uuid` → `raise Http404` (L108).

There is no code path where the pass-through grants access to a real org the caller lacks membership in: if a real, non-deleted org matched the kwarg, the resolver would have found it (L52-66) and the membership check (L91-99) would run normally. Soft-deleted edge case is consistent — both resolver and view-body filter `deleted_at__isnull=True`, so it 404s.

## Corroboration
- Regression tests exercise both UUID and slug routes through these exact permission classes: `backend/apps/organizations/tests/test_slug_routes.py` L321-337 (`IsOrgAdminOrOwner` UUID + slug, expect 200), L340-360 (`IsOrgOwner` slug, expect 200), L363-367 (resolver unit test).

## Residual risk (real, but not "high")
The base class is default-allow on unresolved org. It is currently safe because (1) all consumers carry an org kwarg and (2) view bodies 404 on missing orgs. It would become a genuine bypass if a future view applied one of these classes to a route with no org kwarg and relied on the permission class alone (no queryset/object-level filter). That is a latent footgun / defense-in-depth weakness, appropriately low/info — not a present-day high-severity authorization bypass.

**is_real:** false (as stated — an authorization bypass). **Confidence:** high (0.9). Reframed as a low-severity latent code smell it is accurate.
