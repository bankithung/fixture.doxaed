# Deep-Dive: Tenant Isolation (Pass 2)

**Scope:** Every `/api/...` endpoint (and the `/sadmin/...` HTML/JSON console) in the
Phase 1A backend. For each endpoint we construct the concrete cross-org attack
("user in Org A targets an Org B id") and state whether it succeeds, citing the
queryset / permission class / serializer line that decides the outcome.

**Method:** Full call-path tracing. For each endpoint we follow:
URL kwarg -> permission class `has_permission` -> org resolution -> queryset filter
-> serializer field exposure. Confidence is marked per finding.

**Invariant under test:** #2 "Multi-tenancy by Organization, day 1 — no cross-org
leak via any DRF / SSE / WebSocket endpoint." #12 "module RBAC default-deny."

---

## 0. Enumerated endpoint inventory

Routed from `backend/fixture/urls.py` under `/api/` plus `/sadmin/`.

| # | Method + path | View | Permission classes | Org-scoping mechanism |
|---|---|---|---|---|
| 1 | `POST /api/accounts/auth/signup/` | `signup` | `AllowAny` | n/a (creates own org) |
| 2 | `POST /api/accounts/auth/verify_email/` | `verify_email` | `AllowAny` | token-scoped |
| 3 | `POST /api/accounts/auth/login/` | `login_view` | `AllowAny` | n/a |
| 4 | `POST /api/accounts/auth/logout/` | `logout_view` | `IsAuthenticated` | self |
| 5 | `POST /api/accounts/auth/reauth/` | `reauth_view` | `IsAuthenticated` | self |
| 6 | `POST /api/accounts/auth/password_reset_request/` | — | `AllowAny` | email-scoped |
| 7 | `POST /api/accounts/auth/password_reset_complete/` | — | `AllowAny` | token-scoped |
| 8 | `POST /api/accounts/auth/2fa/enroll|confirm|disable|recovery_codes:regenerate/` | twofa_* | `IsAuthenticated` | self |
| 9 | `GET/PATCH /api/accounts/me/` | `me_view` | `IsAuthenticated` | self |
| 10 | `POST /api/accounts/users/{uuid}:soft_delete/` | `user_soft_delete_view` | `IsAuthenticated` + in-body superuser check | super-admin only |
| 11 | `GET/POST /api/orgs/` | `OrgListCreateView` | `IsAuthenticated` | `user_org_ids()` filter / superuser |
| 12 | `GET/PATCH /api/orgs/{slug_or_uuid}/` | `OrgDetailView` | `IsAuthenticated` | in-view membership check |
| 13 | `POST /api/orgs/{uuid}:change_slug/` | `OrgChangeSlugView` | `IsAuthenticated, IsOrgAdminOrOwner` | permission resolves org |
| 14 | `POST /api/orgs/{uuid}:suspend|unsuspend/` | `OrgSuspend/Unsuspend` | `IsAuthenticated, IsSuperUser` | super-admin only |
| 15 | `POST /api/orgs/{uuid}:archive/` | `OrgArchiveView` | `IsAuthenticated` + in-view owner check | owner/superuser |
| 16 | `POST /api/orgs/{uuid}:transfer_ownership/` | `OrgTransferOwnershipView` | `IsAuthenticated, IsOrgOwner` | permission resolves org |
| 17 | `GET /api/orgs/{uuid}/members/` | `OrgMembersListView` | `IsAuthenticated, HasModule("org.member_directory")` | `get_queryset` filters org |
| 18 | `DELETE /api/orgs/{uuid}/members/{membership_id}/` | `OrgMemberRemoveView` | `IsAuthenticated, IsOrgAdminOrOwner` | `get_object_or_404(... organization=org)` |
| 19 | `GET/POST /api/orgs/{uuid}/invitations/` | `OrgInvitationsView` | `IsAuthenticated, IsOrgAdminOrOwner` | `filter(organization=org)` |
| 20 | `POST /api/orgs/{uuid}/invitations/{id}:revoke/` | `OrgInvitationRevokeView` | `IsAuthenticated, IsOrgAdminOrOwner` | `get_object_or_404(... organization=org)` |
| 21 | `POST /api/invitations:accept/` & `/api/orgs/invitations/accept/` | `InvitationAccept(ByPath)View` | `IsAuthenticated` | token-scoped |
| 22 | `GET /api/orgs/{slug}/members/` | `OrgMembersBySlugView` | `IsAuthenticated, HasModule("org.member_directory")` | `filter(organization=org)` |
| 23 | `GET/POST /api/orgs/{slug}/invitations/` | `OrgInvitationsBySlugView` | `IsAuthenticated, IsOrgAdminOrOwner` | `filter(organization=org)` |
| 24 | `DELETE /api/orgs/{slug}/invitations/{id}/` | `OrgInvitationByIdSlugView` | `IsAuthenticated, IsOrgAdminOrOwner` | `get_object_or_404(... organization=org)` |
| 25 | `POST /api/orgs/{slug}/ownership/transfer/` | `OwnershipTransferBySlugView` | `IsAuthenticated, IsOrgOwner` | permission resolves org |
| 26 | `GET /api/permissions/modules/` | `ModuleCatalogView` | `IsAuthenticated` | global catalog (not tenant data) |
| 27 | `GET /api/permissions/me/modules/?org=` | `MyEffectiveModulesView` | `IsAuthenticated` | **no membership check** |
| 28 | `GET /api/permissions/orgs/{slug}/me/modules/` | `MyModulesBySlugView` | `IsAuthenticated` | **no membership check** |
| 29 | `GET/PUT /api/permissions/orgs/{org_uuid}/users/{user_uuid}/grants/` | `UserGrantsView` | `IsAuthenticated, IsOrgAdminOrOwner` | **target-user org-membership NOT checked** |
| 30 | `GET/PUT /api/permissions/orgs/{slug}/users/{user_uuid}/grants/` | `UserGrantsBySlugView` | `IsAuthenticated, IsOrgAdminOrOwner` | **target-user org-membership NOT checked** |
| 31 | `GET /api/permissions/orgs/{slug}/grants/matrix/` | `MatrixView` | `IsAuthenticated, IsOrgAdminOrOwner` | `build_matrix(org)` filters org |
| 32 | `GET /api/audit/orgs/{slug}/` | `OrgAuditListView` | `IsAuthenticated, HasModule("org.audit_log")` | `filter(organization_id=org.id)` |
| 33 | `GET /api/sports/` & `/api/sports/{code}/` | `SportList/Detail` | `AllowAny` | global metadata (intentional) |
| 34 | `POST /api/feedback/submit/` | `FeedbackSubmitView` | (see app) | self/public |
| 35 | `/sadmin/...` (all) | sadmin views | `@superadmin_required` | super-admin only (cross-org by design) |

---

## Per-endpoint cross-org attack analysis

### Group A — Endpoints that PASS (correctly isolated)

**#11 `GET /api/orgs/`** — `OrgListCreateView.get`
`backend/apps/organizations/views.py:129-135`:
```python
org_ids = OrganizationMembership.objects.user_org_ids(request.user)
qs = Organization.active_objects.filter(id__in=list(org_ids))
```
`user_org_ids` filters `user=user, is_active=True` (`organizations/models.py:93-98`).
**Attack** (Org A user lists orgs) returns only their own orgs. **PASS.** High confidence.

**#12 `GET /api/orgs/{slug_or_uuid}/`** — `OrgDetailView.get`
`organizations/views.py:187-191` enforces membership-or-superuser before returning:
```python
if not OrganizationMembership.objects.filter(
        user=request.user, organization=org, is_active=True).exists():
    raise PermissionDenied("Not a member of this organization.")
```
**Attack** (Org A user GETs Org B's uuid) -> 403. **PASS.** High confidence.
PATCH path (`:198-220`) additionally requires an active `ADMIN` row in that org. **PASS.**

**#13/#16/#25 verb endpoints with `IsOrgAdminOrOwner` / `IsOrgOwner`** —
`organizations/permissions.py:78-99`. `_resolve_org_from_view` (`:28-66`) reads the
URL's `uuid`/`org_uuid`/`slug` and checks an active matching-role membership in
*that* org. **Attack** (Org A admin targets Org B uuid) -> permission resolves Org B,
finds no Org A->admin membership in Org B -> 403. **PASS.** High confidence.

**#17/#22 members list** — `OrgMembersListView` / `OrgMembersBySlugView`.
Queryset is explicitly `filter(organization=..., is_active=True)`
(`organizations/views.py:362-365` and `:519-525`). `HasModule("org.member_directory")`
resolves the same org via `get_organization()` (`views.py:359-360` / `:513-514`).
**Attack** (Org A admin lists Org B members) -> `HasModule` calls
`view.get_organization()` = Org B, then `has_module(user, OrgB, "org.member_directory")`
-> attacker has no roles/grants in Org B -> `effective_modules` empty -> 403.
**PASS.** High confidence.

**#18/#20/#24 nested member/invitation by id** — all use
`get_object_or_404(..., organization=org)` where `org` is the URL org
(`views.py:374-376`, `:444-446`, `:606-608`). A membership/invitation id from Org B
will NOT match `organization=OrgA`, so the lookup 404s; and the `IsOrgAdminOrOwner`
gate already requires Org-A admin. **Cross-org id -> 404, not action.** **PASS.**
High confidence.

**#19/#23 invitations list/create** — `filter(organization=org)` (`views.py:413`,
`:563`), gated by `IsOrgAdminOrOwner` resolving the same org. **PASS.**

**#31 matrix** — `MatrixView` gated by `IsOrgAdminOrOwner` (`permissions/views.py:354`),
`build_matrix(org)` filters `organization=organization` for both memberships
(`matrix.py:89-95`) and grants (`matrix.py:105-110`). Attacker must be admin of the
URL org to pass the gate. **PASS.** High confidence.

**#32 audit feed** — `OrgAuditListView`. Queryset `filter(organization_id=org.id)`
(`audit/views.py:129`), gated by `HasModule("org.audit_log")` resolving the same org
(`audit/views.py:103-107`). Cross-org request -> attacker lacks the module in Org B
-> 403. **PASS.** Cursor/filter params (`actor_id`, `event_type`) all apply AFTER the
org filter, so no leak via filters. High confidence.

**#14 suspend/unsuspend, #35 all `/sadmin/`** — super-admin only by design
(`IsSuperUser`, `@superadmin_required`). Cross-org is the intended super-admin power.
Not a tenant-isolation violation. **PASS / out of scope.**

**#33 sports, #26 module catalog** — global platform metadata, not tenant-scoped data.
`ModuleSerializer` exposes only catalog rows (`permissions/serializers.py:9-15`), no
org data. **PASS / not applicable.**

---

### Group B — FINDINGS (isolation gaps / integrity gaps)

---

#### FINDING 1 (HIGH) — Org admin can write module grants for users who are NOT members of their org (cross-account grant injection + privilege grant to outsiders)

**Endpoints:** #29 `PUT /api/permissions/orgs/{org_uuid}/users/{user_uuid}/grants/`
and #30 the slug alias.

**Files:**
- View: `backend/apps/permissions/views.py:210-269` (`UserGrantsView.put`)
- Target lookup: `backend/apps/permissions/views.py:161-165`
  ```python
  def get_target_user(self):
      from apps.accounts.models import User
      user_uuid = self.kwargs.get("user_uuid")
      return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
  ```
- Write path: `backend/apps/permissions/services/grants.py:135-213` (`bulk_set_grants`)
- Effect on resolution: `backend/apps/permissions/services/resolver.py:89-104`
  (`_apply_overrides` adds the module **regardless of membership**)

**Call path:** `IsOrgAdminOrOwner` (`views.py:150`) resolves the org from the URL's
`org_uuid` kwarg and verifies the *attacker* is an active admin of **that** org
(`permissions.py:91-99`). That check is correct — the attacker must be admin of Org A.
**But the target user is fetched by global PK with no org-membership predicate**
(`views.py:165`). `bulk_set_grants` then upserts
`MembershipModuleGrant(user=<any user>, organization=OrgA, module=...)`
(`grants.py:180-189`). The unique key is `(user, organization, module)`
(`models.py:144-149`) so the row persists for any platform user.

**Concrete attack:** Mallory is admin of Org A. Victim Vic is a member of Org B and
has *no* relationship to Org A. Mallory calls:
```
PUT /api/permissions/orgs/{ORG_A_UUID}/users/{VIC_UUID}/grants/
{ "cells": {"org.audit_log": "grant"}, "reason": "x"*20 }
```
- The gate passes (Mallory is Org A admin).
- A `MembershipModuleGrant(user=Vic, organization=OrgA, module=org.audit_log, state=grant)`
  row is written.
- `effective_modules(Vic, OrgA)` now returns `{"org.audit_log", ...}` because
  `_apply_overrides` adds granted codes with **no membership requirement**
  (`resolver.py:98-100`). Vic, who was never a member of Org A, now passes
  `HasModule("org.audit_log")` for Org A and can read Org A's audit feed (#32).

**Does it succeed?** YES. This is an integrity + privilege-escalation gap:
1. An Org A admin can pollute the grant table of *arbitrary* platform users
   (including Org B members and brand-new users), writing audit rows attributed to
   them and persisting rows keyed to those users.
2. Combined with the membership-free `_apply_overrides`, it can hand a non-member an
   effective module in Org A, defeating default-deny (invariant #12) for that user.

It is *contained to Org A's data surface* (the grant is org=OrgA), so it is not a
read-leak of Org B data by itself; the severity is privilege-grant-to-outsider +
write-amplification on other users' records. **Confidence: HIGH** (path fully traced).

**Also note (same endpoint, GET):** `UserGrantsView.get` (`views.py:171-198`) returns
`MembershipModuleGrant.objects.filter(user=target_user, organization=org)` for an
arbitrary `user_uuid` with no membership check. An Org A admin can probe whether any
platform user has grants in Org A (always empty for true outsiders, so low info-leak),
but the lack of a target-membership guard is the same root cause.

**Fix:** In `get_target_user` / before the write, require an active
`OrganizationMembership(user=target, organization=org)` (404/400 otherwise), mirroring
the `organization=org` predicate used everywhere else
(e.g. `OrgMemberRemoveView` at `views.py:374-376`). Add a multi-tenancy isolation test
parametrized over (attacker-org, target-user-org) per CLAUDE.md "isolation tests are
not optional."

---

#### FINDING 2 (MEDIUM) — `MyEffectiveModulesView` / `MyModulesBySlugView` resolve any org with no membership check (org-existence oracle; defense-in-depth gap)

**Endpoints:** #27 `GET /api/permissions/me/modules/?org={uuid}` and
#28 `GET /api/permissions/orgs/{slug}/me/modules/`.

**Files:**
- `backend/apps/permissions/views.py:111-136` (`MyEffectiveModulesView.get`)
- `backend/apps/permissions/views.py:295-300` (`MyModulesBySlugView.get`)

```python
# views.py:128-136
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, status=404)
modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

**Call path:** Permission is only `IsAuthenticated`. The view loads *any* org by id/slug
and calls `effective_modules(request.user, org)`. Because it only returns the
*requester's own* module set, a true outsider gets `[]` (no roles, no grants ->
`_user_active_roles` empty -> `_base_modules_for_roles` empty,
`resolver.py:53-86`). So **no other tenant's data leaks.**

**What does leak:** org existence + (for the UUID variant) a 200-with-`[]` vs 404
distinction lets any authenticated user enumerate which org UUIDs/slugs exist
(`views.py:128-133`). The slug variant raises `Http404` for missing orgs
(`views.py:298`) but 200 for existing ones, an existence oracle by slug.
**Confidence: HIGH that it is not a data-leak; MEDIUM that the existence oracle matters**
(slugs appear in public URLs anyway, so practical impact is limited). It is still a
defense-in-depth deviation: every other tenant endpoint refuses non-members; this one
silently returns 200. If a future change makes `effective_modules` return anything
membership-independent (as Finding 1 already does for granted outsiders), this becomes a
real leak. **Fix:** return 403/404 when the requester has no active membership in the
target org.

---

#### FINDING 3 (LOW) — `HasModule` swallows all exceptions in `get_organization()` and fails open to "org is None -> 403", but masks 500s; plus `IsOrg*` permissions "fail open" when org cannot be resolved

**Files:**
- `backend/apps/permissions/permissions.py:61-66`:
  ```python
  if hasattr(view, "get_organization"):
      try:
          return view.get_organization()
      except Exception:
          return None
  ```
- `backend/apps/organizations/permissions.py:85-89`:
  ```python
  org = _resolve_org_from_view(view)
  if org is None:
      # Resource-level views without an org slug pass through here ...
      return True
  ```

**Analysis:** Two distinct behaviours:

(a) `HasModule._resolve_organization` catches **every** exception from
`get_organization()` and returns `None`, which `has_permission` maps to a 403
(`permissions.py:46-50`). This *fails closed* for auth (good) but hides genuine errors
(e.g. a malformed slug raising inside `_resolve_org`) as a generic 403, complicating
detection of probing. Not directly exploitable for cross-org access. **Confidence: HIGH**
on behaviour, **LOW** on security impact.

(b) The `_OrgMembershipPermission` base **returns `True` when no org can be resolved**
(`organizations/permissions.py:86-89`). For the endpoints in this codebase the org is
*always* present in the URL, and the views then re-resolve and 404 on a bad org, so this
"pass-through" is currently masked by view-level checks. **However it is a latent
isolation hazard**: any *future* view that attaches `IsOrgAdminOrOwner` but does NOT
also re-check the org in the body would grant access to authenticated non-admins when
org resolution yields `None`. Recommend changing the default to `return False`
(default-deny, invariant #12) and making org-less resource views opt in explicitly.
**Confidence: HIGH on the code path; LOW on present exploitability** (no current view is
reachable with a missing org kwarg).

---

### Group C — Secondary observations (not isolation breaks, noted for completeness)

- **#10 `user_soft_delete`** correctly gates on `actor.is_superuser` in-body
  (`accounts/views.py:454-455`) before touching any user; not org-scoped. PASS.
- **#15 archive** re-checks owner-or-superuser in-view (`organizations/views.py:294-303`)
  in addition to `IsAuthenticated`; cross-org uuid -> the owner check fails -> 403. PASS.
- **#21 invitation accept** is token-scoped; the accepting user is bound by the token,
  not by URL org. Cross-org acceptance is impossible without the secret token. PASS
  (token-validation logic in `services/invitation.py` not re-audited here — flagged for
  a token-replay/expiry deep-dive).
- **`GrantRowSerializer`** (`permissions/serializers.py:18-34`) exposes `granted_by`
  (a user UUID) and `reason`. When Finding 1 is fixed this is moot; until then a GET on
  #29 could surface another org-admin's UUID/reason if a grant existed — minor.
- **Cache key correctness:** `effective_modules` caches per `(user_id, org_id)`
  (`resolver.py:37-39`), so there is no cross-org cache bleed. PASS.

---

## Summary table

| Finding | Severity | Endpoint(s) | Root cause (file:line) | Succeeds? |
|---|---|---|---|---|
| 1 | HIGH | #29/#30 grants PUT/GET | target user fetched globally, no org-membership check — `permissions/views.py:165` + `resolver.py:98-100` | YES |
| 2 | MEDIUM | #27/#28 me/modules | no membership check before `effective_modules` — `permissions/views.py:128-136`, `:295-300` | Existence oracle only (no data leak today) |
| 3 | LOW | base permission classes | `IsOrg*` returns True on unresolved org — `organizations/permissions.py:86-89`; `HasModule` swallows exceptions — `permissions/permissions.py:61-65` | Latent (not reachable today) |

All Group A endpoints (the bulk of the surface) are correctly org-scoped via either a
`filter(organization=...)` queryset, a `get_object_or_404(..., organization=org)`
predicate, or a membership-checking permission class. The single material gap is the
**grants write/read endpoint's missing target-user org-membership check** (Finding 1).
