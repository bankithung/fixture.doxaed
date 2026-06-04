# Module catalog audit — 2026-05-03

Scope: RBAC two-layer model (modules + verbs) cross-checked across spec
(`docs/superpowers/specs/v1Users.md` Appendix A.2-A.4 + B.16), backend
fixture (`backend/apps/permissions/fixtures/modules.json`), backend
resolver (`backend/apps/permissions/services/resolver.py`), and frontend
nav/dashboard (`frontend/src/features/orgs/dashboardCards.ts`,
`frontend/src/features/layout/computeNavItems.ts`,
`frontend/src/features/roles/redirectByRole.ts`,
`frontend/src/features/roles/routes.tsx`).

Spec rule for the role × module matrix: any non-`—` cell in A.3 (✅, 👁,
or 🔵) means "the module is in the role's `default_for_roles`"; row-level
filters then narrow data per Appendix B.2 (the 🔵 scope qualifier is NOT
encoded in the fixture, by design).

## P0 — role landing breaks own role (clicking own landing 403s)

- [ ] **`team_manager` lands on `/o/<slug>/team` but no `tournament.team_manager_workspace` module exists** — `redirectByRole.ts:51` sends `team_manager` to `routes.orgTeam(slug)`. There is no Team Manager surface module in the spec / fixture; the workspace is a *page* gated only by role, not by module. By the audit's strict rubric this is "no module gate" rather than "module gate that 403s," but it is still a P2-class drift since the page should be governed by some module under v1Users.md A.1's two-layer model. Today the page renders unconditionally for anyone hitting the URL with the path matched in `routes.tsx:22`. (`frontend/src/features/roles/redirectByRole.ts:51`, `frontend/src/features/roles/routes.tsx:22`)
- [ ] **No P0s found for the strict definition** — `match_scorer` → `/scoring` is OK (scorer has `match.scoring_console`); `referee` → `/referee` is OK (referee has `match.referee_console`); admin/co_organizer/game_coordinator → dashboard is OK (they all have `org.tournament_list` + module-gated cards).

## P1 — catalog drift (spec ≠ fixture)

- [ ] **None for the 22 modules.** Module count, codes, names, and `default_for_roles` arrays in `backend/apps/permissions/fixtures/modules.json` match v1Users.md Appendix A.2 + A.3 + B.16 exactly (cell-by-cell verified — see Section A).
- [ ] **`category` band naming drift (cosmetic):** spec A.4 enumerates scope as `enum('org', 'tournament', 'match', 'personal')` (`v1Users.md:2182`); the fixture uses `org_scoped`, `tournament_scoped`, `match_scoped`, `personal` (`fixtures/modules.json` throughout); the frontend `ModuleScope` type uses yet a third spelling: `"org" | "tournament" | "match" | "platform"` (`frontend/src/types/user.ts:7`). Three different conventions for the same concept. None breaks anything today (the resolver doesn't read `category`), but the matrix-UI and serializer that surface this band will need a single canonical form.
- [ ] **No `platform` scope band exists in fixture, but frontend `ModuleScope` declares one** (`frontend/src/types/user.ts:7`). Spec has no platform-scoped modules in v1.0 (super-admin uses a separate Django+HTMX surface, not modules). Drift is in the type def only.

## P2 — frontend ≠ permissions (role has module but no surface, or surface but no module)

### Surface but no module gate

- [ ] **`computeNavItems.ts:111` "Scoring" item is role-gated, not module-gated.** The nav reads `roleStrings.includes("scorer") || roleStrings.includes("match_scorer")` instead of `hasModule("match.scoring_console")`. Admins/co_organizers/game_coordinators all have `match.scoring_console` by default but won't get the Scoring nav item because their role string isn't `scorer`/`match_scorer`. (`frontend/src/features/layout/computeNavItems.ts:111-119`)
- [ ] **`computeNavItems.ts:120` "Referee" item is role-gated, not module-gated.** Same problem: admins/co_organizers/game_coordinators have `match.referee_console` but won't see the nav item. (`frontend/src/features/layout/computeNavItems.ts:120-128`)
- [ ] **`computeNavItems.ts:129` "Team" item is role-gated, not module-gated.** No corresponding module exists at all; the only related module is `tournament.team_registration` / `tournament.player_roster` / `match.lineup_submission`, none of which is named "team workspace." (`frontend/src/features/layout/computeNavItems.ts:129-137`)
- [ ] **`dashboardCards.ts:128` "Permissions" / Module-Override card is role-gated (`adminLike`)**, bypassing the module layer entirely. v1Users.md §2.6 says "the Admin can grant or revoke individual modules" — there is no module catalog entry for the override matrix UI itself. The card sidesteps the two-layer model by relying on role only. Comment in code says "module-independent per spec," which is consistent with v1Users.md §2.6 but inconsistent with A.1's stated two-layer principle. Worth a spec clarification (Appendix A should add `org.module_overrides` if this surface should be governed). (`frontend/src/features/orgs/dashboardCards.ts:127-136`, `frontend/src/features/layout/computeNavItems.ts:82-90`)

### Module but no surface (Phase 1A)

- [ ] **`org.tournament_list`** — admins/co_organizers/game_coordinators/match_scorers/referees/team_managers all have it by default, but the dashboard renders only a "Coming in Phase 1B" teaser (`dashboardCards.ts:150-161`) and no nav item. Acceptable — Phase 1B sport module owns the real surface. Card uses `routes.orgTournamentsComingSoon` correctly.
- [ ] **`tournament.editor`, `tournament.bracket_editor`, `tournament.schedule_editor`, `tournament.team_registration`, `tournament.player_roster`, `tournament.lineup_manager`, `tournament.audit_log`, `tournament.report_export`, `tournament.organizer_checklist`, `tournament.day_pack_export`** — all 10 tournament-scoped modules have ZERO surface (no card, no nav item, no route). Phase 1B work; consistent with v1Users.md B.17 sequencing.
- [ ] **`match.scoring_console`, `match.referee_console`, `match.center_admin_view`, `match.lineup_submission`** — 4 match-scoped modules have no card / no nav item / no route surface for users who *should* see them by default (e.g. admin has `match.center_admin_view` but the AppShell never renders a link). Phase 1B surfaces them.
- [ ] **`personal.profile`, `personal.notification_prefs`, `personal.feedback_widget`** — surfaced via dashboard cards / `roleRoutes` correctly.

### Frontend Role union ≠ backend MembershipRole

- [ ] **`frontend/src/types/user.ts:18-24` declares `Role = "owner" | "admin" | "scorer" | "referee" | "viewer" | "guest"` — does not match backend `MembershipRole` enum (`admin | co_organizer | game_coordinator | match_scorer | referee | team_manager`).** `redirectByRole.ts` and `computeNavItems.ts` both sidestep this by widening to `string` ("v1Users.md role catalog is wider than the legacy `Role` union" — comment at `redirectByRole.ts:23`). Functionally correct via string compare, but type system gives no compile-time check that role landing strings match server-side enum values. Would silently break the day a role is renamed.
- [ ] **`owner` is a frontend-only role.** Backend models `is_org_owner` as a boolean flag on the `OrganizationMembership` row (`apps/organizations/models.py:183`), where `is_org_owner=True` implies `role="admin"` (`models.py:235-238`). Frontend treats `owner` as a peer role. The membership serializer must therefore translate (admin + is_org_owner=True) → `roles: ["admin", "owner"]` or similar. Verify the serializer does this — not in scope here, but flagged.

## Section A — All 22 modules (spec ↔ fixture diff)

Spec roles derived from A.3 cells: any non-`—` cell ⇒ role appears in
`default_for_roles`. Order: admin, co_organizer, game_coordinator,
match_scorer, referee, team_manager.

| # | Code | Name | Spec category (A.2) | Spec roles (from A.3) | Fixture roles | Match? | Notes |
|---|------|------|---|---|---|---|---|
| 1 | `org.settings` | Org Settings | Org-scoped | admin, co_organizer | admin, co_organizer | OK | co_org is 👁 read-only via row filter, A.3 row 1 |
| 2 | `org.member_directory` | Member Directory | Org-scoped | admin, co_organizer, game_coordinator | admin, co_organizer, game_coordinator | OK | gc is 👁 read-only |
| 3 | `org.audit_log` | Org Audit Log | Org-scoped | admin, co_organizer, game_coordinator, referee | admin, co_organizer, game_coordinator, referee | OK | gc 🔵 sport, referee 🔵 own matches |
| 4 | `org.tournament_list` | Tournament List | Org-scoped | all 6 | all 6 | OK | scoped per role |
| 5 | `org.branding` | Org Branding | Org-scoped | admin, co_organizer | admin, co_organizer | OK |  |
| 6 | `tournament.editor` | Tournament Editor | Tournament-scoped | admin, co_organizer, game_coordinator | admin, co_organizer, game_coordinator | OK | gc 👁 |
| 7 | `tournament.bracket_editor` | Bracket Editor | Tournament-scoped | admin, co_organizer, game_coordinator | admin, co_organizer, game_coordinator | OK | gc 🔵 assigned |
| 8 | `tournament.schedule_editor` | Schedule Editor | Tournament-scoped | admin, co_organizer, game_coordinator | admin, co_organizer, game_coordinator | OK |  |
| 9 | `tournament.team_registration` | Team Registration Manager | Tournament-scoped | admin, co_organizer, game_coordinator, team_manager | admin, co_organizer, game_coordinator, team_manager | OK | tm 🔵 own team self-register |
| 10 | `tournament.player_roster` | Player Roster Manager | Tournament-scoped | admin, co_organizer, game_coordinator, team_manager | admin, co_organizer, game_coordinator, team_manager | OK |  |
| 11 | `tournament.lineup_manager` | Lineup Manager | Tournament-scoped | all 6 | all 6 | OK | scorer/referee 👁, gc/tm 🔵 |
| 12 | `tournament.audit_log` | Tournament Audit Log | Tournament-scoped | admin, co_organizer, game_coordinator | admin, co_organizer, game_coordinator | OK |  |
| 13 | `tournament.report_export` | Tournament Report Export | Tournament-scoped (B.16) | admin, co_organizer, game_coordinator | admin, co_organizer, game_coordinator | OK | B.16 add |
| 14 | `tournament.organizer_checklist` | Pre-Tournament Checklist | Tournament-scoped (B.16) | admin, co_organizer, game_coordinator | admin, co_organizer, game_coordinator | OK | B.16 add |
| 15 | `tournament.day_pack_export` | Today's Day-Pack Export | Tournament-scoped (B.16) | admin, co_organizer, game_coordinator | admin, co_organizer, game_coordinator | OK | B.16 add; A.3 table not updated to include B.16 rows but B.16 §2645 specifies same defaults |
| 16 | `match.scoring_console` | Scoring Console | Match-scoped | admin, co_organizer, game_coordinator, match_scorer | admin, co_organizer, game_coordinator, match_scorer | OK | admin/co_org "✅ override" |
| 17 | `match.referee_console` | Referee Console | Match-scoped | admin, co_organizer, game_coordinator, referee | admin, co_organizer, game_coordinator, referee | OK |  |
| 18 | `match.center_admin_view` | Match Center (admin view) | Match-scoped | all 6 | all 6 | OK |  |
| 19 | `match.lineup_submission` | Lineup Submission | Match-scoped | admin, co_organizer, game_coordinator, team_manager | admin, co_organizer, game_coordinator, team_manager | OK |  |
| 20 | `personal.notification_prefs` | Notification Preferences | Personal | all 6 | all 6 | OK |  |
| 21 | `personal.profile` | Personal Profile | Personal | all 6 | all 6 | OK |  |
| 22 | `personal.feedback_widget` | Feedback Widget | Personal | all 6 | all 6 | OK |  |

**Summary:** 22 / 22 modules match spec exactly on code, name,
default_for_roles, and category band (allowing for the spec-vs-fixture
naming convention `org` ↔ `org_scoped` covered in P1).

## Section B — Role → default modules

Computed from `fixtures/modules.json` `default_for_roles` arrays.

### admin (15 modules)
`org.settings`, `org.member_directory`, `org.audit_log`,
`org.tournament_list`, `org.branding`, `tournament.editor`,
`tournament.bracket_editor`, `tournament.schedule_editor`,
`tournament.team_registration`, `tournament.player_roster`,
`tournament.lineup_manager`, `tournament.audit_log`,
`tournament.report_export`, `tournament.organizer_checklist`,
`tournament.day_pack_export`, `match.scoring_console`,
`match.referee_console`, `match.center_admin_view`,
`match.lineup_submission`, `personal.notification_prefs`,
`personal.profile`, `personal.feedback_widget` → **22 / 22**.

### co_organizer (22)
Identical set to admin's defaults — 22 / 22. Per v1Users.md §3.6 "default
module set is identical to Admin's defaults except [verb-level
restrictions]" — modules same, verbs differ. Matches.

### game_coordinator (15)
`org.member_directory`, `org.audit_log`, `org.tournament_list`,
`tournament.editor`, `tournament.bracket_editor`,
`tournament.schedule_editor`, `tournament.team_registration`,
`tournament.player_roster`, `tournament.lineup_manager`,
`tournament.audit_log`, `tournament.report_export`,
`tournament.organizer_checklist`, `tournament.day_pack_export`,
`match.scoring_console`, `match.referee_console`,
`match.center_admin_view`, `match.lineup_submission`,
`personal.notification_prefs`, `personal.profile`,
`personal.feedback_widget` → **20 / 22**. Excluded: `org.settings`,
`org.branding`. Matches §4.6 description.

### match_scorer (8)
`org.tournament_list`, `tournament.lineup_manager`,
`match.scoring_console`, `match.center_admin_view`,
`personal.notification_prefs`, `personal.profile`,
`personal.feedback_widget` → **7 / 22**. Confirms v1Users.md §5.6 "scoring
console + assignments + nothing else" (with personal modules + tournament
list scoped to assigned + lineup view scoped to assigned).

### referee (8)
`org.audit_log`, `org.tournament_list`, `tournament.lineup_manager`,
`match.referee_console`, `match.center_admin_view`,
`personal.notification_prefs`, `personal.profile`,
`personal.feedback_widget` → **8 / 22**. Matches §6.6.

### team_manager (9)
`org.tournament_list`, `tournament.team_registration`,
`tournament.player_roster`, `tournament.lineup_manager`,
`match.center_admin_view`, `match.lineup_submission`,
`personal.notification_prefs`, `personal.profile`,
`personal.feedback_widget` → **9 / 22**. Matches §7.6.

### super_admin
**Not represented in `MembershipRole` enum at all** — confirmed
correct by spec: super-admin is a User-level `is_staff` flag with a
separate Django+HTMX console at `sadmin.fixture.doxaed.com`, not an in-org
role (v1Users.md §1.5). Audit's mention of "7 roles" in Phase 1A counts
super_admin as the 7th, but it lives outside the in-Org module catalog by
design.

## Section C — Frontend surface coverage

`adminLike = roles ∋ owner | admin`. Where the rule says "module" the
gate uses `effective_modules`. Where it says "role" the gate uses the
roles array on the membership.

| Surface | File:line | Gate (current) | Should-be gate | Roles seeing it today | Gap |
|---|---|---|---|---|---|
| Dashboard card: Members | `dashboardCards.ts:103-114` | module `org.member_directory` (with adminLike fallback) | module `org.member_directory` | admin, co_organizer, game_coordinator | OK |
| Dashboard card: Settings | `dashboardCards.ts:116-124` | module `org.settings` | same | admin, co_organizer | OK |
| Dashboard card: Permissions | `dashboardCards.ts:128-136` | role `adminLike` only | role-only gate is per-spec §2.6 BUT spec A.1 implies a module | admin (incl. owner) | P2 — see above |
| Dashboard card: Audit | `dashboardCards.ts:139-147` | module `org.audit_log` | same | admin, co_organizer, game_coordinator, referee | OK |
| Dashboard card: Tournaments (Phase 1B teaser) | `dashboardCards.ts:150-161` | module `org.tournament_list` (no role fallback) | same | all 6 | OK |
| Dashboard card: Branding | `dashboardCards.ts:164-172` | module `org.branding` | same | admin, co_organizer | OK |
| Dashboard card: Profile | `dashboardCards.ts:175-181` | unconditional | module `personal.profile` | everyone | tiny P3 — bypasses module gate but module is granted to all 6 roles, no functional gap |
| Dashboard card: Notifications | `dashboardCards.ts:184-192` | module `personal.notification_prefs` (with `true` role fallback) | same | all 6 | OK |
| Dashboard card: Feedback | `dashboardCards.ts:195-203` | module `personal.feedback_widget` (with `true` role fallback) | same | all 6 | OK |
| Nav: Dashboard | `computeNavItems.ts:65-70` | unconditional w/ slug | unconditional OK | everyone with org context | OK |
| Nav: Members | `computeNavItems.ts:73-80` | module `org.member_directory` | same | admin, co_organizer, game_coordinator | OK |
| Nav: Permissions | `computeNavItems.ts:82-90` | role `adminLike` | (per-spec OK) | admin/owner | OK by spec |
| Nav: Audit | `computeNavItems.ts:93-100` | module `org.audit_log` | same | admin, co_organizer, game_coordinator, referee | OK |
| Nav: Scoring | `computeNavItems.ts:111-119` | role `scorer` OR `match_scorer` | module `match.scoring_console` | match_scorer only (legacy `scorer` never set by backend) | **P2 — module-gated would also include admin/co_organizer/game_coordinator** |
| Nav: Referee | `computeNavItems.ts:120-128` | role `referee` | module `match.referee_console` | referee only | **P2 — module-gated would also include admin/co_organizer/game_coordinator** |
| Nav: Team | `computeNavItems.ts:129-137` | role `team_manager` | (no module exists for the workspace) | team_manager | P2 — surface w/o module |
| Landing route: `/o/<slug>/scoring` (`ScorerLandingPage`) | `roles/routes.tsx:20` | path-only, no `<RequiresModule>` | gate by module `match.scoring_console` | anyone navigating | P3 — lands a Phase-1B placeholder; no real data so impact is low |
| Landing route: `/o/<slug>/referee` | `routes.tsx:21` | path-only | gate by module `match.referee_console` | anyone | P3 — placeholder |
| Landing route: `/o/<slug>/team` | `routes.tsx:22` | path-only | (no module) | anyone | P3 — placeholder |
| Landing route: `/me`, `/me/notifications` | `routes.tsx:23-24` | auth-only | OK | every authenticated user | OK (cards gate per module) |
| Redirect: admin/owner/co_organizer/game_coordinator → `/o/<slug>/dashboard` | `redirectByRole.ts:40-47` | OK | OK | as listed | OK |
| Redirect: match_scorer → `/o/<slug>/scoring` | `redirectByRole.ts:49` | role-only | role-only acceptable since target page is a placeholder | match_scorer | OK functionally (scorer has the module too) |
| Redirect: referee → `/o/<slug>/referee` | `redirectByRole.ts:50` | role-only | role-only OK | referee | OK |
| Redirect: team_manager → `/o/<slug>/team` | `redirectByRole.ts:51` | role-only | (no module exists) | team_manager | OK functionally; flagged for spec gap |
| Phase 1B teaser strip on dashboard | `dashboardCards.ts:222-228` | static array | n/a | everyone | OK — pure UX teaser |

### Phase 1A landing destination check (audit §4)

| Role | Lands on | Module needed | Has module by default? | OK? |
|---|---|---|---|---|
| match_scorer | `/o/<slug>/scoring` | `match.scoring_console` | Yes (`fixtures/modules.json:112`) | YES |
| referee | `/o/<slug>/referee` | `match.referee_console` | Yes (`fixtures/modules.json:119`) | YES |
| team_manager | `/o/<slug>/team` | (none defined) | n/a | NO MODULE EXISTS |

No P0 from "own landing 403s" — but team_manager has no module to gate
its landing on. Either spec adds `tournament.team_manager_workspace` (or
similar) to Appendix A.2, or the page is acknowledged as role-gated only.

## Section D — Resolver pseudocode vs spec A.4

### Spec A.4 algorithm (`v1Users.md:2218-2239`)

```python
def effective_modules(user, org):
    active_roles = OrganizationMembership.objects.filter(
        user=user, organization=org, status='active'
    ).values_list('role', flat=True)

    modules = set()
    for role in active_roles:
        modules |= role_default_modules(role)        # Layer 1: union of role defaults

    grants = MembershipModuleGrant.objects.filter(user=user, organization=org)
    for grant in grants:
        if grant.granted:                            # Layer 2: per-(user, org) overrides
            modules.add(grant.module)
        else:
            modules.discard(grant.module)
    return modules
```

### Backend resolver (`backend/apps/permissions/services/resolver.py:107-132`)

```python
def effective_modules(user, organization):
    if user is None or not user.is_authenticated:
        return frozenset()                                # extra guard
    if user_id is None or org_id is None:
        return frozenset()

    cached = cache.get(key)                              # 5-min cache wrapper
    if cached is not None:
        return cached

    roles = _user_active_roles(user, organization)
        # filters OrganizationMembership.objects.filter(
        #     user=user, organization=organization, is_active=True
        # ).values_list('role', flat=True)

    base = _base_modules_for_roles(roles)
        # for each Module in catalog: if role_set ∩ default_for_roles → add code

    final = _apply_overrides(base, user, organization)
        # for each MembershipModuleGrant filter(user, organization):
        #     state == GRANT → add
        #     state == DENY → discard
        #     state == DEFAULT → no-op

    return frozenset(final)
```

### Comparison

| Spec A.4 step | Resolver implementation | Match? |
|---|---|---|
| Filter active memberships by `status='active'` | Filters by `is_active=True` (Boolean field on `OrganizationMembership`, `models.py:185`) — backend uses a Boolean instead of a `status` string but semantics are equivalent for Phase 1A (no separate `status` enum exists on `OrganizationMembership`; it's `is_active` + `removed_at`). | OK (semantic) |
| Union of `role_default_modules(role)` across active roles | `_base_modules_for_roles` iterates `Module.objects.values_list("code", "default_for_roles")` and tests `role_set.intersection(default_for)`. Equivalent to a union — every module whose `default_for_roles` shares any active role with the user is included. | OK |
| `MembershipModuleGrant.objects.filter(user=user, organization=org)` keyed on `(user, org)` | Identical filter (`resolver.py:93-95`). Per the v1Users.md AUDIT FIX 2026-05-02 / `models.py:13-15` and `models.py:140-149` the unique constraint is `(user, organization, module)` — matches spec. | OK |
| `granted=True` → add; `granted=False` → discard | Backend uses tri-state `GrantState` (`default`, `grant`, `deny`) instead of Boolean `granted`. `default` is a no-op (correct — equivalent to "no grant row" per spec A.4 note "do not materialize default rows"). `grant` adds, `deny` discards. | OK (richer; default no-op is documented at `models.py:36-39`) |
| Returns `set[Module]` | Returns `frozenset[str]` of CODES (not Module instances). Functionally equivalent for callers; a small surface-level deviation. | OK (frozenset is immutable + hashable, suitable for caching) |

### Cache contract

| Spec A.4 cache contract | Backend |
|---|---|
| Key `eff_modules:user:<uuid>:org:<uuid>` with `v:<int>` version suffix | Key `effective_modules:{user.id}:{organization.id}` — no version suffix (`resolver.py:37-39`) |
| Bump on `OrganizationMembership` status / create / soft-revoke | Not yet wired; comment at `resolver.py:14-19` says "invalidated on every grant write at the service layer (see `apps.permissions.services.grants`)" — i.e. only grant writes invalidate today |
| Bump on `MembershipModuleGrant` create / update / delete | Implemented via service-layer call; verified via `services/grants.py` (cited in resolver docstring) |
| `transaction.on_commit` push to Redis pub/sub channel `permcache:user:<uuid>:org:<uuid>` | **NOT implemented.** Comment at `resolver.py:43-49` and `:14-19`: "Phase 1A is single-process safe via the shared backend; cross-worker invalidation lands in Phase 1B." Documented deferral, not drift. |
| Synthetic `permissions_changed` notification on `user:<uuid>:notifications` for SPA refresh | Not implemented. Same deferral. |

### Multi-role correctness check (v1Users.md AUDIT FIX 2026-05-02)

Spec required keying overrides on `(user, organization)`, not on
`OrganizationMembership` — to fix the bug where a `granted=False` revoke
on one membership row was bypassed by a second active role on a different
row. Backend implements the fix correctly:

- Constraint: `unique_grant_per_user_org_module` on `(user, organization, module)` (`models.py:144-149`).
- Resolver filter: `MembershipModuleGrant.objects.filter(user=user, organization=organization)` — does NOT join through `OrganizationMembership` (`resolver.py:93-95`).
- Test coverage: `tests/test_resolver_multi_role.py` asserts union semantics for (co_organizer + match_scorer) and (admin + team_manager); `tests/test_resolver_grant_overrides_role_default_deny.py` (per filename) covers the deny-overrides-default case.

### Verdict

Resolver matches spec A.4 algorithm. Cache contract is partially deferred
to Phase 1B (cross-worker invalidation, version suffix, SPA push) but the
deferral is explicit in code comments and is documented in spec B.21.

## Resolver / matrix test alignment (audit §5)

`backend/apps/permissions/tests/test_permission_matrix.py` parametrizes
the matrix as (role, module_code, expected) tuples derived directly from
`fixtures/modules.json`. For each role (loaded from `MembershipRole`
enum) × each module, asserts `module_code in effective_modules(user,
org)` iff `role in module.default_for_roles`. This is exactly the
canonical-RBAC test from CLAUDE.md invariant 12 and from v1Users.md B.15.
6 roles × 22 modules = 132 cells covered.

## Summary

- **0 P0 findings** (no role's default landing destination 403s on its own module gate).
- **0 P1 catalog drift** for the 22 modules — fixture is byte-for-byte aligned with spec A.2 + A.3 + B.16. Minor naming-convention drift on the `category` band string across spec/fixture/frontend (cosmetic).
- **5+ P2 frontend gaps:** nav items for Scoring/Referee/Team are role-gated instead of module-gated, so admins/co_organizers/game_coordinators with the relevant `match.*` modules don't see the nav link even though they have access. Frontend `Role` union doesn't match backend `MembershipRole` enum (sidestepped via `string` widening).
- **1 spec gap:** team_manager landing has no corresponding module in Appendix A.2 (no `tournament.team_manager_workspace` or similar). Either add to spec or acknowledge as role-gated.
- **Resolver matches spec A.4 algorithm.** Cache cross-worker invalidation deferred to Phase 1B per documented spec B.21.
