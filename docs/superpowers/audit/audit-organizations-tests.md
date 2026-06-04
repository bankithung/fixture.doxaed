# Audit: organizations — Missing Test Coverage

**Date:** 2026-06-04
**Lens:** Cross-org isolation (#2), permission-denied/negative tests, state-machine + blocked-transition tests, idempotent-replay tests, untested error paths.
**Source files read:** `models.py`, `views.py`, `permissions.py`, `serializers.py`, `scope.py`, `urls.py`, `services/lifecycle.py`, `services/invitation.py`, `services/ownership.py`, `services/slug.py`, `constants.py`, all 8 test files + conftest + factories.

---

## Summary

The organizations test suite is solid on happy-path service tests, DB constraint enforcement, and a handful of slug-route shape tests. The critical gap is the **near-total absence of HTTP-level (APIClient) tests** for the majority of endpoints — meaning cross-org isolation (#2), permission-denied (403/401) responses, and blocked lifecycle transitions have **zero view-layer coverage**. Only `test_slug_routes.py` uses `APIClient`; everything else tests services directly and never exercises permission checks, auth guards, or cross-tenant boundaries through the actual request/response stack.

---

## Findings

### F-01 — No cross-org isolation tests for any endpoint (Critical, Invariant #2)

**Severity:** critical
**File:** `backend/apps/organizations/tests/` (entire directory)
**Evidence:** Zero tests create two organizations with two separate users and assert that user-A cannot read/mutate org-B data. The only multi-org test in constraints (`test_org_constraints.py:73-84`) tests the DB-level uniqueness constraint, not the API. The `OrgDetailView.get` guard (`views.py:187-191`) is completely untested at the HTTP layer:

```python
# views.py:187-191
if not request.user.is_superuser:
    if not OrganizationMembership.objects.filter(
        user=request.user, organization=org, is_active=True
    ).exists():
        raise PermissionDenied("Not a member of this organization.")
```

**Why it matters:** Invariant #2 states "CI tests assert no cross-org leak via any DRF / SSE / WebSocket endpoint." No such assertion exists for any of the ~15 org API endpoints. A regression in queryset filtering or the permission helper would go undetected.

**Recommendation:** Add a `test_cross_org_isolation.py` that creates two orgs (org_a / org_b), seats user_a in org_a only, and asserts HTTP 403 or 404 on every endpoint: `GET /api/orgs/{org_b.id}/`, `PATCH /api/orgs/{org_b.id}/`, `GET /api/orgs/{org_b.slug}/members/`, `GET /api/orgs/{org_b.id}/invitations/`, `POST /api/orgs/{org_b.id}:suspend/`, `DELETE /api/orgs/{org_b.id}/members/{m.id}/`, `POST /api/orgs/{org_b.id}:transfer_ownership/`, `POST /api/orgs/{org_b.id}:archive/`, `POST /api/orgs/{org_b.id}:change_slug/`.

---

### F-02 — No unauthenticated (401) tests for any endpoint (High)

**Severity:** high
**File:** `backend/apps/organizations/tests/` (entire directory)
**Evidence:** `force_authenticate` appears only in `test_slug_routes.py:57`. No test ever calls any org endpoint without authentication and asserts a 401 response. Every view carries `permission_classes = [IsAuthenticated, ...]` (`views.py:121`, `168`, `251`, `272`, `289`, etc.) but this is never exercised through the HTTP stack.

**Why it matters:** Known issue (b) in the brief shows `/api/accounts/me/` returns 403 not 401 for logged-out users — the same class of regression could exist on any org endpoint. Without a test the boundary is invisible.

**Recommendation:** Add parameterized tests hitting each org endpoint with an unauthenticated client and asserting `status_code == 401`.

---

### F-03 — No permission-denied (403) tests for non-admin roles on admin-only endpoints (High)

**Severity:** high
**File:** `backend/apps/organizations/tests/` (entire directory)
**Evidence:** `IsOrgAdminOrOwner` and `IsOrgOwner` are declared on multiple views (`OrgChangeSlugView`, `OrgMemberRemoveView`, `OrgInvitationsView`, `OrgInvitationRevokeView`, `OrgTransferOwnershipView`, `OwnershipTransferBySlugView` — `views.py:231`, `369`, `408`, `439`, `321`, `635`) but no test ever authenticates as a co-organizer, match scorer, or team manager and asserts a 403 response on any of these endpoints.

**Why it matters:** The permission classes have a subtle bypass: when `_resolve_org_from_view` returns `None` (e.g., a view without a recognized kwarg), `has_permission` returns `True` (`permissions.py:88-89`). A URL misconfig or new view that doesn't use a recognized kwarg silently becomes publicly accessible to any org member.

**Recommendation:** For each admin-gated endpoint, add a test fixture with a co-organizer user and assert HTTP 403. Separately, add a unit test for `_resolve_org_from_view` returning `None` to verify the bypass is intentional and documented.

---

### F-04 — No view-layer tests for suspend / unsuspend / archive colon-verb endpoints (High)

**Severity:** high
**File:** `backend/apps/organizations/tests/test_lifecycle_services.py` and `test_audit_emission.py`
**Evidence:** `test_audit_emission.py:44-57` calls `lifecycle_svc.suspend_org()` / `archive_org()` directly. There is no HTTP test exercising `POST /api/orgs/{uuid}:suspend/` (requires `IsSuperUser`), `POST /api/orgs/{uuid}:unsuspend/`, or `POST /api/orgs/{uuid}:archive/`. The `OrgSuspendView` (`views.py:250-267`) and `OrgArchiveView` (`views.py:286-315`) are completely uncovered at the HTTP layer.

**Why it matters:** The suspend endpoint requires `IsSuperUser`; the archive endpoint uses an inline ownership check (`views.py:294-303`) that is different from the generic `IsOrgOwner` class and is not exercised by any test. A co-organizer hitting the archive endpoint would currently be denied by the inline check, but this is never asserted.

**Recommendation:** Add `test_lifecycle_views.py` covering: superadmin can suspend/unsuspend; non-superadmin gets 403; owner can archive; non-owner gets 403; blocked transitions return 400 (e.g., suspend an already-suspended org).

---

### F-05 — Blocked lifecycle transitions not tested at service layer (suspend/unsuspend) (High)

**Severity:** high
**File:** `backend/apps/organizations/tests/test_lifecycle_services.py`
**Evidence:** `test_lifecycle_services.py` tests only `approve_org` and `reject_org` blocked transitions. The following blocked-transition paths in `lifecycle.py` have no test:

- `suspend_org` when status is `ARCHIVED` or `SUSPENDED` — `lifecycle.py:159-163` specifies only `ACTIVE`, `PENDING_REVIEW`, `ORPHANED` are valid sources; `ARCHIVED` is not. No test verifies `ValidationError` is raised.
- `unsuspend_org` when status is `ACTIVE`, `PENDING_REVIEW`, `ARCHIVED`, or `ORPHANED` — `lifecycle.py:191-194` requires `SUSPENDED`. Only the happy path is tested in `test_audit_emission.py:44-50`.
- `archive_org` when status is already `ARCHIVED` — `lifecycle.py:234` silently returns `org`; there's no test asserting the no-op behaviour or that a second archive does not emit a duplicate audit event.
- `reject_org` when status is `SUSPENDED`, `ACTIVE`, or `ORPHANED` — `lifecycle.py:121` blocks these but only `ARCHIVED` → reject is tested (`test_lifecycle_services.py:117-124`).

**Why it matters:** Invariant #6 requires state machines with audited transitions. Blocked transitions are half the state machine — without tests, regressions in the guard conditions would silently corrupt org status.

**Recommendation:** Add one test per blocked transition in `test_lifecycle_services.py`, naming the pattern `test_cannot_{verb}_{from_status}_org`.

---

### F-06 — No idempotent-replay test for mutation endpoints other than invitation-create (Medium)

**Severity:** medium
**File:** `backend/apps/organizations/tests/test_slug_routes.py:153-182`
**Evidence:** `test_invitation_create_idempotent_on_event_id` tests the `event_id` replay for invitation creation. No analogous test exists for the ownership-transfer endpoint, which also accepts `event_id` in its serializer (`serializers.py:98` — `TransferOwnershipSerializer` has `event_id = serializers.UUIDField(required=False)`) but the `ownership_svc.transfer_ownership` function never reads or uses that field.

```python
# serializers.py:98
event_id = serializers.UUIDField(required=False)
```

The serializer accepts `event_id` but `views.py:331-341` never passes it to the service, and the service has no idempotency guard. A client retry of the transfer call would transfer ownership again (or raise a ValidationError because the old owner is no longer the owner), not return the existing result.

**Why it matters:** Invariant #3 states idempotent writes for *all* writes. Ownership-transfer is a high-stakes mutation; a network retry from the client must be safe.

**Recommendation:** (a) Add idempotency handling to `ownership_svc.transfer_ownership` (audit event lookup by `event_id`, same pattern as `invitation_svc.create_invitation`). (b) Add a test asserting the second POST with the same `event_id` returns 200 without double-flipping ownership.

---

### F-07 — No test for accepting an invitation into a suspended or orphaned org (Medium)

**Severity:** medium
**File:** `backend/apps/organizations/tests/test_invitation_flow.py`
**Evidence:** `invitation_svc.accept_invitation` (`invitation.py:275-278`) blocks acceptance when `org.status not in (ACTIVE, PENDING_REVIEW)`. No test covers the case where the org is `SUSPENDED` or `ORPHANED` at accept time.

```python
# invitation.py:275-278
if org.status not in (OrgStatus.ACTIVE, OrgStatus.PENDING_REVIEW):
    raise ValidationError(
        f"Cannot accept an invitation for an org in status '{org.status}'."
    )
```

**Recommendation:** Add `test_invitation_accept_blocked_for_suspended_org` and `test_invitation_accept_blocked_for_orphaned_org`.

---

### F-08 — No test for inviting into a suspended org (Medium)

**Severity:** medium
**File:** `backend/apps/organizations/tests/test_invitation_flow.py`
**Evidence:** `invitation_svc.create_invitation` (`invitation.py:169-172`) blocks invite creation when org is not `ACTIVE` or `PENDING_REVIEW`. No test verifies this guard fires for `SUSPENDED`, `ARCHIVED`, or `ORPHANED` status.

**Recommendation:** Add `test_invitation_create_blocked_for_suspended_org` covering all invalid-status cases.

---

### F-09 — No test for removing the org owner via the member-remove endpoint (Medium)

**Severity:** medium
**File:** `backend/apps/organizations/tests/` (no HTTP view test for member remove)
**Evidence:** `OrgMemberRemoveView.delete` (`views.py:382-383`) raises `PermissionDenied` when `membership.is_org_owner` is True: "Cannot remove the org owner directly. Transfer ownership first." This guard is untested. There is no HTTP-level test for the member-remove endpoint at all.

**Recommendation:** Add tests: (a) admin removing a regular member → 204; (b) admin attempting to remove the owner → 403; (c) non-admin (co-organizer) attempting to remove any member → 403 (blocked by `IsOrgAdminOrOwner`).

---

### F-10 — No test for OrgDetailView GET / PATCH access control (Medium)

**Severity:** medium
**File:** `backend/apps/organizations/tests/` (no test files exercise `OrgDetailView`)
**Evidence:** `OrgDetailView.get` (`views.py:171-192`) checks membership; `.patch` (`views.py:198-220`) requires admin role. Neither path has any HTTP-level test. The 301 redirect path for old slugs (`views.py:180-184`) in `OrgDetailView` is also untested.

**Recommendation:** Add HTTP tests: (a) member can GET their org; (b) non-member gets 403; (c) admin can PATCH; (d) co-organizer PATCH gets 403; (e) GET with an old slug returns 301 with correct `Location` header.

---

### F-11 — No test for `OrgListCreateView` — superadmin vs. regular user scoping (Medium)

**Severity:** medium
**File:** `backend/apps/organizations/tests/`
**Evidence:** `OrgListCreateView.get` (`views.py:130-135`) returns all orgs for superadmin and only membered orgs for regular users. `OrgListCreateView.post` (`views.py:141-158`) is superadmin-only. Neither path has any HTTP-level test. In particular, there is no test asserting that a regular user cannot see orgs they are not a member of via the list endpoint.

**Recommendation:** Add HTTP tests: (a) regular user list returns only their orgs; (b) superadmin list returns all; (c) regular user POST gets 403; (d) superadmin POST creates org.

---

### F-12 — No test for mark_orphaned_orgs management command (Low)

**Severity:** low
**File:** `backend/apps/organizations/tests/`
**Evidence:** `management/commands/mark_orphaned_orgs.py` is a thin wrapper around `detect_orphaned()` which is tested in `test_orphan_detection.py`. However, the command's `handle()` method and stdout output are never exercised by `call_command()`.

**Recommendation:** Add a test using `call_command('mark_orphaned_orgs')` and check stdout contains the expected count.

---

### F-13 — No test for `ScopedQuerySetMixin.scoped_for` with unauthenticated user (Low)

**Severity:** low
**File:** `backend/apps/organizations/scope.py`
**Evidence:** `ScopedQuerySetMixin.scoped_for` (`scope.py:36-50`) returns `self.none()` for unauthenticated users, but this path is never tested. The `OrgScopedQuerySet` override (`scope.py:53-66`) is similarly untested.

**Recommendation:** Add unit tests for `scoped_for` with (a) unauthenticated user → empty; (b) superuser → all; (c) regular user → only membered orgs.

---

### F-14 — `create_invitation` with empty `roles=[]` list path untested (Low)

**Severity:** low
**File:** `backend/apps/organizations/tests/test_invitation_flow.py`
**Evidence:** `invitation_svc.create_invitation` (`invitation.py:137-138`) raises `ValidationError("roles must be a non-empty list.")` when `roles` is an empty list. The service code path is reachable but there is no test for it.

**Recommendation:** Add `test_invitation_create_with_empty_roles_list_rejected`.

---

### F-15 — No test for `change_slug` no-op when new slug equals current slug (Info)

**Severity:** info
**File:** `backend/apps/organizations/tests/test_slug_redirect.py`
**Evidence:** `slug_svc.change_slug` (`slug.py:78-79`) returns `org` early when `new_slug == org.slug`. No test verifies this branch (no redirect written, no audit emitted).

**Recommendation:** Add `test_change_slug_to_same_slug_is_noop`.

---

## Gaps (forward-looking)

| # | Item | Missing | Blocking | Effort | Needed for |
|---|------|---------|----------|--------|------------|
| G-01 | Cross-org isolation test file | `tests/test_cross_org_isolation.py` covering all ~15 API endpoints | Yes | M | Invariant #2 CI gate |
| G-02 | Unauthenticated 401 parametrized test | Parameterized over all URL patterns in `urls.py` | Yes | S | Security baseline |
| G-03 | Blocked lifecycle transition tests | All non-happy-path status transitions in `lifecycle.py` | Yes | S | Invariant #6 state machine coverage |
| G-04 | `OrgDetailView` + `OrgListCreateView` HTTP tests | Full CRUD permission matrix at view layer | Yes | M | Overall test completeness |
| G-05 | Ownership-transfer idempotency | `event_id` handling in `ownership_svc` + test | No | M | Invariant #3 |
| G-06 | Non-admin role negative tests on every admin-gated endpoint | 403 assertions for co_organizer, match_scorer, referee | Yes | S | Permission matrix coverage |
| G-07 | Member-remove endpoint tests | Happy path + owner-block + non-admin block | No | S | Endpoint coverage |
