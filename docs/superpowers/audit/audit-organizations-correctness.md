# Correctness Audit: apps/organizations

Audit date: 2026-06-04
Auditor: Claude Code (claude-sonnet-4-6)
Scope: backend/apps/organizations — correctness bugs only (wrong conditionals, off-by-one, races, wrong queryset filters, missing transaction.atomic / on_commit, serializer<->model mismatch, wrong HTTP status, None handling, tz math)

---

## Findings

### F-01 — HIGH — KeyError crash when `roles` list is sent to UUID-routed invitation endpoint

**File:** `backend/apps/organizations/views.py:427`

**Evidence:**
```python
inv, _plaintext = invitation_svc.create_invitation(
    org=org,
    email=ser.validated_data["email"],
    role=ser.validated_data["role"],   # <-- KeyError if only "roles" was given
    invited_by=request.user,
    request=request,
)
```

**Why it matters:**
`AdminInvitationCreateSerializer.validate()` (serializers.py:207-210) only adds a default `role` key when *neither* `role` nor `roles` is present. When the SPA sends `{"roles": ["admin"]}`, `validated_data` contains only `"roles"`, not `"role"`. The `OrgInvitationsView.post` (UUID-routed, line 419-435) then does `ser.validated_data["role"]` which raises an uncaught `KeyError`, returning a 500 Internal Server Error to the caller. The slug-routed twin (`OrgInvitationsBySlugView.post`, line 569-587) correctly uses `.get("role")` and `.get("roles")` and forwards both to the service, so only the UUID-routed view is broken.

**Recommendation:**
Replace line 427 with the same pattern used in the slug-routed view:
```python
inv, _plaintext = invitation_svc.create_invitation(
    org=org,
    email=ser.validated_data["email"],
    role=ser.validated_data.get("role"),
    roles=ser.validated_data.get("roles"),
    event_id=ser.validated_data.get("event_id"),
    invited_by=request.user,
    request=request,
)
```

---

### F-02 — HIGH — Idempotent invitation replay returns 201 instead of 200

**File:** `backend/apps/organizations/views.py:433-434` and `views.py:585-587`

**Evidence:**
```python
# OrgInvitationsView (line 433-434)
return Response(
    AdminInvitationSerializer(inv).data, status=status.HTTP_201_CREATED
)

# OrgInvitationsBySlugView (line 585-587)
return Response(
    AdminInvitationSerializer(inv).data, status=status.HTTP_201_CREATED
)
```

**Why it matters:**
Invariant 3 (idempotent writes) requires that a replay returns the existing record with HTTP 200, not 201. The service `create_invitation()` (invitation.py:160-167) returns the existing `AdminInvitation` when the `event_id` matches an existing audit row, but both calling views unconditionally return 201. The caller cannot distinguish a fresh creation from a replay. The `InvitationAcceptView.post` correctly returns `HTTP_200_OK` (line 484) — the invitation-create endpoints should do likewise on replay.

**Recommendation:**
Track whether the service returned an existing invitation by checking if the returned `inv` has `status != PENDING` or by having the service return a flag, then respond with 200 vs 201 accordingly. Simplest approach: return 200 when `event_id` was supplied and the audit row already existed.

---

### F-03 — MEDIUM — `send_mail` called inside `transaction.atomic()` — email sent even if transaction rolls back

**File:** `backend/apps/organizations/services/invitation.py:211-225`

**Evidence:**
```python
with transaction.atomic():
    inv = AdminInvitation.objects.create(...)
    emit_audit(...)
    # Send token to the invitee. Console backend in dev.
    try:
        send_mail(
            subject=f"You've been invited to {org.name}",
            ...
        )
    except Exception:
        pass
```

**Why it matters:**
`send_mail` is called inside `transaction.atomic()`. If `emit_audit()` raises (or any subsequent code causes a rollback), the transaction rolls back but the email has already been delivered (SMTP is not transactional). The invitee receives a token whose corresponding DB row no longer exists. The correct pattern per invariant 4 is to publish side effects only after commit using `transaction.on_commit`.

**Recommendation:**
Move the `send_mail` call outside the `with transaction.atomic():` block (after the `return inv, plaintext` guard) or wrap it in a `transaction.on_commit` callback:
```python
with transaction.atomic():
    inv = AdminInvitation.objects.create(...)
    emit_audit(...)
    transaction.on_commit(lambda: _send_invite_email(org.name, plaintext, email, inv.expires_at))
```

---

### F-04 — MEDIUM — Race condition in `accept_invitation`: expiry update outside atomic block is not protected against concurrent accept

**File:** `backend/apps/organizations/services/invitation.py:248-256`

**Evidence:**
```python
# Pre-check + materialize expiry OUTSIDE of any later atomic block
pre_inv = AdminInvitation.objects.filter(token_hash=token_hash).first()
if pre_inv is None:
    raise ValidationError("Invalid invitation token.")
if pre_inv.status == InviteStatus.PENDING and pre_inv.is_expired():
    AdminInvitation.objects.filter(pk=pre_inv.pk, status=InviteStatus.PENDING).update(
        status=InviteStatus.EXPIRED
    )
    raise ValidationError("Invitation has expired.")
```

**Why it matters:**
The pre-check read (`filter().first()`) and the subsequent `select_for_update().get()` inside the atomic block are not atomic with each other. Between the two reads, a concurrent request could accept the invitation, changing `status` to `ACCEPTED`. The outer read sees `PENDING` and not-yet-expired, so it falls through. The inner `select_for_update` then re-reads `ACCEPTED` and raises "already accepted" — which is correct behaviour, so the race doesn't silently succeed. However, if the outer read happens *just* as the expiry timestamp is hit (within a millisecond), the outer UPDATE may fire concurrently with the inner block's `select_for_update` acquiring the row lock, leading to an unordered interleaving. The actual risk is low (the inner block re-checks `is_expired()`) but the outer UPDATE that fires before the lock can theoretically flip `status=EXPIRED` on a row the inner block then reads as EXPIRED, leading to a confusing "Invitation has expired" error for a legitimate accept that beat the expiry by milliseconds.

**Recommendation:**
Remove the outer pre-check UPDATE entirely. The inner atomic block already handles all status checks including `is_expired()` at line 270 and atomically flips the row via `select_for_update`. The outer read can stay for fast-path rejection but should not mutate state.

---

### F-05 — MEDIUM — `OrgMemberRemoveView` does not use `transaction.atomic()` — audit emit can fail leaving membership deactivated without an audit trail

**File:** `backend/apps/organizations/views.py:384-398`

**Evidence:**
```python
if membership.is_active:
    membership.is_active = False
    membership.removed_at = _tz.now()
    membership.save(update_fields=["is_active", "removed_at"])
    emit_audit(
        ...
        event_type="member_role_revoked",
        ...
    )
return Response(status=status.HTTP_204_NO_CONTENT)
```

**Why it matters:**
The membership deactivation save and the `emit_audit` call are not wrapped in a `transaction.atomic()`. If `emit_audit` raises (e.g., DB constraint on the audit table), the membership row is already written as `is_active=False` with no rollback. The audit trail goes missing while the org state has changed, violating the "DB-first event log" invariant. Every other state-change verb in lifecycle.py wraps the pair inside `transaction.atomic()`.

**Recommendation:**
Wrap both the `membership.save()` and `emit_audit()` calls in `with transaction.atomic():`.

---

### F-06 — MEDIUM — `detect_orphaned()` issues N+1 existence queries — and each per-org atomic block is a separate transaction, making flipping non-atomic across the batch

**File:** `backend/apps/organizations/services/lifecycle.py:265-298`

**Evidence:**
```python
candidates = Organization.objects.filter(
    status=OrgStatus.ACTIVE, deleted_at__isnull=True
)
for org in candidates:
    has_admin = OrganizationMembership.objects.filter(
        organization=org, role=MembershipRole.ADMIN, is_active=True,
    ).exists()
    if not has_admin:
        with transaction.atomic():
            ...
            org.save(update_fields=["status"])
```

**Why it matters:**
1. **N+1 queries**: One `EXISTS` query is issued per candidate org. At scale (many orgs) this is a performance issue, but not a correctness bug per se.
2. **TOCTOU race**: The `candidates` queryset is evaluated lazily; by the time the loop reaches an org and checks `has_admin`, an admin membership could have been created between the check and the update. The per-org `transaction.atomic()` does not lock the `candidates` queryset rows, so a concurrent membership creation is invisible. The org could be incorrectly flipped to `orphaned` immediately after a new admin accepted an invitation.

**Recommendation:**
Use a single SQL subquery to atomically identify and update orphaned orgs, or wrap the entire function in a serializable transaction and use `select_for_update` on the org rows being evaluated.

---

### F-07 — LOW — `archive_org()` accessible from SUSPENDED state but does not clear `suspended_at` / `suspended_reason`

**File:** `backend/apps/organizations/services/lifecycle.py:227-257`

**Evidence:**
```python
def archive_org(...) -> Organization:
    if org.status == OrgStatus.ARCHIVED:
        return org
    ...
    with transaction.atomic():
        before = {"status": org.status, "archived_at": org.archived_at}
        org.status = OrgStatus.ARCHIVED
        org.archived_at = timezone.now()
        org.save(update_fields=["status", "archived_at"])
```

**Why it matters:**
`archive_org` allows any non-ARCHIVED org to be archived (there is no explicit allowlist, only the early-return on `ARCHIVED`). A SUSPENDED org can be archived, which leaves `suspended_at` and `suspended_reason` with stale non-null values in the row even though the org is now ARCHIVED. The `OrganizationSerializer` exposes both `suspended_at` and `suspended_reason`, so clients reading the archived org will see confusing suspension data.

**Recommendation:**
When transitioning from SUSPENDED to ARCHIVED, add `suspended_at` and `suspended_reason` to the `update_fields` and clear them (set to `None`/`""`).

---

### F-08 — LOW — `OrgMembersListView.get_organization()` called once per DRF paginator cycle — double DB round-trip

**File:** `backend/apps/organizations/views.py:359-365`

**Evidence:**
```python
def get_organization(self):
    return _resolve_org(self.kwargs["uuid"])

def get_queryset(self):
    return OrganizationMembership.objects.filter(
        organization=self.get_organization(), is_active=True
    )
```

**Why it matters:**
`_resolve_org` (line 83-86) issues a `get_object_or_404` DB query every time `get_organization()` is called. `get_queryset()` is called by DRF during both permission checks and data fetch phases. This causes two separate `SELECT` queries for the same org row per request. Not a correctness bug, but an unnecessary doubled query.

**Recommendation:**
Cache the result: `return getattr(self, '_org', None) or setattr(self, '_org', _resolve_org(...)) or self._org`, or simply store it in `initial()`.

---

### F-09 — LOW — `OrgMembersBySlugView` aggregation assigns `"id"` from the *first* membership row, which is arbitrary and may mislead consumers

**File:** `backend/apps/organizations/views.py:531-532`

**Evidence:**
```python
agg[r.user_id] = {
    "id": r.id,      # <-- first membership row id in ORDER BY created_at
    ...
    "roles": [r.role],
```

**Why it matters:**
The `OrgMemberDetailSerializer` (serializers.py:124) exposes `id` as a UUID field. When a user has multiple membership rows (e.g., CO_ORGANIZER + GAME_COORDINATOR), the `id` in the response is the `OrganizationMembership.pk` of whichever row happens to sort first — not a stable per-user-per-org identifier. A client using this `id` to issue a DELETE to `/api/orgs/{uuid}/members/{id}/` will work only for the first row; the other role rows remain active. This is a conceptual mismatch: the aggregated view implies one entry per user, but the underlying model allows multiple rows.

**Recommendation:**
Document clearly that `id` in the aggregated response refers to one arbitrary membership row. If the intent is for clients to remove all roles at once, expose `user_id` as the deletion key instead, or return a list of `{ id, role }` pairs so callers can target individual rows.

---

### F-10 — LOW — `OrgDetailView.get()` slug-branch returns a raw `Response(status=404)` instead of raising `Http404` — DRF exception handler is bypassed

**File:** `backend/apps/organizations/views.py:184-185`

**Evidence:**
```python
elif redirect_target is not None:
    resp = Response(status=status.HTTP_301_MOVED_PERMANENTLY)
    resp["Location"] = f"/api/orgs/{redirect_target.id}/"
    return resp
else:
    return Response(status=status.HTTP_404_NOT_FOUND)
```

**Why it matters:**
Returning `Response(status=404)` directly bypasses DRF's exception handler (which would log, add `WWW-Authenticate` headers, etc.) and skips any custom exception handling middleware. The 404 response body is empty rather than the standard `{"detail": "Not found."}` DRF JSON shape, which will cause the SPA to fail its JSON parse.

**Recommendation:**
Replace `return Response(status=status.HTTP_404_NOT_FOUND)` with `raise Http404("Organization not found.")`, which DRF handles consistently.

---

## Gaps (forward-looking, not current bugs)

| # | Area | Missing | Needed for |
|---|------|---------|-----------|
| G-01 | `detect_orphaned` | No test covers PENDING_REVIEW or SUSPENDED orgs; `detect_orphaned` only queries `status=ACTIVE` — orphaned PENDING_REVIEW orgs (no admin ever joined) are never detected | Production correctness |
| G-02 | Invitation — admin role acceptance | `accept_invitation` does not handle the `IntegrityError` from `single_org_per_admin_user` constraint when the accepting user is already an admin elsewhere. The constraint fires inside the `transaction.atomic()` block, rolling it back with an uncaught `IntegrityError` 500 instead of a clean `ValidationError` | Production UX |
| G-03 | `archive_org` | `archive_org` does not set `deleted_at`, so an archived org is still returned by `_resolve_org` (which filters `deleted_at__isnull=True`) and remains accessible via all API endpoints. The separation between "archived" (status) and "soft-deleted" (deleted_at) is undocumented and `deleted_at` is never set by any service | Correctness of access control after archival |
| G-04 | Ownership transfer | `OrgTransferOwnershipView.post` (views.py:341) serializes `org` after `transfer_ownership()` returns but the `org` instance in the view has not been refreshed from DB — the response data is stale (though for `OrganizationSerializer` this happens to be a no-op since no org fields change during the transfer, but the pattern is fragile) | Future-proofing |
| G-05 | `OrgMembersListView` | Uses `OrganizationMembershipSerializer` (one row per membership) while the slug-routed twin `OrgMembersBySlugView` uses `OrgMemberDetailSerializer` (one row per user, aggregated). The two endpoints under `/api/orgs/{uuid}/members/` and `/api/orgs/{slug}/members/` return inconsistent schemas for the same logical resource | API consistency |
| G-06 | `change_slug` | `validate_slug()` is called twice on slug-change: once in `OrgChangeSlugView` (via `ChangeSlugSerializer` which does NOT call `svc_validate_slug`) and once inside `change_slug()`. The serializer only enforces max_length; regex/reserved/uniqueness is only enforced in the service — no double-call issue, but the serializer gives no early feedback on format errors | UX |
