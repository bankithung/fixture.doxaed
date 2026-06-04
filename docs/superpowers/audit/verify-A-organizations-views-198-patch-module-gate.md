# Verify A — organizations/views.py:198 — OrgDetailView PATCH bypasses `org.settings` module gate

**Finding under test (severity claimed: high):**
> OrgDetailView PATCH bypasses org.settings module — deny override on that module has no effect.
> Missing Module Gate: OrgDetailView PATCH bypasses org.settings module.

**Verdict: REAL.** Severity corrected to **medium** (claimed high).

---

## What the real code shows

### 1. The PATCH guard checks role only — never the module

`backend/apps/organizations/views.py` lines 161-220. Class-level
`permission_classes = [IsAuthenticated]` (line 168) — no `HasModule`. The
PATCH handler authorizes with:

```python
198  def patch(self, request, slug_or_uuid: str):
199      if not _is_uuid(slug_or_uuid):
200          raise DRFValidationError("PATCH requires a UUID, not a slug.")
201      org = _resolve_org(slug_or_uuid)
202      # Admin/owner or super-admin only.
203      if not request.user.is_superuser:
204          if not OrganizationMembership.objects.filter(
205              user=request.user,
206              organization=org,
207              is_active=True,
208              role=MembershipRole.ADMIN,
209          ).exists():
210              raise PermissionDenied("Admin role required.")
211      ser = OrganizationUpdateSerializer(data=request.data, partial=True)
```

The only checks are `is_superuser` OR an active `role=ADMIN` membership row.
`effective_modules` / `has_module("org.settings")` is never consulted.

### 2. `org.settings` is a real catalog module governing this surface

- `backend/apps/permissions/fixtures/modules.json` lines 3-8: module
  `"org.settings"`, `category "org_scoped"`, description "Org name, slug …,
  timezone, public-page settings.", `default_for_roles: ["admin","co_organizer"]`.
- Scope is "org": `backend/apps/permissions/tests/test_matrix.py:84`
  `assert scope_for["org.settings"] == "org"`.
- The FE treats it as THE gate for this exact screen:
  `frontend/src/features/orgs/OrgSettingsPage.tsx:39`
  `const REQUIRED_MODULE = "org.settings";` (the PATCH-driven settings form).

### 3. Deny overrides ARE supposed to remove a role-default module

`backend/apps/permissions/services/resolver.py` lines 89-104:

```python
99   if state == GrantState.GRANT:
100       out.add(code)
101   elif state == GrantState.DENY:
102       out.discard(code)
```

So an admin (who gets `org.settings` by role default) can have it revoked by a
`MembershipModuleGrant(state=DENY)`. This is invariant #12's per-user override
layer (and is exercised by
`apps/permissions/tests/test_resolver_grant_overrides_role_default_deny.py`).

### 4. Conclusion of the chain

Because PATCH gates on `role=ADMIN` and never reads `effective_modules`, an
admin with a `DENY` grant on `org.settings` still passes line 204-210 and can
edit `name` / `time_zone` (lines 214-219). **The deny override has no effect on
this write endpoint** — exactly as the finding states. The module gate is
applied to sibling read endpoints (`OrgMembersListView`,
`OrgMembersBySlugView` use `HasModule("org.member_directory")`) but the
settings WRITE path was left role-only.

This contradicts invariant #12 ("modules govern surface visibility … the
per-user override layer (`MembershipModuleGrant`)") and the prior audit's own
note at `audit-fe-orgs-fe_contract.md:93-97`.

## Accuracy of the citation

- File correct. Line 198 = the `def patch(...)` signature; the bypass logic is
  lines 203-210 immediately below. Accurate enough to act on.
- Mechanism description ("bypasses org.settings module — deny override has no
  effect") is precisely correct.

## Severity assessment — corrected to medium

- It is a genuine RBAC-enforcement defect (an explicit deny is silently
  ineffective on a write path), so it is real and worth fixing.
- But blast radius is narrow: requires an *admin*-tier member whose module was
  deliberately denied; impact is limited to editing the org's own
  name/time_zone (not slug — that is a separate colon verb), within their own
  org. No cross-org leak (invariant #2 intact), no data exposure, no
  privilege *escalation* (the actor is already an admin).
- High is reserved for isolation breaks / escalation / data exposure. A
  same-org admin retaining the ability to edit two fields despite a module
  deny is medium.

## Recommended fix (for completeness, not part of verdict)

Extend the PATCH guard so non-superusers must satisfy
`is_org_owner OR has_module(user, org, "org.settings")` (mirror the FE's
intended `canEdit`), instead of bare `role=ADMIN`. Note the FE
(`OrgSettingsPage.tsx:140-151`) has a parallel weakness: `isAdminish`
short-circuits the module check, so it also ignores a deny — but that is a
separate FE finding; the BE gap stands on its own.

**Confidence: high (0.9).**
