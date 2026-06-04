# Deep-Dive: RBAC Resolver + Module System (Pass 2)

**Date:** 2026-06-04
**Scope:** `apps.permissions` (resolver, permission classes, grants service, matrix, scope querysets) + `apps.organizations` (membership permission classes, invitation/ownership services, views) — full call-path tracing for privilege-escalation, fail-open, and default-deny gaps.
**Method:** Read every node in the effective-modules call graph + every permission class/decorator that gates a state-changing verb. Reasoned about exploitability end-to-end. Builds on pass-1 (`audit-permissions-security.md`, `verify-A-permissions-usergrants-idor.md`) — items already covered there are referenced, not re-litigated; this pass adds **new** escalation paths and reasons about chains.

---

## A. The effective_modules() call graph (traced)

```
HasModule(code).has_permission              permissions.py:39
  └─ has_module(user, org, code)            resolver.py:135
       └─ effective_modules(user, org)      resolver.py:107
            ├─ cache.get(key)               resolver.py:122   (LocMem/Redis)
            ├─ _user_active_roles           resolver.py:53   → OrganizationMembership.filter(is_active=True)
            ├─ _base_modules_for_roles      resolver.py:67   → Module.default_for_roles ∩ roleset
            └─ _apply_overrides             resolver.py:89   → MembershipModuleGrant grant/deny
ScopedQuerySet.module_gated                 scope.py:77      → effective_modules per-org loop
MyEffectiveModulesView.get                  views.py:135     → effective_modules (direct)
UserGrantsView.get/put                      views.py:191,266 → effective_modules (direct, target user)
```

**Layering reality (matches invariant #12):** Layer-1 = role→module union (default-deny: a module not in any active role's `default_for_roles` is OFF). Layer-2 = `MembershipModuleGrant` grant/deny override, keyed `(user, org, module)`. The `(user,org)` keying (models.py:83-98) is correct and the multi-role-deny regression is covered by `test_resolver_grant_overrides_role_default_deny.py`. **The module layer itself is sound.** The escalation surface is almost entirely in the *authorization gates around the grant-write and invite verbs*, and in the *fail-open resolution helpers* — not in the union math.

---

## NEW FINDING N1 — CRITICAL (escalation chain): grant-write verb is module-blind, so an org Admin can self-mint any module via the grant matrix, and there is NO module that is "admin-reserved" at the data layer

**Files:** `services/grants.py:53-213` (`set_grant` / `bulk_set_grants`), `views.py:210-269` (`UserGrantsView.put`), `permissions.py:30-83` (`HasModule`).

**The gap:** `bulk_set_grants` accepts **any** `(module_code, state)` pair and upserts it. There is **no allow-list of grantable modules**, no check that the granting admin themselves holds the module, and **no concept of an "admin-only" / non-grantable module**. The only gate is `IsOrgAdminOrOwner` on the view (`views.py:150`). Consequences traced through the full graph:

1. **Self-grant of every surface.** An admin (or owner) can PUT `cells={every module: "grant"}` targeting **their own** `user_uuid`. `bulk_set_grants` writes 22 grant rows; `effective_modules` for that admin now returns the full catalog regardless of role. This is *within* their org so it is not a tenant breach, but it means the module layer provides **zero containment of an admin** — every "module-gated" surface (`match.scoring_console`, `match.referee_console`, `tournament.bracket_editor`, etc.) collapses to "admin can self-enable." Any future code that trusts `has_module(...)` as a *separation-of-duty* control (e.g., "only the assigned scorer/referee may touch this match") is defeated by an admin self-grant. The catalog comment in `match.referee_console` / `match.scoring_console` (modules.json:108-120) already lists `admin` in `default_for_roles`, so admins are scorer+referee by default anyway — meaning **there is no module-level separation between admin and the match-officiating roles at all.** Confidence 0.95.

2. **No re-validation that granted modules are "real" in context.** `_resolve_module` (grants.py:42-51) only checks the module *exists in the catalog*. A `tournament.*` or `match.*` module can be granted to a user in an org with no tournaments — harmless now, but it shows the write path has no scope-awareness; combined with the ghost-grant IDOR (pass-1 FINDING 2 / verify-A) a grant row can be planted for `(arbitrary_user_uuid, org)` and will silently apply when that user later joins.

**Why this is deeper than pass-1:** pass-1 flagged the *target-user-not-validated* IDOR. The deeper issue is **architectural**: the design treats "admin" as omnipotent at the module layer with no non-grantable/sensitive-module class, so the module system cannot enforce separation-of-duty even in principle. If the LOCKED self-serve model ("creator becomes tournament admin") is taken at face value, every workspace creator is an unconstrained admin who can self-grant the entire 22-module surface. **Recommendation:** introduce a `Module.is_admin_grantable` (or a reserved set) and have `bulk_set_grants` reject grants of reserved modules; explicitly document that admin == full module surface if that is intended.

---

## NEW FINDING N2 — HIGH (fail-open): `_OrgMembershipPermission` returns `True` when the org can't be resolved, and the slug→UUID detection makes this reachable on real routes

**File:** `apps/organizations/permissions.py:85-99` (and the resolver helper `:28-66`).

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here...
    return True
```

Pass-1 (FINDING 5) noted this fall-through but rated it MEDIUM and framed it as "documented for resource-level views." Tracing the *actual* routes that mount `IsOrgAdminOrOwner` / `IsOrgOwner` shows it is **more dangerous than rated**, because every one of those views *does* carry an org kwarg, so the only way to hit `org is None` is to make resolution **fail** — which is attacker-influenceable:

- `_resolve_org_from_view` (permissions.py:52-60): when the candidate parses as a UUID but **no active org with that pk exists**, it returns `None` (not the org). So `GET/PUT /api/permissions/orgs/<uuid>/users/<uuid>/grants/` with a **non-existent or soft-deleted org UUID** → `_resolve_org_from_view` returns `None` → **`has_permission` returns `True`** (permission passes). The view's own `get_organization()` then returns `None` and the handler returns 404 (views.py:174-179, 213-216). Today the handler 404s, so no data leaks — **but the permission layer has already said "yes"**, so this is a latent fail-open: any future handler on these classes that doesn't independently re-resolve+404 will execute for a non-admin. Confidence 0.9.
- Slug routes (`UserGrantsBySlugView`, `OrgInvitationsBySlugView`, `OwnershipTransferBySlugView`): `_resolve_org_from_view` lower-cases and looks up by slug; a **valid-but-deleted** org's slug returns `None` (filtered by `deleted_at__isnull=True`, permissions.py:63-65) → permission returns `True`. Again the handler 404s today, but the gate is open.

**Escalation framing:** the permission class is **fail-open on resolution failure**. Defense-in-depth is lost: the security posture depends entirely on every handler re-checking. The owner-only `IsOrgOwner` (permissions.py:114-118) inherits the same base, so `transfer_ownership`'s gate also fails open if the org can't be resolved — the only thing saving it is that `OrgTransferOwnershipView.post` re-resolves via `_resolve_org` and the service re-validates the current owner (ownership.py:60-72). **Recommendation:** flip the `org is None` branch to `return False`; whitelist the (currently zero) genuinely org-less views explicitly. This is a one-line hardening with high blast-radius reduction.

---

## NEW FINDING N3 — HIGH (escalation via invite-tree): invitation role is uncapped relative to inviter; an Admin can invite a second `admin`, and there is no "cannot invite above your own tier" check — combined with weak post-accept re-auth

**Files:** `services/invitation.py:107-227` (`create_invitation`), `:230-322` (`accept_invitation`), `views.py:419-435 / 569-587` (invite POST), `models.py:228-239` (`single_org_per_admin_user` constraint), `_cycle_session` (invitation.py:60-80).

Tracing the invite tree:

1. **Who can invite?** Only `IsOrgAdminOrOwner` (views.py:408, 555). Co-organizer/game-coordinator **cannot** reach the invite POST even though they hold `org.member_directory` by default (modules.json:14) — the view gates on **role**, not module (a deliberate, correct choice documented at views.py:139-148). Good: no module→invite escalation. Confidence 0.95.

2. **But the invited role is uncapped.** `create_invitation` accepts `role=admin` or `roles=[...,"admin"]` and `_pick_highest_role` (invitation.py:102-104) *selects the highest tier* from a list — so a frontend sending `roles:["referee","admin"]` yields an **admin** invite. There is **no check that the inviting admin may not mint another admin.** An org Admin can therefore invite an arbitrary email as **admin**. On accept, `accept_invitation` creates an `OrganizationMembership(role=admin)` (invitation.py:287-293) with no approval gate. **This is the documented self-serve model's blast radius made concrete: any admin can manufacture co-admins at will**, and a compromised admin account can seed persistence (a second admin in a *different* email they control). The `single_org_per_admin_user` DB constraint (models.py:228-233) only stops the *invitee* from being admin in **two** orgs simultaneously — it does **not** stop minting many admins **within one** org (the partial-unique is on `user`, not on count-per-org). The `one_owner_per_org` constraint limits *owners* to one, but admins are unbounded. Confidence 0.9.

3. **Post-accept re-auth is best-effort, not enforced.** `accept_invitation` calls `_cycle_session(request)` (invitation.py:320) which *tries* `cycle_session_on_role_change` and **swallows all exceptions** (invitation.py:73-80, `except Exception: pass`), falling back to `request.session.cycle_key()`, itself wrapped in `except Exception: pass`. So a privilege-elevating membership creation can complete with **no guaranteed session rotation** if the helper raises. (The accounts helper *does* exist now — `accounts/services/session_security.py:21` — so the primary path works; but the silent fallback means a refactor that breaks it fails *open*, i.e., elevation without rotation, with no signal.) Confidence 0.8.

**Escalation scenario (end-to-end):** Admin A (possibly a self-serve workspace creator, possibly compromised) → `POST /api/orgs/{slug}/invitations/ {email: attacker2@x, roles:["admin"]}` → invite created as admin (no tier cap) → attacker accepts → second admin membership, no super-admin approval (by locked design), session-cycle best-effort. Attacker2 now has the full admin surface + can self-grant all 22 modules (chains into N1) + can invite further admins (invite-tree fan-out). **Recommendation:** add an explicit policy check in `create_invitation` (or the view) — e.g., only the **owner** may invite role=admin, or require a second factor / reason + audit alert for admin invites; cap admins-per-org if the product wants containment.

---

## NEW FINDING N4 — MEDIUM (default-on too broad / least-privilege gap): `org.audit_log` defaults ON for `referee`; `match.center_admin_view` (scorer/referee identities) defaults ON for `team_manager`

**File:** `apps/permissions/fixtures/modules.json:21,126`.

Tracing `default_for_roles` against the principle of least privilege:

- `org.audit_log` → `["admin","co_organizer","game_coordinator","referee"]` (modules.json:21). A **referee** gets the **org-wide audit log** (searchable, CSV export — its own description). Referees are match officials; org-wide audit visibility (who invited whom, ownership transfers, grant changes) is a broad info-disclosure default that the union resolver will silently hand them. No grant needed — it is a Layer-1 default. Confidence 0.85 (severity depends on what the audit log exposes; the audit app emits actor UUIDs, IPs, reasons).
- `match.center_admin_view` → includes `team_manager` (modules.json:126). Its description explicitly says it surfaces "**scorer/referee identities**" and "raw event log." A team manager (effectively an external participant in the self-serve model) defaulting into officials' identities is a privacy/least-privilege smell.

**Why it matters for escalation:** these are *reconnaissance* primitives. Combined with FINDING 6 from pass-1 (`/api/permissions/modules/` leaks the full role→module map to any authenticated user) a low-tier member can map exactly which higher-tier identities and audit surfaces they already see and which they'd need a grant for. **Recommendation:** revisit the catalog defaults against least-privilege; gate `org.audit_log` to admin/co_organizer only, and drop `team_manager` from `match.center_admin_view` unless the product explicitly wants it.

---

## NEW FINDING N5 — MEDIUM (resolver fail-open on malformed user object): `effective_modules` authenticated-default is `True`

**File:** `apps/permissions/services/resolver.py:113`.

```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

Pass-1 flagged this (FINDING 1). I re-traced **every** caller to assess real exploitability and **confirm it remains a live latent fail-open**, not merely cosmetic:

- `HasModule.has_permission` (permissions.py:41) pre-guards with `is_authenticated, False` → DRF path is safe.
- **But three callers reach `effective_modules` without that pre-guard:** `MyEffectiveModulesView.get` (views.py:135) passes `request.user` directly; `UserGrantsView.get/put` (views.py:191,266) pass the **target** user (a freshly `get_object_or_404(User)` instance — a real authenticated-flag-bearing model, so OK); `ScopedQuerySet.module_gated` (scope.py:108) — but `module_gated` pre-guards at scope.py:89. The genuinely unguarded ones (`MyEffectiveModulesView`) use `request.user`, which under DRF SessionAuth is always an `AnonymousUser` (has `is_authenticated=False`) or real user — so the missing-attribute branch is unreachable **today**. The risk is a future caller passing a duck-typed/SimpleLazyObject/test double lacking `is_authenticated`: it would be treated as authenticated and the resolver would query DB and **return a non-empty module set for a non-user**. Every *other* guard in the codebase uses `False` (permissions.py:41, scope.py:55/70/89, organizations/permissions.py:80) — this is the lone inconsistency. **Recommendation:** change `True`→`False` (one char). Confidence 0.95 that it is a bug; ~0.4 that it is *currently* reachable (hence MEDIUM, not CRITICAL).

---

## NEW FINDING N6 — MEDIUM (stale-cache privilege window, deny-side): a `deny` override does not take effect across ASGI workers for up to 5 min, so revocation is not immediate

**Files:** `resolver.py:33-50,121-131` (cache), `grants.py:111,211,266` (`invalidate_cache`).

Pass-1 (FINDING 7) covered the multi-worker LocMem staleness generically. The deeper, security-specific framing: the **deny direction is the dangerous one.** `effective_modules` caches the *resolved frozenset* for 300s (resolver.py:131). When an admin writes a `state=deny` to revoke a compromised user's `match.scoring_console` (or any module), `invalidate_cache` (grants.py:111) deletes **only the local process's** key (the `TODO (Appendix B.3)` Redis pub/sub is deferred). Under the planned multi-worker ASGI prod deploy (CLAUDE.md: "Django ASGI"), other workers keep serving the **pre-deny** frozenset for up to 5 minutes → the revoked user still passes `has_module()` on those workers. This is a real-time revocation hole for the exact security action ("cut off this user now") admins will rely on during an incident. Confidence 0.85. **Recommendation:** ship the Redis pub/sub invalidation before multi-worker prod; interim, drop TTL hard or skip cache for `deny`-bearing resolutions.

---

## NEW FINDING N7 — LOW (audit-integrity / non-repudiation): `set_grant`/`bulk_set_grants`/`clear_grants` synthesize a random `target_id` for delete-to-default rows

**File:** `services/grants.py:118` (`target_id=(row.id if row else uuid.uuid4())`), mirrored at `:197`.

When a grant is set to `default`, the row is **deleted** (grants.py:91-96), so `row is None`, and the audit event is emitted with `target_id=uuid.uuid4()` — a **random UUID that points at nothing**. The audit row records the module_code in the payload (grants.py:123-126) so the *what* is preserved, but the `target_id` is non-resolvable, weakening the append-only audit trail's value for "show me the history of grant X" queries and slightly muddying non-repudiation. `clear_grants` (grants.py:247) correctly uses the real `row_id` before delete — so the pattern is inconsistent within the same file. Confidence 0.85. **Recommendation:** capture `existing.id` before deletion and use it as `target_id` (as `clear_grants` already does).

---

## NEW FINDING N8 — LOW (gate/transport mismatch on the matrix read): MatrixView exposes the full per-member override matrix to any org Admin, including `granted_by` admin UUIDs and reasons

**Files:** `views.py:340-371` (`MatrixView`), `services/matrix.py:104-148`, `serializers.py:18-34` (`GrantRowSerializer.granted_by`).

Not a cross-org breach (gate is `IsOrgAdminOrOwner`, org-scoped). The deeper note: the matrix + per-user grants endpoints expose, to *every* admin of an org, the full override map for *every* member plus (via `GrantRowSerializer`) the `granted_by` UUID and free-text `reason`. In the LOCKED self-serve model an org may have multiple co-equal admins (see N3); one admin can thus enumerate exactly which surfaces every other admin/member was hand-granted and *why*. Combined with N4's reconnaissance leaks this is a meaningful internal-recon aid. Pass-1 FINDING 4 flagged `granted_by` on the per-user endpoint; this extends it to the aggregate matrix surface. Confidence 0.8. **Recommendation:** drop raw `granted_by` UUID from API responses (audit log retains it); consider hiding other admins' override reasons from non-owner admins.

---

## Cross-cutting assessment

- **The resolver union math and the `(user,org)` grant keying are correct** and regression-tested. The module system is not where the holes are.
- **The holes are in the gates around the write/invite verbs and in fail-open helpers:** (a) admin is module-omnipotent with no reserved/non-grantable class (N1), (b) two fail-open returns — permission `org is None → True` (N2) and resolver `is_authenticated default True` (N5), (c) uncapped admin-minting invite tree with best-effort re-auth (N3), (d) overly broad least-privilege defaults (N4), (e) deny-revocation not real-time multi-worker (N6).
- **Strongest chain:** N2 (fail-open gate latent) is mostly saved by handler 404s today, but N3→N1 is a *live, by-design-adjacent* escalation: admin invites admin (uncapped) → new admin self-grants all modules (module-blind write) → invites more admins. Under the locked "no super-admin approval gate" decision this is intended reach, but it means **the module layer offers no containment of a compromised or rogue admin**, which should be stated explicitly in the threat model rather than left implicit.

---

## Items confirmed from pass-1 (not re-detailed; still open)
- IDOR: grant target user not validated as org member — `views.py:161-165` / `grants.py:180-189` (pass-1 F2 / verify-A; corrected to LOW there, but feeds N1's ghost-grant chain).
- `MyEffectiveModulesView` missing `deleted_at` filter + no membership gate — `views.py:128` (pass-1 F3).
- `/api/permissions/modules/` leaks full role→module map to all authed users — `views.py:73-88` (pass-1 F6; amplifies N4 recon).
- `X-Forwarded-For` spoofable in audit IP — `audit/services.py:54` (pass-1 F9).
- `event_id` accepted but ignored on bulk grants — `serializers.py:108-110` (pass-1 F10; violates invariant #3).
