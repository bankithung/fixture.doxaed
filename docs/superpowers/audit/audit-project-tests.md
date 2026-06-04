# Test Gap Audit — Phase 1A Backend

**Date:** 2026-06-04
**Scope:** `backend/apps/` — accounts, audit, organizations, permissions, sadmin, sports
**Lens:** cross-org isolation (#2), permission-denied/negative tests, state-machine + blocked-transition tests, idempotent-replay tests, untested error paths

---

## Summary

Phase 1A has solid positive-path and service-layer coverage. The main gaps are:

1. **No API-level cross-org isolation tests for organizations views** (`OrgListCreateView`, `OrgDetailView`, `OrgMemberRemoveView`, `OrgSuspendView`, `OrgArchiveView`, `OrgChangeSlugView`) — only the audit endpoint and the module-scope queryset have cross-org tests.
2. **`OrgMemberRemoveView` has zero test coverage** — both happy-path and denied paths (non-admin trying to remove a member; removing the org owner; cross-org attempt).
3. **Org lifecycle verb views (`OrgSuspendView`, `OrgUnsuspendView`, `OrgArchiveView`, `OrgChangeSlugView`) are only tested at the service layer, never at the HTTP view layer** — no tests for role-denied access (e.g., co-organizer hitting `:suspend/`), no unauthenticated tests.
4. **`GET /api/accounts/me/` has no unauthenticated/403 test** — the known issue (returns 403 not 401 on logged-out hit) is entirely untested, including the regression check.
5. **`GET /api/orgs/` (org list) has no test** — not covered for any role.
6. **Idempotency via `event_id` is only tested for signup and invite create**; ownership transfer, grant mutations, and member-remove lack replay tests.
7. **OrgStatus state-machine blocked-transition tests** only exist for approve/reject at the service layer; suspend/unsuspend/archive blocked transitions (`ARCHIVED → suspend`, `PENDING → unsuspend`, etc.) are not tested.
8. **`MyEffectiveModulesView` (`GET /api/permissions/me/modules/`)** is not covered for the case where the requesting user has no membership in the requested org (should return empty, not 404/500).
9. **Cross-org invite abuse** — no test prevents an admin of Org A from accepting invitations intended for Org B, or from revoking invitations that belong to Org B by guessing UUIDs.

---

## Findings

### F-01 · No API-level cross-org isolation test for `OrgDetailView` (GET + PATCH)

**Severity:** high
**Category:** cross-org isolation
**File:** `backend/apps/organizations/views.py:161–220`
**Evidence:**
```python
# views.py:186-192
if not request.user.is_superuser:
    if not OrganizationMembership.objects.filter(
        user=request.user, organization=org, is_active=True
    ).exists():
        raise PermissionDenied("Not a member of this organization.")
```
The GET guard exists in code, but there is **no test** asserting that user in Org A gets 403 (not 200) on `GET /api/orgs/{org_b_uuid}/`. Similarly there is no test asserting that PATCH by a non-admin in Org B returns 403.

**Why it matters:** CLAUDE.md invariant 2 mandates isolation tests for every endpoint. `OrgDetailView` is a high-traffic read endpoint — a regression in the guard would silently expose all org metadata to any authenticated user.

**Recommendation:** Add `test_org_detail_cross_org_isolation` and `test_org_patch_denied_for_non_admin` in `backend/apps/organizations/tests/`. Parametrize over all six non-admin roles.

---

### F-02 · `OrgMemberRemoveView` has zero test coverage

**Severity:** high
**Category:** cross-org isolation + permission-denied
**File:** `backend/apps/organizations/views.py:368–399`, `backend/apps/organizations/urls.py:71`
**Evidence:**
```python
# urls.py:70-72
path(
    "<uuid:uuid>/members/<uuid:membership_id>/",
    views.OrgMemberRemoveView.as_view(),
    name="org-member-remove",
),
```
No test file in `backend/apps/organizations/tests/` hits `DELETE /api/orgs/{uuid}/members/{membership_id}/`.

**Why it matters:** Missing tests for:
- A non-admin (e.g., co-organizer) trying to remove a member → should 403.
- Removing the org owner → should 403 (`"Cannot remove the org owner directly"`).
- A user from Org A deleting a membership row that belongs to Org B (cross-org DELETE).
- Happy path: admin removes a non-owner member, `is_active` set to False, `removed_at` set, audit emitted.

**Recommendation:** Add `test_member_remove_*.py` in the organizations test directory covering all four cases above.

---

### F-03 · Org lifecycle HTTP views untested (suspend, unsuspend, archive, change-slug) — no role-denied or unauthenticated tests

**Severity:** high
**Category:** permission-denied
**File:** `backend/apps/organizations/views.py:228–315`
**Evidence:**
```python
# views.py:250-253
class OrgSuspendView(APIView):
    permission_classes = [IsAuthenticated, IsSuperUser]
    ...
class OrgArchiveView(APIView):
    permission_classes = [IsAuthenticated]  # auth checked inline
```
`test_lifecycle_services.py` covers the service layer only. No test hits `POST /api/orgs/{uuid}:suspend/`, `:unsuspend/`, or `:archive/` via HTTP.

**Why it matters:**
- `OrgSuspendView` is `IsSuperUser`-gated but this is never verified by a test (a non-super-admin org admin could be allowed if the guard were removed by mistake).
- `OrgArchiveView` has inline ownership check but no test verifies a co-organizer gets 403.
- `OrgChangeSlugView` uses `IsOrgAdminOrOwner` — never tested from HTTP.

**Recommendation:** Add a dedicated `test_org_verb_views.py` testing `:suspend/`, `:unsuspend/`, `:archive/`, `:change_slug/` for (a) super-admin happy path, (b) org-admin denied on super-admin-only verbs, (c) unauthenticated request.

---

### F-04 · `GET /api/accounts/me/` — no unauthenticated test (known 403-vs-401 bug unverified)

**Severity:** high
**Category:** permission-denied + error path
**File:** `backend/apps/accounts/views.py:416–441`
**Evidence:**
```python
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def me_view(request: Request) -> Response:
```
The known issue in the task brief is "(b) `/api/accounts/me/` returns 403 not 401 when logged-out → premature error banner on `/login`". There is **no test** asserting the response code for an unauthenticated GET. The `test_login_flow.py` and `test_audit_emission.py` both call `me_view` but only while authenticated.

**Why it matters:** The bug is documented but unverified. Without a test, a fix for it (switching from DRF session auth's default 403 to 401 via `WWW_AUTHENTICATE_REALM` or custom renderer) would land with no regression guard.

**Recommendation:** Add to `test_login_flow.py`:
```python
def test_me_unauthenticated_returns_401_or_403(client):
    resp = client.get(reverse("accounts:me"))
    assert resp.status_code in (401, 403)
```
And once the bug is fixed, pin the specific expected code.

---

### F-05 · `GET /api/orgs/` (org list) has no test at all

**Severity:** medium
**Category:** cross-org isolation + permission-denied
**File:** `backend/apps/organizations/views.py:116–157`, `backend/apps/organizations/urls.py:21`
**Evidence:**
```python
# views.py:129-135
def get(self, request):
    if request.user.is_superuser:
        qs = Organization.active_objects.all()
    else:
        org_ids = OrganizationMembership.objects.user_org_ids(request.user)
        qs = Organization.active_objects.filter(id__in=list(org_ids))
    return Response(OrganizationSerializer(qs, many=True).data)
```
No test in any file exercises `GET /api/orgs/`.

**Why it matters:** The view has a superuser fast-path that returns ALL orgs and a member-scoped path. No test confirms:
- A regular user only sees their own orgs (cross-org isolation).
- A superuser sees all orgs.
- An unauthenticated user gets 401/403.
- An authenticated user with no memberships gets `[]`, not all orgs.

**Recommendation:** Add `test_org_list_view.py` with four parametrized cases.

---

### F-06 · OrgStatus state-machine blocked-transition tests missing for suspend/archive verbs

**Severity:** medium
**Category:** state-machine blocked transitions
**File:** `backend/apps/organizations/services/lifecycle.py:159–258`
**Evidence:**
```python
# lifecycle.py:159-165
def suspend_org(...):
    if org.status == OrgStatus.SUSPENDED:
        return org  # idempotent
    if org.status not in (OrgStatus.ACTIVE, OrgStatus.PENDING_REVIEW, OrgStatus.ORPHANED):
        raise ValidationError(
            f"Cannot suspend an org in status '{org.status}'."
        )
```
`test_lifecycle_services.py` only tests `approve_org` (pending → active) and `reject_org` (pending → archived). The blocked transitions for the following are **not tested**:
- `ARCHIVED → suspend` (should raise)
- `ACTIVE → unsuspend` (should raise — unsuspend requires `SUSPENDED`)
- `PENDING_REVIEW → unsuspend` (should raise)
- `ARCHIVED → archive` (currently a no-op, not a raise — this is itself a behavioral gap worth verifying)

**Recommendation:** Add `test_org_state_machine_blocked_transitions.py` covering each invalid source state for each transition.

---

### F-07 · Idempotency (`event_id`) tested only for signup and invite-create; missing for ownership-transfer, grant-bulk-set, member-remove

**Severity:** medium
**Category:** idempotent-replay
**File:** `backend/apps/organizations/views.py:318–341`, `backend/apps/permissions/views.py:210–268`
**Evidence:**
```python
# permissions/serializers.py — BulkGrantsCellsSerializer accepts event_id
# but no test in test_grant_audit.py or test_matrix.py replays a PUT with same event_id
```
`event_id` idempotency is tested for:
- `POST /signup/` (`test_signup_path_b.py`)
- `POST /api/orgs/{slug}/invitations/` (`test_slug_routes.py:153`)

But **not** for:
- `PUT /api/permissions/orgs/{slug}/users/{uuid}/grants/` (accepts `event_id` in `BulkGrantsCellsSerializer`)
- `POST /api/orgs/{uuid}:transfer_ownership/` (no `event_id` even in the serializer — worth confirming design intent, may be deliberate)

**Why it matters:** Invariant 3 says idempotency applies to ALL writes. If a grant PUT with the same `event_id` is replayed, the second call must not double-emit audit rows or create duplicate grant rows.

**Recommendation:** Add replay tests for the `PUT /grants/` endpoint. Verify that replaying the same `event_id` returns 200 without new audit rows.

---

### F-08 · Cross-org invitation abuse — no test prevents admin of Org A from revoking Org B's invitation by UUID

**Severity:** medium
**Category:** cross-org isolation
**File:** `backend/apps/organizations/views.py:438–458`, `backend/apps/organizations/views.py:590–618`
**Evidence:**
```python
# views.py:443-445 (OrgInvitationRevokeView)
org = _resolve_org(uuid)
inv = get_object_or_404(
    AdminInvitation, pk=invitation_id, organization=org
)
```
The `organization=org` filter in `get_object_or_404` does prevent cross-org access at the service level, but there is **no test** asserting that `DELETE /api/orgs/{org_a_uuid}/invitations/{org_b_inv_id}/` returns 404 (not 204). The slug-routed version `OrgInvitationByIdSlugView` has the same gap.

**Why it matters:** Without this test, a future refactor that removes the `organization=org` filter in `get_object_or_404` (e.g., for performance) would not be caught by any test.

**Recommendation:** Add `test_invitation_cross_org_revoke_denied` in `test_slug_routes.py` or a dedicated file.

---

### F-09 · `MyEffectiveModulesView` — no test for user querying an org they don't belong to

**Severity:** medium
**Category:** cross-org isolation
**File:** `backend/apps/permissions/views.py:91–136`
**Evidence:**
```python
# views.py:127-135
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, ...)
modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```
When `org` exists but the user has no membership in it, `effective_modules` returns an empty set — the view returns `{"modules": []}` with 200, not 403. No test verifies this behavior is intentional or checks whether it leaks org existence via the response.

**Why it matters:** An authenticated user can probe any org UUID and get a 200 with empty modules. This confirms org existence (an information leak). The spec may intend this (users can see empty modules for public orgs), but there is no test either way.

**Recommendation:** Add `test_my_modules_non_member_org` to `test_matrix.py` asserting either `[]` + 200 (if leak is acceptable) or 403 (if not).

---

### F-10 · `OrgMemberRemoveView` — removing owner not tested at HTTP layer

**Severity:** medium
**Category:** permission-denied + error path
**File:** `backend/apps/organizations/views.py:382–384`
**Evidence:**
```python
if membership.is_org_owner:
    raise PermissionDenied("Cannot remove the org owner directly. Transfer ownership first.")
```
Only `OrgMemberRemoveView` has this guard. There is no HTTP-level test verifying the 403 response is returned when `membership.is_org_owner=True`.

**Why it matters:** If the guard is removed or the condition is changed, no test catches it. The org becomes ownerless in an unexpected way.

**Recommendation:** Add to the member-remove test file: `test_member_remove_owner_denied`.

---

### F-11 · Password-reset complete — no test for expired or replayed token at the HTTP layer

**Severity:** medium
**Category:** error path
**File:** `backend/apps/accounts/views.py:310–323`, `backend/apps/accounts/services/password_reset.py`
**Evidence:** `test_password_reset.py` exists but:
```python
# test_password_reset.py covers service-layer happy path
# No HTTP-layer test for expired token → 400
# No HTTP-layer test for token replay (used_at already set) → 400
```

**Why it matters:** The view returns 400 for `ValueError` raised by the service. If the error handling changes (e.g., starts raising a different exception type), no test catches it.

**Recommendation:** Add to `test_password_reset.py`: `test_password_reset_complete_expired_token_returns_400` and `test_password_reset_complete_replay_returns_400` using the HTTP endpoint directly.

---

### F-12 · `OrgListCreateView` POST (org creation by super-admin) — no test

**Severity:** low
**Category:** permission-denied
**File:** `backend/apps/organizations/views.py:141–157`
**Evidence:**
```python
def post(self, request):
    if not request.user.is_superuser:
        raise PermissionDenied("Only super-admins can create organizations.")
```
No test hits `POST /api/orgs/` as either a super-admin (happy path) or a regular user (403).

**Recommendation:** Add to a new `test_org_list_view.py`: `test_org_create_by_superadmin_201` and `test_org_create_by_regular_user_403`.

---

### F-13 · `GET /api/accounts/me/` (PATCH) — no test for non-authenticated user attempting PATCH

**Severity:** low
**Category:** permission-denied
**File:** `backend/apps/accounts/views.py:416–441`
**Evidence:** PATCH to `/api/accounts/me/` is only tested (in `test_audit_emission.py`) while authenticated. No test for the unauthenticated PATCH path.

**Recommendation:** Add `test_me_patch_unauthenticated_returns_403` alongside the GET test from F-04.

---

### F-14 · `user_soft_delete_view` — no test that a non-superuser gets 403

**Severity:** low
**Category:** permission-denied
**File:** `backend/apps/accounts/views.py:452–456`
**Evidence:**
```python
if not actor.is_superuser:
    return Response({"detail": "forbidden"}, status=status.HTTP_403_FORBIDDEN)
```
`test_audit_emission.py:test_soft_delete_by_super_admin_emits_event` tests the happy path but no test asserts that a regular user gets 403.

**Recommendation:** Add `test_soft_delete_denied_for_regular_user` in `test_audit_emission.py` or `test_login_flow.py`.

---

## Gaps (Forward-looking — not yet blocking but required before Phase 1B)

| Item | Missing | Blocking? | Effort |
|------|---------|-----------|--------|
| Phase 1B: No tournaments/matches/fixtures tests exist at all | Full test suite for Tournament, Match, MatchEvent state machines + bracket generator | No (Phase 1B not built) | XL |
| `apps/permissions/tests/test_module_matrix.py` name from CLAUDE.md | CLAUDE.md §Workflow references `apps/permissions/tests/test_module_matrix.py` but the file is named `test_permission_matrix.py` — either rename the file or update the CLAUDE.md reference | No | S |
| WebSocket/SSE consumer tests | No tests for `apps/live/` (does not exist yet) — invariant 11 requires SSE one-way / WS two-way split to be tested before Phase 1B | No | L |
| Redis pub/sub `transaction.on_commit` hook test | Invariant 4 mandates publish only after DB commit; no test verifies the hook fires correctly (requires real Redis or fakeredis) | No | M |
| Migration deploy-block test | CLAUDE.md §Commands states migrations are blocked while any tournament is in `live` state; no test for the pre-flight check | No (pre-flight not built) | M |
| Notifications dispatch tests | `apps/notifications/` does not exist yet; required before Phase 1B | No | L |
| `apps/sadmin/tests/test_pii_redaction.py` | This file exists but should be verified to cover audit-log PII redaction, not just feedback submit | No | S |
