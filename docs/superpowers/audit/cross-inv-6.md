# Cross-Cutting Audit — Invariant 6: Status as state-machine enums with audited transitions (no ad-hoc boolean flags)

**Scope:** Whole backend (`backend/apps`, excl. `.venv`) + frontend (`frontend/src`, excl. `node_modules`).
**Invariant text:** *"State machines, not boolean flags. Status are explicit enums with audit-logged transitions (PRD §5.2, §5.5 — every transition specifies trigger / precondition / notification / audit)."*
**Date:** 2026-06-04
**Verdict:** Phase 1A **substantially complies** with the spirit of inv-6 for the lifecycles it implements (Org, Invitation, Feedback, Sport, GrantState). Status fields are `TextChoices` enums, transitions live in service-layer verbs that validate preconditions and emit `AuditEvent` rows inline, and the audit table is append-only at the DB level. **No genuine boolean-as-status anti-patterns were found.** The findings below are about **rigor gaps** (no central transition table, two transitions lack precondition guards, two transitions are mutated directly in views/verbs bypassing the canonical service) and **Phase 1B prep gaps** (the PRD §5.2/§5.5 Tournament/Match machines — the heart of this invariant — are not built yet, but nothing in 1A blocks them).

---

## Findings

### F1 — No centralized/declarative state-machine layer; every transition table is implicit in prose + scattered `if` guards
**Severity:** medium
**Files:** entire backend — confirmed absent via repo-wide search.
**Evidence:** A search for `VALID_TRANSITIONS|ALLOWED_TRANSITIONS|can_transition|transition_to|StateMachine|django_fsm|FSMField` across `backend/**/*.py` returned **"No matches found."** Each transition is hand-coded as an ad-hoc precondition check inside its own service function, e.g. `apps/organizations/services/lifecycle.py:91`:
```python
if org.status != OrgStatus.PENDING_REVIEW:
    raise ValidationError(f"Cannot approve org in status {org.status}")
```
and `apps/organizations/services/lifecycle.py:161`:
```python
if org.status not in (OrgStatus.ACTIVE, OrgStatus.PENDING_REVIEW, OrgStatus.ORPHANED):
    raise ValidationError(f"Cannot suspend an org in status '{org.status}'.")
```
**Why it matters:** The invariant + PRD §5.2/§5.5 mandate that *every* transition has an explicit trigger/precondition/notification/audit row, and the test plan (PRD line 1021) requires a "State machine" suite asserting "Every transition + every blocked transition." With no single source of truth (a transition map / FSM), the set of legal edges is not enumerable, not parametrizable, and not enforceable consistently. This is tolerable for 1A's 5-state Org machine but will not scale to the 9-state Tournament + 12-state Match machines of Phase 1B without a real FSM abstraction. The duplicated inline-fallback in `sadmin/services/superadmin_verbs.py` (see F3) is a direct symptom.
**Recommendation:** Before Phase 1B, introduce a small declarative transition primitive (a `{from_state: {trigger: to_state}}` map + a `transition(obj, trigger, actor, reason)` helper that validates the edge, performs the save, and emits the audit row in one atomic block). Either adopt a library (`django-fsm-2`/`viewflow.fsm`) or a ~40-line in-house helper. Retrofit `OrgStatus`, `InviteStatus`, `FeedbackStatus` onto it so the same machinery is reused by the Tournament/Match machines, and back it with the parametrized "every transition + every blocked transition" pytest suite the PRD already calls for.

### F2 — `archive_org` has no source-state precondition; allows archiving from any non-`archived` state (incl. `suspended`, `orphaned`)
**Severity:** medium
**File:** `backend/apps/organizations/services/lifecycle.py:227-257`
**Evidence:**
```python
def archive_org(*, org, archived_by, reason, request=None):
    if org.status == OrgStatus.ARCHIVED:
        return org
    if not reason or len(reason.strip()) < 3:
        raise ValidationError("A reason of at least 3 characters is required.")
    with transaction.atomic():
        ...
        org.status = OrgStatus.ARCHIVED
```
The only guard is "already archived → no-op" and a reason-length check. There is **no whitelist of legal source states.** Compare with `approve_org`/`reject_org`/`unsuspend_org`/`suspend_org`, which all enumerate legal source states.
**Why it matters:** Inv-6 requires each transition specify *preconditions*. PRD §5.2 lists `* → cancelled` and `* → paused` as explicit wildcard transitions, but archive is positioned as `completed → archived` (auto) or admin-forced — it is not a documented `*`-source edge. An unguarded any→archived edge means audit/state coherence can be skipped (e.g., archiving a `pending_review` org never sets a review decision; archiving a `suspended` org loses the suspension lineage). It is also untestable as a "blocked transition."
**Recommendation:** Add an explicit legal-source whitelist (e.g., `{ACTIVE, SUSPENDED, ORPHANED}` per the product's intended archive policy, or `*`-minus-terminal if archive is truly universal) and a corresponding "blocked transition" test. Fold into the F1 transition map.

### F3 — Org suspend/unsuspend transition is duplicated in `superadmin_verbs.py` with an inline fallback that mutates `org.status` directly, bypassing the canonical service guards
**Severity:** medium
**File:** `backend/apps/sadmin/services/superadmin_verbs.py:94-158`
**Evidence:** `suspend_org` (line 109-128) and `unsuspend_org` (line 140-158) each carry an `except (ImportError, AttributeError):` fallback that re-implements the transition:
```python
except (ImportError, AttributeError):
    before = {"status": org.status}
    org.status = OrgStatus.SUSPENDED
    org.suspended_at = timezone.now()
    org.suspended_reason = reason
    org.save(update_fields=["status", "suspended_at", "suspended_reason"])
    emit_audit(...)
```
The fallback **omits the precondition guards** present in the canonical `lifecycle.suspend_org` (which rejects suspending an `archived` org and requires reason ≥3 chars) and the `unsuspend` fallback omits the "must currently be suspended" guard.
**Why it matters:** Two divergent code paths for the same state transition violate "one canonical, audited transition." The sibling app `lifecycle.py` *does* exist and *is* importable (it is the same repo), so the fallback is dead code today — but it is a latent inv-6 violation: if the import ever changes shape, suspensions would silently route through an unguarded edge. It also contradicts the file's own docstring claim that it is a "thin delegate."
**Recommendation:** Delete the inline fallbacks; let the import fail loudly (the deferral rationale — "sibling service may not have shipped" — is obsolete now that 1A is complete). Keep `superadmin_verbs.suspend_org/unsuspend_org` as pure delegates like `approve_org`/`reject_org` already are (lines 72-91).

### F4 — Membership deactivation (`member_role_revoked`) transition lives inline in the view, not in a service verb
**Severity:** low
**File:** `backend/apps/organizations/views.py:385-398`
**Evidence:**
```python
if membership.is_active:
    membership.is_active = False
    membership.removed_at = _tz.now()
    membership.save(update_fields=["is_active", "removed_at"])
    emit_audit(... event_type="member_role_revoked" ...)
```
The state change + audit happen directly in `OrgMemberRemoveView.delete`, not in `organizations/services/`. Note this is a **boolean lifecycle flag** (`is_active`), not an enum.
**Why it matters:** `OrganizationMembership.is_active` is a legitimate, defensible boolean (it is part of three unique constraints — `unique_active_role_per_user_per_org`, `one_owner_per_org`, `single_org_per_admin_user` — at `models.py:208-239`; modelling it as an enum would complicate those partial-unique conditions). So this is **not** a boolean-as-status violation per se. The gap is purely that this transition is not in the service layer like every other audited transition, so it is harder to reuse/test and inconsistent with the B.4 "transitions live in services" pattern. The audit *is* emitted (good), and it is inside an implicit request transaction.
**Recommendation:** Extract a `services/membership.py::deactivate_membership(...)` verb (mirroring `invitation.revoke_invitation`) and call it from the view. Low priority — behavior is correct today.

### F5 — `Sport.status` is an enum but has no transition guard at all (free mutation via admin/data load)
**Severity:** low
**File:** `backend/apps/sports/models.py:24-37, 87-92`
**Evidence:** `SportStatus` is a proper `TextChoices` (`planned → coming_soon → active → deprecated`) with a documented intended progression in the docstring (lines 25-37), but there is **no service verb, no precondition, and no audit emission** for changing it — it is mutated only by `load_sports` / Django admin / future code. Search confirmed no `sport` transition service exists.
**Why it matters:** The catalog is platform metadata (not org-scoped, not user-facing-mutable in 1A), so the absence of a guarded transition is acceptable *for 1A*. But per inv-6 the documented lifecycle (`planned→coming_soon→active→deprecated`) is currently unenforced and unaudited — flipping a sport to `active` is a meaningful platform event (it implies a per-sport plugin shipped). Marked low because there is no end-user mutation path today.
**Recommendation:** When Phase 1B wires the first sport plugin, add a `promote_sport(sport, to_status, by, reason)` service verb with edge validation + `emit_audit` (event_type e.g. `sport_status_changed`). No action needed for 1A.

### F6 — `AdminInvitation.effective_status` computes `expired` on read without persisting; the read-model and stored state can disagree
**Severity:** low (info-leaning)
**File:** `backend/apps/organizations/models.py:319-329`
**Evidence:**
```python
@property
def effective_status(self) -> str:
    if self.status == InviteStatus.PENDING and self.is_expired():
        return InviteStatus.EXPIRED
    return self.status
```
A `pending` row past `expires_at` surfaces as `expired` to readers but the DB column stays `pending` until `accept_invitation` sweeps it (`invitation.py:252-255`). The transition `pending → expired` is therefore **time-triggered but lazily materialized**, and the materialization-on-accept path emits **no audit row** for the expiry transition (the accept path just `.update(status=EXPIRED)` then raises).
**Why it matters:** This is a reasonable pattern (PRD §5.2 has auto/time-triggered transitions), and the computed property is well-documented. The inv-6 gap is narrow: the `→ expired` transition is the one Org-domain transition with **no `AuditEvent`** (every other one audits). For a low-stakes invite expiry this is defensible, but it is the lone unaudited transition in the app.
**Recommendation:** Either (a) emit a `member_invite_expired` audit row when the lazy `.update(...EXPIRED)` fires in `accept_invitation`, or (b) move expiry sweeping into a scheduled job that audits it. Document the decision in v1Users.md so the "every transition is audited" claim stays literally true.

### F7 (positive / info) — Booleans audited correctly: `User.is_active` suspension is a guarded, audited transition
**Severity:** info
**File:** `backend/apps/sadmin/services/superadmin_verbs.py:166-219`
**Evidence:** `suspend_user`/`unsuspend_user` flip `user.is_active` inside `@transaction.atomic` with `payload_before`/`payload_after` and an `emit_audit` (`user_suspended`/`user_unsuspended`). `User.is_active` is Django's built-in auth boolean (cannot be an enum without breaking `AbstractUser`), so this is the correct way to honor inv-6 for an unavoidable boolean: treat it as a 2-state machine with audited transitions.
**Why it matters:** Confirms no violation here — included so the report is not silently selective. Same applies to `OrganizationMembership.is_active` (F4) and `Organization.deleted_at` soft-delete.

### F8 (positive / info) — Audited transitions are backed by DB-level append-only enforcement
**Severity:** info
**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:17-35`
**Evidence:** A `BEFORE UPDATE OR DELETE` trigger on `audit_event` raises `42501 insufficient_privilege`, so the audit rows produced by every transition cannot be mutated/erased — the "audit-logged transitions" half of inv-6 is enforced at the database, not just app, layer (and ties to inv-5).
**Why it matters:** Strengthens inv-6: transition history is tamper-evident. No action.

### F9 (frontend / info) — Frontend mirrors backend status enums as exact typed unions; no boolean-as-status drift
**Severity:** info
**Files:** `frontend/src/types/user.ts:100,142`, `frontend/src/types/api.generated.ts:849,1106,1237,1244`
**Evidence:** Status types are string-literal unions matching the backend `TextChoices` exactly — `OrganizationStatusEnum: "pending_review" | "active" | "suspended" | "archived" | "orphaned"` (line 1106), `AdminInvitationStatusEnum: "pending" | "accepted" | "expired" | "revoked"` (line 849), `SportStatusEnum` (1237), `StateEnum: "default" | "grant" | "deny"` (1244), `GrantState` (user.ts:100). `is_active`/`is_org_owner` appear only as the same booleans the backend exposes (`orgs.ts:40`, `api.generated.ts:1059,1092`). No frontend code invents a boolean status proxy.
**Why it matters:** Confirms the SPA does not undermine inv-6. No action. (Frontend does not — and should not — own transition validation; it is presentation only.)

---

## Gaps (Phase 1B prep)

| Item | Current state | Missing | Needed for | Blocking 1A? | Effort |
|------|---------------|---------|-----------|--------------|--------|
| **Tournament state machine (PRD §5.2)** | Spec only (prose transition table, lines 285-327). No `tournaments` app, no `Tournament.status` enum, no transitions. | The 9-state happy path + 4 side states (`cancelled`/`paused`/`disputed`/`orphaned`), each with trigger/precondition/notification/audit; rule-freeze boundary at `registration_open`. | Phase 1B core. | No — 1A does not block it. The audit infra (`emit_audit`, append-only trigger), `ActorRole.SYSTEM` for auto-transitions, and the org-lifecycle pattern are reusable templates. | XL |
| **Match state machine (PRD §5.5)** | Spec only (lines 391-414). No `matches` app, no `Match.status` enum. | 12-state path incl. `live_*` halves/ET/penalties + 6 side states; the `live_first_half`-rule-freeze boundary (inv-7); `MatchEvent` DB-first event log (inv-4). | Phase 1B scorer flow. | No. | XL |
| **Central FSM primitive** | None (F1). | A declarative transition map + `transition()` helper + parametrized "every transition / every blocked transition" pytest suite (PRD line 1021). | Both machines above + retrofitting Org/Invite/Feedback. Strongly recommended *before* Phase 1B to avoid the F3-style duplication multiplying. | No, but ships best alongside the first Phase 1B machine. | M |
| **`disputed` overlay status** | None. PRD §5.2/§5.5 model `disputed` as an *overlay* that auto-clears. | Decide overlay vs. discrete state; likely a separate `has_open_disputes`-derived flag — must be modeled as a derived/computed state (à la `effective_status`), NOT a raw boolean, to stay inv-6-compliant. | Phase 1B disputes app. | No. | M |
| **Auto/time-triggered transitions** | Only lazy/manual transitions exist in 1A (e.g. invite expiry F6, `detect_orphaned` cron at `lifecycle.py:265`). No scheduler. | PRD §5.2/§5.5 have many `(auto)` time-triggered edges (registration window open/close, scheduled→live, lineup deadlines). Needs a scheduler (cron/Celery-beat) that performs + audits these. | Phase 1B. Note PRD has no Celery in 1A; `detect_orphaned` is a `manage.py` cron — the same pattern can carry early 1B auto-transitions. | No. | L |

---

## Summary

Invariant 6 is **honored, not violated, in Phase 1A**: every status field is an explicit `TextChoices` enum (`OrgStatus`, `InviteStatus`, `FeedbackStatus`, `SportStatus`, `GrantState`, `ActorRole`); the genuinely-boolean lifecycles that *must* be boolean (`User.is_active`, `OrganizationMembership.is_active`, soft-delete `deleted_at`) are all flipped through guarded, atomic, audited verbs; and the audit trail is append-only at the DB layer. There are **no ad-hoc boolean-as-status anti-patterns.** The medium findings are rigor gaps — no central transition table (F1), two transitions missing source-state guards or living outside the canonical service (F2, F3) — that should be fixed *before* Phase 1B amplifies them across the much larger Tournament/Match machines. The real weight of inv-6 (PRD §5.2/§5.5) is entirely Phase 1B and unbuilt, but 1A's audit infrastructure and service-verb pattern provide a clean, non-blocking foundation for it.
