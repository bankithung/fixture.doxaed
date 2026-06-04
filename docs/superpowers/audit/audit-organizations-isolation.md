# Tenant Isolation Audit — `apps/organizations`

**Date:** 2026-06-04
**Scope:** `backend/apps/organizations` (views, permissions, serializers, models, services, scope) + `backend/apps/permissions` (views that reference org membership).
**Lens:** Can Org A reach Org B data? Default managers, get_queryset/get_object, object perms, serializer FKs accepting/leaking cross-org ids.

---

## Summary

The core org-scoping logic (membership-filtered list, org-anchor checks on every mutation verb) is structurally sound for the happy path. However four isolation-relevant issues were found and nine categories of mandatory cross-org endpoint tests are entirely absent.

---

## Findings

### F-1 (HIGH) — `_OrgMembershipPermission.has_permission` returns `True` when org cannot be resolved

**File:** `backend/apps/organizations/permissions.py:86-89`

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

**Why it matters:** `_resolve_org_from_view` returns `None` in two scenarios: (a) the URL kwarg is missing, and (b) the UUID or slug is present but the org does not exist (deleted or non-existent). In scenario (b) the permission class silently approves the request instead of returning 403/404. This applies to `IsOrgAdminOrOwner`, `IsOrgOwner`, and `IsOrgMember`. Any caller that then does `get_object_or_404(Organization, pk=uuid_value)` will surface a 404, but if the view instead continues to work with `None` it is a privilege bypass. Additionally if the URL kwarg resolves to a *deleted* org, this path approves a request for a soft-deleted org.

**Recommendation:** Change the `None` branch to `return False` rather than `return True`. Views that genuinely have no org in the URL should not use these permission classes; they should use `IsAuthenticated` alone and apply object-level checks.

---

### F-2 (HIGH) — `MyEffectiveModulesView` reveals membership existence for orgs the caller does not belong to

**File:** `backend/apps/permissions/views.py:91-136`

```python
permission_classes = [IsAuthenticated]

org = Organization.objects.filter(id=org_uuid).first()
...
modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

**Why it matters:** `effective_modules(user, org)` returns a `frozenset` that is always non-empty for any role the user holds in any org. If the user has NO membership in the queried org the set is empty — but the endpoint still responds 200. An authenticated user in Org A can probe Org B's UUID and receive a 200 with `{"modules": []}` vs a 404, confirming existence of Org B. More critically there is no membership check — only `IsAuthenticated`. If by bug the resolver ever returns modules for a mismatched user+org pair the data would be leaked directly.

**Recommendation:** Add a membership check before calling `effective_modules`. If the user has no active membership in `org` (and is not superuser) return 404 (not 403, to avoid org-existence enumeration).

---

### F-3 (MEDIUM) — `UserGrantsView.get_target_user` does not verify the target user is a member of the org

**File:** `backend/apps/permissions/views.py:161-165, 171-198`

```python
def get_target_user(self):
    from apps.accounts.models import User
    user_uuid = self.kwargs.get("user_uuid")
    return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
```

**Why it matters:** An org admin in Org A can call `GET /api/permissions/orgs/<org_a_uuid>/users/<user_b_uuid>/grants/` where `user_b` belongs only to Org B. The view returns that user's grant rows and `effective_modules` within Org A. Since `MembershipModuleGrant.objects.filter(user=target_user, organization=org)` will return an empty set the grants list is empty — but `effective_modules(target_user, org_a)` is called, which computes roles for target_user in org_a (none, so empty). No cross-org data leaks in v1 because result is always empty, but: (a) it confirms user existence cross-org via 200 vs 404; (b) in Phase 1B when module grants are more populated a stale membership row could produce non-empty output; (c) the same `PUT` path can write `MembershipModuleGrant` rows for a user who has no membership in the org at all.

**Recommendation:** In `get` and `put`, after resolving `target_user`, assert an active `OrganizationMembership(user=target_user, organization=org)` exists; return 404 otherwise.

---

### F-4 (MEDIUM) — `AdminInvitationSerializer` exposes `organization` FK (PK value) to anyone who can read the invitation list

**File:** `backend/apps/organizations/serializers.py:169-184`

```python
class AdminInvitationSerializer(serializers.ModelSerializer):
    ...
    fields = [
        "id",
        "organization",   # ← this is the FK UUID
        "email",
        "role",
        "status",
        ...
    ]
```

**Why it matters:** Not a direct cross-org leak (the invitation list is already gated by `IsOrgAdminOrOwner` and the view filters by `organization=org`), but the serializer emits the `organization` UUID in every response, which enables enumeration of other org UUIDs if an invitation is accidentally shown to the wrong party. Minor for v1 because the list endpoint is correctly org-scoped; the risk materialises if the serializer is reused in a broader context (e.g., a future "my invitations" endpoint without strict scoping).

**Recommendation:** The field is OK to keep for now given the current view scoping. Add a note in the serializer that it must not be used in any context where org membership has not been confirmed. Consider dropping `organization` from the response in a future pass.

---

### F-5 (LOW) — `OrgListCreateView.get` uses `Organization.active_objects.all()` for superusers, exposing ALL orgs including suspended/pending ones

**File:** `backend/apps/organizations/views.py:130-134`

```python
if request.user.is_superuser:
    qs = Organization.active_objects.all()
else:
    org_ids = OrganizationMembership.objects.user_org_ids(request.user)
    qs = Organization.active_objects.filter(id__in=list(org_ids))
```

**Why it matters:** Superuser list returning all orgs is intentional and correct. However `active_objects` filters `deleted_at__isnull=True` only — it includes `SUSPENDED`, `ORPHANED`, `PENDING_REVIEW` orgs in the non-superuser branch too. A regular member in a suspended org can still see their org in the list. This is a design decision (members should know their org is suspended) but it means suspended org data (name, slug, status) is returned to members who may no longer have legitimate access, which could be surprising.

**Recommendation:** Document the intentional decision; consider filtering out `SUSPENDED` orgs from the non-superuser branch or adding a `status__in` filter.

---

### F-6 (LOW) — `_resolve_org_from_view` in `permissions.py` falls through to slug-based lookup when the UUID kwarg resolves to nothing, potentially matching a different org

**File:** `backend/apps/organizations/permissions.py:52-66`

```python
if candidate_uuid is not None:
    org = Organization.objects.filter(
        pk=candidate_uuid, deleted_at__isnull=True
    ).first()
    if org is not None:
        return org
    # Fall through: a string that *parses* as a UUID is never a slug
    # (slugs are lowercase ASCII with hyphens). Return None.
    return None
```

The comment correctly notes that a UUID that does not match returns `None` (not a slug fallthrough). This is correctly handled. However the combined `kwargs.get("uuid") or kwargs.get("org_uuid") or kwargs.get("slug_or_uuid") or kwargs.get("slug")` priority chain means if multiple kwargs are present (unusual but possible with nested routers) the first non-falsy one wins, potentially resolving the wrong org.

**Recommendation:** Accept the current implementation as fine for v1's single router setup. Add an assertion or test that no URL pattern injects multiple org-keyed kwargs simultaneously.

---

## Gaps — Missing Cross-Org Isolation Tests

The following isolation test scenarios are entirely absent from `backend/apps/organizations/tests/`. The CLAUDE.md invariant #2 states these are mandatory.

| Gap | Endpoint | Description | Effort |
|-----|----------|-------------|--------|
| G-1 | `GET /api/orgs/` | User in Org A must not see Org B in the list response | S |
| G-2 | `GET /api/orgs/{uuid}/` | User in Org A must get 403 when fetching Org B by UUID | S |
| G-3 | `PATCH /api/orgs/{uuid}/` | User in Org A must get 403 when patching Org B | S |
| G-4 | `GET /api/orgs/{slug}/members/` | User in Org A must get 403 when fetching Org B members | S |
| G-5 | `GET /api/orgs/{uuid}/invitations/` | User in Org A must get 403 when listing Org B invitations | S |
| G-6 | `POST /api/orgs/{uuid}/invitations/` | User in Org A must get 403 when creating invite in Org B | S |
| G-7 | `DELETE /api/orgs/{uuid}/members/{id}/` | User in Org A must get 403 when removing Org B member | S |
| G-8 | `GET /api/permissions/orgs/{slug}/grants/matrix/` | User in Org A must get 403 on Org B matrix — test exists for outsider=no-membership (test_matrix.py:305) but NOT for user-in-different-org | S |
| G-9 | `GET /api/permissions/me/modules/?org=<org_b_uuid>` | Any authenticated user can call this for any org UUID; test that a non-member gets 200 with empty modules (confirms F-2 above) | S |
| G-10 | `PUT /api/permissions/orgs/{slug}/users/{user_uuid}/grants/` | Org A admin writing grants for Org B user (cross-org write) | S |

### Additional spec-required test

| Gap | Description |
|-----|-------------|
| G-11 | `POST /{uuid}:change_slug/` — user in Org A must get 403 when changing Org B slug. Currently `OrgChangeSlugView` uses `IsOrgAdminOrOwner` so the permission class should catch it, but there is no test verifying this. |
| G-12 | `POST /{uuid}:archive/` — non-member of the org must get 403. No test. |
| G-13 | `POST /{uuid}:transfer_ownership/` — user in Org A must not be able to transfer Org B ownership. No test. |

---

## What Is Clean

- `OrgListCreateView.get` correctly uses `user_org_ids` to scope the queryset for non-superusers. No cross-org leak here.
- `OrgDetailView.get` explicitly checks `OrganizationMembership.objects.filter(user=request.user, organization=org, is_active=True).exists()` before serving org data.
- `OrgDetailView.patch`, `OrgArchiveView`, `OrgMemberRemoveView`, `OrgInvitationsView`, `OrgInvitationRevokeView`, `OrgInvitationsBySlugView`, `OrgInvitationByIdSlugView` all resolve the org from the URL first and then verify membership via `IsOrgAdminOrOwner` or inline checks.
- `OrgMembersListView.get_queryset` always filters `organization=self.get_organization()` so it can only return members of the resolved org.
- `AdminInvitation` listing is always filtered `organization=org` before returning.
- `OrganizationMembershipManager.user_org_ids` correctly filters `is_active=True` and `organization__deleted_at__isnull=True`.
- `ScopedQuerySet.scoped_for_user` correctly excludes deleted orgs and unauthenticated users.
- `transfer_ownership` service uses `select_for_update` and validates both membership rows belong to the same org.
- `accept_invitation` resolves org from the invitation row itself (not from user input), so cross-org assignment is impossible.
