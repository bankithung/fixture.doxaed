# Cross-cutting audit — Invariant 3: Idempotent writes (client `event_id` + unique constraint, replay → 200)

**Scope:** whole backend + frontend (excluding `backend/.venv`, `frontend/node_modules`).
**Invariant under test (CLAUDE.md #3):** "Every mutation endpoint accepts a client-generated `event_id` (UUID) with a unique DB constraint. Re-submitting returns the existing record (200, not 201). This is non-negotiable for the scorer flow but applies to *all* writes."
**Date:** 2026-06-04
**Phase context:** 1A is implemented; 1B (tournaments/matches/scorer — where invariant 3 is "non-negotiable") is not built.

---

## How idempotency is implemented in Phase 1A

There is **no dedicated `event_id` ledger / table**. The single idempotency anchor in the entire backend is:

- `backend/apps/audit/models.py:48` — `idempotency_key = models.UUIDField(unique=True, null=True, blank=True)`
- DB-level uniqueness confirmed in `backend/apps/audit/migrations/0001_initial.py:30-33` (`unique=True`).

Pattern: `emit_audit(..., idempotency_key=event_id)` writes the key onto the AuditEvent row; replay is detected by looking up a prior AuditEvent with the same key and rebuilding the prior result from its `target_id` / `payload_after`.

This is a sound *chassis*, but coverage across mutation endpoints is **partial and inconsistent**, and the replay-detection code has a **non-atomic race** that breaks the "replay → 200" guarantee under concurrency.

---

## Findings

### F1 — `bulk_set_grants` (module-override matrix PUT) silently drops `event_id`; endpoint is NOT idempotent — HIGH
- **Serializer accepts the key but the view discards it:** `backend/apps/permissions/views.py:210-246` — `put()` reads `cells`/`grants`+`reason` and calls `bulk_set_grants(...)` with **no** `event_id`/`idempotency_key` argument.
- **Service has no idempotency parameter at all:** `backend/apps/permissions/services/grants.py:135-213` — `bulk_set_grants(*, user, organization, grants, granted_by, reason, request, actor_role)`. No replay short-circuit; each changed module unconditionally `update_or_create`s a row and emits an audit event with **no** `idempotency_key`.
- **Serializer self-documents the gap:** `backend/apps/permissions/serializers.py:107-110` — `# event_id is accepted for idempotency but currently ignored at the service layer (Phase 1A ...)`.
- **Frontend DOES send it:** `frontend/src/features/permissions/ModuleMatrixPage.tsx:97` — `event_id: newEventId()`.
- **Why it matters:** A double-submitted matrix save (slow network, double-click, TanStack retry) re-applies the upserts and writes **duplicate `module_grant_changed` audit rows**. There is no unique constraint to stop it (the AuditEvent idempotency_key is left null). Violates invariant 3 for a real, shipping mutation endpoint.
- **Fix:** Thread `event_id` into `bulk_set_grants`; before the atomic block, look up a prior AuditEvent with that `idempotency_key` (event_type `module_grant_changed`) and short-circuit-return if found; pass `idempotency_key=event_id` on (at least the first) emitted audit row. Because a bulk op emits *N* audit rows, a single key cannot dedup all of them — prefer a dedicated idempotency ledger keyed on `event_id` for bulk verbs (see Gap G1). Have the view return 200 (not the implicit 200 it already returns) on replay.

### F2 — `transfer_ownership` drops `event_id`; ownership-swap write is NOT idempotent — HIGH
- **Serializer declares it:** `backend/apps/organizations/serializers.py:98` — `event_id = serializers.UUIDField(required=False)`.
- **Both views ignore it:** `backend/apps/organizations/views.py:331-338` (`OrgTransferOwnershipView`) and `backend/apps/organizations/views.py:650-657` (`OwnershipTransferBySlugView`) call `ownership_svc.transfer_ownership(...)` with **no** `event_id`.
- **Service has no idempotency parameter:** `backend/apps/organizations/services/ownership.py:40-115` — `transfer_ownership(*, org, current_owner_user, new_owner_user, requested_by, request)`; emits `ownership_transfer_accepted` audit with no `idempotency_key`.
- **Frontend sends it:** `frontend/src/features/orgs/OwnershipTransferModal.tsx:60` → `frontend/src/api/orgs.ts:99-111` (`transferOwnership` payload includes `event_id`).
- **Why it matters:** A replayed transfer re-runs the owner-flag swap and emits a second audit row. The state-machine end-state is the same on a clean replay, but it is not a guaranteed no-op (e.g. if ownership was transferred onward in between, a stale replay could mis-fire) and it double-audits. Invariant-3 violation; also weakens the audited-state-machine invariant (#6).
- **Fix:** Add `event_id` to `transfer_ownership`; short-circuit on a prior `ownership_transfer_accepted` AuditEvent with the same key (return the existing memberships); pass `idempotency_key=event_id` to `emit_audit`.

### F3 — Invitation-create returns 201 (not 200) on idempotent replay; test enshrines the wrong contract — MEDIUM
- **Service correctly replays:** `backend/apps/organizations/services/invitation.py:158-167` returns the existing `AdminInvitation` when the `event_id` was seen before.
- **But the view hard-codes 201:** `backend/apps/organizations/views.py:585-587` — `return Response(AdminInvitationSerializer(inv).data, status=status.HTTP_201_CREATED)` with no branch for the replay case. (UUID-routed sibling `OrgInvitationsView.post` at `views.py:419` has the same shape.)
- **Test asserts the bug:** `backend/apps/organizations/tests/test_slug_routes.py:177` — `assert resp2.status_code == 201` on the *second* (replay) call. Invariant 3 mandates 200 on replay. The test passes only because the implementation is wrong in the same direction.
- **Why it matters:** Clients cannot distinguish "created" from "replayed" — the documented contract is broken. Contrast with feedback (does it right) and signup (does it right).
- **Fix:** Have `create_invitation` signal whether it replayed (e.g. return a `created: bool` or compare a prior-lookup flag), and have both invitation-create views return 200 on replay / 201 on fresh create. Update `test_invitation_create_idempotent_on_event_id` to assert 200 on `resp2`.

### F4 — Check-then-create idempotency is non-atomic; concurrent replay raises uncaught IntegrityError (500) instead of 200 — MEDIUM
- **Root pattern:** `backend/apps/audit/services.py:45-48` — `existing = AuditEvent.objects.filter(idempotency_key=...).first(); if existing: return existing` then falls through to `AuditEvent.objects.create(...)`. There is no `select_for_update`, no `get_or_create`, no `IntegrityError` catch.
- **Same racy pattern at each call site's replay guard:** signup `backend/apps/accounts/services/signup.py:176-186`; invitation `backend/apps/organizations/services/invitation.py:160-167`; feedback service `backend/apps/sadmin/services/feedback.py:74-81`; feedback view `existed_before` probe `backend/apps/sadmin/views/feedback.py:174-181` (separate query, also racy).
- **Why it matters:** The unique constraint (`audit_event.idempotency_key`) correctly prevents a duplicate row — but when two replays of the *first* request run concurrently (the exact double-submit scenario invariant 3 exists to absorb), both pass `.first()`, both reach `create()`, and the loser raises `IntegrityError`. Nothing catches it: signup/invitation propagate a 500; the feedback view's broad `except Exception` (`feedback.py:192-197`) converts it to a 500. The invariant promises 200, not 500, on replay.
- **Fix:** Replace check-then-create with an atomic upsert keyed on `idempotency_key` (e.g. `get_or_create(idempotency_key=..., defaults=...)`) inside the service, and catch `IntegrityError` at the replay boundary to re-fetch and return the existing row. For bulk verbs use a dedicated single-row idempotency ledger (Gap G1) so one INSERT arbitrates the whole operation.

### F5 — Several Phase-1A state-changing writes accept no `event_id` at all — MEDIUM
Invariant 3 says it "applies to *all* writes," but these mutation endpoints have neither an `event_id` field nor a replay guard (each emits audit unconditionally):
- Org lifecycle verbs (all in `backend/apps/organizations/views.py`): `PATCH` org `198-220`; `change_slug` `234-247`; `suspend` `254-267`; `unsuspend` `275-`; `archive` `292-`; member remove `372-`; invitation revoke `442-`.
- Org create: `backend/apps/organizations/views.py:141-158` (`OrgListCreateView.post`).
- Accounts writes (`backend/apps/accounts/views.py`): profile `PATCH` `me_view` `416-441`; `user_soft_delete_view` `449-474`; `twofa_disable_view` `369-382`; `twofa_recovery_regenerate_view` `385-396`; 2FA enroll/confirm `336-366`.
- **Why it matters:** These are lower-risk (most are naturally convergent or super-admin-gated, low volume) but they are still writes the invariant claims to cover. A retried `archive`/`suspend`/`soft_delete` double-audits; a retried 2FA `recovery_regenerate` would *invalidate the codes the user just saw*.
- **Confidence:** medium that this is a true violation vs. an accepted Phase-1A scope cut — the wording "applies to *all* writes" is unambiguous, but no spec carve-out for these specific verbs was found. Recommend an explicit decision: either add `event_id` to these verbs or record a documented exemption list in the PRD/v1Users decisions log.
- **Fix:** Add `event_id` (optional UUID) to the serializers and thread `idempotency_key` through to `emit_audit` for the convergent verbs; for recovery-code regeneration, gate it behind idempotency *or* explicitly document it as deliberately non-idempotent.

### F6 — No shared idempotency-key helper on the frontend; `crypto.randomUUID()` is UUID v4 — LOW / INFO
- **Duplicated helper:** identical `newEventId()` defined three times — `frontend/src/features/orgs/InviteCreateModal.tsx:58`, `frontend/src/features/permissions/ModuleMatrixPage.tsx:24`, `frontend/src/features/orgs/OwnershipTransferModal.tsx:29` (plus an inline `crypto.randomUUID()` at `frontend/src/features/layout/OrgDashboardPage.tsx:86`).
- **v4 vs v7:** all use `crypto.randomUUID()` (UUID v4). Invariant 1 mandates UUID v7 for PKs; an opaque idempotency key only needs uniqueness, so v4 is functionally fine — flagging for consistency only (info).
- **Bigger gap:** the key is generated fresh per click, not persisted across a *page reload* of an in-flight submit. True end-to-end idempotency wants the key stable for the logical operation (generate once, reuse on retry). Today a user who reloads mid-submit and retries gets a new key and a duplicate.
- **Fix:** Centralize one `newEventId()` (and consider a tiny "stable per pending mutation" wrapper). Optional: align on v7 for cosmetic consistency.

### F7 — No test covers concurrent replay or the IntegrityError path — LOW
- Existing idempotency tests are all sequential single-thread: signup `backend/apps/accounts/tests/test_signup_path_b.py:253-271`; invitation `backend/apps/organizations/tests/test_slug_routes.py:153-182`; feedback `backend/apps/sadmin/tests/test_feedback_submit.py:90-103`; bulk-grant matrix `backend/apps/permissions/tests/test_matrix.py:241`.
- None exercise the concurrent double-submit that F4 describes, so the 500-on-race regression is invisible to CI.
- **Fix:** Add a test that forces two `create()`s for the same `idempotency_key` (e.g. mock `.first()` to return None on the second call, or use threads/`pytest`-with-`transaction=True`) and assert the second resolves to 200 with the existing row, not a 500.

---

## What is correct (so it is not relitigated)
- **Unique DB constraint exists:** `audit_event.idempotency_key UNIQUE` (`audit/models.py:48`, migration `0001_initial.py:32`).
- **Signup endpoint replay → 200:** `backend/apps/accounts/views.py:117-119` + service `signup.py:235-239`; test `test_signup_path_b.py:253-267` asserts 200 on replay.
- **Feedback endpoint replay → 200:** `backend/apps/sadmin/views/feedback.py:199-202` (200 when `existed_before`, else 201); service `feedback.py:74-81`.
- **Audit emission is the single idempotency chokepoint** (`emit_audit`), which is a clean place to harden (F4).

---

## Gaps (prep for Phase 1B, where invariant 3 is non-negotiable for the scorer)

- **G1 — No general `event_id` ledger / mixin.** Phase 1A piggybacks idempotency on `AuditEvent.idempotency_key`, which only works for single-audit-row verbs and breaks for bulk verbs (F1) and any verb that emits 0 audit rows. The scorer flow (`MatchEvent` writes, PRD §5.5) needs a first-class, per-write unique `event_id` column on the domain table (or a shared `IdempotentWrite` ledger) so the *domain row itself* enforces uniqueness and replay returns the canonical record. **Blocking for Phase 1B scorer.** Effort: M.
- **G2 — Atomic upsert / IntegrityError handling is not a reusable primitive.** Before 1B, refactor `emit_audit` + a shared `idempotent(...)` helper into an atomic `get_or_create` + IntegrityError-catch pattern (fixes F4 once, everywhere). Effort: S–M.
- **G3 — Replay-response contract is inconsistent (201 vs 200 vs 500).** Invitation returns 201 (F3), signup/feedback return 200, racy paths return 500 (F4). Establish one rule + a thin view helper that maps `(created|replayed)` → `(201|200)` and a service-layer `IntegrityError → re-fetch → 200`. Effort: S. Needed before 1B so the scorer client can trust status codes.
- **G4 — Frontend idempotency-key lifecycle is per-click, not per-operation.** For the scorer (offline/retry-heavy) the key must be generated once per logical action and reused on every retry until ack. Centralize the helper (F6) and define the persistence rule before building the scorer. Effort: S.
- **G5 — Decision needed on "all writes" scope (F5).** Either extend `event_id` to the remaining 1A verbs or record an explicit exemption list in the decisions log, so 1B inherits an unambiguous rule.

**1A does NOT block 1B**: the `audit.idempotency_key` chassis, the audit-emission chokepoint, and the working signup/feedback replay paths are reusable foundations. The above gaps are additive hardening, not rewrites.
