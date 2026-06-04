# Cross-Cutting Audit — Invariant 8: Person ↔ Player Split

**Date:** 2026-06-04
**Scope:** Whole backend + frontend (excl. `backend/.venv`, `frontend/node_modules`).
**Invariant under test:** *8. Person↔Player split — `Person` is the platform-scoped human identity; `Player` is a per-tournament registration referencing a `Person`. This is what makes cross-tournament career stats work without later migrations.*

## Verdict

**Invariant 8 is Phase 1B-only and is NOT blocked by Phase 1A.** No `Person` or `Player` model exists anywhere in the codebase (confirmed by exhaustive search — zero `class Person` / `class Player` matches in `backend/`). Per the LOCKED spec `v1Users.md §8` ("Player — DEFERRED TO SPORT MODULE"), this is correct and intentional: the user-types phase commits only to the *concept*, not the schema. Phase 1A lays down every foundation the future split needs (UUID v7 helper, soft-delete pattern, Fernet field encryption, generic audit targets, data-driven module RBAC) without prematurely committing the schema. The few violations found are all spec/doc hygiene, not code blockers.

---

## Findings

### F1 — [INFO] No Person/Player models exist (correct — Phase 1B deferral)
- **Where:** entire `backend/apps/` (search `class\s+(Person|Player)\b` → no matches; `backend/apps/sports/` is catalog-only with no per-sport plugin subdir).
- **Evidence:** `backend/apps/sports/models.py:1` — *"Sports catalog — Phase 1B scaffold. This app holds ONLY the catalog of sports... Until then, every row is a metadata stub with `status=\"planned\"`."* Directory listing of `apps/sports/` shows no `football/` (or any sport) sub-app, so no `Player` schema is prematurely committed.
- **Spec basis:** `docs/superpowers/specs/v1Users.md:1842` — *"## 8. Player — DEFERRED TO SPORT MODULE"*; line 1890 — *"The implementation plan should NOT scaffold the Player table from this document. The sport module is the authoritative source."*
- **Why it matters:** Confirms the invariant is not violated by omission — deferral is the locked decision.
- **Recommendation:** None. Keep deferred until the sport module (`v1Sport.md`) phase.

### F2 — [HIGH] Spec conflict: PRD §8 `PersonAccount(user, person)` join table vs. v1Users.md locked `Person.user` OneToOneField
- **Where:** `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md:887`
- **Evidence:** PRD ER diagram: ` ├── PersonAccount(user, person)` / ` │     └─ role = player  -- claimed player`. The LOCKED user-types spec supersedes this: `docs/superpowers/specs/v1Users.md:1867` — *"Person ↔ User link approach | When v1.5 claim flow lands, link via a single `Person.user` OneToOneField. **No separate `PersonAccount` join table.**"* (re-affirmed at `v1Users.md:1905`).
- **Why it matters:** This is the single most consequential design decision for the split's data model. If a Phase 1B implementer reads PRD §8 first (it is still "canonical" for the data model except where superseded), they could scaffold a `PersonAccount` join table — directly contradicting the locked decision and creating the exact later-migration that invariant 8 exists to prevent. It is a latent trap, not yet a code defect.
- **Recommendation:** Fold the v1Users.md decision into PRD §14 (Decisions log) and strike/annotate the `PersonAccount` line in the PRD §8 ER diagram (line 887) to point at `Person.user` OneToOneField. Bump PRD draft number per CLAUDE.md "Working with the PRD" rule.

### F3 — [INFO] `tournament.player_roster` module catalog row present as forward-compat dead code (correct)
- **Where:** `backend/apps/permissions/fixtures/modules.json:66-71`
- **Evidence:** `"code": "tournament.player_roster", "name": "Player Roster Manager", "description": "Add/edit/remove players; eligibility freeze; suspension overrides.", "default_for_roles": ["admin", "co_organizer", "game_coordinator", "team_manager"]`.
- **Spec basis:** `v1Users.md:2123` lists `tournament.player_roster` in the 22-module catalog; `v1Users.md:1866` — *"Permission matrix Player row | Dead code in v1.0; retained for v1.5 forward-compatibility."*
- **Why it matters:** RBAC surface for the future Player roster is already wired in a *data-driven* way (`Module.default_for_roles` JSON, resolved by `apps/permissions/services/matrix.py`), so adding Player-related modules later needs zero code change — only a fixture edit. This is exactly what "without later migrations" requires.
- **Recommendation:** None. The data-driven catalog is the right shape.

### F4 — [INFO] PRD §3.2 row-level "Player" RBAC verb matrix is NOT implemented in 1A (correct per supersession)
- **Where:** PRD `2026-04-30-fixture-platform-prd.md:133,141,152` (Player row in the §3.2 verb matrix) — has no parametrized test or enforcement code in `backend/apps/permissions/`.
- **Evidence:** `apps/organizations/models.py:44-53` `MembershipRole` enum has six roles and **no `player` member**, with the comment `apps/organizations/models.py:45` — *"In-Org roles. Player goes via Phase 1B."* The implemented RBAC is module-based only (`apps/permissions/services/matrix.py`), not the row-level verb matrix for Player.
- **Spec basis:** `v1Users.md:1904` — *"Permission matrix Player row | Dead code in v1.0."* CLAUDE.md invariant 12 confirms modules govern surface visibility in 1A.
- **Why it matters:** Absence of a Player role enum member is expected, not a violation. When the split lands, `Player` is *passive data with no login* (`v1Users.md:1865`), so it does NOT need a `MembershipRole`/`ActorRole` enum entry at all — Person links to User via OneToOne for the (v1.5) claim flow, not via a membership role.
- **Recommendation:** None now. Document in the sport-module plan that Player needs no `MembershipRole` enum addition (it is not an auth principal in v1.0).

### F5 — [LOW] Audit actor reservation for Person not yet representable as typed FK (acceptable; generic UUID target works)
- **Where:** `backend/apps/audit/models.py:67-70`
- **Evidence:** `target_type = models.CharField(...)`, `target_id = models.UUIDField(db_index=True)` — generic string+UUID target, so a future `Person`/`Player` is auditable with no schema change. However, `v1Users.md:1896` reserves: *"`MatchEvent.actor_user` and similar audit hooks will reference `Person` (via the linked `User` if claimed)"* — there is no `Person` FK reservation in `AuditEvent` because Person doesn't exist yet.
- **Why it matters:** Not a blocker — `target_type`/`target_id` is deliberately polymorphic and `actor_user` (FK to User) covers claimed-Person actors via the future `Person.user` link. Only flagged so the sport-module implementer remembers that career-stat rollups keyed on Person will read `target_type='person'` audit rows, which requires no migration to the audit table.
- **Recommendation:** None to 1A. In the sport module, ensure Person/Player mutations emit `AuditEvent` with `target_type` in `{"person","player"}` so cross-tournament identity audit is queryable.

---

## Prep Gaps (Phase 1B readiness for the split — 1A does NOT block any of these)

| # | Gap | Current state | Needed for | Effort |
|---|-----|---------------|------------|--------|
| G1 | `Person` model (platform-scoped, NOT org-scoped per `v1Users.md:1864`; fields `name`, `dob` [encrypted], `photo`, `deleted_at`, reserved `user` OneToOne) | Does not exist. Reusable foundations present: `uuid7()` helper (`apps/accounts/models.py:28`), Fernet crypto (`apps/accounts/services/_crypto.py:41` `encrypt_secret`), soft-delete `deleted_at` pattern (`apps/accounts/models.py:75`). | Cross-tournament career stats; v1.5 claim flow. | M |
| G2 | `Player` model (per-tournament registration → `Person` FK; `org` FK per invariant 2; sport-specific attrs deferred to sport module) | Does not exist; `apps/sports/models.py` is catalog-only. Sport-specific fields (`jersey_no`, `position`, `is_goalkeeper`, eligibility enum) intentionally undefined (`v1Users.md:1880`). | Tournament rosters, lineups, suspensions. | L |
| G3 | Hard DB constraint: a `Person` cannot be on two `Team`s in the same tournament | Not present (no Person/Team/Player). Spec: `v1Users.md:1870`, PRD §5.3 line 352, PRD §13 line 1087. | Data-integrity invariant of the split. | S |
| G4 | `Person.user` OneToOneField (claim link) + decision recorded in PRD | Reserved in spec only (`v1Users.md:1867`); **PRD §8:887 still shows the contradicting `PersonAccount` join table** (see F2). | v1.5 Player claim flow. | S (doc) |
| G5 | `dob` field-level encryption reuse | `_crypto.py` is currently 2FA-only by docstring but is mechanism-agnostic (key from `SECRET_KEY`). PRD §7.7 line 910 wants `cryptography.fernet` for `Person.dob`. | PII protection of Person.dob. | S |
| G6 | Audit `target_type` values for Person/Player + career-stat rollup query | `AuditEvent` generic target supports it (`apps/audit/models.py:67-70`); no Person/Player emitters exist. | Auditable cross-tournament identity. | S |
| G7 | Per-org sport opt-in + sport-module wiring (`Sport.python_module_path` populated) | Field exists but blank (`apps/sports/models.py:108`); no per-sport app. | Tournament/Player work for football. | M |

## Foundations confirmed present (de-risk the split)
- **UUID v7 PKs:** `apps/accounts/models.py:28` `uuid7()` reused by every app (organizations, audit, permissions, sports) — Person/Player will reuse it.
- **Soft-delete:** `deleted_at` + manager pattern (`apps/accounts/models.py:75`, `apps/organizations/models.py:73`) ready to copy for Person/Player (`v1Users.md:1869`).
- **Field encryption:** `apps/accounts/services/_crypto.py` Fernet helper, mechanism-agnostic, ready for `Person.dob`.
- **Module RBAC is data-driven:** `apps/permissions/services/matrix.py` resolves from `Module.default_for_roles` JSON — adding Player modules = fixture edit, no code/migration.
- **Frontend anticipates the split non-blockingly:** `frontend/src/features/roles/TeamManagerLandingPage.tsx:27-30` placeholder tile — *"Register Persons as Players for each tournament with eligibility checks."*
