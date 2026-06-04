# Adversarial Verify B — organizations/permissions.py:86

## Finding under review
- severity: high
- area: organizations
- file: backend/apps/organizations/permissions.py
- line: 86
- title: `_OrgMembershipPermission` silently passes through when org context cannot be resolved from URL kwargs
- claim: Authorization bypass when org context cannot be resolved from URL kwargs

## Verdict: NOT REAL (overstated / theoretical) — is_real=false

The pass-through exists in the code exactly as described, but it does NOT
constitute an exploitable authorization bypass. Every consuming view
independently re-resolves the org in its handler body and returns 404
before touching any data, so no real org's data is ever exposed or
mutated via this branch.

## Code seen (backend/apps/organizations/permissions.py)

`_resolve_org_from_view` (lines 28-66) returns `None` in only three cases:
- no org-identifying kwarg present (lines 43-44)
- candidate parses as a UUID but matches no live org (lines 56-60)
- candidate is a slug that matches no live org (lines 63-66)

`_OrgMembershipPermission.has_permission` (lines 78-99):
```
85   org = _resolve_org_from_view(view)
86   if org is None:
87       # Resource-level views without an org slug pass through here;
88       # object-level permission filters at the queryset layer.
89       return True
```

## Why it is not exploitable — every consuming view re-resolves

Confirmed usages of the subclasses (`IsOrgAdminOrOwner`/`IsOrgOwner`/`IsOrgMember`):

1. URL routes (backend/apps/organizations/urls.py) for ALL these views
   capture a kwarg (`<uuid:uuid>`, `<str:slug>`, or `<str:slug_or_uuid>`).
   So the "no kwarg" branch (lines 43-44) is unreachable for these views —
   candidate is always present.

2. When the kwarg points at a nonexistent / soft-deleted org,
   `_resolve_org_from_view` returns None and the permission passes through,
   BUT each view body then re-resolves and 404s:
   - `OrgChangeSlugView` (views.py:235), `OrgTransferOwnershipView` (:325):
     `_resolve_org(uuid)` → `get_object_or_404(...)` (views.py:83-86).
   - Slug aliases `OrgInvitationsBySlugView` (:562/:570),
     `OrgInvitationByIdSlugView` (:605), `OwnershipTransferBySlugView` (:644):
     `_resolve_org_by_slug_or_uuid(slug)` raises `Http404` (views.py:89-108).
   - `OrgMemberRemoveView` (:373), `OrgInvitationsView` (:412/:420),
     `OrgInvitationRevokeView` (:443): `_resolve_org(uuid)` → 404.
   - permissions/views.py `UserGrantsView` (:150) / `UserGrantsBySlugView`
     (:303) / `MatrixView` (:354): `get_organization()` returns None and the
     handler returns explicit 404 (views.py:175-179, 212-216, 369-370).

3. Views that DO NOT use these classes enforce membership inline and are
   unaffected: `OrgListCreateView` (:142-143 super-only POST; :130-134
   membership-scoped GET queryset), `OrgDetailView` (:187-191 membership
   check), `OrgArchiveView` (:294-303 owner check), `OrgMembersListView` /
   `OrgMembersBySlugView` use `HasModule("org.member_directory")`.

The crucial point: the pass-through returns True ONLY when the org is
None (i.e. does not exist / not accessible by slug-or-uuid lookup). It
never returns True for a *real, existing* org that the authenticated user
lacks membership in — that path always hits the membership `qs.exists()`
check at lines 91-99. So an authenticated non-member cannot reach a real
org's data through this branch.

## Regression coverage confirming intended behavior
backend/apps/organizations/tests/test_slug_routes.py:321-378 exercises
`IsOrgAdminOrOwner`/`IsOrgOwner` over BOTH uuid and slug kwargs and unit-
tests `_resolve_org_from_view` directly. The pass-through's original
purpose (per the comment + the test header at lines 313-318) was to avoid
a 500 when a slug string was cast to a UUID column — a real bug that was
fixed; the `return True` is the deliberate "let the body 404" fallback.

## Residual risk (defense-in-depth note, not a high finding)
The pattern is fragile: a FUTURE view that uses one of these permission
classes but trusts the permission for org scoping WITHOUT re-resolving in
the body (e.g. a list endpoint with a non-org-scoped default queryset)
would leak. Today no such view exists, so this is a latent maintenance
hazard, not a present authorization bypass. A safer default would be
`return False` (fail-closed) since the body re-resolves anyway. That makes
this at most a LOW / INFO hardening item, not HIGH.

## Confidence: high (0.9) that the HIGH severity is wrong; the present-state
behavior is fail-closed in practice via redundant body re-resolution.
