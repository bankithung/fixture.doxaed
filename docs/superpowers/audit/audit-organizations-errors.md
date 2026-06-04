# Audit: organizations — Error Handling & Silent Failures

**Date:** 2026-06-04
**Scope:** `backend/apps/organizations/` — bare/broad `except`, `except: pass`, masking fallbacks,
missing validation, unguarded `None`/`KeyError`, non-atomic multi-writes,
500-on-bad-input where 400 is correct, inconsistent error bodies.

---

## Findings

### F-1 — TOCTOU race in `create_invitation`: pending-check is outside the transaction

**Severity:** high
**File:** `backend/apps/organizations/services/invitation.py:177-183`

```python
existing = AdminInvitation.objects.filter(
    organization=org, email=email, status=InviteStatus.PENDING
).first()
if existing is not None:
    raise ValidationError(...)

# ... then, inside transaction.atomic():
inv = AdminInvitation.objects.create(...)
```

The duplicate-invite guard runs BEFORE `transaction.atomic()`. Two concurrent
`create_invitation` calls with the same `(org, email)` both pass the check, then
both attempt `AdminInvitation.objects.create()`. The second will hit the DB partial
unique constraint (`unique_pending_invite_per_email_per_org`) and raise an unhandled
`IntegrityError`, bubbling up as a 500. The service comment says "surface a clean
message…so callers don't crash on IntegrityError" — but the guard is outside the
transaction so a concurrent second caller still crashes.

**Recommendation:** Move the `existing` check inside `transaction.atomic()` and use
`select_for_update()` on the lookup row, OR catch `IntegrityError` from the
`objects.create()` call and raise `ValidationError` instead.

---

### F-2 — Bare `except Exception: pass` silently swallows session-cycle failures

**Severity:** medium
**File:** `backend/apps/organizations/services/invitation.py:73-74, 79-80`

```python
try:
    from apps.accounts.services.session_security import cycle_session_on_role_change
    cycle_session_on_role_change(request)
    return
except Exception:  # noqa: BLE001 — fallback path; helper not yet shipped
    pass

if request is not None and hasattr(request, "session"):
    try:
        request.session.cycle_key()
    except Exception:  # noqa: BLE001 — anonymous / no session
        pass
```

Both arms swallow all exceptions including `AttributeError`, `RuntimeError`, and
`ImproperlyConfigured`. If the accounts service ships but has a bug, the session
is never cycled, the anti-fixation defence (B.11) silently fails, and nothing is
logged. The token has been accepted and membership created before this runs.

**Recommendation:** Narrow the first `except` to `ImportError` (the only expected
failure while the helper "hasn't shipped yet"). Wrap the `cycle_key()` fallback in a
logged `logger.warning(...)` at minimum rather than a bare `pass`, so session-cycle
failures surface in production logs.

---

### F-3 — Bare `except Exception: pass` masks email send errors with no logging

**Severity:** low
**File:** `backend/apps/organizations/services/invitation.py:224-225`

```python
try:
    send_mail(..., fail_silently=True)
except Exception:  # noqa: BLE001 — never break the verb on email
    pass
```

`fail_silently=True` already suppresses SMTP exceptions inside `send_mail`. The
outer `except Exception: pass` layer on top swallows anything else (e.g., an
`ImproperlyConfigured` when `EMAIL_BACKEND` is missing, or a template-rendering
error in a custom backend). No log line is emitted.

**Recommendation:** Replace with a `logger.warning("invite email failed: %s", exc, exc_info=True)`
instead of `pass` so email delivery failures show up in Sentry / logs without
breaking the verb.

---

### F-4 — `_OrgMembershipPermission.has_permission()` returns `True` when org cannot be resolved

**Severity:** high
**File:** `backend/apps/organizations/permissions.py:86-89`

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

When the URL kwarg is present but the org is deleted or the slug is wrong,
`_resolve_org_from_view` returns `None` and `has_permission` returns `True`, granting
access. This is the "unauthenticated to an unknown org" scenario: a user who is not
a member of any org gets `True` from `IsOrgAdminOrOwner` if the kwarg silently fails
to resolve. The comment says "object-level permission filters at the queryset layer"
but `OrgMembersBySlugView`, `OrgInvitationsBySlugView`, and `OrgInvitationByIdSlugView`
do NOT have an `has_object_permission` guard — they rely entirely on `has_permission`.

**Recommendation:** When a kwarg IS present (`candidate` is non-None) but the org
cannot be found, return `False` (deny), not `True`. Only return `True` when no
org-identifying kwarg exists at all (pure resource-level views that legitimately
don't have an org scope).

---

### F-5 — `OrgDetailView.get` returns a bare `Response(status=404)` instead of raising `Http404`

**Severity:** low
**File:** `backend/apps/organizations/views.py:185`

```python
else:
    return Response(status=status.HTTP_404_NOT_FOUND)
```

DRF's exception handler wraps `Http404` into a JSON `{"detail": "Not found."}` body.
A bare `Response(status=404)` returns an empty body. This is inconsistent with the
UUID path (which uses `get_object_or_404` and produces a JSON body) and with every
other endpoint in the app.

**Recommendation:** Replace with `raise Http404("Organization not found.")` so the
response body is consistent.

---

### F-6 — `OrgDetailView.patch` does not validate `time_zone` against IANA zone list at the service layer — no-op on empty body returns 200

**Severity:** low
**File:** `backend/apps/organizations/views.py:211-219`

```python
ser = OrganizationUpdateSerializer(data=request.data, partial=True)
ser.is_valid(raise_exception=True)
update_fields = []
for field in ("name", "time_zone"):
    if field in ser.validated_data:
        setattr(org, field, ser.validated_data[field])
        update_fields.append(field)
if update_fields:
    org.save(update_fields=update_fields)
return Response(OrganizationSerializer(org).data)
```

`OrganizationUpdateSerializer.validate_time_zone` does validate against `_TZ_NAMES`.
However the serializer is instantiated with `partial=True` and `data=request.data`.
If the client sends `{}`, `ser.validated_data` is empty, `update_fields` stays `[]`,
`org.save()` is skipped, and the view returns 200 with the unchanged org. This is
intentional (PATCH semantics), but there is no audit event emitted for a successful
PATCH, and no `update_fields` on the `save()` call tracks `updated_at`. If
`Organization` ever gets an `updated_at` field this silent no-audit path will be a
gap. Low risk now.

**Recommendation:** Emit an audit event on any successful PATCH that changes at
least one field, consistent with every other state-change verb in this app. Add
`updated_at = models.DateTimeField(auto_now=True)` to `Organization` so the DB
tracks mutation time.

---

### F-7 — `detect_orphaned()` performs N+1 per-org queries and uses non-atomic outer loop

**Severity:** medium
**File:** `backend/apps/organizations/services/lifecycle.py:265-298`

```python
candidates = Organization.objects.filter(status=OrgStatus.ACTIVE, deleted_at__isnull=True)
for org in candidates:
    has_admin = OrganizationMembership.objects.filter(
        organization=org, role=MembershipRole.ADMIN, is_active=True
    ).exists()
    if not has_admin:
        with transaction.atomic():
            org.status = OrgStatus.ORPHANED
            org.save(update_fields=["status"])
            emit_audit(...)
            flipped += 1
```

Each iteration issues a separate `EXISTS` query (N+1). For a platform with thousands
of orgs this is a cron job that hammers the DB. More critically, the `candidates`
queryset is evaluated lazily outside any transaction, so an org that becomes active
between iteration start and the check for that org may be double-processed on the
next cron run. These are not correctness-breaking at small scale but will be at
production scale.

**Recommendation:** Use a single annotated query with `Subquery` or a `LEFT JOIN`
to find all active orgs lacking an active admin membership, then bulk-update in one
`transaction.atomic()`. Emit individual audit rows inside the same transaction.

---

### F-8 — `accept_invitation`: double-fetch of `AdminInvitation` without maintaining `select_for_update` state

**Severity:** medium
**File:** `backend/apps/organizations/services/invitation.py:249-264`

```python
pre_inv = AdminInvitation.objects.filter(token_hash=token_hash).first()
if pre_inv is None:
    raise ValidationError("Invalid invitation token.")
if pre_inv.status == InviteStatus.PENDING and pre_inv.is_expired():
    AdminInvitation.objects.filter(...).update(status=InviteStatus.EXPIRED)
    raise ValidationError("Invitation has expired.")

with transaction.atomic():
    try:
        inv = AdminInvitation.objects.select_for_update().get(token_hash=token_hash)
    except AdminInvitation.DoesNotExist as exc:
        raise ValidationError("Invalid invitation token.") from exc
```

The pre-check outside the transaction reads a non-locked snapshot. If an invitation
expires or is revoked between the pre-check and the `select_for_update` inside the
transaction, the lock is acquired on the already-mutated row and the status checks
correctly catch it. This is acceptable correctness-wise. However the expiry-flip
`update()` outside any transaction at line 253 can partially succeed if the DB
connection drops mid-call, leaving the audit log without a record of the expiry
transition (no `emit_audit` call accompanies that `update()`).

**Recommendation:** Move the expiry materialisation + audit emission inside the
`transaction.atomic()` block after the `select_for_update()`. Remove the pre-check
entirely and rely solely on the locked read.

---

### F-9 — `OrgMemberRemoveView`: member-remove audit event missing `payload_before`; `is_active` silently skipped if already False

**Severity:** low
**File:** `backend/apps/organizations/views.py:382-398`

```python
if membership.is_active:
    membership.is_active = False
    membership.removed_at = _tz.now()
    membership.save(update_fields=["is_active", "removed_at"])
    emit_audit(
        ...
        payload_after={"is_active": False},
        ...
    )
return Response(status=status.HTTP_204_NO_CONTENT)
```

If the membership is already inactive (`is_active=False`) the view silently returns
204 without any error. An admin calling DELETE on an already-removed member gets
success, which is arguably correct for idempotency, but there is no `payload_before`
in the audit event, making it impossible to reconstruct the membership state before
the removal in the audit log.

**Recommendation:** Add `payload_before={"is_active": membership.is_active}` to
`emit_audit`. Optionally return 200 with the membership object on already-inactive
to distinguish the idempotent replay from the actual removal.

---

### F-10 — `OrgMembersListView.get_organization()` is called once by `get_queryset` with no caching — double DB hit when `HasModule` also calls `view.get_organization()`

**Severity:** low
**File:** `backend/apps/organizations/views.py:359-365`
**Also:** `backend/apps/permissions/permissions.py:62-65`

```python
# HasModule._resolve_organization calls view.get_organization() during has_permission
if hasattr(view, "get_organization"):
    try:
        return view.get_organization()
    except Exception:
        return None
```

`get_organization()` calls `_resolve_org(self.kwargs["uuid"])` which issues a DB
query (`get_object_or_404`). `HasModule._resolve_organization` calls
`view.get_organization()` during the permission check, and `get_queryset()` calls it
again. This is two DB round-trips for the same org per request. Same pattern applies
to `OrgMembersBySlugView`.

**Recommendation:** Cache the result in `self._org` with a `functools.cached_property`
or manual `_cache_org` attribute:

```python
def get_organization(self):
    if not hasattr(self, "_org"):
        self._org = _resolve_org(self.kwargs["uuid"])
    return self._org
```

---

### F-11 — `HasModule._resolve_organization` swallows all exceptions from `view.get_organization()`

**Severity:** medium
**File:** `backend/apps/permissions/permissions.py:63-65`

```python
try:
    return view.get_organization()
except Exception:
    return None
```

If `get_organization()` raises `Http404` (e.g., org is deleted), the permission class
catches it and returns `None`, which causes `has_permission` to return `False`
(deny). This is fail-closed and security-correct. However a genuine bug inside
`get_organization()` — such as a `KeyError` or `AttributeError` — will also silently
return `False`, yielding a mysterious 403 with no error logged. Developers will waste
time debugging why a valid request is denied.

**Recommendation:** Narrow to `except (Http404, Exception)` with a logger warning for
anything that is not `Http404`, or at minimum: `except Exception as exc: logger.debug(...)`
so the real cause is visible in logs.

---

### F-12 — `create_organization` does not validate `time_zone` at the service layer

**Severity:** medium
**File:** `backend/apps/organizations/services/lifecycle.py:32-76`

```python
def create_organization(
    *,
    slug: str,
    name: str,
    created_by,
    time_zone: str = "Asia/Kolkata",
    ...
) -> Organization:
    from apps.organizations.services.slug import validate_slug
    slug = validate_slug(slug)
    name = (name or "").strip()
    if not name:
        raise ValidationError("Organization name is required.")
    ...
    org = Organization.objects.create(..., time_zone=time_zone, ...)
```

`time_zone` is never validated against `zoneinfo.available_timezones()` at the
service layer. The serializer (`OrganizationCreateSerializer.validate_time_zone`)
does validate it, but direct callers of the service (e.g., the sadmin console, test
factories, management commands, future Phase 1B code) bypass the serializer and can
insert an invalid IANA zone name. The DB column is a plain `CharField` with no check
constraint.

**Recommendation:** Add a `zoneinfo` check inside `create_organization`:

```python
import zoneinfo
if time_zone not in zoneinfo.available_timezones():
    raise ValidationError(f"Unknown IANA time zone '{time_zone}'.")
```

Mirror this in `update_org` (once that service function exists).

---

### F-13 — `OrgInvitationsView.post` (UUID-route) does not forward `roles` or `event_id` to the service

**Severity:** medium
**File:** `backend/apps/organizations/views.py:419-435`

```python
def post(self, request, uuid):
    org = _resolve_org(uuid)
    ser = AdminInvitationCreateSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    try:
        inv, _plaintext = invitation_svc.create_invitation(
            org=org,
            email=ser.validated_data["email"],
            role=ser.validated_data["role"],   # <-- KeyError if only "roles" provided
            invited_by=request.user,
            request=request,
        )
```

The UUID-routed invitation create endpoint passes only `role` to the service, not
`roles` or `event_id`. The `AdminInvitationCreateSerializer.validate` method sets
`attrs["role"] = MembershipRole.CO_ORGANIZER` as a default when neither is provided,
so `ser.validated_data["role"]` does not raise `KeyError`. However:

1. A client sending only `{"roles": ["admin"]}` gets `role=CO_ORGANIZER` (the
   default) instead of `admin`, because `roles` is silently ignored on this route.
2. `event_id` idempotency is not honoured on the UUID route at all.

The slug-routed `OrgInvitationsBySlugView.post` correctly passes `roles` and
`event_id`. The UUID route is inconsistent.

**Recommendation:** Mirror the slug-route body:

```python
inv, _plaintext = invitation_svc.create_invitation(
    org=org,
    email=ser.validated_data["email"],
    role=ser.validated_data.get("role"),
    roles=ser.validated_data.get("roles"),
    invited_by=request.user,
    request=request,
    event_id=ser.validated_data.get("event_id"),
)
```

---

### F-14 — `OrgTransferOwnershipView.post` response returns stale org data (does not refresh)

**Severity:** low
**File:** `backend/apps/organizations/views.py:325-341`

```python
def post(self, request, uuid):
    org = _resolve_org(uuid)
    ...
    ownership_svc.transfer_ownership(...)
    ...
    return Response(OrganizationSerializer(org).data)
```

`transfer_ownership` only mutates `OrganizationMembership` rows, not `Organization`.
The response serializes the `org` object fetched before the service call. This is
correct today because `OrganizationSerializer` does not include membership fields.
However if ownership info is ever added to the response (e.g., `owner_user_id`),
the stale in-memory object will return incorrect data.

**Recommendation:** Add `org.refresh_from_db()` before the `Response(...)` to be
defensive, even if currently correct.

---

## Gaps (forward-looking, not current bugs)

| # | Area | Missing | Needed for |
|---|------|---------|-----------|
| G-1 | `lifecycle.py` | No `update_org` service function | `OrgDetailView.patch` bypasses the service layer; writes directly to the model via `setattr` + `org.save()`, with no audit event and no time_zone validation at service layer |
| G-2 | `models.py` | `Organization` has no `updated_at` field | Cannot know when an org was last mutated without trawling AuditEvent |
| G-3 | `lifecycle.py` | `detect_orphaned` has no test for orgs that transition from pending→orphaned concurrently | Production cron could double-flip if run concurrently |
| G-4 | `invitation.py` | No rate-limiting on `create_invitation` | Anyone with admin membership can spam email addresses |
| G-5 | `views.py` | No cross-org isolation test for `OrgMembersListView` (UUID) | Multi-tenancy invariant #2 requires every endpoint has an isolation test; `test_slug_routes.py` covers slug path but not the `HasModule`-gated UUID path |
| G-6 | `invitation.py` | Idempotency replay on `accept_invitation` not implemented (only `create_invitation` has idempotency via `event_id`) | Architect invariant #3 says "all writes" must be idempotent |
| G-7 | `ownership.py` | `transfer_ownership` does not refresh the returned `org` object in the view | If `Organization` gains ownership-related fields the view will serialize stale data |
| G-8 | `services/` | No service-layer function for unsuspend, archive, change_slug that validates `OrgStatus` transition from `ARCHIVED` state | Archiving an already-archived org silently returns the unchanged org rather than 409 for archive; `unsuspend` correctly raises but `archive` has an early-return-if-already-archived with no error |
