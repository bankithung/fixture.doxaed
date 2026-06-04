# Adversarial Verification A — UserGrantsView / UserGrantsBySlugView IDOR

## Finding under test
- **Claimed severity:** high
- **File:** `backend/apps/permissions/views.py:161`
- **Title:** IDOR — admin can create/read module grants for any platform user not in their org

## Verdict
**is_real = true (partially), but severity overstated → corrected to LOW.**
The authorization gap exists (target user is never validated as an org
member), but the "cross-org / read any platform user's grants" framing is
inaccurate. No foreign-org tenant data is read or written.

## Evidence (real code)

### 1. Permission gate scopes to the org-in-URL (NOT cross-org)
`backend/apps/permissions/views.py:150`
```
permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]
```
`backend/apps/organizations/permissions.py:85-99` (`_OrgMembershipPermission.has_permission`):
the org is resolved from the URL kwarg (`org_uuid`/`slug`) and the requester
must have an **active ADMIN membership in THAT org**. An admin of Org X
therefore cannot reach Org Y's endpoint. So the breach is NOT a cross-tenant
(invariant #2) violation.

### 2. The actual defect: target user not validated as org member
`backend/apps/permissions/views.py:161-165`
```python
def get_target_user(self):
    from apps.accounts.models import User
    user_uuid = self.kwargs.get("user_uuid")
    return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
```
This loads **any platform-scoped User by UUID** with no check that the user is
a member of `org`. Neither the GET handler (`views.py:171-198`), the PUT
handler (`views.py:210-269`), nor the service layer enforces membership.

### 3. PUT writes ghost grant rows for non-members
`backend/apps/permissions/services/grants.py:135-213` (`bulk_set_grants`):
upserts `MembershipModuleGrant(user=target_user, organization=org, module=...)`
via `update_or_create` (lines 180-189) with **no membership precondition**.
Result: an admin can persist override rows for an arbitrary User UUID who is
not a member of their org (orphan/ghost grants in the admin's OWN org table).

### 4. GET leaks essentially nothing for non-members
`backend/apps/permissions/services/resolver.py:53-64,107-132`: for a target
with no active membership in `org`, `_user_active_roles` returns `set()` →
`_base_modules_for_roles` returns `set()` → `effective_modules` is empty
(plus any orphan override rows). So GET does not expose another org's
permission data. The only read signal is the `get_object_or_404`
existence oracle (200 if the User UUID exists, 404 if not) — a weak
user-enumeration leak.

### 5. No test covers the non-member / arbitrary-target case
`backend/apps/permissions/tests/test_matrix.py:226-362`: every test
(`test_put_grants_accepts_cells_shape`, the forbidden-role cases) sets the
`target` up as a real member via `OrganizationMembershipFactory`. There is
NO test asserting a target who is not a member is rejected — confirming the
guard was never written.

## Why severity is LOW, not HIGH
- Requester is gated to **their own org** (admin of that org); no cross-tenant
  isolation breach (invariant #2 holds).
- The resolver scopes all reads/writes by `(user, org)`; no foreign-org
  permission data is read.
- Realistic harm: (a) admin pre-seeds orphan override rows for arbitrary
  User UUIDs not in their org (data-integrity / ghost grants, harmless until
  that user later joins — at which point a stale override could silently apply,
  the one non-trivial risk), and (b) a weak User-existence enumeration oracle
  via 200-vs-404.
- It is a genuine missing-authorization-check (target object not validated
  against the tenant scope), so it should be fixed (add an
  `OrganizationMembership` existence check in `get_target_user` / the
  handlers), but it does not rise to high.

## Recommended fix (for the report)
In `get_target_user` (or both handlers), after resolving `org`, require an
active `OrganizationMembership(user=target_user, organization=org)` and return
404 otherwise — mirroring the membership check the requester themselves must
pass. Add a regression test for a non-member target.

## Confidence
0.9 — code paths read directly; conclusion follows from the `(user, org)`
scoping in the resolver and the absence of any membership guard.
