# Tenant Isolation Audit — Phase 1A Backend

**Date:** 2026-06-04
**Scope:** `backend/apps/` — every DRF endpoint and queryset through the lens of cross-org data leak (Invariant #2).
**Status:** GREENFIELD Phase 1A only (accounts, organizations, permissions/RBAC, audit, sadmin, sports). Phase 1B (tournaments, teams, fixtures, matches, live, notifications, disputes) does not exist yet.

---

## Summary

The core isolation mechanism — `OrganizationMembership.objects.user_org_ids(user)` feeding every queryset that is org-scoped — is sound. The `ScopedQuerySet` base class exists and is tested. The audit feed, org list, member lists, and invitation lists are all properly scoped. The sadmin console is correctly super-admin-gated. Sports catalog is intentionally public (platform metadata).

**Four real vulnerabilities were found, all in Phase 1A production code.**

---

## Findings

### F-1 (HIGH) — `PATCH /api/accounts/me/` accepts any org UUID in `last_active_org_id` without membership verification

**File:** `backend/apps/accounts/serializers.py:117` and `backend/apps/accounts/serializers.py:178-183`

**Evidence:**

```python
# serializers.py line 107-132: MeSerializer.Meta
fields = (
    ...
    "last_active_org_id",   # line 117 — in fields but NOT in read_only_fields
    "last_active_org_slug",
    ...
)
read_only_fields = (
    "id",
    "email",
    "is_superuser",
    ...
    # last_active_org_id is NOT here — it is WRITABLE
)

# serializers.py line 178-183
def get_last_active_org_slug(self, user):
    if not user.last_active_org_id:
        return None
    from apps.organizations.models import Organization
    org = Organization.objects.filter(id=user.last_active_org_id).only("slug").first()
    return org.slug if org else None  # No membership check!
```

**Why it matters:** Any authenticated user can PATCH `/api/accounts/me/` with `{"last_active_org_id": "<uuid-of-any-org>"}` to set their `last_active_org_id` to an org they do not belong to. The `get_last_active_org_slug` method then fetches and returns that org's slug in the GET `/api/accounts/me/` response — leaking the slug of any org whose UUID the attacker knows (or can enumerate). No `validate_last_active_org_id` method exists to prevent this.

**Recommendation:** Add a `validate_last_active_org_id` method to `MeSerializer` that verifies the supplied UUID corresponds to an org in which the requesting user has an active membership (use `OrganizationMembership.objects.user_org_ids(request.user)`). Alternatively, mark `last_active_org_id` as `read_only` and update it only via the service layer on org-context switches.

**Confidence:** High (confirmed by reading serializer; no validation hook exists).

---

### F-2 (MEDIUM) — `GET /api/permissions/me/modules/?org=<uuid>` leaks organization existence to non-members

**File:** `backend/apps/permissions/views.py:91-136`

**Evidence:**

```python
class MyEffectiveModulesView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        ...
        org = Organization.objects.filter(id=org_uuid).first()
        if org is None:
            return Response({"detail": "Organization not found."}, status=404)

        modules = sorted(effective_modules(request.user, org))
        return Response({"modules": modules})   # returns [] for non-members; no 403
```

**Why it matters:** A user who is not a member of org X can probe `GET /api/permissions/me/modules/?org=<org-X-uuid>`. The endpoint returns HTTP 200 with `{"modules": []}` rather than 403. This leaks:
1. The org's existence (200 vs 404 distinction confirms the UUID is a real, non-deleted org).
2. Absence of any modules is the correct answer for a non-member, but the HTTP 200 implicitly confirms org existence.

The slug-routed alias `GET /api/permissions/orgs/{slug}/me/modules/` (views.py line 295-300) has the same issue: it returns 200 with an empty modules list for any valid slug, even if the requester is not a member.

**Recommendation:** After resolving the org, verify the requesting user has at least one active membership in it. If not, return 403 (or 404, consistent with the rest of the surface). A `not OrganizationMembership.objects.filter(user=request.user, organization=org, is_active=True).exists()` check before calling `effective_modules` would suffice.

**Confidence:** High (confirmed by reading the view; no membership check before returning 200).

---

### F-3 (MEDIUM) — `GET/PUT /api/permissions/orgs/{org}/users/{user_uuid}/grants/` does not verify `target_user` is a member of `org`

**File:** `backend/apps/permissions/views.py:161-165` and `backend/apps/permissions/views.py:171-198`

**Evidence:**

```python
def get_target_user(self):
    from apps.accounts.models import User
    user_uuid = self.kwargs.get("user_uuid")
    return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))   # line 165 — no org-membership check

def get(self, request, org_uuid, user_uuid):
    org = self.get_organization()
    ...
    target_user = self.get_target_user()   # any user in the system

    rows = MembershipModuleGrant.objects.filter(
        user=target_user, organization=org
    )   # returns empty if non-member — no 404/403

    effective = sorted(effective_modules(target_user, org))   # returns [] for non-member
    return Response({"grants": serialized, "effective_modules": effective})
```

**Why it matters:** An admin of Org A can call `GET /api/permissions/orgs/<org-A-uuid>/users/<user-B-uuid>/grants/` where User B is not a member of Org A at all. The endpoint returns HTTP 200 with empty grants and empty effective_modules. While no Org A data leaks to Org B, this reveals that the user exists in the system (200 vs 404). For the PUT variant, the admin could attempt to create grant rows for an arbitrary user outside the org, which would produce `MembershipModuleGrant` rows for a (user, org) pair with no backing `OrganizationMembership` row — a data integrity hole that would corrupt future `effective_modules` output for that user if they later join the org.

**Recommendation:** In `get_target_user()` (or at the top of each handler), assert that `OrganizationMembership.objects.filter(user=target_user, organization=org, is_active=True).exists()`. Return 404 if the user is not a member of the org. This prevents both the user-existence probe and the orphan-grant data corruption.

**Confidence:** High (confirmed; no membership check for `target_user` in any path).

---

### F-4 (LOW) — `OrgChangeSlugView` resolves the org inside the handler AFTER the permission check, leaving a window where `IsOrgAdminOrOwner` could pass for a different org than the one being mutated

**File:** `backend/apps/organizations/views.py:228-247`

**Evidence:**

```python
class OrgChangeSlugView(APIView):
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]   # line 231

    def post(self, request, uuid):
        org = _resolve_org(uuid)   # line 235 — org resolved INSIDE the handler
        ser = ChangeSlugSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            org = slug_svc.change_slug(org=org, ...)
```

`IsOrgAdminOrOwner.has_permission()` calls `_resolve_org_from_view(view)` which reads `view.kwargs.get("uuid")`. Since `_resolve_org_from_view` and `_resolve_org` both read the same `uuid` kwarg, they resolve the same org in practice. The actual risk is theoretical: if any middleware or decorator were ever to rewrite `self.kwargs["uuid"]` between `has_permission` and `post()`, the permission check and the mutation would apply to different orgs. Currently there is no such middleware, so this is a structural code-smell rather than an exploitable bug.

The same pattern exists on `OrgArchiveView` (line 286), `OrgTransferOwnershipView` (line 321), and `OrgMemberRemoveView` (line 368).

**Recommendation:** Resolve the org once (in `has_permission` or a `get_object` override), store it on `self` or `request`, and re-use it in the handler. This eliminates the dual-lookup entirely and makes the intent unambiguous.

**Confidence:** Low (not exploitable today; structural concern only).

---

## Confirmed-Clean Patterns (no finding)

- **OrgListCreateView.get():** Correctly filters to `user_org_ids(request.user)` for non-superusers (views.py:133-134). Superuser bypass returns all — intentional.
- **OrgDetailView.get():** Explicitly checks `OrganizationMembership.objects.filter(user=request.user, organization=org, is_active=True).exists()` before returning (views.py:187-191).
- **OrgDetailView.patch():** Checks for `role=MembershipRole.ADMIN` before mutating (views.py:203-210).
- **OrgMembersListView/OrgMembersBySlugView:** Both use `organization=self.get_organization()` scoping; the permission class additionally verifies the requester has the `org.member_directory` module inside the resolved org (views.py:357-365, 511-548).
- **OrgInvitationsView / OrgInvitationsBySlugView:** Both gate on `IsOrgAdminOrOwner` via `_resolve_org_from_view` which reads the same URL kwarg used to fetch the invitation, ensuring requester and resource are always in the same org (views.py:408-435, 552-587).
- **OrgInvitationRevokeView / OrgInvitationByIdSlugView:** Use `get_object_or_404(AdminInvitation, pk=invitation_id, organization=org)` — the `organization=org` filter prevents fetching invitations from other orgs (views.py:443-458, 604-618).
- **OrgMemberRemoveView:** Uses `get_object_or_404(OrganizationMembership, pk=membership_id, organization=org)` — cross-org membership removal blocked (views.py:374-375).
- **OrgAuditListView:** Correctly filters `AuditEvent.objects.filter(organization_id=org.id)` and verifies membership via `HasModule("org.audit_log")` (audit/views.py:129). Cross-org test exists and passes (test_audit_list_view.py:120-146).
- **UserGrantsView/MatrixView:** The requester's admin role in the target org is verified by `IsOrgAdminOrOwner` before any data is read or written. The grant rows are always doubly-scoped: `filter(user=target_user, organization=org)`.
- **sadmin views:** All views decorated with `@superadmin_required` which 404s non-superusers. Not a tenant-isolation surface — it is an admin-only platform console. Intentionally cross-org.
- **Sports catalog:** Intentionally public (`AllowAny`); no org-scoped data.
- **ScopedQuerySet / ScopedManager:** Correct implementation in `permissions/scope.py` and `organizations/scope.py`. Isolation unit tests exist in `test_scope_queryset.py`.

---

## Gaps (forward-looking)

| # | Item | Missing | Needed for | Effort | Blocking |
|---|------|---------|------------|--------|---------|
| G-1 | Cross-org isolation test suite (endpoint-level) | No test exists that asserts User-in-Org-A → 403/404 when hitting every Org-B-scoped endpoint via UUID and slug. The CLAUDE.md invariant says "CI tests assert no cross-org leak via any DRF/SSE/WebSocket endpoint." | Invariant #2 compliance | M | No |
| G-2 | `last_active_org_id` PATCH validation | No `validate_last_active_org_id` in `MeSerializer`. Fix for F-1. | Invariant #2 | S | No |
| G-3 | `MyEffectiveModulesView` membership check | No membership gate on `/me/modules/?org=` or `/orgs/{slug}/me/modules/`. Fix for F-2. | Invariant #2 | S | No |
| G-4 | `UserGrantsView` target-user membership check | No membership assertion for `target_user` in either GET or PUT. Fix for F-3. | Invariant #2 | S | No |
| G-5 | Phase 1B isolation tests | Phase 1B models (Tournament, Match, Team, etc.) don't exist yet but when implemented MUST use `ScopedManager` or equivalent, and every endpoint MUST have a cross-org isolation test. | Phase 1B launch | L | No (future) |
| G-6 | Redis pub/sub cache invalidation for `effective_modules` | Noted as a TODO in `permissions/services/resolver.py:49`. In a multi-worker deployment, cache invalidation only flushes the local-mem entry on the calling worker. Other workers continue serving stale module sets. | Production multi-worker deploy | M | No (Phase 1B) |
