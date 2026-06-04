# Tenant-Isolation Audit — `apps/permissions`

**Scope:** `backend/apps/permissions/` plus the `IsOrgAdminOrOwner` /
`IsOrgMember` helpers in `apps/organizations/permissions.py` that gate
every permissions endpoint.

**Audit date:** 2026-06-04  
**Severity scale:** critical | high | medium | low | info

---

## Summary

Five isolation findings across the permissions surface, ranging from **high**
to **low** severity. No finding currently allows Org A data to be read by a
fully-correct Org B admin, but three findings in combination create a realistic
attack path:

1. An admin in Org A can read/write module grants for *any platform user*
   (not just Org A members) via the `UserGrantsView` endpoints.
2. Any authenticated user can probe org existence (including soft-deleted orgs)
   via `MyEffectiveModulesView` without being a member of the org.
3. The `IsOrgAdminOrOwner` guard silently passes when the org UUID in the URL
   does not match any row, turning a missing-org request into an authenticated
   pass-through.
4. A subtle `getattr` default in the `effective_modules()` resolver makes the
   early-return guard incorrect; objects that lack `is_authenticated` skip the
   guard.
5. No cross-org endpoint isolation tests exist for the three write paths
   (`PUT /grants/`, matrix, slug-PUT).

---

## Findings

---

### F-1 — HIGH: `UserGrantsView.get_target_user()` fetches any user, not just org members

**File:** `backend/apps/permissions/views.py:161-165`

```python
def get_target_user(self):
    from apps.accounts.models import User
    user_uuid = self.kwargs.get("user_uuid")
    return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
```

**Why it matters:** An admin in Org A can call
`PUT /api/permissions/orgs/{org_A_uuid}/users/{user_B_uuid}/grants/`
where `user_B_uuid` is a user who belongs only to Org B. The target user is
resolved from the global `User` table without checking membership in the
requested org. `bulk_set_grants` then writes `MembershipModuleGrant` rows
keyed `(user_B, org_A, module)`. The same path exists for GET (reading
grant state for a cross-org user) and for the slug-routed alias
`UserGrantsBySlugView`.

**Attack impact:**
- Admin of Org A can enumerate module grants of users in other orgs via GET.
- Admin of Org A can upsert or clear module-grant rows for users in other
  orgs, injecting an override that will apply if that user ever joins Org A,
  and emitting spurious audit events attributed to Org A.

**Recommendation:** After resolving the org and the target user, assert
membership before proceeding:

```python
def get_target_user(self):
    from apps.accounts.models import User
    user_uuid = self.kwargs.get("user_uuid")
    user = get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
    org = self.get_organization()
    if org is not None and not OrganizationMembership.objects.filter(
        user=user, organization=org, is_active=True
    ).exists():
        raise Http404("User is not a member of this organization.")
    return user
```

**Confidence:** High

---

### F-2 — HIGH: `IsOrgAdminOrOwner.has_permission()` returns `True` when org UUID resolves to nothing

**File:** `backend/apps/organizations/permissions.py:85-89`

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

**Why it matters:** For `UserGrantsView` and `MatrixView`, the URL always
contains `org_uuid` or `slug`. If the caller supplies a UUID that does not
match any active org, `_resolve_org_from_view` returns `None` and
`has_permission` returns `True`. The view's own `get_organization()` then
also returns `None`, and the view returns 404 — BUT only after `has_permission`
has already granted access. Chained with a future view that doesn't immediately
404 on a missing org, this becomes an unauthenticated surface.

More concretely today: a non-admin user in Org A who knows a deleted org's
UUID can hit `GET /api/permissions/orgs/{deleted_uuid}/grants/matrix/` and
`IsOrgAdminOrOwner` returns `True` (deleted org resolves to None → pass), then
`MatrixView.get_organization()` returns None → Http404. The net result is a 404,
not a 403 — which leaks whether the org UUID was ever valid (timing difference)
and means access control is not fully exercised.

**Recommendation:** Change the `org is None` branch to `return False` and let
the view handle its own 400 / 404 for missing slug/UUID. The comment "object-
level permission filters at the queryset layer" only applies to views that carry
no org context — and all permissions views carry an explicit org context.

```python
if org is None:
    return False  # no org context = deny, not pass
```

**Confidence:** High

---

### F-3 — MEDIUM: `MyEffectiveModulesView` leaks org existence to non-members and queries soft-deleted orgs

**File:** `backend/apps/permissions/views.py:128`

```python
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, status=status.HTTP_404_NOT_FOUND)

modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

**Two sub-issues:**

**(a) Soft-deleted orgs are discoverable.** `Organization.objects` is the
default manager which returns all rows, including those with `deleted_at` set.
An authenticated user can probe any org UUID and receive 200 (with an empty
module list) for soft-deleted orgs, or 404 for truly non-existent UUIDs. This
makes soft-delete non-transparent. Should use `Organization.active_objects`.

**(b) No membership check before responding 200.** A user with no membership
in Org B can call `GET /api/permissions/me/modules/?org={org_B_uuid}` and
receive `{"modules": []}` with status 200, confirming the org exists and that
the caller is not a member. A consistent 404 for "not a member or not found"
would prevent oracle-style org enumeration.

**Recommendation:**

```python
org = Organization.active_objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
# Verify caller is actually a member (non-members get 404, not 200+empty list).
if not request.user.is_superuser:
    from apps.organizations.models import OrganizationMembership
    if not OrganizationMembership.objects.filter(
        user=request.user, organization=org, is_active=True
    ).exists():
        return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

The same sub-issue (a) applies to the slug alias `MyModulesBySlugView`
(`views.py:296`), which uses `_resolve_org_by_slug_or_uuid` — that helper does
check `deleted_at__isnull=True`, so (a) is already handled there. But (b) is
still present: any authenticated user who knows the slug can receive a 200 with
an empty list.

**Confidence:** High for (a); Medium for (b) (depends on product-level information-classification decision).

---

### F-4 — LOW: `effective_modules()` early-return guard uses wrong `getattr` default

**File:** `backend/apps/permissions/services/resolver.py:113`

```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

**Why it matters:** The guard intends to short-circuit for unauthenticated users.
The default value in `getattr(user, "is_authenticated", True)` is `True`, not
`False`. If any caller passes an object that lacks the `is_authenticated`
attribute (e.g., a plain Python object used in a test double or a future
integration), the guard evaluates `not True` = `False` and DOES NOT short-
circuit — the resolver proceeds as if the user is authenticated. This is a
correctness defect rather than an exploitable bypass in production (DRF's
`IsAuthenticated` already filters at the view layer), but it creates a latent
risk if the resolver is ever called outside a request context.

**Recommendation:** Change the default to `False`:

```python
if user is None or not getattr(user, "is_authenticated", False):
    return frozenset()
```

**Confidence:** High (logic error confirmed by code reading).

---

### F-5 — MEDIUM: `HasModule._resolve_organization()` silently swallows exceptions from `view.get_organization()`

**File:** `backend/apps/permissions/permissions.py:61-65`

```python
if hasattr(view, "get_organization"):
    try:
        return view.get_organization()
    except Exception:
        return None
```

**Why it matters:** The bare `except Exception` clause means any error inside
`get_organization()` — including a `PermissionDenied` raised intentionally, or
a database `OperationalError` — silently returns `None`. The caller then falls
through to `org_uuid` kwargs resolution. If that also returns `None`,
`has_module()` is called with `org=None`, and `effective_modules()` immediately
returns `frozenset()`, so the permission check fails closed (returns `False`).
That is the safe failure mode. However, if the fallback org resolution
succeeds (e.g., `org_uuid` kwarg exists), the module check will run against a
different org than the view intended — a wrong-org rather than no-org resolution.

**Recommendation:** Only swallow exceptions that indicate "no org context"
(`Http404`, `ObjectDoesNotExist`). Re-raise all others:

```python
from django.core.exceptions import ObjectDoesNotExist
from django.http import Http404

if hasattr(view, "get_organization"):
    try:
        return view.get_organization()
    except (Http404, ObjectDoesNotExist):
        return None
    # All other exceptions propagate (e.g., DB error, PermissionDenied).
```

**Confidence:** Medium (the wrong-org path requires a view with both
`get_organization()` that errors AND an `org_uuid` kwarg, which is not the
current layout but is plausible in Phase 1B views).

---

## Gaps (Missing Tests)

| ID | Area | Missing | Blocking | Effort |
|----|------|---------|----------|--------|
| G-1 | `UserGrantsView` GET | Test: admin of Org A reads grants for user who is NOT a member of Org A (should 404). | Yes | S |
| G-2 | `UserGrantsView` PUT | Test: admin of Org A writes grants for user from Org B (should 404). | Yes | S |
| G-3 | `UserGrantsBySlugView` GET/PUT | Same cross-org checks via slug route. | Yes | S |
| G-4 | `MyEffectiveModulesView` | Test: authenticated non-member gets 404 not 200+empty for a valid org UUID. | Yes | S |
| G-5 | `MyEffectiveModulesView` | Test: soft-deleted org UUID returns 404 not 200. | Yes | S |
| G-6 | `IsOrgAdminOrOwner` pass-through | Test: request with a non-existent org UUID returns 403, not 404 (guard must reject, not pass). | Yes | S |
| G-7 | `MatrixView` | Test: admin of Org A cannot access matrix for Org B by supplying Org B's UUID/slug. | Yes | S |
| G-8 | `effective_modules` resolver | Test: object without `is_authenticated` attribute returns `frozenset()`. | No | XS |
| G-9 | `HasModule._resolve_organization` | Test: `get_organization()` raises non-Http404 exception — verify it propagates rather than silently returning None. | No | S |
| G-10 | Cross-org grant write isolation | End-to-end: user in Org A cannot have `MembershipModuleGrant` rows written against them by an admin in Org B. | Yes | M |
