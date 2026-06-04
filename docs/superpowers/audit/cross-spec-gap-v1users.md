# Cross-Spec Gap Audit — v1Users.md vs Implementation

**Date:** 2026-06-04
**Auditor:** spec-gap-v1users agent (Read/Grep/Glob; no knowledge graph)
**Spec audited:** `docs/superpowers/specs/v1Users.md` (Draft v4, post-audit) — all 10 role sections + Appendix A (22-module catalog + override model) + Appendix B (B.1–B.22 implementation guardrails)
**Implementation surface:** `backend/apps/{accounts,organizations,permissions,audit,sadmin}` + `frontend/src`

## Verdict

Phase 1A user/RBAC chassis is largely faithful to the locked v1Users decisions: the 22-module catalog is complete and correct, the per-user override model + UI ships, the multi-role resolver audit-fix is correctly implemented and tested, and the OrganizationMembership constraints (`unique_active_role_per_user_per_org`, `one_owner_per_org`, `single_org_per_admin_user`, `owner_flag_only_on_admin_role`) all exist. The gaps that remain are: (1) the entire Phase-1B two-layer membership schema (`TournamentMembership`/`TeamMembership`/`MatchAssignment`) is absent — these were spec'd as Phase-1A "schema-only" in B.17/B.18 but were not built; (2) the deferrable `one_owner_per_org` follow-up RunSQL migration was never created; (3) the 8-value membership status enum is collapsed to a single `is_active` boolean; (4) invite-tree delegation rules (§2.9) are not enforced; (5) orphan auto-promotion (§2.10) is not implemented; plus several stale/contradictory code comments.

---

## Findings

### F1 — Two-layer membership schema (TournamentMembership / TeamMembership / MatchAssignment) entirely absent
**Severity:** high · **Category:** schema-gap
**Evidence:** `Grep "TournamentMembership|TeamMembership|MatchAssignment"` over `backend/` → "No files found." There is no `apps/tournaments`, `apps/teams`, `apps/matches`, `apps/fixtures`, `apps/live`, `apps/notifications`, or `apps/disputes`.
**Spec:** v1Users.md §4.7 (`TournamentMembership`), §5.7/§6.7 (`MatchAssignment` with status enum, `replaced_by_assignment`, `referee_approval_status`), §7.7 (`TeamMembership`), and **B.17/B.18 explicitly place these three membership tables + their constraints in Phase 1A** ("Tournament/Team/Match memberships … schema and constraints — but the parent tables … are stubs"; migrations 0010/0012/0014/0015).
**Why it matters:** The spec's authorization invariants for GameCoord/Scorer/Referee/TM are two-layer (Org-membership AND scope-membership). With no scope tables, those four roles can hold an OrganizationMembership but have no operational scope binding — the resolver returns role-default modules with no row-level scope enforcement. B.2's scope-filter pattern (which queries exactly these tables) cannot be implemented. This is the single largest deviation from the locked Phase-1A boundary.
**Recommendation:** Build migrations 0010 (`TournamentMembership`), 0012 (`TeamMembership`), 0014 (`MatchAssignment` + status/referee fields), 0015 (no-scorer-and-referee pre_save signal) as schema-only with stub parent tables, exactly as B.18 sequences. If the team intentionally deferred ALL of these to Phase 1B, update B.17/B.18 in the spec to reflect that decision rather than leaving the spec claiming Phase 1A.

### F2 — `one_owner_per_org` deferrable follow-up RunSQL migration was never created
**Severity:** high · **Category:** schema-gap / data-integrity
**Evidence:** `backend/apps/organizations/models.py:216-226` declares the constraint with a comment: *"the spec's DEFERRABLE INITIALLY DEFERRED requirement is therefore added by a follow-up RunSQL migration owned by the organizations agent. This declarative constraint stays IMMEDIATE until then."* `Glob backend/apps/organizations/migrations/*.py` returns only `__init__.py` and `0001_initial.py`. `Grep "RunSQL"` in organizations app → none. The only RunSQL in the codebase is `apps/audit/migrations/0002_audit_append_only.py:53`.
**Spec:** v1Users.md §2.7 constraint block: `one_owner_per_org` MUST be `DEFERRABLE INITIALLY DEFERRED` "to allow atomic ownership-swap within a single transaction (outgoing flips False, incoming flips True)."
**Why it matters:** The constraint is currently IMMEDIATE (Django can't combine `condition` + `deferrable` on a partial unique). The atomic swap only works because `ownership.py` orders the saves (clears outgoing owner first). That workaround is correct for the ownership-transfer path, but any future code that sets the new owner before clearing the old, or any bulk operation, will hit an IntegrityError mid-transaction that the spec intended to defer to COMMIT. The deferred behavior the spec mandates simply does not exist.
**Recommendation:** Add `0002_one_owner_per_org_deferrable.py` with `RunSQL` that drops the partial-unique index and re-creates `one_owner_per_org` as a real deferrable EXCLUDE/UNIQUE constraint at the DB level (mirroring the deferrable-via-RunSQL pattern), or formally accept the ordered-save workaround and remove the "follow-up migration owned by the organizations agent" promise from the model comment.

### F3 — 8-value membership status enum collapsed to a single `is_active` boolean
**Severity:** high · **Category:** schema-gap / lifecycle
**Evidence:** `backend/apps/organizations/models.py:185` — `is_active = models.BooleanField(default=True)`. There is no `status` field on `OrganizationMembership`. PRD §3.3 line 191: `status ∈ { invited, pending_email_verification, pending_approval, active, suspended, revoked, declined, left }`. v1Users.md §2.7 schema shows `status = enum(...)  # PRD §3.3 (8 values)`.
**Why it matters:** The spec's constraints reference status values the model cannot represent: §2.7's `single_org_per_admin_user` is spec'd as `Q(role='admin', status__in=['active','invited','pending_email_verification','pending_approval'])` to prevent dual-approval races during simultaneous signups; the implementation's version is `Q(role='admin', is_active=True)` (models.py:229-233) — so a user with a *pending* admin invite in Org X is NOT blocked from a pending admin signup in Org Y, re-opening the race the spec widened the constraint to close. Lifecycle states `invited`, `declined`, `left`, `suspended` vs `revoked` are all indistinguishable. The invite-accept service (invitation.py:294-297) "reactivates" by flipping `is_active`, losing the declined/revoked/left distinction. Audit/UX surfaces that filter on membership status (§2.10, §3.9, §5.9) cannot work as spec'd.
**Recommendation:** Add a `status` CharField with the 8 PRD §3.3 choices; keep `is_active` as a derived/computed convenience or migrate constraints to use `status`. Widen `single_org_per_admin_user` and `unique_active_role_per_user_per_org` to the pending-inclusive status sets per §2.7.

### F4 — Invite-tree delegation rules (§2.9) not enforced in the invitation service
**Severity:** medium · **Category:** authorization-gap
**Evidence:** `backend/apps/organizations/services/invitation.py:107-146` `create_invitation` validates only that each role is a member of `MembershipRole.values`; it never checks the inviter's role against the invitable set. It then collapses a multi-role invite to the single highest-rank role (`_pick_highest_role`, lines 102-104, 142). No check that, e.g., a Co-organizer cannot invite an Admin, or that a Game coordinator can only invite Scorers/Referees/TMs scoped to their tournament.
**Spec:** v1Users.md §2.9 delegation table, §3.8 (Co-org cannot invite Admin), §4.8 (GameCoord cannot invite Admin/Co-org), §5.8/§6.8 (Scorer/Referee have ZERO invite power), §7.8 (TM zero invite power). §2.13 server-side validation step: *"Inviter has permission to invite this role (§2.9)."*
**Why it matters:** Privilege escalation. As written, any user who can reach the invite endpoint with a chosen role can invite at any tier, including `admin` — bypassing the "only existing Admins can promote to Admin" lock (§2.9, §3.2). The frontend `InviteCreateModal.tsx` even defaults the role checkbox to `["admin"]` (line 84) and offers all 6 role checkboxes to every caller with no tier filtering.
**Recommendation:** Add an `_assert_can_invite(inviter, org, role)` guard in `create_invitation` implementing the §2.9 matrix (Admin→all incl. sub-Admin; Co-org→peer Co-org + all sub-roles, NOT Admin; GameCoord→peer GameCoord + Scorer/Referee/TM scoped; Scorer/Referee/TM→none). Reflect the same constraint in the SPA invite form's role options. Add a parametrized authorization test.

### F5 — Orphan handling implements detection only, not the §2.10 auto-promotion cascade
**Severity:** medium · **Category:** lifecycle-gap
**Evidence:** `backend/apps/organizations/services/lifecycle.py:265-298` `detect_orphaned()` flips active orgs with no active admin to `OrphanED` and audits `org_orphaned`. There is no auto-promotion logic anywhere (no `org_owner_auto_promoted` emission outside the event_type catalog; `Grep` shows the event_type only in spec).
**Spec:** v1Users.md §2.10 Orphan handling: *"If another active Admin exists → first by created_at is auto-promoted to owner … If no other Admin but ≥1 active Co-organizer exists → first Co-organizer by created_at is auto-promoted to Admin AND owner … If no Admin and no Co-organizer → Org enters orphaned status."* B.7 lists `org_owner_auto_promoted` as an always-on notification.
**Why it matters:** The implementation orphans an org whenever the owning admin is removed even if other admins/co-orgs exist who should be auto-promoted first. The spec's intent is that `orphaned` is the *last resort*, reached only when no Admin AND no Co-organizer remain. Current behavior will over-orphan and surface healthy orgs in the Super-admin reassignment queue. Also, owner departure with a surviving second Admin should auto-promote that Admin to owner; today that org could end up with zero owners but a live Admin.
**Recommendation:** Implement the 3-tier cascade (promote-existing-admin → promote-first-co-org → orphan) as a service invoked on owner removal/suspension, emitting `org_owner_auto_promoted` (and notifications per B.7). `detect_orphaned()` should only fire the orphan path when both the admin AND co-organizer pools are empty.

### F6 — Stale/contradictory deferrable comments in ownership service and constraint tests
**Severity:** low · **Category:** code-integrity / misleading-docs
**Evidence:** `backend/apps/organizations/services/ownership.py:91` comment: *"Atomic swap. Thanks to DEFERRABLE INITIALLY DEFERRED, the constraint is checked at COMMIT, not after each UPDATE."* — directly contradicts the same file's own docstring (lines 6-20) which explains Django drops the deferrable flag and the swap relies on ordered saves. `backend/apps/organizations/tests/test_org_constraints.py:6` claims `one_owner_per_org (deferrable; checked at COMMIT)` and `test_ownership_transfer.py:3` claims *"the DEFERRED constraint allows the swap inside one transaction."* The constraint is IMMEDIATE (F2).
**Why it matters:** A future maintainer reading line 91 will believe deferral protects them and may reorder the saves, introducing an IntegrityError. The tests pass regardless of deferral (they'd pass with IMMEDIATE because the ordered save satisfies the constraint at each step), so they give false assurance that deferred behavior is verified.
**Recommendation:** Fix the ownership.py:91 comment to state the swap relies on save-ordering with an IMMEDIATE constraint. Update test docstrings, or add a real test that proves deferral (insert two owners then swap-without-ordering inside one txn and assert it commits) once F2's RunSQL migration lands.

### F7 — Module-override resolver does not model the A.3 access-level qualifiers (✅ / 👁 / 🔵)
**Severity:** low · **Category:** spec-simplification
**Evidence:** `backend/apps/permissions/models.py:67` stores only `default_for_roles = JSONField()` (a flat list of role strings). The resolver (`resolver.py:67-86`) treats a module as binary present/absent. Appendix A.3 distinguishes ✅ full / 👁 read-only / 🔵 scoped / — none per (role × module). The matrix test (`test_permission_matrix.py:48`) only asserts presence/absence, not level.
**Why it matters:** `org.settings` is ✅ for Admin but 👁 (read-only) for Co-organizer (§3.6, A.3); `org.member_directory` is ✅ for Admin/Co-org but 👁 for GameCoord. The current model grants Co-org the `org.settings` module identically to Admin with no read-only distinction, so the "Co-organizer cannot edit Org identity fields" lock (§3.2, §3.10) is unenforced at the module layer. This is partially mitigated by the spec's design (B.2 says level/scope is enforced by row-level filters, not the module flag) and is arguably a Phase-1B concern, hence low severity — but the gap should be tracked, because today nothing enforces Co-org read-only on org.settings.
**Recommendation:** Either add a per-(role,module) access-level to the catalog, or document explicitly (in code + spec) that A.3's ✅/👁 distinction is enforced by endpoint-level write-permission checks (not yet built) and add those checks when the Org Settings write endpoints land.

### F8 — Resolver cross-worker cache invalidation (B.3 / A.4) deferred; only single-backend delete implemented
**Severity:** low · **Category:** known-deferral
**Evidence:** `backend/apps/permissions/services/resolver.py:42-50` `invalidate_cache` only calls `cache.delete(...)` with a `TODO (Appendix B.3): publish to Redis pub/sub channel … Phase 1A is single-process safe via the shared backend; cross-worker invalidation lands in Phase 1B.` The full A.4 invalidation contract (version-suffixed key `eff_modules:user:<uuid>:org:<uuid>:v:<int>`, `permcache:` pub/sub, `permissions_changed` synthetic SSE notification) is not implemented.
**Why it matters:** Matches the README known-issue (d): dev uses LocMemCache; under multiple ASGI workers in prod a grant change on worker A won't drop worker B's cached module set for up to TTL (300s), so a revoked module can remain effective for 5 minutes on some workers. Acceptable for Phase 1A single-process, but a correctness hazard the moment the app runs >1 worker — which production (ASGI) will.
**Recommendation:** Implement the B.3 Redis pub/sub invalidation + version-suffix key before multi-worker deploy; wire the `permissions_changed` always-on SSE notification when the live app lands.

### F9 — Org status enum diverges from spec naming (`pending_review` vs `pending_approval`)
**Severity:** info · **Category:** naming-inconsistency
**Evidence:** `backend/apps/organizations/models.py:37` `PENDING_REVIEW = "pending_review"`. v1Users.md §2.3 Path B and §1.5 Orgs page use `pending_approval` for the Org status; the Super-admin console page filter lists *"active / pending_approval / suspended / orphaned"* (§1.5 table row 3).
**Why it matters:** Cosmetic but real: the sadmin console spec, approval-flow copy, and any status-filter UI reference `pending_approval`. The membership status enum (PRD §3.3) also uses `pending_approval`. Two different strings for the same concept invites filter/serializer bugs at the sadmin boundary.
**Recommendation:** Pick one canonical value (`pending_review` or `pending_approval`) and align the spec + code + sadmin filters. If `pending_review` is intentional, fold the rename into v1Users §1.5/§2.3.

---

## Gaps (consolidated, for the planner)

| Item | Missing | Spec ref | Effort | Blocking for |
|------|---------|----------|--------|--------------|
| TournamentMembership / TeamMembership / MatchAssignment schema | All three tables + their constraints + no-scorer/referee signal | §4.7,§5.7,§6.7,§7.7,B.17,B.18 | L | GameCoord/Scorer/Referee/TM operational scope; B.2 scope filters; Phase 1B |
| `one_owner_per_org` deferrable RunSQL migration | Follow-up migration promised in model comment never written | §2.7 | S | True deferred-at-commit ownership swaps |
| 8-value membership status enum | `status` field; only `is_active` bool exists | PRD §3.3, §2.7, §2.10, §3.9, §5.9 | M | Full lifecycle modeling; pending-inclusive admin-uniqueness race fix |
| Invite-tree delegation enforcement | `_assert_can_invite(inviter, role)` per §2.9 matrix | §2.9, §2.13, §3.8, §4.8, §5.8, §6.8, §7.8 | M | Prevents privilege escalation via invite |
| Orphan auto-promotion cascade | promote-admin → promote-co-org → orphan; `org_owner_auto_promoted` | §2.10, B.7 | M | Correct ownership succession |
| A.3 access-level qualifiers (✅/👁/🔵) | Module model is binary; no read-only/scoped distinction | §A.3, §3.6 | M | Co-org read-only org.settings; scoped data |
| Cross-worker cache invalidation (B.3) | Redis pub/sub + versioned key + permissions_changed SSE | A.4, B.3 | M | Multi-worker prod correctness |
| Ownership concurrency (SELECT FOR UPDATE on Org) + transfer initiate/accept two-step | Service does one-shot swap; no pending-transfer token row | §2.10, B.21 | M | Concurrent-transfer safety |
| Org-status naming alignment | `pending_review` vs spec `pending_approval` | §1.5, §2.3 | S | sadmin console filter parity |

## What is correctly implemented (verified, not gaps)

- **22-module catalog** — `apps/permissions/fixtures/modules.json` has exactly 22 entries with correct codes, categories, and `default_for_roles`, including the 3 post-audit B.16 additions (`tournament.report_export`, `tournament.organizer_checklist`, `tournament.day_pack_export`). Loaded idempotently via `load_modules`.
- **Per-user module override schema AND UI ship in v1.0** (matches the §2.6/§2.14 locked decision; supersedes the older A.4 header note "UI in v1.5"). Backend: `MembershipModuleGrant` keyed on (user, organization) per the A.4 audit-fix; `services/grants.py` enforces reason ≥20 chars, audits each change, supports bulk + clear. Frontend: `ModuleMatrixPage.tsx` + `GrantCell.tsx` (3-state default/grant/deny matrix, per-row save, idempotent event_id).
- **Multi-role resolver audit-fix** — `resolver.py` unions role defaults then applies (user, org) overrides; `test_resolver_grant_overrides_role_default_deny.py` proves a single DENY wins over a multi-role union. This is the exact bug A.4 was rewritten to fix.
- **OrganizationMembership constraints** — all 4 present (`unique_active_role_per_user_per_org`, `one_owner_per_org`, `single_org_per_admin_user`, `owner_flag_only_on_admin_role`) with DB-level tests in `test_org_constraints.py`.
- **Invite token flow** — opaque token + sha256 hash, plaintext emailed only, 7-day expiry, single-use, session-cycle on accept (B.11), idempotent via event_id.
- **`media` role correctly dropped** — `MembershipRole` enum (models.py:44-52) has exactly the 5 invitable roles + admin; no `media` value (matches §10.5).
- **UUID v7 PKs** on every model via `uuid7` helper (B.1, invariant 1).
- **Permission matrix parametrized test** covers all 22×6 cells against the fixture (invariant 12, B.15).
