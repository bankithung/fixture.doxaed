# Cross-Org Isolation Sweep — Phase 1A API Surface

Date: 2026-06-04
Scope: every `/api/*` route declared in `backend/fixture/urls.py` + each
`backend/apps/*/urls.py`. For each route: view, read/write, org-scoping
mechanism, and whether a cross-org isolation test exists. Plus `/sadmin/*`
(platform-scoped, noted for completeness).

Method: read of all `urls.py`, all `views.py`, the two permission modules
(`apps/organizations/permissions.py`, `apps/permissions/permissions.py`),
the resolver, the scope queryset, and all `apps/*/tests/**`. No knowledge
graph used.

---

## Route inventory (what scopes each, and isolation-test status)

Legend: **Scoping** = the mechanism that prevents cross-org access.
**Iso test** = a test that asserts a user in Org A is denied / cannot see
Org B data through THIS route.

### accounts (`/api/accounts/`) — platform-scoped, not org-tenanted
| Route | View | R/W | Scoping | Iso test |
|---|---|---|---|---|
| `auth/signup/` | `signup` | W | AllowAny; creates own org | n/a |
| `auth/verify_email/` (+`verify-email/`) | `verify_email` | W | token | n/a |
| `auth/login/` | `login_view` | W | AllowAny | n/a |
| `auth/logout/` | `logout_view` | W | IsAuthenticated, self | n/a |
| `auth/reauth/` | `reauth_view` | W | self | n/a |
| `auth/password_reset_request/` (+hyphen) | `password_reset_request_view` | W | AllowAny | n/a |
| `auth/password_reset_complete/` (+hyphen) | `password_reset_complete_view` | W | token | n/a |
| `auth/2fa/enroll|confirm|disable/` | twofa views | W | self | n/a |
| `auth/2fa/recovery_codes:regenerate/` | `twofa_recovery_regenerate_view` | W | self | n/a |
| `me/` (GET/PATCH) | `me_view` | R/W | self | **see Finding 4** |
| `users/{uuid}:soft_delete/` | `user_soft_delete_view` | W | super-admin only (in-body check) | n/a |

### organizations (`/api/orgs/`) — ORG-TENANTED (highest risk)
| Route | View | R/W | Scoping | Iso test |
|---|---|---|---|---|
| `` (GET) | `OrgListCreateView.get` | R | `OrganizationMembership.objects.user_org_ids` filter (views.py:133) | **none (Finding 2)** |
| `` (POST) | `OrgListCreateView.post` | W | super-admin only | n/a |
| `{slug_or_uuid}/` (GET) | `OrgDetailView.get` | R | member check (views.py:187-191) | **none (Finding 2)** |
| `{slug_or_uuid}/` (PATCH) | `OrgDetailView.patch` | W | admin check (views.py:203-210) | **none (Finding 2)** |
| `{uuid}:change_slug/` | `OrgChangeSlugView` | W | `IsOrgAdminOrOwner` | **none (Finding 2)** |
| `{uuid}:suspend/` `:unsuspend/` | suspend/unsuspend | W | `IsSuperUser` | n/a |
| `{uuid}:archive/` | `OrgArchiveView` | W | owner-or-SA (views.py:294-303) | **none (Finding 2)** |
| `{uuid}:transfer_ownership/` | `OrgTransferOwnershipView` | W | `IsOrgOwner` | **none (Finding 2)** |
| `{uuid}/members/` (GET) | `OrgMembersListView` | R | `HasModule("org.member_directory")` + `get_organization` | **none (Finding 2)** |
| `{uuid}/members/{mid}/` (DELETE) | `OrgMemberRemoveView` | W | `IsOrgAdminOrOwner` + `get_object_or_404(...,organization=org)` | **none (Finding 2)** |
| `{uuid}/invitations/` (GET/POST) | `OrgInvitationsView` | R/W | `IsOrgAdminOrOwner` | **none (Finding 2)** |
| `{uuid}/invitations/{id}:revoke/` | `OrgInvitationRevokeView` | W | `IsOrgAdminOrOwner` + obj org-scoped | **none (Finding 2)** |
| `invitations/accept/` | `InvitationAcceptByPathView` | W | token | n/a |
| `{slug}/members/` (GET) | `OrgMembersBySlugView` | R | `HasModule("org.member_directory")` | partial (unknown-slug only) |
| `{slug}/invitations/` (GET/POST) | `OrgInvitationsBySlugView` | R/W | `IsOrgAdminOrOwner` | partial (unknown-slug only) |
| `{slug}/invitations/{id}/` (DELETE) | `OrgInvitationByIdSlugView` | W | `IsOrgAdminOrOwner` + obj org-scoped | **none (Finding 2)** |
| `{slug}/ownership/transfer/` | `OwnershipTransferBySlugView` | W | `IsOrgOwner` | **none (Finding 2)** |
| `{slug_or_uuid}/` (catch-all detail) | `OrgDetailView` | R/W | member/admin check | **none (Finding 2)** |

### invitations (root) (`/api/invitations:accept/`)
| `invitations:accept/` | `InvitationAcceptView` | W | token | n/a |

### permissions (`/api/permissions/`) — ORG-TENANTED
| Route | View | R/W | Scoping | Iso test |
|---|---|---|---|---|
| `modules/` (GET) | `ModuleCatalogView` | R | IsAuthenticated; catalog is global metadata | n/a |
| `me/modules/?org={uuid}` (GET) | `MyEffectiveModulesView` | R | computes effective set (empty for non-member); **no membership gate / no 403** | **none (Finding 3)** |
| `orgs/{org_uuid}/users/{user_uuid}/grants/` (GET/PUT) | `UserGrantsView` | R/W | `IsOrgAdminOrOwner` | **none (Finding 2)** — only slug variant tested |
| `orgs/{slug}/grants/matrix/` (GET) | `MatrixView` | R | `IsOrgAdminOrOwner` | non-member 403 tested (test_matrix.py:305) |
| `orgs/{slug}/me/modules/` (GET) | `MyModulesBySlugView` | R | no membership gate (mirrors Finding 3) | **none (Finding 3)** |
| `orgs/{slug}/users/{user_uuid}/grants/` (GET/PUT) | `UserGrantsBySlugView` | R/W | `IsOrgAdminOrOwner` | non-admin role 403 tested; **no Org-A-admin-vs-Org-B test** |

### audit (`/api/audit/`) — ORG-TENANTED
| `orgs/{slug}/` (GET) | `OrgAuditListView` | R | `HasModule("org.audit_log")` + `organization_id` filter | **YES** (test_audit_list_view.py:120 `test_cross_org_leak_blocked`) |

### sports (`/api/sports/`) — global public metadata
| `` (GET) / `{code}/` (GET) | Sport list/detail | R | AllowAny; intentionally public, no org FK | n/a |

### feedback (`/api/feedback/submit/`)
| `submit/` (POST) | `FeedbackSubmitView` | W | IsAuthenticated; writes own feedback | n/a |

### sadmin (`/sadmin/...`) — PLATFORM-scoped, super-admin only
All HTML + JSON-API verbs gated by `@superadmin_required` (404 for non-SA).
Not org-tenanted; a super-admin is platform-global by design. No cross-org
isolation applies. (`bulk_email_api`, `system_health_api`,
`archive_feedback_api`, orgs/users/feedback/audit HTML views.)

---

## Findings

### Finding 1 — `_OrgMembershipPermission` fails OPEN when org cannot be resolved (latent)
**Severity:** medium
**File:** `backend/apps/organizations/permissions.py:85-89`
**Evidence:**
```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```
**Why it matters:** Every org-tenanted view guarded by `IsOrgMember` /
`IsOrgAdminOrOwner` / `IsOrgOwner` will return `True` from the permission
check whenever the org kwarg is absent OR unresolvable. Today the views
that use these classes (`OrgChangeSlugView`, `OrgInvitations*`,
`OrgMemberRemove`, ownership transfer, `UserGrantsView`) all re-resolve the
org inside the handler and `get_object_or_404`, so the net effect is a 404
rather than a leak — defense-in-depth, not an active breach. BUT the comment
explicitly promises "object-level permission filters at the queryset layer"
which is NOT enforced by the base class itself. The first future view that
trusts this class without an in-handler org filter (likely in Phase 1B
tournaments/matches) will leak cross-org. This is a fail-open default that
contradicts invariant 12 (default-deny).
**Recommendation:** Change the `org is None` branch to `return False`
(fail-closed). For the handful of genuinely org-less views, use a distinct
non-org permission class. Add a unit test asserting the class denies when
no org kwarg is present.

### Finding 2 — No cross-org isolation test for ANY org-tenanted write/read route except audit
**Severity:** high
**File:** `backend/apps/organizations/tests/test_slug_routes.py` (whole file);
`backend/apps/permissions/tests/test_matrix.py` (whole file)
**Evidence:** The only cross-org leak assertion in the codebase is
`backend/apps/audit/tests/test_audit_list_view.py:120`
(`test_cross_org_leak_blocked`). Existing org/permissions tests only cover
(a) unknown-slug → 403/404 (`test_slug_routes.py:97-104`) and (b) wrong-ROLE
within the SAME org (`test_matrix.py:283-362`). There is no test where an
*admin/owner of Org A* targets Org B's UUID/slug and is denied. Grep across
`backend/apps/organizations/tests` and `backend/apps/permissions/tests`
returns zero "other org / outsider-with-membership-elsewhere" cases for:
`OrgDetailView` (GET/PATCH), `OrgChangeSlugView`, `OrgArchiveView`,
`OrgTransferOwnershipView`, `OrgMembersListView` (UUID), `OrgMemberRemoveView`,
`OrgInvitationsView`/`RevokeView` (UUID), `OrgInvitationByIdSlugView`,
`OwnershipTransferBySlugView`, `UserGrantsView` (UUID GET/PUT).
**Why it matters:** CLAUDE.md invariant 2 and the test conventions state
"Every endpoint must be covered by a test that asserts user A in Org X
cannot access org Y data" and "Multi-tenancy isolation tests are not
optional." The current guards appear correct on read, but they are
UNVERIFIED by the suite, so any future refactor (e.g. the Finding 1
fail-open, or a dropped `organization=org` filter) would pass CI silently.
**Recommendation:** Add a parametrized cross-org suite: seat user as
admin/owner in Org A, then hit each org-tenanted route with Org B's
slug AND uuid, asserting 403/404 and (for list routes) zero Org-B rows.
Mirror the audit test's three-part structure. Treat this as the standing
isolation harness Phase 1B route additions must extend.

### Finding 3 — `me/modules/` (UUID + slug) discloses org existence to non-members; no 403 for outsiders
**Severity:** low
**File:** `backend/apps/permissions/views.py:128-136` (`MyEffectiveModulesView`)
and `backend/apps/permissions/views.py:295-300` (`MyModulesBySlugView`)
**Evidence:**
```python
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, status=404)
modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```
There is no membership check: any authenticated user may probe any org
UUID/slug. A member gets their module list; a non-member gets `200
{"modules": []}`; a missing org gets `404`. The 200-vs-404 distinction
confirms org existence (enumeration), and the slug variant additionally
confirms the slug→org mapping.
**Why it matters:** Minor information disclosure (org enumeration), not a
data leak — `effective_modules` correctly returns empty for non-members
(`resolver.py:126` queries memberships for that user+org). Still violates
the spirit of default-deny: an outsider should get 403/404 uniformly, not a
200 that distinguishes "exists, you're out" from "doesn't exist."
**Recommendation:** Return 404 (or 403) when the requesting user has no
active membership in the resolved org, so existence is not observable to
non-members. Add an isolation test for both variants.

### Finding 4 — `MeSerializer.last_active_org_id` is writable with no membership validation
**Severity:** low
**File:** `backend/apps/accounts/serializers.py:108-132`
**Evidence:** `last_active_org_id` is in `fields` (line 116) but NOT in
`read_only_fields` (lines 122-132), and there is no `validate_last_active_org_id`.
`me_view` PATCH (`backend/apps/accounts/views.py:423-426`) calls
`serializer.save()` directly. `MeSerializer.get_last_active_org_slug`
(serializers.py:177-184) then resolves and returns that org's slug on the
next GET with no membership check.
**Why it matters:** An authenticated user can PATCH `last_active_org_id` to
ANY org UUID (including one they do not belong to) and read back that org's
slug via `last_active_org_slug` — a cross-org slug-disclosure / enumeration
primitive. It does not grant data access (all org-data routes re-check
membership), and `memberships[]` is still scoped to the user's own orgs,
but writing an arbitrary tenant pointer to a user record is an invariant-2
smell.
**Recommendation:** Either make `last_active_org_id` read-only and add a
dedicated `POST /api/accounts/me:set_active_org/` that validates membership,
or add `validate_last_active_org_id` asserting the user has an active
membership in the target org. Add a test.

### Finding 5 — Org-scoped audit route is the lone surface with a written isolation contract
**Severity:** info
**File:** `backend/apps/audit/views.py:124-129`,
`backend/apps/audit/tests/test_audit_list_view.py:120-146`
**Evidence:** `qs = AuditEvent.objects.filter(organization_id=org.id)` plus
`HasModule("org.audit_log")`, and a dedicated cross-org test. This is the
reference implementation the other org-tenanted routes should be measured
against.
**Why it matters:** Confirms the pattern works and is testable; the gap is
purely that it has not been replicated (Finding 2).
**Recommendation:** Use this as the template for the standing isolation
harness.

---

## Gaps

1. **Standing multi-tenancy isolation harness is missing** (blocking for the
   invariant-2 CI claim). Only `audit` has a cross-org test. Every other
   org-tenanted route in `organizations` and `permissions` is unverified.
   Effort: M.

2. **Fail-open default in `_OrgMembershipPermission`** must be flipped to
   fail-closed before Phase 1B adds views that rely on it without an
   in-handler org filter. Effort: S.

3. **`me/modules/` outsider behavior** (200 vs 404) needs a membership gate
   to stop org enumeration. Effort: S.

4. **`last_active_org_id` writability** needs validation or a dedicated verb.
   Effort: S.

5. **No project-level conftest / CI marker** enforcing that every new
   org-tenanted endpoint ships with an isolation test. Consider a pytest
   marker (e.g. `@pytest.mark.isolation`) + a CI gate, given the aggressive
   parallel-agent workflow where dropped `organization=` filters are easy to
   introduce. Effort: M.

6. **Phase 1B routes (tournaments, teams, fixtures, matches, live, disputes,
   notifications) do not exist yet** — every one of them will be org-tenanted
   and must adopt `ScopedManager` + an isolation test from day one. Not a
   defect today; flagged so the harness lands before the routes do. Effort: L
   (deferred).
