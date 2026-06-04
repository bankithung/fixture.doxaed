# Security Audit: backend/apps/permissions

**Date:** 2026-06-04
**Auditor:** Claude Code (Sonnet 4.6)
**Scope:** `backend/apps/permissions/` — broken access control/IDOR, injection, hardcoded secrets, weak crypto, auth/session flaws, CSRF gaps, DRF mass-assignment / over-exposed fields, SSRF, missing rate limits, 404-vs-403 info leak, token entropy/hashing.

---

## Findings

---

### FINDING 1 — CRITICAL: Wrong default in `is_authenticated` guard (`effective_modules`)

**File:** `backend/apps/permissions/services/resolver.py:113`

**Evidence:**
```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

**Why it matters:**
The `getattr` default is `True`, not `False`. This guard is intended to return early (empty frozenset) for unauthenticated users. But `getattr(user, "is_authenticated", True)` means: if the `user` object lacks an `is_authenticated` attribute, assume `True` (authenticated). The condition then becomes `not True` = `False`, so the early-return is *skipped*. A crafted object (or edge-case anonymous user type) that lacks `is_authenticated` will be treated as authenticated and the resolver will proceed to query DB for their modules.

Compare with the correct default used everywhere else in the codebase:
- `permissions.py:41` — `getattr(user, "is_authenticated", False)` ✓
- `scope.py:55` — `getattr(user, "is_authenticated", False)` ✓
- `scope.py:70,89` — `getattr(user, "is_authenticated", False)` ✓
- `organizations/permissions.py:80` — `getattr(user, "is_authenticated", False)` ✓

This is a copy-paste mistake. The `effective_modules` resolver is called from `has_module`, which is called from `HasModule` DRF permission — but `HasModule.has_permission` already guards authentication at line 41 before calling `has_module`. However, `effective_modules` is also called directly from views (`MyEffectiveModulesView`, `UserGrantsView`) and test code, making this a latent defect with exploitable paths if `effective_modules` is ever called with a non-standard user object.

**Recommendation:** Change `True` to `False`:
```python
if user is None or not getattr(user, "is_authenticated", False):
    return frozenset()
```

---

### FINDING 2 — HIGH: IDOR — Admin can grant module overrides to any platform user not in their org

**File:** `backend/apps/permissions/views.py:161-165, 210-246`

**Evidence:**
```python
def get_target_user(self):
    from apps.accounts.models import User
    user_uuid = self.kwargs.get("user_uuid")
    return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
```

The `get_target_user()` method resolves `user_uuid` directly from the platform `User` table with no check that the target user holds an active `OrganizationMembership` in the org whose URL is in the path. In `PUT /api/permissions/orgs/{org_uuid}/users/{user_uuid}/grants/`, the admin's permission is correctly scoped to the org (via `IsOrgAdminOrOwner` → `_OrgMembershipPermission` checks admin membership in `org_uuid`), but nothing prevents the admin from supplying a `user_uuid` belonging to a user who has never joined that org.

Impact:
1. The PUT path calls `bulk_set_grants(user=target_user, organization=org, ...)` which creates `MembershipModuleGrant` rows for `(platform_user_X, org_A)` even though that user has no `OrganizationMembership` in org A. These orphaned grant rows pollute the permissions table and would take effect the moment that user is later invited to the org — bypassing the normal grant workflow.
2. The GET path leaks `effective_modules` for any platform user (returns empty set if not a member, but confirms the UUID is a valid user by returning 200 vs 404).

**Recommendation:** Add a membership existence check before proceeding:
```python
# In get() and put(), after resolving org and target_user:
from apps.organizations.models import OrganizationMembership
if not OrganizationMembership.objects.filter(
    user=target_user, organization=org, is_active=True
).exists():
    return Response(
        {"detail": "User is not an active member of this organization."},
        status=status.HTTP_404_NOT_FOUND,
    )
```

---

### FINDING 3 — HIGH: Org existence oracle via `MyEffectiveModulesView` (no membership gate + soft-delete bypass)

**File:** `backend/apps/permissions/views.py:128`

**Evidence:**
```python
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, status=status.HTTP_404_NOT_FOUND)
modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

Two issues:
1. The query at line 128 omits `deleted_at__isnull=True`. A soft-deleted org will return 200 with an empty module list rather than 404. An attacker can distinguish "org exists but deleted" (200, empty modules) from "org never existed" (404). The slug-alias helper `_resolve_org_by_slug_or_uuid` correctly filters `deleted_at__isnull=True`; the UUID path in `MyEffectiveModulesView` does not.
2. There is no org-membership gate. Any authenticated user can query effective modules for any org UUID and receive 200 with an empty list (if not a member) vs 200 with populated modules (if a member). This confirms org UUID existence to non-members and leaks membership status via the non-empty module list.

The slug-based `MyModulesBySlugView` correctly returns 404 for missing/deleted orgs (via `_resolve_org_by_slug_or_uuid`) but then also lacks a membership gate.

**Recommendation:**
- Add `deleted_at__isnull=True` to the UUID path query.
- Optionally add a membership check returning 404 if the caller has no active membership (convert 200-empty-modules to 404-not-found for non-members to prevent org enumeration).

---

### FINDING 4 — MEDIUM: `GrantRowSerializer` leaks granting admin UUID

**File:** `backend/apps/permissions/serializers.py:30`

**Evidence:**
```python
fields = [
    "id",
    "module_code",
    "state",
    "reason",
    "granted_by",       # FK → User UUID exposed
    "created_at",
    "updated_at",
]
```

The `granted_by` field is a raw FK serialized as the granting admin's UUID. This field is returned in:
- `GET /api/permissions/orgs/{org}/users/{user_uuid}/grants/` (readable by all admins of the org)
- The `PUT` response for the same endpoint

While the endpoint is admin-only, exposing the raw UUID of the administrator who issued each grant lets any admin enumerate which other admin accounts are active and who issued which grants. In a future multi-org scenario this could cross org boundaries.

**Recommendation:** Serialize as `granted_by_email` (truncated) or omit from the API response entirely — the audit log already records this information with full context.

---

### FINDING 5 — MEDIUM: `IsOrgAdminOrOwner` fall-through returns `True` when no org is resolvable

**File:** `backend/apps/organizations/permissions.py:85-89`

**Evidence:**
```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

When `_resolve_org_from_view` returns `None` (org not found in kwargs), the permission check returns `True` — granting access. This is documented as intentional for "resource-level views", but it creates a class of views where a stale or invalid org slug/UUID in the URL bypasses admin enforcement. In the permissions app specifically, if `UserGrantsView.get_organization()` returned `None` (e.g. malformed UUID), the view itself returns 404 — but the permission check has already returned `True`, meaning authentication succeeded. This ordering dependency is fragile.

**Recommendation:** Consider changing the `org is None` branch to return `False` (deny) and instead explicitly whitelist the small number of resource-level views that genuinely need no org context. Alternatively, document which views rely on this fallthrough and add a test asserting the behavior.

---

### FINDING 6 — MEDIUM: `ModuleCatalogView` exposes `default_for_roles` to all authenticated users

**File:** `backend/apps/permissions/views.py:73-88`, `serializers.py:14`

**Evidence:**
```python
class ModuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Module
        fields = ["id", "code", "name", "description", "category", "default_for_roles"]
        read_only_fields = fields
```

`GET /api/permissions/modules/` is accessible to any authenticated user (even a `referee` or `team_manager` with no admin role). The response includes `default_for_roles` for all 22 modules. This reveals the platform's full RBAC role-to-module mapping to every logged-in user, allowing reconnaissance for privilege escalation paths.

**Recommendation:** Restrict `ModuleCatalogView` to `IsOrgAdminOrOwner` (consistent with the matrix endpoint that also shows role defaults), or strip `default_for_roles` from the response for non-admin users.

---

### FINDING 7 — MEDIUM: Stale cache can grant elevated permissions for up to 5 minutes after revocation

**File:** `backend/apps/permissions/services/resolver.py:33-50`

**Evidence:**
```python
CACHE_TTL_SECONDS = 300  # 5 minutes
# ...
# TODO (Appendix B.3): publish to Redis pub/sub channel
# `effective_modules_invalidate` so other ASGI workers also drop
# their local-mem cache. Phase 1A is single-process safe via the
# shared backend; cross-worker invalidation lands in Phase 1B.
```

Cache invalidation at `grants.py:111` calls `invalidate_cache(user.id, organization.id)` which only clears the local process cache. When deployed behind multiple ASGI workers (Daphne/uvicorn), each worker has its own `LocMemCache`. A grant revocation by one worker will not be visible to other workers for up to 5 minutes. This means a user whose `state=deny` grant was just written could still pass `has_module()` checks on other workers.

In production this should be Redis-backed cache (mitigating the inter-worker issue) but the Phase 1B TODO means the gap exists and could reach production if the LocMemCache backend is not swapped before go-live.

**Recommendation:** Prioritize the Phase 1B Redis pub/sub invalidation path. As a short-term mitigation, reduce `CACHE_TTL_SECONDS` for grant-sensitive operations, or use a shorter TTL specifically for deny overrides.

---

### FINDING 8 — MEDIUM: No rate limiting on grant-mutation endpoints

**File:** `backend/apps/permissions/views.py:150, 354`

**Evidence:**
The base `REST_FRAMEWORK` settings apply `AnonRateThrottle` (60/min) and `UserRateThrottle` (240/min) globally. No `throttle_classes` or `throttle_scope` is defined on `UserGrantsView`, `UserGrantsBySlugView`, or `MatrixView`. An admin could programmatically call `PUT /grants/` in rapid succession, flooding the audit table with spurious audit rows and triggering the `_resolve_module` DB lookup for every module code in each call.

**Recommendation:** Add a tighter scope throttle for grant mutation:
```python
throttle_classes = [ScopedRateThrottle]
throttle_scope = "grant_mutation"  # e.g., "10/min" in DEFAULT_THROTTLE_RATES
```

---

### FINDING 9 — LOW: `HTTP_X_FORWARDED_FOR` not validated — IP address spoofing in audit log

**File:** `backend/apps/audit/services.py:54`

**Evidence:**
```python
ip = (
    request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    or request.META.get("REMOTE_ADDR", "")
)
```

`HTTP_X_FORWARDED_FOR` is a client-controlled header. Any authenticated user can send `X-Forwarded-For: 127.0.0.1` and have that recorded as their IP in the audit log for every grant change. This undermines forensic investigations since the recorded IP becomes untrusted.

**Recommendation:** Trust `X-Forwarded-For` only when requests arrive via a trusted reverse proxy. Use Django's `IPWARE` library or `django-ipware` with `TRUSTED_PROXIES` / `NUM_PROXIES` settings, or use `REMOTE_ADDR` only and configure the proxy to strip/override `X-Forwarded-For`.

---

### FINDING 10 — LOW: `event_id` accepted but silently ignored in `BulkGrantsCellsSerializer`

**File:** `backend/apps/permissions/serializers.py:108-110`

**Evidence:**
```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```

The `event_id` field is documented in the API and accepted by the serializer, but no deduplication is performed. A client retrying a `PUT /grants/` with the same `event_id` will re-execute the full `bulk_set_grants` call. The existing state-comparison in `bulk_set_grants` (`if prior_state == state: continue`) makes most retries safe, but this diverges from the architectural invariant (§3) that promises idempotency via `event_id`.

**Recommendation:** Document the gap clearly (already done in a code comment) and treat it as a Phase 1B blocker. In Phase 1B, wire `event_id` into a deduplication table before applying grants.

---

### FINDING 11 — INFO: No cross-org IDOR tests for `UserGrantsView`

**File:** `backend/apps/permissions/tests/test_matrix.py`

**Evidence:**
The test suite (test_matrix.py lines 273-362) tests that non-admin roles are rejected. There is no test asserting that an admin in Org A cannot PUT grants targeting a user in Org B (FINDING 2 above), and no test confirming that supplying a `user_uuid` of a non-member returns an error. The IDOR in FINDING 2 would not be caught by the current suite.

**Recommendation:** Add parametrized cross-org isolation tests for the grants endpoints:
```python
def test_grants_put_rejects_non_member_target_user(...)
def test_grants_get_rejects_non_member_target_user(...)
def test_admin_org_a_cannot_put_grants_in_org_b(...)
```

---

## Gaps (Forward-Looking)

| Item | Missing | Current State | Needed For | Effort | Blocking? |
|------|---------|---------------|-----------|--------|-----------|
| Redis cache invalidation | Cross-worker `effective_modules` invalidation via pub/sub (Appendix B.3) | TODO comment; LocMemCache in prod would serialize revocations stale | Correct revocation under multiple ASGI workers | M | Yes (prod) |
| `event_id` idempotency for bulk grants | Deduplication table lookup in `bulk_set_grants` | `event_id` accepted, silently ignored | Architectural invariant §3 | M | No (Phase 1B) |
| Membership check on grant target user | Verify `target_user` is an active member of `org` before GET/PUT grants | Not present | IDOR fix (FINDING 2) | S | Yes |
| `deleted_at` filter in `MyEffectiveModulesView` | Add `deleted_at__isnull=True` to UUID-path query | Missing (slug path handles it correctly) | Consistent soft-delete behavior | S | Yes |
| Non-member gate on `me/modules/` | Verify caller has active membership before returning 200 | Returns 200 with empty modules for non-members | Prevent org enumeration | S | No |
| Tighter throttle on grant mutation | Per-endpoint `throttle_scope` | Global `UserRateThrottle` 240/min only | Protect audit table and DB from bulk abuse | S | No |
| Trusted proxy configuration | `IPWARE`/`NUM_PROXIES` setting | Raw `X-Forwarded-For` | Reliable IP audit trails | S | No |
| Cross-org isolation tests for `UserGrantsView` | Test that admin in Org A cannot target user/org B | Not present | Confidence in IDOR remediation | S | Yes |
