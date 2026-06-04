# Cross-Cutting Audit — Invariant #7: Rule-Freeze Boundaries

**Scope:** Whole backend (`backend/apps/**`, `backend/fixture/**`) + frontend (`frontend/src/**`), excluding `.venv` / `node_modules`.
**Date:** 2026-06-04
**Auditor model:** Opus 4.8 (1M)

## Invariant under test

> **7. Rule freeze at the right boundary.** Tournament structured rules are mutable in `draft` / `published`, frozen at `registration_open` (amend requires reason + 24h grace + notifications). Match rules are *additionally* frozen once the match enters `live_first_half`; no amend retroactively applies.

PRD canon: §5.2 "Rule-freeze policy" (lines 317–327), §5.5 "Per-match rule freeze" (lines 425–427), §6 data-model `Tournament` row (`structured_rules`, `prose_rules`, `rule_freeze_at`, `registration_open_at`, `registration_close_at` — line 942), `GenerationRun` (`inputs_hash`, `last_manual_edit_at` — line 962), event hooks `rule_amend_proposed` / `rule_amend_effective` (line 712), `tournament_state_changed → rule freeze/unfreeze` (line 863).

## Headline conclusion

Invariant #7 is a **Phase 1B concern**. The models it governs (`Tournament`, `Match`, `GenerationRun`) **do not exist** in the codebase. Therefore there are **no direct violations** of #7 in the implemented Phase-1A code — there is nothing yet to freeze, and nothing in 1A writes mutable tournament/match rules.

The real question the task asks — *"confirm 1A does not BLOCK it and record prep gaps"* — is answered **YES, 1A does not block #7, and is in fact well-positioned for it.** The audit log, the scope-filter base classes, and the established lifecycle/state-transition service pattern are all reusable hook points. The single genuine prep gap is the **absence of any deferred-execution mechanism** for the "24-hour grace period before the amend takes effect" requirement (no Celery / scheduler in 1A).

Severity legend: critical | high | medium | low | info.

---

## Findings

### F1 — No Tournament / Match / GenerationRun models exist; #7 is entirely unbuilt (Phase 1B)
- **Severity:** info (expected per project status; not a 1A defect)
- **Evidence:**
  - `backend/apps/permissions/scope.py:18` — the only `class Tournament` in the repo is a **docstring example**, not a real model:
    ```python
    18:    class Tournament(models.Model):
    ```
    (inside a triple-quoted integration-pattern docstring, lines 11–26)
  - Repo-wide search `class (Tournament|Match|Fixture|MatchEvent|Bracket|Player|Team|Person|Dispute)` over `backend/**/*.py` returns **only** that one docstring hit. No real model class anywhere.
  - Repo-wide search for `freeze|frozen|rule_freeze|registration_open|amend|inputs_hash|last_manual_edit` over `**/*.{py,ts,tsx}` returns **zero** rule-freeze domain matches — only unrelated tokens (`frozenset`, `OWNER_2FA_GRACE_DAYS`, "gracefully", 2FA `recovery_codes:regenerate`).
  - Search for `GenerationRun|inputs_hash|structured_rules|prose_rules|rule_freeze_at|registration_open_at` over `backend/**/*.py`: **No files found.**
- **Why it matters:** Confirms the audit baseline — #7 cannot be violated by code that does not exist. Establishes that every freeze obligation below is a *forward* obligation on the 1B Tournament/Match/Fixtures agents, not a backlog defect.
- **Recommendation:** None for 1A. Track #7 in the 1B implementation plan for `apps.tournaments` (rule-freeze on `registration_open`) and `apps.matches` (per-match freeze on `live_first_half`).

### F2 — Audit infrastructure is freeze-ready: `emit_audit()` already carries `tournament_id`, `match_id`, before/after JSONB, and a free-form `event_type`
- **Severity:** info (positive prep confirmation)
- **Evidence:**
  - `backend/apps/audit/services.py:24-39` — `emit_audit(*, ... tournament_id=None, match_id=None, ..., payload_before=None, payload_after=None, reason="", idempotency_key=None, ...)` — the exact shape PRD §5.2 demands ("Audit `before`/`after` of every changed field", "Required reason ≥20 chars").
  - `backend/apps/audit/models.py:64-65` — columns already present:
    ```python
    64:    tournament_id = models.UUIDField(null=True, blank=True, db_index=True)
    65:    match_id = models.UUIDField(null=True, blank=True, db_index=True)
    ```
  - `backend/apps/audit/models.py:68` — `event_type = models.CharField(max_length=64, db_index=True)` is **free-form** (no `choices`), so `rules_frozen`, `rule_amend_proposed`, `rule_amend_effective`, `tournament_state_changed` (PRD lines 712, 863) flow through **without a migration**.
  - `backend/apps/audit/services.py:80-87` — `emit_audit_on_commit()` defers emission to `transaction.on_commit`, aligning with invariant #4 (DB-first; publish post-commit).
- **Why it matters:** The hardest part of #7 — an append-only, before/after-capturing audit trail scoped to tournament & match — is **already built and DB-enforced** (append-only migration `audit/migrations/0002_audit_append_only.py`). 1B freeze hooks should call `emit_audit()` and not invent a parallel log.
- **Recommendation:** When 1B lands, the tournament `amend_rules` / `freeze_rules` verbs MUST emit via `apps.audit.services.emit_audit` (service-layer pattern, per `audit/services.py:1-11`), passing `tournament_id` (and `match_id` for per-match freeze), `payload_before` = pre-amend rule snapshot, `payload_after` = post-amend snapshot, `reason` (enforce ≥20 chars at the verb, per PRD §5.2 line 322). Do **not** route freeze through Django signals (B.4 lock forbids it).

### F3 — Established lifecycle/state-transition service pattern is the correct template for the freeze verbs; 1A does not block it
- **Severity:** info (positive prep confirmation)
- **Evidence:**
  - `backend/apps/organizations/services/lifecycle.py:84-109` (`approve_org`) demonstrates the canonical guarded-transition shape the freeze verbs must mirror: **precondition check → `ValidationError` on bad state → `transaction.atomic()` → before/after dict → inline `emit_audit()`**:
    ```python
    91:    if org.status != OrgStatus.PENDING_REVIEW:
    92:        raise ValidationError(f"Cannot approve org in status {org.status}")
    94:    with transaction.atomic():
    95:        before = {"status": org.status}
    96:        org.status = OrgStatus.ACTIVE
    97:        org.save(update_fields=["status"])
    98:        emit_audit( ... payload_before=before, payload_after={"status": org.status} ... )
    ```
  - `backend/apps/organizations/services/lifecycle.py:119-123` (`reject_org`) shows the **reason-required** guard (`len(reason.strip()) < 8 → ValidationError`) — the same gate PRD §5.2 requires for amends (there ≥20 chars).
  - `backend/apps/organizations/models.py:34-41` (`OrgStatus` TextChoices) + lifecycle marks `archived_at` / `suspended_at` (lines 138-139) show how to model an explicit state machine with timestamp marks — exactly how `Tournament.rule_freeze_at` (PRD line 942) and per-match freeze marks should be modelled.
  - `backend/apps/organizations/models.py:322-329` (`effective_status` property) shows the **read-time derived-state** idiom 1B can reuse to surface "frozen" without a sweep job.
  - `backend/apps/permissions/scope.py:11-29` (docstring) explicitly anticipates `apps/tournaments/models.py` swapping in `ScopedManager` — the multi-tenancy chassis is pre-wired for the Tournament model.
- **Why it matters:** Invariant #6 (state machines not booleans) and #7 (freeze at state boundary) share one implementation idiom. 1A already ships that idiom in `lifecycle.py`; 1B can copy it verbatim for `Tournament` status + rule-freeze. Nothing in 1A's design forces a boolean-flag shortcut.
- **Recommendation:** Author the 1B freeze verbs (`apps/tournaments/services/rules.py`: `amend_rules(...)`, `freeze_rules(...)`; `apps/matches/services/...`: per-match freeze guard) in the `lifecycle.py` style. Add a `state machine` test suite per `CLAUDE.md` ("every transition + every blocked transition") that asserts: rule write in `draft`/`published` succeeds; rule write at `registration_open`+ raises unless via the amend verb; per-match rule write after `live_first_half` raises.

### F4 — No deferred-execution mechanism exists for the "24-hour grace period before amend takes effect"
- **Severity:** medium (prep gap; blocks the *full* §5.2 amend workflow, not 1A)
- **Evidence:**
  - PRD §5.2 line 324: "**24-hour grace period** before amend takes effect (configurable; Super-admin can waive in emergencies with reason)." This requires a future-dated effect, i.e. deferred execution or a sweep.
  - 1A explicitly has **no task queue**: `backend/apps/organizations/management/commands/mark_orphaned_orgs.py:3` — *"Run periodically (cron / systemd timer) — there's no Celery in 1A."*
  - `backend/apps/organizations/services/lifecycle.py:269` — *"Intended to be called by a manage.py cron command (no Celery in 1A)."*
  - `backend/apps/organizations/serializers.py:163` — *"...we don't run a cron — read-time [computation]"* (1A leans on read-time derivation instead of scheduled jobs).
  - Search for `celery|apscheduler|django-q|scheduled|grace_period|effective_at|takes effect` over `backend/apps` + `backend/fixture`: only the `emit_audit_on_commit` hook, the cron-command comments above, and KPI nightly-cron comments — **no scheduler that can fire an event 24h in the future.**
  - PRD §6 line 962 `GenerationRun` and the scheduled-notification cron (CLAUDE.md `notifications/` app) are likewise **not built**.
- **Why it matters:** A rule amend that "takes effect in 24h" is a future-dated state change. With no Celery/scheduler, 1B must choose between (a) a `manage.py apply_due_rule_amends` cron command + systemd timer (the 1A house style), or (b) a read-time `effective_rules` property that compares `amend_effective_at` to `now()` (the `effective_status` idiom). Either works, but the decision is **unmade** and there is no infra to lean on today. This is the one place where #7's full spec needs scaffolding that 1A did not lay.
- **Recommendation:** Decide the grace-period mechanism in the 1B plan. Cheapest path consistent with 1A: store `rule_amend_effective_at` on the amend record (or on `Tournament`), expose an `effective_structured_rules` read-time property (mirror `AdminInvitation.effective_status`, `organizations/models.py:322-329`), and add a `manage.py finalize_due_amends` command (mirror `mark_orphaned_orgs`) wired to a systemd timer for firing the `rule_amend_effective` audit/notification at the boundary. Do **not** assume a broker exists. If the project later adopts Channels-worker-backed scheduling, revisit.

### F5 — Frontend has zero rule-freeze / amend / "regenerate vs keep manual" UI (Phase 1B)
- **Severity:** info (expected; not a 1A defect)
- **Evidence:**
  - Search `freeze|frozen|amend|rule_freeze|registration_open|regenerate|keep manual|inputs_hash|last_manual_edit` over `frontend/src`: only matches are `accounts/auth/2fa/recovery_codes:regenerate` route strings in `frontend/src/types/api.generated.ts:55,64,1357` and a "Regenerate whenever a backend serializer changes" comment in `frontend/src/types/generated.ts:5` — **all unrelated to rule freeze.**
  - The frontend `tournament`/`match` hits (e.g. `frontend/src/features/roles/ScorerLandingPage.tsx`, `RefereeLandingPage.tsx`, `features/errors/ComingSoonPage.tsx`, `features/layout/OrgComingSoonPage.tsx`) are **role-landing scaffolds / "coming soon" placeholders**, not scoring or rule surfaces.
- **Why it matters:** Invariant #10's "regenerate / keep manual / view diff" banner and #7's amend-with-reason modal are both 1B UI. Their absence is correct for 1A. No premature/incorrect freeze UI exists to fix.
- **Recommendation:** None for 1A. 1B frontend plan must add: (a) an amend-rules modal enforcing reason ≥20 chars + showing the 24h grace notice; (b) a "rules frozen" read-only state on the tournament rules editor once status ≥ `registration_open`; (c) a per-match "rules locked" indicator once `live_first_half`. Mirror the existing module-gated read-only pattern (`frontend/src/features/permissions/ModuleMatrixPage.tsx`).

---

## Gaps (prep for Phase 1B #7)

| # | Gap | Where 1A should/already lands the hook | Blocking 1B? | Effort |
|---|-----|----------------------------------------|--------------|--------|
| G1 | `Tournament` model with `status` enum + `structured_rules`/`prose_rules` JSONB + `rule_freeze_at` mark, modelled as a state machine (not booleans). | New `apps.tournaments`; copy `OrgStatus`/lifecycle-marks idiom from `organizations/models.py:34-41,138-139`; swap in `ScopedManager` per `permissions/scope.py:11-29`. | No (1A unblocked) | L |
| G2 | Tournament rule-freeze + formal amend verbs (`amend_rules`, `freeze_rules`) with reason ≥20 chars, before/after audit. | New `apps/tournaments/services/rules.py`; copy guarded-transition shape from `organizations/services/lifecycle.py:84-144`; emit via `audit/services.py:emit_audit`. | No | M |
| G3 | **24h grace-period deferred execution** for amends ("takes effect in 24h"). No scheduler in 1A. | Decide cron-command + systemd-timer (mirror `mark_orphaned_orgs.py`) vs read-time `effective_rules` (mirror `AdminInvitation.effective_status`, `organizations/models.py:322-329`). | No, but **needed for full §5.2** | M |
| G4 | Per-match rule freeze: `Match` rules immutable once `live_first_half`; tournament amend must NOT retro-apply. | New `apps.matches`; guard at the rule-write verb keyed on match status; `match_id` audit column already exists (`audit/models.py:65`). | No | M |
| G5 | `GenerationRun` model (`inputs_hash` + `last_manual_edit_at`) backing invariant #10's regenerate/keep-manual banner — interacts with freeze (regeneration of a frozen tournament's bracket must respect freeze). | New `apps.fixtures`; PRD §6 line 962. Not started. | No | M |
| G6 | State-machine test suite for freeze ("every transition + every blocked transition") + multi-tenant isolation tests on the new freeze endpoints. | New `apps/tournaments/tests/`, `apps/matches/tests/`; follow the parametrized style already used in `permissions/tests/test_permission_matrix.py`. | No | M |
| G7 | Notification fan-out on amend (`rule_amend_proposed` / `rule_amend_effective`, PRD line 712) — `notifications/` app not built. | New `apps.notifications`; SSE delivery per invariant #11. | No | M |
| G8 | Frontend: amend-rules modal (reason + grace notice), frozen read-only rules editor, per-match rules-locked indicator. | New 1B feature folders; mirror module-gated read-only pattern in `frontend/src/features/permissions/ModuleMatrixPage.tsx`. | No | M |

**Bottom line:** 1A places **no blocker** on invariant #7. The audit log (`tournament_id`/`match_id`/before-after/free-form `event_type`), the scope-filter chassis, and the lifecycle-verb idiom are all reusable, correctly-shaped hook points. The only substantive missing scaffold specific to #7 is a deferred-execution mechanism for the 24-hour amend grace period (G3), which is a deliberate 1A omission ("no Celery in 1A") rather than a defect.
