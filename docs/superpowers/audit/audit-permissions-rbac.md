# RBAC Audit — backend/apps/permissions + related surfaces

**Audit date:** 2026-06-04
**Scope:** Every mutating and sensitive-read endpoint for `apps/permissions`, `apps/organizations`, `apps/accounts`, `apps/audit`, and `apps/sadmin`, examined against the server-side RBAC gate (role/module checks, not SPA button hiding). Checks: `effective_modules` resolver correctness, per-user grant overrides, owner-only verbs, invite tree, `single_org_per_admin_user`, default-deny, and password-reprompt.

---

## Summary

The RBAC implementation is architecturally sound: the module-catalog resolver, the `HasModule` permission class factory, the `IsOrgAdminOrOwner`/`IsOrgOwner` role gates, and the `ScopedQuerySet` multi-tenancy helpers are all present and covered by parametrized tests. No findings of "endpoint with no gate at all" were discovered for existing Phase 1A surfaces.

**Three medium-to-high severity gaps found.** All relate to logic defects or missing enforcement rather than absent gates.

---

## Findings

### FINDING-1 — HIGH: `effective_modules()` auth guard uses wrong default — passes unauthenticated objects with `.is_authenticated` missing

**File:** `backend/apps/permissions/services/resolver.py:113`

**Evidence:**
```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

The default for `getattr(user, "is_authenticated", True)` is `True`. This means that if a non-standard user object is passed that **lacks** an `is_authenticated` attribute at all (e.g. a raw model instance, a mock, or a future service-account type), the guard evaluates `not True` → `False`, so it **does not** short-circuit and proceeds to look up active memberships for that object. The correct default is `False` (fail-closed). Every other guard in the codebase uses `False` as the default:

- `apps/permissions/scope.py:56`: `if not getattr(user, "is_authenticated", False)`
- `apps/organizations/permissions.py:79`: `if not getattr(user, "is_authenticated", False)`
- `apps/organizations/scope.py:44`: `if not getattr(user, "is_authenticated", False)`

Because the resolver is the root of the entire module-gate system — `HasModule` calls `has_module()` which calls `effective_modules()` — this is the fallback path for every `HasModule`-gated endpoint. DRF `IsAuthenticated` will catch unauthenticated HTTP sessions before the resolver is invoked in production, but the incorrect default creates a latent risk in any code path that calls `effective_modules()` directly without an outer auth guard (e.g. service-to-service calls, management commands, tests).

**Recommendation:** Change `True` to `False` on line 113:
```python
if user is None or not getattr(user, "is_authenticated", False):
```

**Confidence:** High.

---

### FINDING-2 — HIGH: `require_recent_password_reauth` decorator exists but is applied to ZERO sensitive endpoints

**File:** `backend/apps/accounts/decorators.py:23`

**Evidence:** The decorator is defined and fully implemented:
```python
def require_recent_password_reauth(within_minutes: int | None = None):
    """DRF view decorator. 403s with {"detail": "password_reauth_required"}
    if the session has no recent reauth marker within `within_minutes`
    (default `settings.SENSITIVE_REAUTH_WINDOW_MINUTES`).
    ...
    """
```

The docstring and the accounts app's CLAUDE.md note (Appendix B.18) state that "any sensitive verb (suspend, impersonate, transfer ownership, force-disable 2FA, delete Org) MUST re-prompt for password regardless of session age." Searching the entire backend reveals the decorator is imported and defined in `decorators.py` but never applied to any view:

```
grep require_recent_password_reauth → only backend/apps/accounts/decorators.py:23
```

The following endpoints are classified sensitive in v1Users.md Appendix B.18 and are **missing the password-reprompt gate**:

| Endpoint | View | Severity |
|---|---|---|
| `POST /api/orgs/{uuid}:transfer_ownership/` | `OrgTransferOwnershipView` | Critical |
| `POST /api/orgs/{slug}/ownership/transfer/` | `OwnershipTransferBySlugView` | Critical |
| `POST /api/orgs/{uuid}:archive/` | `OrgArchiveView` | High |
| `POST /api/accounts/auth/2fa/disable/` | `twofa_disable_view` | High |
| `POST /api/accounts/auth/2fa/recovery_codes:regenerate/` | `twofa_recovery_regenerate_view` | High |
| Sadmin `user_verb` → `impersonate_start` | `sadmin/views/users.py` | High |
| Sadmin `user_verb` → `force_logout_all` | `sadmin/views/users.py` | High |

The sadmin surface is additionally protected by `@superadmin_required`, but the API endpoints accessible to regular org admins/owners (ownership transfer, archive, 2FA disable) are entirely unprotected against a session-hijack or stolen session: a valid session cookie is sufficient to execute these irreversible actions.

**Recommendation:** Apply `@require_recent_password_reauth()()` to each of the sensitive API endpoint handlers listed above. Add the same gate to the sadmin `user_verb` view (defense-in-depth even though `@superadmin_required` is there). Add test coverage that asserts a 403 when `last_password_reauth` is absent or stale, and a 2xx when it is fresh.

**Confidence:** High.

---

### FINDING-3 — MEDIUM: `_OrgMembershipPermission.has_permission` returns `True` when org cannot be resolved from view kwargs

**File:** `backend/apps/organizations/permissions.py:86-89`

**Evidence:**
```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

When the resolver cannot find an org UUID/slug in `view.kwargs`, the permission class returns `True` unconditionally (for any authenticated user, including those in zero orgs). The comment acknowledges this is intentional for resource-level views, but it creates a systemic risk: any view that accidentally uses `IsOrgAdminOrOwner` without exposing the org identifier in its URL will silently pass all authenticated users through the role gate. The gate effectively becomes `IsAuthenticated` for those cases. At the current route inventory this is not exploited (every view that uses `IsOrgAdminOrOwner` does so with an org-bearing URL kwarg), but it is a latent foot-gun as Phase 1B adds more routes.

There is no test that verifies that a view with a mis-configured URL kwarg (e.g., no org arg) does NOT accidentally pass a non-admin user through.

**Recommendation:** Add a narrowing guard: if the view's class name (or a class attribute) indicates it should require an org and none could be resolved, return `False` instead of `True`. At minimum, add a `has_permission_without_org: bool = False` class attribute to `_OrgMembershipPermission` that subclasses can flip to the current `True` behavior only where truly needed. Also add a test that asserts `IsOrgAdminOrOwner` on a kwarg-less request returns 403 not 200.

**Confidence:** Medium (pattern is documented and intentional, but poses architectural risk for future routes).

---

### FINDING-4 — MEDIUM: `MyEffectiveModulesView` and `MyModulesBySlugView` do not verify requesting user is a member of the queried org

**Files:**
- `backend/apps/permissions/views.py:111-136` (`MyEffectiveModulesView`)
- `backend/apps/permissions/views.py:295-300` (`MyModulesBySlugView`)

**Evidence (MyEffectiveModulesView):**
```python
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, status=status.HTTP_404_NOT_FOUND)

modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

There is no membership check before calling `effective_modules`. Any authenticated user may query `GET /api/permissions/me/modules/?org=<any_valid_uuid>`. For a non-member the resolver returns `frozenset()` (correct, no data leaked). However:

1. **Org existence oracle:** A non-member can probe any org UUID and distinguish "org exists" (200 with `modules:[]`) from "org does not exist" (404). This is an information-disclosure vulnerability that leaks whether a UUID corresponds to an active organization.
2. **Same pattern in the slug alias** `MyModulesBySlugView` — probing `/api/permissions/orgs/{slug}/me/modules/` returns 200 for any valid slug even when the requester has no membership.

The correct behaviour is 404 (or 403) when the requesting user is not a member of the org.

**Recommendation:** After resolving the org, add:
```python
if not request.user.is_superuser:
    if not OrganizationMembership.objects.filter(
        user=request.user, organization=org, is_active=True
    ).exists():
        raise Http404  # do not reveal existence to non-members
```
Add a test: non-member probing a valid org UUID should get 404, not 200 with empty modules.

**Confidence:** High.

---

### FINDING-5 — LOW: `OrgArchiveView` does not use a dedicated permission class; role check is inlined in view body

**File:** `backend/apps/organizations/views.py:286-315`

**Evidence:**
```python
class OrgArchiveView(APIView):
    """Owner or super-admin only."""
    permission_classes = [IsAuthenticated]

    def post(self, request, uuid):
        org = _resolve_org(uuid)
        if not request.user.is_superuser:
            is_owner = OrganizationMembership.objects.filter(
                user=request.user,
                organization=org,
                is_active=True,
                role=MembershipRole.ADMIN,
                is_org_owner=True,
            ).exists()
            if not is_owner:
                raise PermissionDenied(...)
```

The role check is correct (only `is_org_owner=True` passes), but it is performed inside the handler body rather than in `permission_classes`. DRF calls `permission_classes` at the class level, so OPTIONS requests or other HTTP methods bypass the inline check. More importantly, this pattern is inconsistent with all other admin-gated views (which use `IsOrgOwner`) and is harder to audit/test.

**Recommendation:** Add `IsOrgOwner` to `permission_classes` and remove the inline check, mirroring `OrgTransferOwnershipView`. This also enables DRF's OPTIONS response to correctly reflect that the endpoint requires authentication, rather than just `IsAuthenticated`.

**Confidence:** High (logic is correct but fragile and inconsistent).

---

### FINDING-6 — LOW: Bulk-grant `event_id` idempotency is accepted but ignored

**File:** `backend/apps/permissions/serializers.py:109-110`

**Evidence:**
```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```

The `BulkGrantsCellsSerializer` accepts an `event_id` field and the API docs suggest it provides idempotent write behaviour (Invariant 3 from CLAUDE.md). However, the service layer (`bulk_set_grants`) does not check or enforce idempotency against this field. A client that retries a failed PUT with the same `event_id` will execute the write a second time if the first partially succeeded.

This is a documented Phase 1A deferral, not a defect, but it violates the architectural invariant "replay returns 200 not 201" for this endpoint class.

**Recommendation:** Track this as a Phase 1B issue. The workaround (a second PUT is idempotent at the state level because setting `grant` again on an already-`grant` row is a no-op) partially mitigates the risk, but it does not prevent duplicate audit rows. Document the duplicate-audit risk explicitly.

**Confidence:** High.

---

### FINDING-7 — INFO: Cross-worker cache invalidation for `effective_modules` is deferred (Phase 1A single-process safe)

**File:** `backend/apps/permissions/services/resolver.py:42-50`

**Evidence:**
```python
def invalidate_cache(user_id: uuid.UUID, organization_id: uuid.UUID) -> None:
    """Drop the cache entry for (user, org).

    TODO (Appendix B.3): publish to Redis pub/sub channel
    `effective_modules_invalidate` so other ASGI workers also drop
    their local-mem cache. Phase 1A is single-process safe via the
    shared backend; cross-worker invalidation lands in Phase 1B.
    """
    cache.delete(cache_key(user_id, org_id))
```

In development (LocMemCache) or with a single ASGI worker, cache invalidation on grant-write is correct. In production with multiple ASGI workers and a shared Redis cache, invalidation is propagated because Django's Redis cache backend is centralized. However, if the cache backend is later changed to a per-worker in-memory layer, stale permissions could persist for up to 5 minutes after a grant change. The comment and TODO are accurate.

**Recommendation:** Complete the Redis pub/sub invalidation in Phase 1B before horizontal scaling. Until then, ensure `CACHES["default"]` always points to the shared Redis backend in production (not `LocMemCache`).

**Confidence:** High.

---

## Gaps (Forward-Looking)

| # | Gap | Missing | Needed For | Effort | Blocking |
|---|---|---|---|---|---|
| G-1 | No cross-org isolation tests for org-facing API endpoints | Per-endpoint assertion that user-in-org-X cannot read/mutate org-Y data via any slug/UUID endpoint | Invariant 2 compliance | M | No (Phase 1B) |
| G-2 | No password-reprompt (`require_recent_password_reauth`) applied to any endpoint | Wire decorator to ownership transfer, archive, 2FA disable, impersonation (Finding 2) | B.18 security invariant | S | Yes (Phase 1A gap) |
| G-3 | `effective_modules` unauthenticated object guard uses wrong default | Fix `getattr(user, "is_authenticated", True)` → `False` (Finding 1) | Defense-in-depth | S | Yes (Phase 1A gap) |
| G-4 | `MyEffectiveModulesView` membership guard missing | Non-members probe org existence | Information disclosure | S | Yes (Phase 1A gap) |
| G-5 | No parametrized endpoint-level cross-org isolation test suite | The scope.py comment says "CI tests assert no cross-org leak" but only `test_audit_list_view.py` has a single cross-org test | Invariant 2 compliance | L | No (Phase 1B) |
| G-6 | `event_id` idempotency for bulk-grants not implemented | Duplicate audit rows on retry | Invariant 3 | M | No (Phase 1B) |
| G-7 | Phase 1B RBAC extensions (TournamentMembership, per-tournament role matrix, module gates for match/live/dispute surfaces) are not yet designed | TournamentMembership model + tournament-scoped RBAC spec | Phase 1B | XL | No |
