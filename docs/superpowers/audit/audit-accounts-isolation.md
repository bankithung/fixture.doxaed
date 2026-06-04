# Tenant-Isolation Audit: `apps/accounts`

**Date:** 2026-06-04
**Scope:** `backend/apps/accounts` — every endpoint and queryset for cross-org data
leakage. Org A must never be able to read or influence Org B data through
any path in this app.

---

## Findings

### F-01 · HIGH — `PATCH /me/` accepts arbitrary `last_active_org_id` with no membership check

**File:** `backend/apps/accounts/serializers.py:107–132`
**Evidence:**

```python
fields = (
    ...
    "last_active_org_id",
    ...
)
read_only_fields = (
    "id",
    "email",
    "is_superuser",
    "has_2fa_enrolled",
    "twofa_enrolled_at",
    "email_verified_at",
    "memberships",
    "last_active_org_slug",
    "deleted_at",
)
```

`last_active_org_id` is listed in `fields` but **not** in `read_only_fields`,
so DRF accepts it as a writable field on `PATCH /api/accounts/me/`.

The view calls `serializer.save()` unconditionally:

```python
# views.py:423-426
serializer = MeSerializer(user, data=request.data, partial=True)
serializer.is_valid(raise_exception=True)
...
serializer.save()
```

There is no `validate_last_active_org_id` method and no service-layer check
to verify that `request.user` holds an active membership in the submitted
org UUID.

**Why it matters:**
A user in Org A can PATCH `last_active_org_id` to any UUID, including one
belonging to Org B they have never seen. On the subsequent GET `/me/`,
`get_last_active_org_slug` will query `Organization.objects.filter(id=...)` on
that arbitrary UUID and leak the org's slug back to the caller:

```python
# serializers.py:178-184
def get_last_active_org_slug(self, user):
    if not user.last_active_org_id:
        return None
    org = Organization.objects.filter(id=user.last_active_org_id).only("slug").first()
    return org.slug if org else None
```

This is a cross-org information-disclosure path: an attacker who guesses or
obtains any Organization UUID can learn its slug without holding a membership.
Slugs may be non-public and carry naming information about the tenant.

**Recommendation:**
Add a `validate_last_active_org_id` method to `MeSerializer` (or inline in
the view) that verifies `OrganizationMembership.objects.filter(user=user,
organization_id=value, is_active=True).exists()`. Reject with 400 if not.
Alternatively move `last_active_org_id` to `read_only_fields` and provide a
dedicated endpoint for setting the active-org context.

---

### F-02 · MEDIUM — `last_active_org_id` has no DB-level FK constraint

**File:** `backend/apps/accounts/models.py:86`
**Evidence:**

```python
last_active_org_id = models.UUIDField(null=True, blank=True)
```

This is a bare `UUIDField`, not a `ForeignKey` to `Organization`. There is
no database-level referential integrity, no `on_delete=SET_NULL`, and no
validation that the UUID refers to an actual org row.

**Why it matters:**
Combined with F-01, this means any 32-hex UUID—valid or not—can be written
to the field. The absence of a FK also means stale references survive org
deletion without being nulled out.

**Recommendation:**
Replace with `ForeignKey("organizations.Organization", null=True, blank=True,
on_delete=models.SET_NULL, related_name="+")`. This enforces DB integrity and
auto-nulls when the org is deleted. Add a migration. The SPA org-switcher
already assumes the value is consistent.

---

### F-03 · MEDIUM — `user_soft_delete_view` lacks reauth gate for superuser-escalated action

**File:** `backend/apps/accounts/views.py:449-474`
**Evidence:**

```python
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def user_soft_delete_view(request: Request, user_id) -> Response:
    actor = request.user
    if not actor.is_superuser:
        return Response({"detail": "forbidden"}, status=status.HTTP_403_FORBIDDEN)
    ...
    target.soft_delete()
```

The `require_recent_password_reauth` decorator exists in
`apps/accounts/decorators.py` and is documented as mandatory for "any
sensitive verb (suspend, impersonate, transfer ownership, force-disable 2FA,
**delete**)" (v1Users.md Appendix B.18). The decorator is defined but never
applied to this view.

**Why it matters:**
If a superuser's session is hijacked (e.g. XSS or session fixation), an
attacker can permanently soft-delete any user account — anonymizing their
email and name irreversibly — without triggering a re-password challenge.
This is a cross-org action: the superuser can target users in any org.

**Recommendation:**
Add `@require_recent_password_reauth()` above `@permission_classes` on
`user_soft_delete_view`. The decorator is already implemented; it is simply
not wired.

---

### F-04 · MEDIUM — `_OrgMembershipPermission.has_permission` returns `True` when org cannot be resolved from kwargs

**File:** `backend/apps/organizations/permissions.py:86-89`
**Evidence:**

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

When `_resolve_org_from_view` cannot find an org (e.g. an org UUID in the
URL is valid as a UUID but does not exist, or the kwarg key name does not
match), the base permission class falls through to `return True` for any
authenticated user, relying entirely on the queryset layer for isolation.

`OrgMembersListView` (`views.py:349`) uses `HasModule("org.member_directory")`
rather than an `_OrgMembershipPermission` subclass. `HasModule._resolve_organization`
calls `view.get_organization()` which calls `_resolve_org(self.kwargs["uuid"])`.
If `_resolve_org` raises a 404 (deleted or missing org), the exception
propagates before `HasModule.has_permission` can return False. This is safe,
but the general `_OrgMembershipPermission` fallback-to-True is a latent risk
for any view that:
  (a) uses `IsOrgMember` / `IsOrgAdminOrOwner` / `IsOrgOwner`, and
  (b) has an org kwarg under a non-standard key name.

**Why it matters:**
A future view that accidentally names the URL kwarg `organization_id` instead
of `uuid` / `org_uuid` / `slug` / `slug_or_uuid` would silently bypass the
membership check for any authenticated user.

**Recommendation:**
Change the `org is None` branch to `return False` (deny by default) and only
allow through if the view is explicitly decorated with a marker that opts out
of the org-resolution requirement. Alternatively add `org_uuid` as the
canonical kwarg and enforce it in the docstring / base class.

---

### F-05 · LOW — `MeSerializer.get_memberships` silently swallows `effective_modules` exceptions, potentially returning empty module list

**File:** `backend/apps/accounts/serializers.py:169-173`
**Evidence:**

```python
try:
    modules = list(effective_modules(user, org))
except Exception:
    modules = []
```

Any exception from the resolver — including a DB error or cache corruption —
silently returns `effective_modules = []` to the SPA. The SPA uses this list
to hide/show menu items. A transient DB error can therefore degrade all users
to a "no modules" experience without any visible error.

**Why it matters:**
This is not a direct isolation bug, but a defensive-coding failure that could
be exploited to temporarily deny access: if the cache or DB can be poisoned,
the SPA will silently render as if the user has no org-level access. Combined
with F-01, an attacker may also craft a `last_active_org_id` that causes the
slug lookup to fail and the module list to be empty for the legitimate user.

**Recommendation:**
Re-raise the exception or return a sentinel that causes the SPA to retry rather
than presenting an empty module set. At minimum log the exception at ERROR level
so it appears in alerting.

---

### F-06 · INFO — No cross-org isolation test for `GET /me/` or `PATCH /me/`

**File:** `backend/apps/accounts/tests/` (no such test exists)

The existing test `test_user_self_update_emits_event` only patches `name` and
verifies an audit row. There is no test that:
  - PATCHes `last_active_org_id` to an org the user is NOT a member of.
  - Asserts the response is rejected (after F-01 is fixed).
  - Asserts `get_last_active_org_slug` does NOT return slugs for unrelated orgs.

**Recommendation:**
Add a test:
```python
def test_me_patch_last_active_org_id_rejected_if_not_member():
    user_a = UserFactory()
    org_b = OrganizationFactory()  # user_a has no membership here
    api.force_authenticate(user_a)
    resp = api.patch(reverse("accounts:me"), {"last_active_org_id": str(org_b.id)})
    assert resp.status_code == 400
```

---

### F-07 · INFO — `user_soft_delete_view` has no test asserting non-superusers receive 403 for users in other orgs

**File:** `backend/apps/accounts/tests/test_audit_emission.py:148-163`

The existing test only exercises the superuser-happy-path. There is no test
that an Org Admin (non-superuser) cannot reach the soft-delete endpoint for
a user in a different org.

**Recommendation:**
Add:
```python
def test_soft_delete_forbidden_for_org_admin():
    admin = UserFactory()  # org admin, not superuser
    target = UserFactory()
    api.force_authenticate(admin)
    resp = api.post(reverse("accounts:user_soft_delete", args=[str(target.id)]))
    assert resp.status_code == 403
```

---

## Gaps (forward-looking)

| # | Item | Why it matters | Effort |
|---|------|----------------|--------|
| G-01 | `last_active_org_id` needs FK + membership validator (fixes F-01 + F-02) | Core isolation invariant | S |
| G-02 | Wire `@require_recent_password_reauth()` on `user_soft_delete_view` (fixes F-03) | v1Users.md B.18 contractual requirement | XS |
| G-03 | Change `_OrgMembershipPermission` org-None fallback to `False` (fixes F-04) | Defence-in-depth for future views | S |
| G-04 | Add parametrized cross-org isolation tests for all `/me/` mutations (fixes F-06) | Invariant #2 CI gate | S |
| G-05 | Add non-superuser 403 test for `user_soft_delete_view` (fixes F-07) | Coverage gap | XS |
| G-06 | `effective_modules` exception should not silently return `[]`; log at ERROR or propagate (fixes F-05) | Availability + observability | S |
