# Integrity Audit: backend/apps/sports — Idempotency / Audit / State (#3/#4/#5/#6)

**Date:** 2026-06-04
**Scope:** `backend/apps/sports/` only — audited through four invariant lenses:
1. Invariant 3 — Mutations accept `event_id` + unique DB constraint + replay→existing
2. Invariant 4 — DB-first event log; Redis publish only in `transaction.on_commit`
3. Invariant 5 — AuditEvent append-only enforced at DB level (trigger + REVOKE)
4. Invariant 6 — Status via explicit state-machine (not ad-hoc bool); transitions audited

---

## Summary

The sports app in Phase 1A is intentionally **read-only from the API surface**. All
mutating paths (`load_sports` management command, and implicit super-admin ORM writes)
are out-of-band and do not go through DRF views. This narrows the scope significantly:
invariants 3 and 4 are structurally N/A for the current code, but the absence of the
write path means when it _is_ added (Phase 1B or sadmin sport-status flip) it will land
without any scaffolding for idempotency, audit, or state-machine guards. Invariants 5
and 6 reveal real gaps that need to be addressed now or before Phase 1B begins.

---

## Findings

### F1 — HIGH: `SportStatus` transitions are not guarded by a state machine; `load_sports` can silently downgrade status

**File:** `backend/apps/sports/management/commands/load_sports.py:89`
**Evidence:**
```python
_obj, created = Sport.objects.update_or_create(
    code=code, defaults=defaults
)
```
**Why it matters:** `defaults` always includes `status` from the JSON file (line 75–88).
Re-running `load_sports` with a modified `sports.json` can silently flip a sport from
`active` back to `planned` — or from `deprecated` to `coming_soon` — with no transition
guard, no precondition check, and no audit row. Invariant 6 requires explicit state-machine
transitions with audit logs for every status change.

**Recommendation:** Add a transition guard inside `load_sports` (and any future admin verb)
that: (a) reads the current status before overwriting, (b) validates the
planned→coming_soon→active→deprecated directed graph (no backward jumps without explicit
`--allow-downgrade` flag), and (c) calls `emit_audit()` whenever the status field actually
changes (detected by comparing `_obj.status` before and after or checking `created` vs
updated). Alternatively, strip `status` out of `defaults` and manage status via a separate
explicit command/sadmin verb.

---

### F2 — HIGH: Status changes by `load_sports` are never audit-logged

**File:** `backend/apps/sports/management/commands/load_sports.py:49–95`
**Evidence:**
```python
# No import of emit_audit, no AuditEvent creation anywhere in the file.
with transaction.atomic():
    for entry in data:
        ...
        _obj, created = Sport.objects.update_or_create(
            code=code, defaults=defaults
        )
```
**Why it matters:** A super-admin running `load_sports` can change `status` from `planned`
to `active` (making a sport's full plugin visible) with no trace in the `audit_event` table.
This violates invariant 6 ("state changes audit-logged") and invariant 5's intent (the audit
log must be the complete record of all state transitions).

**Recommendation:** After `update_or_create`, detect if `status` changed:
```python
if not created and _obj.status != defaults["status"]:
    emit_audit(
        actor_user=None,
        actor_role=ActorRole.SYSTEM,
        event_type="sport.status_changed",
        target_type="sport",
        target_id=_obj.id,
        payload_before={"status": _obj.status},
        payload_after={"status": defaults["status"]},
        reason="load_sports command",
    )
```
Note: `_obj` from `update_or_create` reflects the post-save state, so capture
`old_status = Sport.objects.filter(code=code).values_list("status", flat=True).first()`
**before** calling `update_or_create`.

---

### F3 — MEDIUM: `SportStatus` lacks a formal transition table; any value→any value is accepted at the DB level

**File:** `backend/apps/sports/models.py:87–92`
**Evidence:**
```python
status = models.CharField(
    max_length=16,
    choices=SportStatus.choices,
    default=SportStatus.PLANNED,
    db_index=True,
)
```
**Why it matters:** Django `choices` only validates at the form/serializer layer; raw ORM
assignments (including `update_or_create`) bypass it entirely. There is no model-layer
`clean()` method, no DB-level CHECK constraint, and no service-layer transition function
that enforces `planned→coming_soon→active` ordering. A future developer (or the Phase 1B
agent) can set `status="active"` directly on a `deprecated` sport without any guard.
Invariant 6 requires state machines, not booleans or raw `choices` fields.

**Recommendation:** Add a DB-level `CheckConstraint` that at minimum ensures valid enum
values, and add a `transition_status(new_status)` service function that validates
direction and calls `emit_audit`. A lightweight lookup dict
`VALID_TRANSITIONS = {PLANNED: {COMING_SOON}, COMING_SOON: {ACTIVE, PLANNED}, ...}` is
sufficient for Phase 1A.

---

### F4 — MEDIUM: No `event_id` / idempotency key on the future sport-status mutation path

**File:** `backend/apps/sports/views.py` (entire file), `backend/apps/sports/urls.py`
**Evidence:**
```python
# views.py — only GET endpoints exist; no mutation views at all.
class SportListView(generics.ListAPIView): ...
class SportDetailView(generics.RetrieveAPIView): ...
```
**Why it matters:** There is currently no write API for sports, which is correct for Phase 1A.
However, when the Phase 1B sport-status-flip verb is added (e.g., a sadmin action to promote
a sport from `planned` to `coming_soon`), it must accept a client-supplied `event_id` UUID
with a unique DB constraint per invariant 3. There is no skeleton or comment to remind
the implementing agent of this requirement.

**Recommendation:** Add a `# PHASE_1B_TODO: Any PATCH/action endpoint here must accept
event_id (invariant 3) and call emit_audit (invariant 6).` comment block in `views.py`
now, so the constraint is visible to whoever builds the write path. Optionally scaffold
an abstract `SportActionSerializer` base with the `event_id` field already wired.

---

### F5 — MEDIUM: `load_sports` does not check for Redis/on_commit before any future pub/sub

**File:** `backend/apps/sports/management/commands/load_sports.py:52`
**Evidence:**
```python
with transaction.atomic():
    for entry in data:
        ...
        _obj, created = Sport.objects.update_or_create(...)
```
**Why it matters:** Currently no Redis publish occurs here, which is correct. However
the command does mutate `SportStatus` inside a transaction. When Phase 1B adds live
channel notifications (e.g., "a new sport is now active"), a developer may naively add
a `channel_layer.group_send()` call inside the `transaction.atomic()` block, violating
invariant 4 (Redis publish must only happen in `transaction.on_commit`). There is no
guard or comment to prevent this.

**Recommendation:** Add a `transaction.on_commit` wrapper stub and a comment:
```python
# Any channel_layer.group_send() for sport-status changes MUST be
# wrapped in transaction.on_commit(lambda: ...) — invariant 4.
```

---

### F6 — LOW: Append-only enforcement (invariant 5) is correctly implemented in `audit_event` — but the comment in migration 0002 says "production should ADDITIONALLY REVOKE" and that REVOKE is never done

**File:** `backend/apps/audit/migrations/0002_audit_append_only.py:11–13`
**Evidence:**
```
Production deployments should
ADDITIONALLY REVOKE UPDATE/DELETE on audit_event from the application
role for defense in depth — handled in deploy provisioning, not here.
```
**Why it matters:** The trigger-based approach (which fires even for superusers) is the
primary guard and is sound. However, the comment acknowledges a second layer — REVOKE at
the Postgres role level — which is not implemented anywhere in the repository (no deploy
script, no provisioning playbook, no migration). This means in production the application
DB role retains `UPDATE/DELETE` permission on `audit_event`, so a compromised app-layer
credential could bypass the trigger via a `DISABLE TRIGGER` call (requires superuser) or
an out-of-band psql session with the app role. This is not a sports-specific issue but is
relevant because sports status changes will eventually emit audit rows.

**Recommendation:** Add a second migration (or a deploy-provisioning script committed to
the repo) that executes:
```sql
REVOKE UPDATE, DELETE ON TABLE audit_event FROM <app_role>;
```
Document the app-role name in `.env.example` so the deploy step can reference it.

---

### F7 — INFO: No `python_module_path` validation or state-machine guard before it is populated

**File:** `backend/apps/sports/models.py:108`
**Evidence:**
```python
# When the per-sport plugin app is built (Phase 1B), this field is
# populated with its dotted Python path (e.g., "apps.sports.football").
python_module_path = models.CharField(max_length=200, blank=True, default="")
```
**Why it matters:** `python_module_path` should only be non-empty when `status="active"`.
Currently there is no CHECK constraint or model-layer validation to enforce this coupling.
A misconfigured `load_sports` run could set a module path on a `planned` sport, causing
Phase 1B dispatch logic to attempt to load a non-existent plugin.

**Recommendation:** Add a DB-level `CheckConstraint`:
```python
models.CheckConstraint(
    check=(
        Q(python_module_path="") | Q(status="active")
    ),
    name="sport_module_path_requires_active_status",
)
```
and enforce in the `transition_status()` service function.

---

## Gaps (forward-looking; not present defects)

| # | Area | Missing | Needed for | Effort | Blocking? |
|---|------|---------|-----------|--------|-----------|
| G1 | sports/views.py | Sport status-flip write endpoint with `event_id` + audit | Phase 1B | M | No |
| G2 | sports/services.py | `transition_status()` service enforcing valid transitions + audit emission | Phase 1B | S | No |
| G3 | sports/models.py | `CheckConstraint` for `python_module_path` requiring `status=active` | Phase 1B | S | No |
| G4 | deploy/provisioning | `REVOKE UPDATE, DELETE ON audit_event FROM <app_role>` SQL | Production | S | No |
| G5 | sports/ | No channel_layer integration guard or scaffold for on_commit pub/sub | Phase 1B | S | No |
| G6 | sports/tests/ | No test asserting that `load_sports` does NOT downgrade status | Now | S | No |
| G7 | sports/ | No isolation test verifying sport catalog is NOT org-scoped (cross-org read confirmed safe, but not explicitly tested) | Now | S | No |
