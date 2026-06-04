# Cross-cutting audit — Invariant 2 (Multi-tenancy by Organization)

Scope: whole backend + frontend (excl. `backend/.venv`, `frontend/node_modules`).
Invariant under test: **every tenant-scoped model carries an `organization` FK; every
queryset filters by accessible orgs; no cross-org leak via any endpoint; an isolation
test exists per endpoint.**

Date: 2026-06-04. Method: direct Read/Grep/Glob of real files. Confidence noted per finding.

---

## Executive summary

Phase 1A is structurally **sound** on invariant 2. Every Phase 1A tenant-scoped model
(`OrganizationMembership`, `AdminInvitation`, `SlugRedirect`, `MembershipModuleGrant`)
carries an `organization` FK, and `AuditEvent` / `UsageEvent` carry an `organization_id`
column. API endpoints enforce org boundaries through DRF permission classes
(`IsOrgMember` / `IsOrgAdminOrOwner` / `IsOrgOwner` / `HasModule(...)`) that resolve the
org from the URL and check membership/module, plus explicit `.filter(organization=org)`
in view bodies. The audit list endpoint has a real cross-org-leak test.

However the **mechanism is ad-hoc, not the sanctioned one**, and several gaps will
become real leaks the moment Phase 1B models land if not fixed first:

1. There are **two divergent scope implementations** (`apps/organizations/scope.py` and
   `apps/permissions/scope.py`); the project doc names the permissions one as canonical,
   and the organizations one is **dead, unused, and behaviourally different** (filters
   on `ORG_FIELD` default `organization`, no `module_gated`). No model uses either.
2. The canonical `ScopedManager`/`ScopedQuerySet` is **not wired into a single model** —
   all Phase 1A querysets hand-roll `.filter(organization=...)`, the exact "code-smell"
   the scope module's own docstring warns against.
3. `_OrgMembershipPermission.has_permission` **fail-opens** (`return True`) when the org
   can't be resolved from the URL — safe today only because every view body also 404s,
   but a latent footgun for Phase 1B views that rely on the permission alone.
4. Per-endpoint cross-org isolation tests are **missing for most endpoints** (org
   detail, members, invitations, grants, matrix, me/modules). Only audit has one.
5. The scope-queryset tests **don't actually exercise row-level filtering** on a child
   model — they only assert on the `_user_org_ids` helper.

None of these **block** Phase 1B, but #1/#2/#3 are prep gaps that should be closed before
the first tenant-scoped Phase 1B model (Tournament) is written, or every new model will
copy the ad-hoc pattern.

---

## Findings

### F1 — Two divergent, duplicated scope implementations; one is dead code
**Severity: high · Category: maintainability / latent-leak · Confidence: high**

`apps/organizations/scope.py` and `apps/permissions/scope.py` both implement an
"org scope filter" but with different APIs and semantics:

- `apps/permissions/scope.py:64` — `scoped_for_user(user)`, filters on
  `organization_id__in`, plus `module_gated(...)` (permissions/scope.py:77). Has a
  `ScopedManager` (line 114). This is the one the project doc + this file's own
  docstring call canonical: "This is THE ONLY sanctioned way to filter by org —
  hand-rolled `.filter(organization__in=...)` callsites are a code-smell" (scope.py:5-7).
- `apps/organizations/scope.py:21` — `ScopedQuerySetMixin.scoped_for(user)` (note the
  **different method name**), filters on `f"{ORG_FIELD}__in"` (scope.py:50), **no
  `module_gated`**, no `ScopedManager`. Docstring claims it is "the mixin every
  tenant-scoped QuerySet plugs into" (scope.py:3) — contradicting the permissions one.

Grep confirms `apps/organizations/scope.py` is imported by **nothing** outside its own
file (no test, no model, no view references `organizations.scope`).

Why it matters: Phase 1B authors will pick one of two contradictory "canonical" modules.
The org one lacks module-gating and uses a different method name, so a model wired to it
silently bypasses module-level RBAC (invariant 12) and breaks the documented call
convention. Two sources of truth for the tenant boundary is exactly how cross-org leaks
get introduced.

Fix: Delete `apps/organizations/scope.py` (or re-export from it: `from
apps.permissions.scope import ScopedManager, ScopedQuerySet`). Keep `apps/permissions/scope.py`
as the single source. Update `apps/organizations/scope.py:1` docstring references.

---

### F2 — Canonical ScopedManager/ScopedQuerySet is wired into zero models
**Severity: medium · Category: prep-gap / consistency · Confidence: high**

Every Phase 1A tenant-scoped model declares a plain manager, not the scoped one:

- `apps/organizations/models.py:145-146` — `objects = OrganizationManager()`,
  `active_objects = ActiveOrganizationManager()` (no scope).
- `apps/organizations/models.py:197` — `OrganizationMembership.objects =
  OrganizationMembershipManager()` (no scope).
- `apps/permissions/models.py` — `Module` / `MembershipModuleGrant` use the default
  manager.

Consequently all org filtering is hand-rolled in view bodies, e.g.:
- `apps/organizations/views.py:133-134` — `OrganizationMembership.objects.user_org_ids(...)`
  then `Organization.active_objects.filter(id__in=...)`.
- `apps/organizations/views.py:363-365` — `OrganizationMembership.objects.filter(
  organization=self.get_organization(), is_active=True)`.
- `apps/audit/views.py:129` — `AuditEvent.objects.filter(organization_id=org.id)`.

These are correct today, but they are the "code-smell the multi-tenancy isolation tests
will catch" per `apps/permissions/scope.py:6-7`. Each new callsite is a place a `.filter`
can be forgotten.

Why it matters: invariant 2 says "default managers filter by accessible orgs." Today the
default manager filters nothing; safety depends on every author remembering to filter.
For Phase 1B (Tournament/Team/Match/etc.) the spec pattern (`Tournament.objects =
ScopedManager.from_queryset(TournamentQuerySet)()`) must be the default or a leak is one
missing `.filter()` away.

Fix: Adopt `ScopedManager` on tenant-scoped models (at minimum for new Phase 1B models;
ideally retrofit `OrganizationMembership` / `MembershipModuleGrant` with a scoped manager
+ keep the convenience `user_org_ids`). Add a CI guard that asserts every model with an
`organization` FK exposes `scoped_for_user`.

---

### F3 — Org-membership permission classes fail-open when org is unresolved
**Severity: medium · Category: access-control / latent-leak · Confidence: high**

`apps/organizations/permissions.py:85-89`:

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

`IsOrgMember` / `IsOrgAdminOrOwner` / `IsOrgOwner` all inherit this. When the URL kwarg
doesn't resolve to an org (unknown slug, or a view that simply has no org kwarg), the
permission **grants access** and defers to "the queryset layer." That is safe for the
current views only because each view body independently calls `_resolve_org(...)` /
`get_object_or_404` and 404s. There is no enforced contract guaranteeing the body filters.

Why it matters: any Phase 1B view that relies solely on `IsOrgAdminOrOwner` (the
documented usage) and forgets to re-filter in the body is wide open. A fail-open default
in a tenant-boundary permission is the highest-leverage place for a future cross-org leak.

Fix: Change the default to fail-closed (`return False`) for the org-scoped classes, and
introduce a separate explicit "resource-level, no org context" base for the few views
that legitimately have no org kwarg. Add a test asserting an unknown slug → 403/404 on
each gated endpoint.

---

### F4 — `MyEffectiveModulesView` returns 200 for orgs the user isn't a member of (org-existence leak)
**Severity: low · Category: enumeration / minor-leak · Confidence: high**

`apps/permissions/views.py:128-136`: the view loads **any** org by UUID with no
membership check —

```python
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response(..., status=404)
modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

`effective_modules` returns an empty frozenset for a non-member (no roles → empty base,
resolver.py:126-128), so no *data* leaks — but the **status code distinguishes** an
existing org (`200 {"modules": []}`) from a non-existent one (`404`). A logged-in user
can enumerate which org UUIDs exist. The slug variant `MyModulesBySlugView`
(permissions/views.py:295-300) has the same shape (404 only when slug missing).

Why it matters: minor org-existence enumeration; not a data leak. Inconsistent with the
audit/members endpoints which 403 for non-members.

Fix: Return `{"modules": []}` (or 403) uniformly whether or not the org exists, OR
require active membership before responding 200. Prefer: if the user has no active
membership in the org, return 403 to match sibling endpoints.

---

### F5 — `UserGrantsView` accepts any target user UUID, not scoped to org membership
**Severity: low · Category: enumeration · Confidence: medium**

`apps/permissions/views.py:161-198`: GET/PUT `/orgs/{org}/users/{user_uuid}/grants/` is
admin-gated for the *org* (`IsOrgAdminOrOwner`), but `get_target_user()` does
`get_object_or_404(User, id=...)` for **any** platform user (views.py:165). An org admin
can probe whether an arbitrary user UUID exists (404 vs 200-with-empty-grants). The
returned grants/effective-modules are correctly scoped to the admin's org, so no
cross-org data leaks; only user-existence is observable.

Why it matters: low — user-existence enumeration by an authenticated org admin. No
membership-in-this-org check on the target.

Fix: 404 the target if they have no `OrganizationMembership` in this org (and no existing
grant rows for this org), so a non-member target is indistinguishable from a missing one.

---

### F6 — Cross-org isolation tests exist for only one endpoint
**Severity: high · Category: test-coverage · Confidence: high**

CLAUDE.md / invariant 2: "Multi-tenancy isolation tests are not optional. Every endpoint
must be covered by a test that asserts user A in Org X cannot access org Y data."

Reality (Grep over `**/test_*.py`):
- Only `apps/audit/tests/test_audit_list_view.py:120` (`test_cross_org_leak_blocked`)
  is a true per-endpoint cross-org test.
- `test_matrix.py` has member-vs-non-member 403 tests
  (`test_matrix_get_forbidden_for_member_with_no_role`, line 305) but **no Org-X-admin →
  Org-Y 403** assertion.
- No cross-org test for: `GET/PATCH /api/orgs/{id}/` (OrgDetailView),
  `GET /api/orgs/{id}/members/`, `GET/POST /api/orgs/{id}/invitations/`,
  invitation revoke, member remove, `me/modules`, `users/.../grants/`.

Why it matters: the invariant explicitly mandates per-endpoint isolation tests; absence
means a regression that drops a `.filter(organization=...)` would pass CI.

Fix: Add a parametrized "Org X actor must get 403/404 (and zero Org-Y rows) on every
org-scoped endpoint" suite, mirroring `test_cross_org_leak_blocked`.

---

### F7 — Scope-queryset tests don't exercise row-level filtering on a child model
**Severity: medium · Category: test-quality · Confidence: high**

`apps/permissions/tests/test_scope_queryset.py` and `test_module_gated_queryset.py` test
the tenant boundary only via the `_user_org_ids` helper and `effective_modules`, never by
constructing a real child model with an `organization` FK and asserting
`Model.objects.scoped_for_user(user_X)` excludes Org-Y rows. The tests even acknowledge
this: "Cleaner: define a fake OrgScopedThing model in a test app ... more ceremony than
needed" (test_scope_queryset.py:22-23) and the helper `_build_scoped_queryset`
(test_scope_queryset.py:26-31) is defined but **never called**.

Why it matters: the canonical scope filter's actual `.filter(organization_id__in=...)`
behaviour (permissions/scope.py:75) is unverified end-to-end. `module_gated` row output
(permissions/scope.py:111) is likewise never asserted to return/exclude rows.

Fix: Add a tiny test-only model (or use `MembershipModuleGrant`, which has an
`organization` FK) and assert `scoped_for_user` / `module_gated` return exactly the
Org-X rows and exclude Org-Y rows, including the superuser-bypass and anonymous paths.

---

### F8 — `OrgListCreateView.post` is super-admin-only, conflicting with the LOCKED self-serve org-creation decision
**Severity: medium · Category: product-vs-invariant drift · Confidence: medium**

`apps/organizations/views.py:142-143`: `POST /api/orgs/` raises `PermissionDenied`
unless `request.user.is_superuser`. The LOCKED product decision is "self-serve signup,
NO super-admin approval gate; creating a tournament auto-provisions the creator's
personal workspace (Organization)." Org creation today flows through signup
(`apps/accounts/views.py:90` `signup`, which provisions a pending-review org) — so the
self-serve path exists — but the direct `POST /api/orgs/` create endpoint is locked to
super-admin, which will conflict with the planned "create tournament → auto-provision
workspace org" path in Phase 1B.

Why it matters: not strictly an invariant-2 leak, but it is a multi-tenancy *provisioning*
mismatch flagged because the locked flow makes Organization the hidden tenant created on
tournament creation. If Phase 1B calls a service that ends up here, it will 403.

Fix: When Phase 1B lands tournament-auto-provisioning, route org creation through a
service callable by an authenticated non-super-admin (or relax this endpoint). Confirm
against the (to-be-written) tournament spec before changing. Marked medium/medium pending
that spec.

---

## Phase 1B readiness (does 1A block invariant-2 work?)

**No hard blockers.** The chassis pieces invariant 2 needs in Phase 1B exist:

- `ScopedManager`/`ScopedQuerySet` (permissions/scope.py) with `scoped_for_user` +
  `module_gated` is ready to attach to Tournament/Team/Match models.
- `HasModule(module_code)` permission factory (permissions/permissions.py:30) supports a
  `get_organization()` hook for nested resources — the documented Phase 1B pattern.
- `OrganizationMembership.objects.user_org_ids(user)` (organizations/models.py:87) and
  `effective_modules(user, org)` (resolver.py:107) are the building blocks for row scope.
- `AuditEvent` already carries `tournament_id` / `match_id` columns
  (audit/models.py:64-65) for Phase 1B scope.

**Prep gaps to close before the first tenant-scoped Phase 1B model:**

1. Resolve the two-scope-module split (F1) so there is exactly one canonical scope helper.
2. Make `ScopedManager` the default manager on new tenant-scoped models (F2) and add a
   CI guard ("every model with an `organization` FK exposes `scoped_for_user`").
3. Fix the fail-open permission default (F3) before any view relies on the permission
   class alone.
4. Stand up the parametrized per-endpoint cross-org isolation suite (F6) and a real
   row-level scope test harness (F7) so Phase 1B endpoints inherit the test pattern.
5. `module_gated` loops `effective_modules` per org in Python (permissions/scope.py:104-108);
   fine at "<= 50 orgs per user" but document/verify the N-bound before Match-scale lists.
6. No `apps/live` app exists yet — SSE/WS channel scoping (invariant 11) is unbuilt;
   when built, the `match:<uuid>` / `user:<uuid>:notifications` channels must enforce the
   same org boundary on subscribe (out of scope for 1A but the isolation-test pattern from
   F6 should extend to SSE/WS endpoints per invariant 2's "via any ... SSE/WebSocket endpoint").

---

## Models inventory (org-FK presence)

| Model | File:line | Tenant-scoped? | org FK / column | Verdict |
|---|---|---|---|---|
| Organization | organizations/models.py:111 | is the tenant | n/a (id == org) | OK |
| OrganizationMembership | organizations/models.py:177 | yes | `organization` FK | OK (FK present; manager not scoped — F2) |
| AdminInvitation | organizations/models.py:259 | yes | `organization` FK | OK |
| SlugRedirect | organizations/models.py:345 | yes | `organization` FK | OK |
| Module | permissions/models.py:42 | no (global catalog) | none (correct) | OK |
| MembershipModuleGrant | permissions/models.py:107 | yes | `organization` FK | OK |
| AuditEvent | audit/models.py:63 | yes (org-tagged) | `organization_id` UUID col | OK (nullable by design) |
| Feedback | sadmin/models.py:42 | no (platform/super-admin) | none | OK (super-admin only) |
| UsageEvent | sadmin/models.py:105 | partial | `organization_id` UUID col | OK |
| KPISnapshot | sadmin/models.py:142 | no (platform rollup) | none | OK |
| Sport | sports/models.py | no (global metadata) | none | OK (public catalog) |
| User | accounts/models.py:66 | platform identity | `last_active_org_id` (pointer) | OK (not tenant-scoped) |

No tenant-scoped model is **missing** an org FK. The invariant-2 risk is in the
*enforcement mechanism* (F1-F3) and *test coverage* (F6-F7), not the schema.
