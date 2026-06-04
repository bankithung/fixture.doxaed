# Integrity Audit: `backend/apps/organizations` — Invariants #3/#4/#5/#6

**Date:** 2026-06-04
**Scope:** Idempotency, audit emission, append-only enforcement, Redis-on-commit, state-machine purity
**Status:** 7 findings (2 medium, 4 low, 1 info); 4 forward-looking gaps

---

## Findings

### F-01 — MEDIUM: UUID-based invitation POST silently drops `event_id` and `roles`

**File:** `backend/apps/organizations/views.py:424`
**Evidence:**
```python
inv, _plaintext = invitation_svc.create_invitation(
    org=org,
    email=ser.validated_data["email"],
    role=ser.validated_data["role"],
    invited_by=request.user,
    request=request,
)
```
The slug-routed sibling at line 574 correctly passes `event_id=ser.validated_data.get("event_id")` and `roles=ser.validated_data.get("roles")`. The UUID-routed `OrgInvitationsView.post` does not pass `event_id` or `roles`, so:
- Callers using the canonical AIP-136 UUID endpoint cannot get idempotent replay (invariant #3 violation).
- Multi-role invites (`roles=["admin","referee"]`) silently resolve to `co_organizer` because `role` key is not present in `AdminInvitationCreateSerializer`'s validated data when `roles` is given.

**Why it matters:** PRD invariant 3 says every mutation endpoint accepts `event_id` for idempotent replay. The two invitation endpoints have a feature split: slug route is fully idempotent; UUID route is not.

**Recommendation:** Update `OrgInvitationsView.post` to mirror the slug route — pass `role=ser.validated_data.get("role")`, `roles=ser.validated_data.get("roles")`, and `event_id=ser.validated_data.get("event_id")` to `invitation_svc.create_invitation`.

---

### F-02 — MEDIUM: `OrgDetailView.patch` mutates org without audit row or idempotency

**File:** `backend/apps/organizations/views.py:198-220`
**Evidence:**
```python
if update_fields:
    org.save(update_fields=update_fields)
return Response(OrganizationSerializer(org).data)
```
There is no `emit_audit(...)` call, no `transaction.atomic()` wrapper, and no `event_id` field accepted. `name` and `time_zone` changes go unrecorded in the audit log.

**Why it matters:**
- Invariant #6: every state-changing action must be audit-logged. Renaming an org or changing its timezone is a state change with user-visible effects.
- Invariant #3: mutations need `event_id` for idempotency.
- Without `transaction.atomic()`, a crash between `org.save` and any future audit row would leave the state inconsistent.

**Recommendation:**
1. Wrap in `transaction.atomic()`.
2. Add `emit_audit(event_type="org_settings_changed", payload_before={"name": old_name, ...}, ...)` after the save.
3. Accept optional `event_id` in `OrganizationUpdateSerializer` and forward to the audit call.

---

### F-03 — LOW: `OrgMemberRemoveView.delete` mutates membership outside a transaction

**File:** `backend/apps/organizations/views.py:385-398`
**Evidence:**
```python
if membership.is_active:
    membership.is_active = False
    membership.removed_at = _tz.now()
    membership.save(update_fields=["is_active", "removed_at"])
    emit_audit(...)
```
No `transaction.atomic()` block. If the process crashes after `membership.save` but before `emit_audit` the membership is deactivated with no audit record. Every service-layer verb (lifecycle.py, invitation.py, ownership.py) wraps both the save and the audit in a single atomic block; this view bypasses that pattern.

**Why it matters:** Invariant #4 (DB-first event log) + invariant #6 (audit-logged state changes). The view inlines service-layer logic instead of delegating to a service; it also violates the rule that business logic lives in services not views.

**Recommendation:** Extract a `membership_svc.remove_member(membership, removed_by, request)` service function using `transaction.atomic()`, move the save and audit emit inside it, and call it from the view.

---

### F-04 — LOW: `archive_org` accepts any non-ARCHIVED status, including SUSPENDED

**File:** `backend/apps/organizations/services/lifecycle.py:227-257`
**Evidence:**
```python
def archive_org(...):
    if org.status == OrgStatus.ARCHIVED:
        return org  # only guard is "already archived"
    ...
    org.status = OrgStatus.ARCHIVED
```
There is no check blocking `SUSPENDED → ARCHIVED` at the service layer. The PRD/v1Users.md spec (§2.2) implies archive is an owner/super-admin verb; but the transition from `SUSPENDED` is ambiguous — a super-admin suspending an org should remain the one to unsuspend or archive it explicitly. More critically, `ORPHANED → ARCHIVED` is also silently allowed, which could conflict with a super-admin reassignment flow.

**Why it matters:** Invariant #6 mandates explicit state-machine transitions with defined preconditions. Undeclared transitions bypass audit context and may conflict with future Phase 1B logic.

**Recommendation:** Add an explicit allowlist of valid source statuses:
```python
if org.status not in (OrgStatus.ACTIVE, OrgStatus.PENDING_REVIEW, OrgStatus.SUSPENDED, OrgStatus.ORPHANED):
    raise ValidationError(...)
```
… or document the exact allowed transitions in a comment keyed to the PRD transition table.

---

### F-05 — LOW: `detect_orphaned` checks then flips without `select_for_update` — TOCTOU race

**File:** `backend/apps/organizations/services/lifecycle.py:265-298`
**Evidence:**
```python
candidates = Organization.objects.filter(status=OrgStatus.ACTIVE, deleted_at__isnull=True)
for org in candidates:
    has_admin = OrganizationMembership.objects.filter(...).exists()
    if not has_admin:
        with transaction.atomic():
            org.status = OrgStatus.ORPHANED
            org.save(update_fields=["status"])
```
The `has_admin` check and subsequent `atomic` block are not tied by a lock. If a new admin membership is created for the org between the `exists()` call and the `select_for_update` / `save()` inside the block, the org would be incorrectly flipped to `ORPHANED`.

**Why it matters:** The management command is run as a cron, so concurrent request processing can create memberships in the window between the check and the flip. A false positive orphan-marking breaks org access for all members.

**Recommendation:** Re-check `has_admin` inside the `transaction.atomic()` block using `select_for_update()` on the org row, then discard and continue if an admin was found:
```python
with transaction.atomic():
    org_locked = Organization.objects.select_for_update().get(pk=org.pk)
    if org_locked.status != OrgStatus.ACTIVE:
        continue
    if OrganizationMembership.objects.filter(organization=org_locked, role='admin', is_active=True).exists():
        continue
    org_locked.status = OrgStatus.ORPHANED
    org_locked.save(update_fields=["status"])
    emit_audit(...)
```

---

### F-06 — LOW: DB-level REVOKE UPDATE/DELETE on `audit_event` is promised but not implemented in any migration or provisioning script

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:10-12`
**Evidence:**
```
# ADDITIONALLY REVOKE UPDATE/DELETE on audit_event from the application
# role for defense in depth — handled in deploy provisioning, not here.
```
The trigger (`audit_event_append_only`) installed by this migration correctly prevents mutation at the session level, including superuser sessions. However, the comment explicitly defers the complementary `REVOKE UPDATE, DELETE ON audit_event FROM <app_role>` to "deploy provisioning" — and no such provisioning script, SQL file, or Ansible/chef role exists in the repository.

**Why it matters:** Invariant #5 requires UPDATE/DELETE denied at the Postgres role level, not only via trigger. The trigger alone is sufficient during development but the defense-in-depth REVOKE layer is unimplemented.

**Recommendation:** Create a `scripts/provision_db_roles.sql` (or a separate migration that is environment-aware) containing:
```sql
REVOKE UPDATE, DELETE ON audit_event FROM <app_db_user>;
```
Reference it from the deployment runbook. Add a CI check (e.g., a test that attempts `UPDATE audit_event SET reason='' WHERE false` as the app DB user) to verify the REVOKE is in effect.

---

### F-07 — INFO: No Redis publish on org state changes (notifications deferred to Phase 1B live agent)

**File:** `backend/apps/organizations/services/lifecycle.py:1-6`
**Evidence:**
```
Notification fan-out / Redis publish is the live agent's concern;
we do not couple to it here.
```
None of the lifecycle verbs (suspend, unsuspend, archive, orphan) emit a `transaction.on_commit` Redis publish. The v1Users.md spec (§B.4 example and Appendix line 2393) shows `transaction.on_commit(lambda: notify_org_members(org, 'org_suspended'))` as the expected pattern.

**Why it matters:** Invariant #4 requires Redis publish only in `on_commit`. The absence is intentional deferral (Phase 1B), but there is no TODO stub or hook point in the services. When the live agent lands, it will have to add `on_commit` callbacks retroactively to each lifecycle verb, which is a retroactive-edit risk.

**Recommendation:** Add a commented-out `on_commit` stub in each state-change verb as a stable hook point:
```python
# TODO Phase-1B live agent: transaction.on_commit(lambda: publish_org_event(org.id, event_type))
```

---

## Gaps (forward-looking; not bugs in current code)

### G-01 — Medium effort — Idempotency for lifecycle verbs (suspend, unsuspend, archive, transfer ownership, change_slug)

None of the non-invitation verbs accept an `event_id`. If a client retries a `suspend` or `transfer_ownership` call due to a network timeout it receives a validation error on the second call instead of the idempotent existing response. The `AdminInvitationCreateSerializer` shows the pattern — it needs to be replicated in `SuspendSerializer`, `ArchiveSerializer`, `TransferOwnershipSerializer`, and `ChangeSlugSerializer`, and the corresponding service functions need to thread the idempotency key through to `emit_audit`.

### G-02 — Small effort — `OrgDetailView.patch` has no test coverage

No test in any `test_*.py` file exercises `PATCH /api/orgs/{uuid}/`. The field update path is untested, meaning the missing audit bug (F-02) would not have been caught by the test suite.

### G-03 — Small effort — `OrgMemberRemoveView.delete` has no test coverage

No test covers the member-remove DELETE endpoint. The missing transaction wrapper (F-03) and the missing `payload_before` in the audit emit go undetected.

### G-04 — Large effort — No DEFERRABLE INITIALLY DEFERRED migration for `one_owner_per_org`

`backend/apps/organizations/models.py:218-222` notes that Django silently drops `deferrable=Deferrable.DEFERRED` on a partial `UniqueConstraint`. The ownership swap in `ownership_svc` compensates via ordered saves (clear first, set second). The intended spec behavior (check-at-COMMIT) is not delivered. A `RunSQL` migration using `ALTER TABLE ... ADD CONSTRAINT one_owner_per_org_deferred UNIQUE (organization_id) DEFERRABLE INITIALLY DEFERRED WHERE (is_org_owner AND is_active)` would need a workaround for partial-index deferrability (Postgres does allow deferrable full constraints, and a full constraint with DEFERRABLE is possible but loses the partial-index optimization). This is a known limitation documented in the codebase but should be tracked as a future migration task.
