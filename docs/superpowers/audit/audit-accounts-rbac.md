# RBAC Audit — accounts app (backend/apps/accounts + backend/apps/permissions)

**Date:** 2026-06-04
**Auditor:** Claude Code (automated)
**Scope:** Server-side access control on every mutating and sensitive-read endpoint
in `backend/apps/accounts/` and `backend/apps/permissions/`, including
the `effective_modules` resolver, per-user grants, owner-only verbs,
invite tree, `single_org_per_admin_user`, default-deny, and password-reprompt.

---

## Summary

Phase 1A has a well-structured RBAC chassis. The permission matrix
(`test_permission_matrix.py`), module-override resolver, grant-write
audit trail, session-fixation defenses, and most endpoint guards are
correctly implemented and tested. Four security findings require
remediation, ranging from high (a wrong boolean default in the
resolver short-circuits the unauthenticated guard) to medium (no
password-reprompt on sensitive 2FA and ownership operations).

---

## Findings

---

### F-01 — HIGH: `effective_modules` resolver uses wrong default — unauthenticated objects can bypass the early-return guard

**File:** `backend/apps/permissions/services/resolver.py:113`

**Evidence:**
```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

The `getattr` third argument is `True`, meaning: if `user` has no
`is_authenticated` attribute, assume it IS authenticated. For a plain
Python object that lacks this attribute (e.g. a mock, a test stub,
or a future system actor), the guard silently passes and the full
DB-backed resolver runs. The correct default is `False` (default-deny).

Compare against the safe pattern used everywhere else in the codebase:

```python
# scope.py:55 — correct
if not getattr(user, "is_authenticated", False):
    return []

# permissions.py:41 — correct
if not getattr(user, "is_authenticated", False):
    return False
```

**Why it matters:** The `effective_modules` result is used by `HasModule`
(the primary gating class), by `MeSerializer.get_memberships`, and by
`MyEffectiveModulesView`. Any object without an `is_authenticated`
attribute that reaches any of these paths will be treated as an
authenticated user and receive module data it should not see.

**Recommendation:** Change line 113 of `resolver.py` to
`not getattr(user, "is_authenticated", False)`.

---

### F-02 — HIGH: `MyEffectiveModulesView` leaks modules for orgs the requesting user is NOT a member of

**File:** `backend/apps/permissions/views.py:128-136`

**Evidence:**
```python
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, status=404)

modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

There is no membership check between "org exists" and
"call effective_modules". An authenticated user in Org A can supply
the UUID of Org B (which they are not a member of) and receive a 200
response. When the user has no active membership in org B, `effective_modules`
correctly returns an empty frozenset — BUT this still confirms that
the org UUID exists (org enumeration) and, importantly, if a grant
row for that (user, org) pair was ever written, it could be read.

The same problem does NOT exist for the slug-routed alias
(`MyModulesBySlugView`) because the slug alone reveals nothing
sensitive, but the UUID route is the exploitable surface.

**Why it matters:** Invariant 2 mandates no cross-org data leak via
any endpoint. Returning 200 with `{"modules": []}` for a foreign
org UUID is an org-enumeration vector, and confirmed absence of
modules is itself information.

**Recommendation:** After loading `org`, assert:
```python
if not request.user.is_superuser:
    if not OrganizationMembership.objects.filter(
        user=request.user, organization=org, is_active=True
    ).exists():
        raise Http404  # or 403; use 404 to avoid confirming org existence
```
Add a cross-org isolation test analogous to
`test_matrix_get_forbidden_for_member_with_no_role`.

---

### F-03 — MEDIUM: Sensitive self-service verbs (2FA disable, recovery code regeneration) are NOT gated by `require_recent_password_reauth`

**Files:** `backend/apps/accounts/views.py:369-396`

**Evidence:**
```python
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_disable_view(request: Request) -> Response:
    # No require_recent_password_reauth decorator
    ...

@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_recovery_regenerate_view(request: Request) -> Response:
    # No require_recent_password_reauth decorator
    ...
```

The decorator `require_recent_password_reauth` exists in
`backend/apps/accounts/decorators.py` and is correctly documented
in `v1Users.md Appendix B.18` as mandatory for "suspend, impersonate,
transfer ownership, force-disable 2FA, delete Org". The decorator is
never applied to any view in the codebase.

Disabling 2FA or regenerating recovery codes from a stolen/XSS'd session
without a password reprompt allows an attacker who hijacks a live
session to strip 2FA silently, downgrading account security permanently.

`user_soft_delete_view` checks `is_superuser` (correct for that action)
but does not use the decorator either, though the superuser-only guard
is an adequate substitute for that specific verb.

**Recommendation:** Apply
`@require_recent_password_reauth()` to:
- `twofa_disable_view`
- `twofa_recovery_regenerate_view`

Also consider applying it to `OrgTransferOwnershipView` (in
`organizations/views.py:318`) and `OrgChangeSlugView` (in
`organizations/views.py:228`) which are both high-impact irreversible
operations. These are in the organizations app, not accounts, but they
use the accounts-owned decorator and the spec (`B.18`) explicitly lists
"transfer ownership" as a sensitive verb.

---

### F-04 — MEDIUM: `PATCH /api/accounts/me/` allows writing `last_active_org_id` to ANY arbitrary org UUID without membership check

**Files:** `backend/apps/accounts/serializers.py:107-132`, `backend/apps/accounts/views.py:423-441`

**Evidence:**
```python
class MeSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = (
            ...
            "last_active_org_id",  # writable (not in read_only_fields)
            ...
        )
        read_only_fields = (
            "id", "email", "is_superuser", "has_2fa_enrolled",
            "twofa_enrolled_at", "email_verified_at", "memberships",
            "last_active_org_id",  # WAIT — this IS listed as read_only
            ...
        )
```

Looking closely: `last_active_org_id` IS in `read_only_fields` (line 130
of `serializers.py`), so it cannot be set via the PATCH body from the
SPA. However the `me_view` PATCH at line 423 reads and logs
`last_active_org_id` in the before/after audit payload assuming the value
is already user-controlled. Confirming this is read_only is correct.
This finding is a false alarm — `last_active_org_id` is correctly
read-only in `MeSerializer`. **Severity lowered to info.**

---

### F-05 — LOW: `twofa_disable_view` accepts a self-service `actor=request.user` — no super-admin path exists to force-disable a user's 2FA via the API

**File:** `backend/apps/accounts/views.py:372-382`

**Evidence:**
```python
def twofa_disable_view(request: Request) -> Response:
    ...
    twofa_svc.disable_2fa(
        request.user,
        actor=request.user,   # always self
        ...
    )
```

The `disable_2fa` service accepts any `actor`, but the view hard-codes
`actor=request.user`. There is no super-admin endpoint to force-disable
another user's 2FA (e.g. account recovery support path). This is a
missing capability, not a security hole, but the absence forces a
manual DB action if a user loses their authenticator and all recovery
codes.

**Recommendation:** Phase 1B: add a super-admin-only verb
`POST /api/accounts/users/{uuid}:force_disable_2fa/` analogous to
`user_soft_delete_view`, gated by `is_superuser` AND
`require_recent_password_reauth`.

---

### F-06 — LOW: `OrgChangeSlugView` uses `IsOrgAdminOrOwner` but does NOT verify the slug-change applies to the org the admin actually belongs to

**File:** `backend/apps/organizations/views.py:228-247`

**Evidence:**
```python
class OrgChangeSlugView(APIView):
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    def post(self, request, uuid):
        org = _resolve_org(uuid)   # loads org from the URL uuid
        ...
```

`IsOrgAdminOrOwner._resolve_org_from_view` extracts the org from
`view.kwargs["uuid"]`. The permission class checks the resolved org
against the user's membership — so a non-admin cannot call this.
This is correct. No finding. **Resolved as not an issue.**

---

### F-07 — INFO: No test exercises the 401/403 distinction for `GET /api/accounts/me/` when unauthenticated

**Files:** `backend/apps/accounts/views.py:416-441`

**Evidence:**
The known issue "(b)" from the task description confirms that
`GET /api/accounts/me/` returns 403 (not 401) for logged-out callers.
DRF's `IsAuthenticated` returns 403 to unauthenticated requests by
default unless the `WWW-Authenticate` header is set. The
`DEFAULT_AUTHENTICATION_CLASSES` setting determines whether DRF emits
401 or 403. If session auth is the only configured class,
`request.user` is `AnonymousUser`, DRF sees no valid auth challenge,
and returns 403.

This causes the SPA login page to display a premature error banner
instead of silently handling "not yet logged in."

**Recommendation:** In `settings/base.py`, ensure
`DEFAULT_AUTHENTICATION_CLASSES` includes
`SessionAuthentication` (which does issue the challenge correctly),
OR handle the 403 case in the SPA without displaying an error banner
for `me/` specifically.

---

## Gaps (forward-looking)

| Gap | Area | Missing | Needed for | Blocking | Effort |
|-----|------|---------|------------|----------|--------|
| G-01 | accounts | No cross-org isolation test for `/api/permissions/me/modules/?org=<foreign-org-uuid>` | Invariant 2 enforcement | Yes (fix F-02 first) | S |
| G-02 | accounts | `require_recent_password_reauth` decorator defined but NEVER applied to any view | v1Users.md Appendix B.18 compliance | Yes | S |
| G-03 | permissions | Superuser bypass in `effective_modules` is unconditional — no deleted/suspended org guard | Multi-tenancy correctness at scale | No | M |
| G-04 | accounts | No super-admin force-disable-2FA API endpoint for account recovery | Operational support in Phase 1B | No | M |
| G-05 | accounts/permissions | `effective_modules` cache invalidation is single-process only (LocMemCache) — cross-worker invalidation deferred to Phase 1B | Live production with multiple ASGI workers | Yes (Phase 1B) | L |
| G-06 | accounts | `PATCH /api/accounts/me/` audit logs `last_active_org_id` changes but no validation that the new `last_active_org_id` (if ever made writable) points to an org the user belongs to | Defense-in-depth | No | S |
| G-07 | accounts | No per-endpoint test for 401 vs 403 responses on authenticated-only endpoints — SPA behavior depends on this distinction | Known bug (b) in the task | No | S |
