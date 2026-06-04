# Permissions App — Test Gap Audit

**Date:** 2026-06-04
**Scope:** `backend/apps/permissions/` — missing cross-org isolation tests, permission-denied/negative tests, idempotent-replay tests, and untested error paths.
**Method:** Read all source files and every test file; findings are cited with file:line + quoted evidence.

---

## Findings

---

### F-01 — No unauthenticated-request tests for any HTTP endpoint
**Severity:** high
**Category:** permission-denied / negative

All five HTTP views (`ModuleCatalogView`, `MyEffectiveModulesView`, `MyModulesBySlugView`, `UserGrantsView`, `UserGrantsBySlugView`) are gated by `IsAuthenticated`, but no test ever calls any of them without credentials.

**Evidence — views.py:74, 92, 150, 278, 303** — every view carries:
```python
permission_classes = [IsAuthenticated]
```
**Evidence — test_matrix.py:46-48** — the only test helper always authenticates:
```python
def _api(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
```
No test creates a bare `APIClient()` (no `force_authenticate`) and asserts `401`.

**Why it matters:** If DRF's `DEFAULT_AUTHENTICATION_CLASSES` ever loses `SessionAuthentication` or the wrong `DEFAULT_PERMISSION_CLASSES` is set globally, unauthenticated callers could silently get data. The test suite would not catch this.

**Recommendation:** Add a parametrized negative test in `test_matrix.py` that creates a plain `APIClient()` without `force_authenticate` and asserts `HTTP 401` / `403` (DRF default is 403 when no credentials + `IsAuthenticated`; document the expected code) for every endpoint: `GET /modules/`, `GET /me/modules/`, `GET /orgs/{slug}/me/modules/`, `GET /orgs/{slug}/grants/matrix/`, `GET /orgs/{slug}/users/{uuid}/grants/`, `PUT /orgs/{slug}/users/{uuid}/grants/`.

---

### F-02 — Cross-org isolation: grants endpoint never tested against a user querying another org's data
**Severity:** critical
**Category:** cross-org isolation (invariant #2)

`UserGrantsView` and `UserGrantsBySlugView` (GET and PUT) accept `org_uuid`/`slug` and `user_uuid` as URL kwargs and fetch grants from the DB. There is no test in which:
- User A is a member of Org X (as admin), but requests grants for Org Y (where A has no membership).
- The expected result is `403`.

**Evidence — views.py:171-198** — the GET path:
```python
def get(self, request, org_uuid, user_uuid):
    org = self.get_organization()
    if org is None:
        return Response({"detail": "Organization not found."}, status=404)
    target_user = self.get_target_user()
    rows = MembershipModuleGrant.objects.filter(user=target_user, organization=org)
```
`get_organization()` resolves the org from the URL, but `IsOrgAdminOrOwner` gates on whether the caller is an admin of *that* org. If the caller is admin in Org X but not Org Y, the permission check should yield `403`. This logic is correct — but there is zero test asserting it.

**Evidence — test_matrix.py (entire file)** — every `UserGrantsView` test uses the same admin user for the same org. No test uses admin_of_org_x calling an endpoint for org_y.

**Why it matters:** Invariant #2 mandates isolation tests for every endpoint. This is the most security-critical gap in the permissions test suite. A future refactor of `IsOrgAdminOrOwner` or URL routing could silently open a cross-org data read.

**Recommendation:** Add to `test_matrix.py`:
```python
def test_user_grants_get_blocked_for_admin_of_different_org(loaded_modules):
    org_x = OrganizationFactory(slug="org-x")
    org_y = OrganizationFactory(slug="org-y")
    admin_x = UserFactory()
    OrganizationMembershipFactory(user=admin_x, organization=org_x,
                                   role=MembershipRole.ADMIN, is_org_owner=True)
    victim = UserFactory()
    OrganizationMembershipFactory(user=victim, organization=org_y,
                                   role=MembershipRole.TEAM_MANAGER)
    resp = _api(admin_x).get(
        f"/api/permissions/orgs/{org_y.slug}/users/{victim.id}/grants/")
    assert resp.status_code == 403
```
Mirror for PUT and for UUID-routed `UserGrantsView`.

---

### F-03 — Cross-org isolation: `MyEffectiveModulesView` / `MyModulesBySlugView` never tested for org the user does not belong to
**Severity:** high
**Category:** cross-org isolation (invariant #2)

Both views return the calling user's effective modules for an org specified in the query string / URL path. A user can supply any org UUID/slug and the endpoint will silently return an empty module list instead of `403`. No test asserts that a non-member querying a foreign org gets an appropriate error.

**Evidence — views.py:111-136** — `MyEffectiveModulesView.get`:
```python
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, status=404)
modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```
A user in Org X queries with `?org=<org_y_uuid>` → `effective_modules` returns `frozenset()` (no membership) → `200 {"modules": []}`. The empty response leaks the information that the org exists and the user has no modules there. No test covers this path.

**Why it matters:** The expected behavior is debatable (200 with empty set vs 403), but it is undocumented and untested. Invariant #2 isolation tests must cover this surface.

**Recommendation:** Decide and document whether non-members should get `200 []` or `403`, then write a test that asserts the chosen behavior. If `200 []` is intentional (it makes the "no modules" case indistinguishable from "unknown org"), document it explicitly; if `403` is intended, add the membership check to the view.

---

### F-04 — Cross-org isolation: `UserGrantsView` PUT never tests that a user in Org Y cannot have grants written by admin from Org X
**Severity:** critical
**Category:** cross-org isolation (invariant #2)

The PUT path of `UserGrantsView` passes `target_user` + `org` to `bulk_set_grants`. If `IsOrgAdminOrOwner` somehow resolves the wrong org or the slug lookup can be confused, an admin of Org X could write grants into Org Y. No test covers this scenario.

**Evidence — views.py:210-250** — PUT flow does not validate that `target_user` is actually a member of `org`; it just writes the grant:
```python
bulk_set_grants(user=target_user, organization=org, grants=grants_pairs, ...)
```
If `target_user` is a user in Org Y but the URL points to Org X, the grant gets written into Org X for a user who may not belong there. No test for this path.

**Recommendation:** Add a test asserting that PUT `/orgs/{org_x.slug}/users/{user_in_org_y.id}/grants/` returns `404` or `403` (target user not a member of the org). Also add the membership check to the view logic before calling `bulk_set_grants`.

---

### F-05 — `HasModule` permission class has no dedicated tests
**Severity:** high
**Category:** permission-denied / negative

`permissions.py` defines the `HasModule(module_code)` class factory. This factory has four code paths in `_resolve_organization`:
1. `view.get_organization()` — tested only indirectly.
2. `view.organization` attribute.
3. `view.kwargs["org_uuid"]` / `view.kwargs["organization_uuid"]`.
4. `request.org_context`.

None of these resolution paths are tested directly. There are also no tests for `HasModule` returning `False` (user lacks the module) vs `True` (user has it).

**Evidence — permissions.py:52-80** — four-path resolution:
```python
def _resolve_organization(self, request, view):
    if hasattr(view, "get_organization"):
        try:
            return view.get_organization()
        except Exception:
            return None
    if hasattr(view, "organization") and view.organization is not None:
        return view.organization
    kwargs = getattr(view, "kwargs", {}) or {}
    org_uuid = kwargs.get("org_uuid") or kwargs.get("organization_uuid")
    ...
    return getattr(request, "org_context", None)
```

**Why it matters:** `HasModule` is the primary permission gate for Phase 1B surfaces (tournament editor, bracket editor, scoring console). If `_resolve_organization` silently returns `None` in an edge case, `has_permission` returns `False` — denying all access. The opposite bug (returns `None` → falls through to `return False` — actually safe) but paths 2-4 are untested and path 3 has a silent `try/except Exception: return None` that swallows all resolution failures.

**Recommendation:** Add `test_has_module_permission.py` with:
- A view that sets `view.organization` and test that `HasModule("x")` allows/denies based on resolver result.
- A view that sets `view.kwargs["org_uuid"]` — same check.
- A test where `get_organization()` raises an exception — assert `has_permission` returns `False` (not 500).
- A test with an unauthenticated user — assert `False`.
- A test with `is_superuser=True` — assert `True` (bypass).

---

### F-06 — `bulk_set_grants` and `clear_grants` short-reason rejection not tested at service layer
**Severity:** medium
**Category:** error path

`test_grant_audit.py:59-72` tests `set_grant` with a short reason. But `bulk_set_grants` and `clear_grants` have identical `MIN_REASON_LEN` guards that are **never tested in the negative**.

**Evidence — grants.py:151-154** — `bulk_set_grants`:
```python
if not reason or len(reason.strip()) < MIN_REASON_LEN:
    raise GrantValidationError(
        f"Reason must be at least {MIN_REASON_LEN} characters (B.17)."
    )
```
**Evidence — grants.py:229-232** — `clear_grants`:
```python
if not reason or len(reason.strip()) < MIN_REASON_LEN:
    raise GrantValidationError(...)
```
Neither has a `pytest.raises(GrantValidationError)` test.

**Recommendation:** Add to `test_grant_audit.py`:
```python
def test_bulk_set_grants_rejects_short_reason(loaded_modules):
    ...
    with pytest.raises(GrantValidationError):
        bulk_set_grants(user=user, org=org, grants=[...], granted_by=admin, reason="short")

def test_clear_grants_rejects_short_reason(loaded_modules):
    ...
    with pytest.raises(GrantValidationError):
        clear_grants(user=user, org=org, granted_by=admin, reason="short")
```

---

### F-07 — `set_grant` / `bulk_set_grants` with an invalid module code not tested
**Severity:** medium
**Category:** error path

`_resolve_module()` in `grants.py` raises `GrantValidationError` if the module code does not exist in the DB. No test exercises this path.

**Evidence — grants.py:42-49**:
```python
def _resolve_module(module_or_code) -> Module:
    if isinstance(module_or_code, Module):
        return module_or_code
    try:
        return Module.objects.get(code=module_or_code)
    except Module.DoesNotExist as exc:
        raise GrantValidationError(
            f"Module with code={module_or_code!r} does not exist."
        ) from exc
```

**Recommendation:** Add a test that calls `set_grant(..., module="nonexistent.module", ...)` and asserts `GrantValidationError`.

---

### F-08 — `set_grant` with an invalid state string not tested
**Severity:** low
**Category:** error path

`_validate_state()` raises `GrantValidationError` for a state value outside `GrantState.choices`. No test exercises this.

**Evidence — grants.py:33-38**:
```python
def _validate_state(state: str) -> str:
    if state not in {choice for choice, _ in GrantState.choices}:
        raise GrantValidationError(
            f"Invalid grant state: {state!r}. ..."
        )
```

**Recommendation:** Add `test_set_grant_rejects_invalid_state` that passes `state="invalid_value"` and asserts `GrantValidationError`.

---

### F-09 — `effective_modules` default for `is_authenticated` is wrong (`True` instead of `False`)
**Severity:** medium
**Category:** latent bug / untested error path

`resolver.py:113` uses `getattr(user, "is_authenticated", True)`. The default `True` means that if a mock/proxy object without `is_authenticated` is passed, the guard `not True` evaluates to `False`, the check is NOT triggered, and the resolver proceeds as if the user is authenticated. Every other guard in the codebase uses `False` as the safe default.

**Evidence — resolver.py:113**:
```python
if user is None or not getattr(user, "is_authenticated", True):
```
Compare with `scope.py:55`:
```python
if not getattr(user, "is_authenticated", False):
```
And `permissions.py:41`:
```python
if not getattr(user, "is_authenticated", False):
```

No test exercises `effective_modules` with an object that lacks `is_authenticated`.

**Recommendation:** Change line 113 to `getattr(user, "is_authenticated", False)`. Add a test:
```python
def test_effective_modules_with_object_lacking_is_authenticated(loaded_modules):
    class FakeUser:
        id = uuid.uuid4()
        pk = id
    assert effective_modules(FakeUser(), org) == frozenset()
```

---

### F-10 — No idempotent-replay test for the PUT grants endpoint (`event_id` is accepted but ignored)
**Severity:** high
**Category:** idempotent-replay (invariant #3)

`BulkGrantsCellsSerializer` accepts an `event_id` field but the service layer ignores it. The PUT endpoint has no idempotency guarantee: two identical PUT calls with the same `event_id` are both executed (audit rows emitted twice for the second call if state changed back and forth). There is no test that submits the same `event_id` twice and asserts no duplicate audit rows.

**Evidence — serializers.py:110**:
```python
event_id = serializers.UUIDField(required=False)
```
**Evidence — views.py:221-249** — `event_id` is never read from `payload` or passed to `bulk_set_grants`:
```python
ser = BulkGrantsCellsSerializer(data=request.data)
ser.is_valid(raise_exception=True)
payload = ser.validated_data
grants_pairs = [(code, state) for code, state in payload["cells"].items()]
reason = payload["reason"]
# event_id silently dropped
```

**Why it matters:** Invariant #3 ("idempotent writes") applies to all writes. The bulk grants PUT is a mutation endpoint that must honor `event_id`. The serializer accepts it but the implementation ignores it, giving a false sense of compliance.

**Recommendation:** Either implement `event_id` idempotency at the service layer (with a unique constraint table) or document the known gap in the view and add a test that asserts the current behavior (second identical call still succeeds without 200-cached response) so the deviation from invariant #3 is explicit.

---

### F-11 — `ScopedQuerySet.scoped_for_user` never called on an actual tenant-scoped model instance in any isolation test
**Severity:** medium
**Category:** cross-org isolation

`test_scope_queryset.py` tests isolation by calling `_user_org_ids()` directly rather than the actual `scoped_for_user()` filter on a model with an `organization_id` FK. This means the `.filter(organization_id__in=...)` path in `ScopedQuerySet.scoped_for_user` is not exercised on a real tenant-scoped model row.

**Evidence — test_scope_queryset.py:53-57**:
```python
qs = ScopedQuerySet(model=Organization)
# Since we're scoping Organization rows themselves, swap organization_id → id.
# Easier: construct a synthetic test by checking _user_org_ids directly.
org_ids = qs._user_org_ids(user)
assert org_x.id in org_ids
assert org_y.id not in org_ids
```
The test comment explicitly acknowledges this shortcut.

**Recommendation:** Create a minimal inline test model (or use an existing Phase 1A model that has `organization` FK, such as `MembershipModuleGrant`) and exercise `scoped_for_user` end-to-end. Assert that user A cannot retrieve rows belonging to Org B's members.

---

### F-12 — Matrix endpoint never tested for a soft-deleted organization
**Severity:** low
**Category:** error path

`_resolve_org_by_slug_or_uuid` filters `deleted_at__isnull=True` but no test passes a slug/uuid for a soft-deleted org and asserts `404`.

**Evidence — views.py:65-70**:
```python
return Organization.objects.filter(
    slug=value, deleted_at__isnull=True
).first()
```

**Recommendation:** Add a test that creates an org, sets `deleted_at=timezone.now()`, and asserts the matrix endpoint returns `404`.

---

### F-13 — `MyEffectiveModulesView` bad-UUID query param path tested implicitly but 400 shape never asserted
**Severity:** low
**Category:** error path

`views.py:121-126` returns a structured `400` when `?org=` is a non-UUID string. No test asserts this path or the response body.

**Evidence — views.py:121-126**:
```python
try:
    org_uuid = uuid.UUID(org_id)
except (ValueError, TypeError):
    return Response(
        {"detail": "Invalid org UUID."},
        status=status.HTTP_400_BAD_REQUEST,
    )
```

**Recommendation:** Add tests for:
1. `?org=` absent → `400 {"detail": "Missing required query param: org"}`.
2. `?org=not-a-uuid` → `400 {"detail": "Invalid org UUID."}`.
3. `?org=<valid-uuid-of-nonexistent-org>` → `404`.

---

## Summary Table

| ID   | Severity | Category                    | One-line description                                                 |
|------|----------|-----------------------------|----------------------------------------------------------------------|
| F-01 | high     | permission-denied/negative  | No unauthenticated-request tests for any HTTP endpoint               |
| F-02 | critical | cross-org isolation (#2)    | Admin of Org X can call grants endpoint for Org Y — untested         |
| F-03 | high     | cross-org isolation (#2)    | Non-member querying foreign org's modules — behavior untested        |
| F-04 | critical | cross-org isolation (#2)    | PUT grants for a user not in the target org — untested               |
| F-05 | high     | permission-denied/negative  | `HasModule` factory has no unit tests (4 resolution paths)           |
| F-06 | medium   | error path                  | `bulk_set_grants` / `clear_grants` short-reason rejection not tested |
| F-07 | medium   | error path                  | `_resolve_module` with nonexistent code not tested                   |
| F-08 | low      | error path                  | `_validate_state` with invalid state not tested                      |
| F-09 | medium   | latent bug + untested path  | `is_authenticated` default wrong (True vs False) in resolver         |
| F-10 | high     | idempotent-replay (#3)      | `event_id` accepted but ignored; no idempotency test                 |
| F-11 | medium   | cross-org isolation (#2)    | `scoped_for_user` tested via private helper, not real FK model       |
| F-12 | low      | error path                  | Soft-deleted org not tested in slug resolution paths                 |
| F-13 | low      | error path                  | `MyEffectiveModulesView` 400 / 404 error paths not tested            |

---

## Gaps (Forward-looking)

| Item | Missing | Needed for | Effort | Blocking? |
|------|---------|------------|--------|-----------|
| Parametrized cross-org isolation test harness | A factory pattern for "user_in_org_X hits endpoint for org_Y" | Every Phase 1B endpoint (tournaments, matches, etc.) will need this | M | Yes — must exist before Phase 1B endpoint tests land |
| `HasModule` view integration test fixture | A minimal test view class with `get_organization()` hook | Testing HasModule in isolation before Phase 1B wires it to real views | S | No |
| `event_id` idempotency service + test | Global `EventLog` table + unique constraint + 200-replay path | Invariant #3 on all PUT/POST grant mutations | L | No (Phase 1B) |
| Redis pub/sub cache-invalidation test | Multi-worker cache invalidation on grant write (Appendix B.3) | Production correctness for multi-worker ASGI deploy | M | No (Phase 1B) |
| `MembershipModuleGrant` unique-constraint replay test | Test that POSTing the same (user, org, module) twice returns the existing row (200, not 201 / IntegrityError) | Invariant #3 | S | No |
| Permission matrix parametrized test for verb-level actions | A test per verb (`view_grants`, `set_grant`, etc.) per role | CLAUDE.md invariant #12 "parametrize over PRD §3.2" | L | No (Phase 1B) |
