# Adversarial Verify A — bulk_set_grants is NOT idempotent (event_id dropped)

**Verdict: REAL. Severity: high (confirmed correct).**
**Confidence: high (0.95).**

## Finding under review
`backend/apps/permissions/views.py:210` `put()` (module-matrix PUT) reads `cells/grants + reason`
and calls `bulk_set_grants(...)` with NO `event_id`/`idempotency_key`; the service layer has no
idempotency parameter and unconditionally upserts + emits audit; the serializer self-documents that
`event_id` is ignored; the frontend DOES send it. A double-submit re-applies upserts and writes
duplicate `module_grant_changed` audit rows.

## What the real code shows (every claim independently confirmed)

### 1. View drops event_id — `backend/apps/permissions/views.py:210-246`
The `put()` handler parses both body shapes. For the `cells` shape it builds:
```
ser = BulkGrantsCellsSerializer(data=request.data)   # :222
ser.is_valid(raise_exception=True)
payload = ser.validated_data
grants_pairs = [(code, state) for code, state in payload["cells"].items()]  # :225-227
reason = payload["reason"]                            # :228
```
Then calls the service (:239-246):
```
bulk_set_grants(
    user=target_user, organization=org, grants=grants_pairs,
    granted_by=request.user, reason=reason, request=request,
)
```
`payload["event_id"]` is parsed/validated but never read or forwarded. CONFIRMED.

### 2. Serializer self-documents the gap — `backend/apps/permissions/serializers.py:107-110`
```
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
# with the global event_id table).
event_id = serializers.UUIDField(required=False)
```
Verbatim match to the finding. CONFIRMED.

### 3. Service has no idempotency param + unconditional upsert/audit — `backend/apps/permissions/services/grants.py:135-213`
Signature `bulk_set_grants(*, user, organization, grants, granted_by, reason, request=None, actor_role=...)`
— no `event_id`/`idempotency_key` parameter (:135-144). Inside `transaction.atomic()` it loops, and
for each changed module does `MembershipModuleGrant.objects.update_or_create(...)` (:180-189) and
`emit_audit(... event_type="module_grant_changed" ...)` (:192-209) with NO `idempotency_key=` passed.
CONFIRMED.

### 4. emit_audit WOULD dedupe if given the key — `backend/apps/audit/services.py:38,45-48`
`emit_audit` accepts `idempotency_key: uuid.UUID | None = None` and short-circuits:
```
if idempotency_key:
    existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        return existing
```
The dedup machinery exists; the grants service simply never uses it. This strengthens the finding:
the omission is a real, fixable gap, not an unsupported feature. CONFIRMED.

### 5. Frontend DOES send event_id (so double-submit is realistic)
- `frontend/src/features/permissions/ModuleMatrixPage.tsx:95-98`:
  `permissionsApi.setGrants(orgSlug, userId, { cells, event_id: newEventId() })`
- `frontend/src/api/permissions.ts:27-39`: `setGrants(...)` payload type includes `event_id: string`
  and PUTs the whole payload to `/api/permissions/orgs/${slug}/users/${userId}/grants/`.
- Test `frontend/src/features/permissions/__tests__/ModuleMatrixPage.test.tsx:125-126` asserts the
  payload contains a non-empty `event_id`.
The client generates a fresh per-save `event_id`, so the server is contractually expected to honor it.
CONFIRMED.

### 6. No DB-level safety net masks the gap — `backend/apps/permissions/models.py:141-149`
`MembershipModuleGrant`'s only unique constraint is `(user, organization, module)` — no `event_id`
column anywhere on the model. So idempotency cannot be enforced at the DB layer for this write;
the view/service layer is the only place it could live, and it doesn't. CONFIRMED.

## Behavior of a double-submit (re-derived from the code)
- The grant rows themselves: `update_or_create` is convergent for a fixed `cells` payload, so the
  final grant STATE is unchanged by a replay. The data-corruption blast radius is bounded.
- Audit rows: on the FIRST submit the loop sees `prior_state != state` and emits one
  `module_grant_changed` row per changed module. On an immediate REPLAY of the SAME payload,
  `prior_state == state` (:169) so those modules are skipped → typically NO duplicate audit rows for
  an exact same-payload double-submit. Duplicate audit rows occur on interleaved/competing submits
  (A→B then a delayed retry of A→B after a B→A flip) or concurrent saves, where each transition is a
  real change. So "writes duplicate audit rows" is true in the general retry/concurrency case but is
  partially self-mitigated for the exact-same-payload immediate replay because of the
  `prior_state == state` skip.

## Invariant mapping
This violates **Invariant 3 (idempotent writes): "Every mutation endpoint accepts a client-generated
event_id (UUID) with a unique DB constraint. Re-submitting returns the existing record."** The PUT is
a mutation endpoint, accepts `event_id`, and silently ignores it — no unique constraint, no
"return existing" behavior. The endpoint is not idempotent. The grant convergence (update_or_create)
softens, but does not satisfy, the invariant: there is no `event_id` uniqueness and audit emission is
not guaranteed-once across retries/concurrency.

## Severity judgment
Severity **high** is appropriate and I leave it unchanged:
- It is a direct violation of a LOCKED, "non-negotiable" architectural invariant (Invariant 3),
  explicitly called out as applying to *all* writes, not just scoring.
- The audit log is a compliance/append-only system of record (Invariants 4 and 5); spurious or
  inconsistent audit rows undermine its trustworthiness.
- The frontend already sends `event_id`, so the contract is live and being broken silently in prod.
It is not "critical" because: grant state itself converges (no privilege-escalation/data-loss on
replay), the duplicate-audit risk is partially mitigated for exact replays, and it is scoped to a
single admin-only endpoint (low call volume).

## Conclusion
is_real = true. Severity high is correct. The omission is real, self-documented, and the supporting
machinery (emit_audit idempotency_key) already exists — making this a clean, well-scoped fix.
