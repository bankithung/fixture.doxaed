# Adversarial Verify A — Permissions cross-org endpoint isolation tests

**Finding (as received):**
- severity: high
- area: permissions tests
- file: `backend/apps/permissions/tests/test_matrix.py:1`
- title: No cross-org endpoint isolation tests for `UserGrantsView` GET/PUT or `MatrixView`
- evidence: "Missing Test Coverage: No cross-org endpoint isolation tests for UserGrantsView GET/PUT or MatrixView"

**Verdict: REAL (test-coverage gap), severity downgraded high → medium.**
**Confidence: 0.85**

---

## What the code actually shows

### 1. The views exist and are admin-gated
`backend/apps/permissions/views.py`:
- `UserGrantsView(APIView)` (L139) — `permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]` (L150). GET (L171) + PUT (L210). Org resolved from `org_uuid` kwarg (L152-159).
- `UserGrantsBySlugView(UserGrantsView)` (L303) — slug-routed alias, resolves org from `slug` kwarg (L311-316).
- `MatrixView(APIView)` (L340) — `permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]` (L354). GET (L367).

### 2. The gate DOES enforce cross-org isolation at runtime
`backend/apps/organizations/permissions.py`:
- `IsOrgAdminOrOwner` (L108) inherits `_OrgMembershipPermission.has_permission` (L78-99).
- It resolves the org from the URL kwargs (`_resolve_org_from_view`, L28-66) and checks
  `OrganizationMembership.objects.filter(user=user, organization=org, is_active=True, role__in=(ADMIN,)).exists()` (L91-99).
- Therefore an admin of Org A hitting Org B's endpoint has **no** admin membership in Org B → `exists()` is False → 403.
- **The implementation is not vulnerable.** This is why severity is downgraded from high to medium: the finding is a coverage gap, not a live cross-org leak.

### 3. The endpoint-level tests that DO exist (all single-org)
`backend/apps/permissions/tests/test_matrix.py` — every HTTP test uses one org (`slug="acme"`/`"closed"`). Negative-access tests:
- `test_matrix_get_forbidden_for_non_admin_roles` (L283-295) — non-admin role **in the same org** → 403.
- `test_matrix_get_forbidden_for_member_with_no_role` (L305-310) — outsider with **NO membership at all** → 403.
- `test_user_grants_get_forbidden_for_non_admin_with_member_directory` (L320-336) — non-admin actor + target **in the same org** → 403.
- `test_user_grants_put_forbidden_for_co_organizer` (L339-362) — co-organizer actor + target **in the same org** → 403.

None of these create a **second org** and assert that an admin/member of Org A is denied on Org B's `grants/`, `grants/matrix/`, or `users/{uuid}/grants/` endpoint. The no-membership outsider test (L305) is the closest, but a true outsider is a distinct path from "admin of a *different* org" — the latter passes the `is_authenticated` + admin-role checks for *their own* org and is the realistic privilege-escalation vector.

### 4. The cross-org tests that exist are at the WRONG layer
Cross-org isolation tests in the permissions suite operate on the manager/queryset layer, not the HTTP endpoint layer:
- `test_scope_queryset.py` (L40-66) — `ScopedQuerySet` org_x vs org_y filtering.
- `test_module_gated_queryset.py` (L26-74) — `module_gated` org_x vs org_y filtering.
These never exercise `UserGrantsView` / `MatrixView` over HTTP.

### 5. Minor correction to the finding's framing
The finding names `UserGrantsView` (the UUID-routed base view). The endpoint tests in `test_matrix.py` target `UserGrantsBySlugView` (slug variant) and `MatrixView`. The UUID-routed `UserGrantsView` GET is touched only once on a **positive** admin path (L407-410, inside `test_slug_alias_resolves_to_existing_uuid_logic`); its PUT and all cross-org negative paths are entirely untested. This strengthens the gap rather than weakening it.

## Why this matters (project invariants)
- Architectural invariant #2: "CI tests assert no cross-org leak via **any** DRF / SSE / WebSocket endpoint."
- CLAUDE.md: "Every endpoint must be covered by a test that asserts user A in Org X cannot access org Y data."
- These two override-management endpoints (per-user module grants + aggregate matrix) are a security-sensitive surface and have no cross-org endpoint test.

## Why medium, not high
The runtime behavior is correct (`IsOrgAdminOrOwner` is org-scoped via the URL). No exploitable leak exists today. This is a real, invariant-mandated test gap on a sensitive endpoint, so it is not low/info — but absent an actual vulnerability, high overstates it. **Medium.**

## Suggested fix
Add to `test_matrix.py`: create org_a + org_b, seat the actor as ADMIN in org_a only, then assert 403 on:
- `GET /api/permissions/orgs/{org_b.slug}/grants/matrix/`
- `GET` and `PUT /api/permissions/orgs/{org_b.slug}/users/{target_in_b.id}/grants/`
- the UUID-routed `GET`/`PUT /api/permissions/orgs/{org_b.id}/users/{target.id}/grants/`
