# RBAC Audit: organizations app

**Date:** 2026-06-04
**Scope:** `backend/apps/organizations/` (views, permissions, serializers, services, urls) + `backend/apps/permissions/` (resolver, grants, scope, views)
**Lens:** Is every mutating and sensitive-read endpoint gated server-side by role/module? Covers: effective_modules resolver, per-user MembershipModuleGrant, owner-only verbs, invite tree, single_org_per_admin_user constraint, default-deny, password-reprompt.

---

## Summary

The organizations app has solid structural RBAC wiring. Membership-role checks (`IsOrgAdminOrOwner`, `IsOrgOwner`, `IsSuperUser`) are applied consistently to all mutating verb routes. The module catalog, effective_modules resolver, grant override path, and the MembershipModuleGrant deny-override flow all work correctly. DB constraints (`single_org_per_admin_user`, `one_owner_per_org`, `owner_flag_only_on_admin_role`) are in place and tested.

Five genuine findings, ranging from high to low severity, are documented below. No password-reprompt / sudo flow exists anywhere in the codebase — this is a forward-looking gap but not a regression, as the spec defers it to Phase 1B. The most important finding is a pass-through bug in the `_OrgMembershipPermission` base class that silently grants access when the URL resolver cannot derive an org context.

---

## Findings

### F-01 — HIGH: `_OrgMembershipPermission.has_permission` silently passes through when org cannot be resolved

**File:** `backend/apps/organizations/permissions.py:86-89`

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

**Why it matters:** When `_resolve_org_from_view` returns `None` (because the view has no recognized URL kwarg — `uuid`, `org_uuid`, `slug_or_uuid`, or `slug`), `IsOrgAdminOrOwner`, `IsOrgOwner`, and `IsOrgMember` all return `True` for any authenticated user. This is documented as intentional for "resource-level views without an org slug," but it creates a silent bypass if any future org-scoped view is wired with an unrecognized kwarg name (e.g., `org_id` or `pk`). There is currently no enforcement that every view using these classes has a recognized kwarg. The comment says "object-level permission filters at the queryset layer" but there is no `has_object_permission` override in the class, so that filtering must be manually implemented in each such view — and there is no test to assert the fallback is safe.

**Recommendation:** Add an explicit allowlist of the recognized kwarg names to the docstring, or raise `ImproperlyConfigured` in non-production environments when org resolution returns `None` on a mutation verb (`POST`, `PATCH`, `PUT`, `DELETE`). Alternatively, flip the default to `False` (deny on resolution failure) and document which views intentionally rely on the pass-through. Also add `has_object_permission` to `_OrgMembershipPermission` that re-checks the membership against the instance's `organization` FK, making the class safe-by-default for both check levels.

**Confidence:** 0.95

---

### F-02 — HIGH: `OrgDetailView.PATCH` does not check `org.settings` module — co_organizer with deny override can still mutate name/time_zone

**File:** `backend/apps/organizations/views.py:198-220`

```python
def patch(self, request, slug_or_uuid: str):
    ...
    if not request.user.is_superuser:
        if not OrganizationMembership.objects.filter(
            user=request.user,
            organization=org,
            is_active=True,
            role=MembershipRole.ADMIN,
        ).exists():
            raise PermissionDenied("Admin role required.")
```

**Why it matters:** The module catalog (`modules.json:3-8`) declares `org.settings` as the module controlling "Org name, slug (locked post-publish), branding, timezone, public-page settings," with `default_for_roles: ["admin", "co_organizer"]`. v1Users.md §2 / invariant #12 states that module visibility governs surface access, and that a `MembershipModuleGrant` deny override must revoke access even for role defaults. The `PATCH` on org name/time_zone is the canonical `org.settings` write surface. The gate here is `role=ADMIN` only (role-level), skipping the module layer entirely. An admin with a `deny` grant on `org.settings` can still PATCH. Conversely, the check does not include co_organizer, which has the module by default — but that discrepancy may be intentional (owner-only write).

**Recommendation:** Add `HasModule("org.settings")` to `OrgDetailView`'s `permission_classes` (or check it inside `patch()`). This properly propagates the deny-override semantics. Decide whether co_organizer should be allowed to PATCH name/time_zone; if not, keep the current `role=ADMIN` role-level check and document the intentional narrowing from the module defaults.

**Confidence:** 0.88

---

### F-03 — MEDIUM: `OrgChangeSlugView` has no `org.settings` module check — mirrors F-02

**File:** `backend/apps/organizations/views.py:228-247`

```python
class OrgChangeSlugView(APIView):
    """POST /api/orgs/{uuid}:change_slug/"""
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]
```

**Why it matters:** Slug changes are a significant settings operation (old slug is redirected, branding URLs change). The `org.settings` module controls slug mutation per the catalog description ("slug (locked post-publish)"). Using only `IsOrgAdminOrOwner` omits the module deny-override path: an admin with an explicit `state=deny` on `org.settings` can still change the slug. Severity is medium (not high) because slug changes require the `ADMIN` role, so the population of affected users is small.

**Recommendation:** Add `HasModule("org.settings")` alongside `IsOrgAdminOrOwner`.

**Confidence:** 0.85

---

### F-04 — MEDIUM: No endpoint-level cross-org isolation tests for the organizations views

**File:** `backend/apps/organizations/tests/` — no test file asserts a 403 / 404 when user in Org X hits a verb URL targeting Org Y's UUID/slug.

**Why it matters:** CLAUDE.md invariant #2 states: "Every endpoint must be covered by a test that asserts user A in Org X cannot access org Y data." The existing tests in `test_slug_routes.py` and `test_org_constraints.py` only test happy-path (admin of the org gets 200). There are no negative path tests asserting that an authenticated user who is a member of Org X gets a 403 when they attempt `GET /api/orgs/{org_Y_uuid}/members/`, `POST /api/orgs/{org_Y_uuid}/invitations/`, `DELETE /api/orgs/{org_Y_uuid}:archive/`, etc. The `ScopedQuerySet` isolation tests (`test_scope_queryset.py`) cover the queryset layer but not the DRF view layer.

**Recommendation:** Add a parametrized test suite (e.g., `test_cross_org_isolation.py`) that for each mutating + sensitive-read org endpoint, asserts a `403` response when the caller holds only a membership in a *different* org. This is the canonical "multi-tenancy isolation test" called for by invariant #2.

**Confidence:** 0.97

---

### F-05 — LOW: `MyEffectiveModulesView` discloses the existence of any non-deleted organization to any authenticated user

**File:** `backend/apps/permissions/views.py:111-136`

```python
def get(self, request):
    ...
    org = Organization.objects.filter(id=org_uuid).first()
    if org is None:
        return Response({"detail": "Organization not found."}, status=404)
    modules = sorted(effective_modules(request.user, org))
    return Response({"modules": modules})
```

**Why it matters:** When the requesting user has no membership in the target org, `effective_modules` returns an empty frozenset and the view returns `{"modules": []}` with HTTP 200. A non-member can distinguish "org exists but I have no modules" (200 + empty list) from "org does not exist" (404) by UUID-probing. This is an organization-existence oracle. It is low severity because UUIDs are v7 (opaque, not guessable), and the information leak is org existence only, not any content.

**Recommendation:** After resolving the org, verify the requesting user has at least one active membership (or is superuser). If not, return 404 to match the access-denied shape for non-members. This collapses the "exists but no access" and "does not exist" cases, eliminating the oracle.

**Confidence:** 0.82

---

## Gaps (forward-looking, not regressions)

### G-01 — Password re-prompt / sudo gate for sensitive verbs

**Missing:** No `password_reprompt`, `re_authenticate`, or sudo-session check exists anywhere in `backend/apps/`. Sensitive verbs (`transfer_ownership`, `archive`, `change_slug`, grant-override PUT) execute immediately on a valid authenticated session with no additional identity proof.
**Current state:** Spec does not mandate a specific session-age check, and the accounts agent's `cycle_session_on_role_change` stub is the only session-security hook present (invite-accept only).
**Needed for:** Phase 1B / security hardening. v1Users.md §1.8 defers this; it is not a regression.
**Effort:** M
**Blocking:** No

---

### G-02 — Cross-worker cache invalidation for effective_modules

**Missing:** `backend/apps/permissions/services/resolver.py:47-50` has a documented TODO: cross-worker Redis pub/sub invalidation of the `effective_modules:{user}:{org}` cache key is deferred to Phase 1B. In a single-worker dev environment (locmem cache) this is safe. In production (multi-worker ASGI + Redis cache), a grant change in worker A will not be seen by worker B for up to 5 minutes.
**Current state:** Comment in `resolver.py` and `grants.py` explicitly notes this.
**Needed for:** Production deploy (Phase 1B live transport milestone).
**Effort:** S
**Blocking:** No (Phase 1A is single-process safe)

---

### G-03 — No endpoint for org-level role-change (PATCH membership.role)

**Missing:** There is no `PATCH /api/orgs/{uuid}/members/{membership_id}/` endpoint to change an existing member's role. Invite + remove is the only supported workflow. An admin who wants to promote a co_organizer to admin must invite them again (which the unique-pending-invite constraint may block if they already have a different active invitation), or directly manipulate the DB.
**Current state:** Invitation flow only.
**Needed for:** Full member management UX.
**Effort:** M
**Blocking:** No

---

### G-04 — `approve_org` / `reject_org` service functions have no DRF endpoint

**Missing:** `backend/apps/organizations/services/lifecycle.py:84-144` implements `approve_org` and `reject_org` but there is no corresponding URL route in `backend/apps/organizations/urls.py`. These are only reachable via the sadmin console (`backend/apps/sadmin/views/orgs.py`), which is correct for the super-admin workflow, but means there is no machine-readable API for automated approval flows (e.g., webhook-triggered onboarding).
**Current state:** Sadmin-only, HTML views.
**Needed for:** Phase 1B self-serve org creation (locked product decision: "self-serve signup, NO super-admin approval gate").
**Effort:** M
**Blocking:** Phase 1B self-serve tournament workflow depends on resolving this.

---

### G-05 — No `org.settings` module endpoint for PATCH (SPA surface gating)

**Missing:** The SPA module-gating pattern (invariant #12) requires that PATCH name/time_zone checks `org.settings`. As noted in F-02, this check is absent. Even if F-02 is fixed at the view layer, the SPA will also need to know whether the user has `org.settings` in their effective set to render the edit controls — this is handled correctly by `MyEffectiveModulesView`, so the SPA side is fine once F-02 is resolved.
**Current state:** F-02 covers the server-side gap; this gap entry tracks the documentation/test coverage aspect.
**Effort:** S (depends on F-02 fix)
**Blocking:** No
