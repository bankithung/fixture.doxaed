# Security Audit: `backend/apps/organizations`

**Audit date:** 2026-06-04
**Auditor:** Claude Code (automated)
**Scope:** Broken access control / IDOR, injection, hardcoded secrets, weak crypto, auth/session flaws, CSRF gaps, DRF mass-assignment / over-exposed fields, SSRF, missing rate limits, 404-vs-403 info leak, token entropy/hashing.

---

## Findings

### FINDING 1 — HIGH: Cross-org IDOR: `OrgMembersListView` (UUID route) resolves org but never verifies caller membership

**File:** `backend/apps/organizations/views.py:357–365`
**Evidence:**
```python
class OrgMembersListView(ListAPIView):
    permission_classes = [IsAuthenticated, HasModule("org.member_directory")]

    def get_organization(self):
        return _resolve_org(self.kwargs["uuid"])

    def get_queryset(self):
        return OrganizationMembership.objects.filter(
            organization=self.get_organization(), is_active=True
        )
```

`HasModule` resolves the organization via `get_organization()` and calls `has_module(user, org, module_code)`. That resolver checks if the user has the module enabled — but if no `MembershipModuleGrant` row exists and the role isn't in the default-allow list for `org.member_directory`, it may return False correctly. However, the test `test_members_by_slug_404_when_org_not_found` explicitly accepts either 403 **or** 404: `assert resp.status_code in (403, 404)`. This means there is no dedicated test that confirms a user who is a valid member of Org A cannot call `GET /api/orgs/{org_b_uuid}/members/`. The view's queryset filters memberships by the resolved org, so an authenticated user of Org A could enumerate the member list of Org B if `HasModule` resolves to `True` for them (e.g., if the module resolver falls back open or if the user is a superuser). The UUID-routed `OrgMembersListView` does NOT call `get_organization()` inside `has_permission` — it delegates that to `HasModule._resolve_organization`, which calls `view.get_organization()`. If that returns an org the user is not a member of, `has_module` still runs against that org. The isolation is only as strong as `has_module`'s correctness — which is not verified by a cross-org isolation test.

**Why it matters:** Any authenticated user who can guess or enumerate a UUID could attempt to list members of another organization, violating invariant #2 (no cross-org leak via any endpoint).

**Recommendation:** Add an explicit membership check inside `OrgMembersListView.get_queryset()` or in a dedicated `has_object_permission` override: verify `OrganizationMembership.objects.filter(user=request.user, organization=org, is_active=True).exists()` before returning the queryset. Add a cross-org isolation test (user from Org A hitting the UUID endpoint for Org B expecting 403).

---

### FINDING 2 — HIGH: Cross-org IDOR: `OrgMembersBySlugView` has same gap; no isolation test exists

**File:** `backend/apps/organizations/views.py:502–549`
**Evidence:**
```python
class OrgMembersBySlugView(APIView):
    permission_classes = [IsAuthenticated, HasModule("org.member_directory")]

    def get_organization(self):
        return _resolve_org_by_slug_or_uuid(self.kwargs["slug"])
```

The slug-routed view has the same structural issue as Finding 1. The test suite accepts `403 or 404` for unknown slugs but does not test: "authenticated member of Org A calls `GET /api/orgs/org-b-slug/members/`."

**Recommendation:** Same as Finding 1. Add explicit cross-org isolation tests for slug routes.

---

### FINDING 3 — HIGH: `OrgDetailView` GET 404 vs 403 info leak — non-member gets 403 disclosing org existence

**File:** `backend/apps/organizations/views.py:186–192`
**Evidence:**
```python
        if not request.user.is_superuser:
            if not OrganizationMembership.objects.filter(
                user=request.user, organization=org, is_active=True
            ).exists():
                raise PermissionDenied("Not a member of this organization.")
        return Response(OrganizationSerializer(org).data)
```

When a valid UUID or slug is given for an org that exists but the caller is not a member, the view returns **403** ("Not a member of this organization."). This confirms to an unauthenticated or wrong-org user that the organization UUID/slug is valid and the org exists. Returning 404 for non-members (same as for deleted orgs) would prevent oracle attacks.

**Why it matters:** An attacker can enumerate valid org UUIDs by distinguishing 403 (org exists, not a member) from 404 (org not found). Combined with UUID v7's time-ordered structure, this could assist in discovering other tenants' org IDs.

**Recommendation:** For `GET /api/orgs/{slug_or_uuid}/`, return 404 (not 403) to non-members when the org exists, to prevent oracle-style enumeration. The audit log can still record the access attempt with the real organization ID.

---

### FINDING 4 — HIGH: `accept_invitation` accepts token for any email — no binding to invitee email

**File:** `backend/apps/organizations/services/invitation.py:230–322`
**Evidence:**
```python
def accept_invitation(
    *,
    token_plaintext: str,
    accepting_user,
    request: Optional[HttpRequest] = None,
) -> OrganizationMembership:
    ...
    membership = OrganizationMembership.objects.filter(
        user=accepting_user, organization=org, role=inv.role
    ).first()
```

The invitation is bound to an email address (`inv.email`). However, `accept_invitation` does NOT verify that `accepting_user.email == inv.email`. Any authenticated user who obtains the plaintext token (e.g., via forwarding the invitation email) can accept an invitation intended for a different email address and gain membership in the organization under an arbitrary user account.

**Why it matters:** This means invitation-based access control is not bound to the intended recipient's identity. A user who receives a forwarded invitation email (or who intercepts it) gains org access under a completely different user account than intended.

**Recommendation:** Add the check: `if accepting_user.email.lower() != inv.email: raise ValidationError("This invitation is for a different email address.")` in `accept_invitation`, before the membership creation block. Consider whether a verified-email bypass should be allowed for super-admin acceptance (it should not be).

---

### FINDING 5 — MEDIUM: `OrgChangeSlugView` permission class `IsOrgAdminOrOwner` is applied but `_resolve_org_from_view` resolves from UUID kwarg — permission check is authoritative, but `get_object_or_404` on the view fires AFTER the permission class, allowing timing oracle

**File:** `backend/apps/organizations/views.py:228–247`
**Evidence:**
```python
class OrgChangeSlugView(APIView):
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    def post(self, request, uuid):
        org = _resolve_org(uuid)
        ...
```

The permission class `IsOrgAdminOrOwner` calls `_resolve_org_from_view(view)` which hits the DB to find the org. Then the view body calls `_resolve_org(uuid)` which hits `get_object_or_404` again (a second DB query for the same org). This double-resolution is inefficient and could introduce subtle divergence if the org is deleted between the two DB hits. More importantly, `_resolve_org_from_view` returns `None` if the org isn't found — and `_OrgMembershipPermission.has_permission` returns `True` (!) when `org is None`:

```python
        if org is None:
            # Resource-level views without an org slug pass through here;
            # object-level permission filters at the queryset layer.
            return True
```

**Why it matters:** If the org UUID in the URL does not exist (e.g., a race condition where the org is deleted between the permission check and the view body), the permission class silently passes (`return True`), and the subsequent `get_object_or_404` raises a 404. This is not exploitable in isolation, but it represents a logic inconsistency: the permission check claims to guard org-level access, but silently grants permission when the org is missing.

**Recommendation:** The comment "Resource-level views without an org slug pass through here" should NOT apply to views that always have an org UUID kwarg like `OrgChangeSlugView`, `OrgMembersListView`, etc. Either (a) differentiate which view classes require a mandatory org kwarg and treat `org is None` as permission denied for them, or (b) cache the org on the view request cycle to avoid double-resolution and ensure the same org object is used in both the permission check and the view body.

---

### FINDING 6 — MEDIUM: `OrgMemberRemoveView` — no rate limiting; member removal is not idempotent with event_id

**File:** `backend/apps/organizations/views.py:368–399`
**Evidence:**
```python
class OrgMemberRemoveView(APIView):
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    def delete(self, request, uuid, membership_id):
        org = _resolve_org(uuid)
        membership = get_object_or_404(
            OrganizationMembership, pk=membership_id, organization=org
        )
```

The `DELETE /api/orgs/{uuid}/members/{membership_id}/` endpoint carries no throttle class and no `event_id` idempotency key. While the global `UserRateThrottle` (240/min) applies, there is no fine-grained throttle on this destructive action. The invariant #3 ("idempotent writes") requires a client-generated `event_id` on every mutation endpoint — this endpoint does not implement it.

**Recommendation:** Apply a dedicated throttle (e.g., 30/min at the most) on this endpoint. Add an `event_id` parameter to the DELETE body and honour the idempotency replay contract.

---

### FINDING 7 — MEDIUM: `OrgInvitationsView` (UUID route) uses `IsOrgAdminOrOwner` but the same permission loophole applies when org not found

**File:** `backend/apps/organizations/views.py:407–435`
**Evidence:**
```python
class OrgInvitationsView(APIView):
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    def get(self, request, uuid):
        org = _resolve_org(uuid)
        qs = AdminInvitation.objects.filter(organization=org).order_by("-created_at")
```

`GET /api/orgs/{uuid}/invitations/` lists all invitations for an org — including revoked and expired ones. The permission class enforces admin membership, which is correct. However, the `AdminInvitationSerializer` exposes `invited_by` (a user UUID/PK) in the response. If the invitation was sent by a user who later left the org, their user ID is still visible to anyone with admin access. This is a minor PII exposure: the `invited_by` FK is surfaced as a raw user ID; the serializer does not restrict it.

**Recommendation:** Decide explicitly whether `invited_by` is appropriate for admin-only visibility; if so, document it. Consider whether `invited_by` should be expanded to a safe subset of user fields (name only, not email) in the response, per GDPR-style data minimization.

---

### FINDING 8 — MEDIUM: `OrgMembersBySlugView` exposes member `email` field to all `org.member_directory` module holders

**File:** `backend/apps/organizations/views.py:536–540` and `serializers.py:124–131`
**Evidence:**
```python
agg[r.user_id] = {
    ...
    "email": r.user.email,
    "full_name": getattr(r.user, "name", "") or "",
    ...
}
```
```python
class OrgMemberDetailSerializer(serializers.Serializer):
    email = serializers.EmailField()
```

The member directory endpoint returns the raw email address of every member to any user who holds `org.member_directory` module access (includes `game_coordinator`, `co_organizer`, `admin` roles by default). Email addresses are PII. Lower-privileged roles (game coordinator, team manager) probably do not need to see member email addresses.

**Why it matters:** If a game coordinator or team manager is a bad actor, this gives them the email addresses of all org members, which can be used for phishing or scraping.

**Recommendation:** Either (a) scope email visibility to admin/co-organizer only (add a secondary permission check on the field level), or (b) replace `email` with a hashed/obfuscated version for lower-privileged roles. At minimum, document this data sharing in a data map.

---

### FINDING 9 — MEDIUM: `ATOMIC_REQUESTS = True` + `transaction.atomic()` double-nesting — invitation expiry materialization can fail to persist

**File:** `backend/apps/organizations/services/invitation.py:252–256`
**Evidence:**
```python
    pre_inv = AdminInvitation.objects.filter(token_hash=token_hash).first()
    if pre_inv is None:
        raise ValidationError("Invalid invitation token.")
    if pre_inv.status == InviteStatus.PENDING and pre_inv.is_expired():
        AdminInvitation.objects.filter(pk=pre_inv.pk, status=InviteStatus.PENDING).update(
            status=InviteStatus.EXPIRED
        )
        raise ValidationError("Invitation has expired.")
```

With `ATOMIC_REQUESTS = True`, every DRF view runs inside an outer transaction. The pre-check `.update(status=InviteStatus.EXPIRED)` is intended to save outside the inner `transaction.atomic()` block. However, the `raise ValidationError` that follows causes DRF's exception handler to call `connection.set_rollback(True)` in some configurations, which would roll back the outer ATOMIC_REQUESTS transaction — potentially including the expiry materialization. The code comment says "Pre-check + materialize expiry OUTSIDE of any later atomic block" but the DRF exception handler may still roll it back via ATOMIC_REQUESTS.

**Why it matters:** Expired tokens may not get permanently marked as expired in the database even though a user sees an "invitation expired" error. On retry with the same token, they may see inconsistent behavior depending on timing.

**Recommendation:** Move the expiry materialization to a `transaction.on_commit` callback or use a separate DB connection call protected by a savepoint. Alternatively, rely solely on the `is_expired()` property check at accept-time and remove the pre-check materialization, since it's redundant with the inner block check.

---

### FINDING 10 — MEDIUM: No rate limiting on invitation-accept endpoint

**File:** `backend/apps/organizations/views.py:461–485`
**Evidence:**
```python
class InvitationAcceptView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        ser = AcceptInvitationSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            membership = invitation_svc.accept_invitation(
                token_plaintext=ser.validated_data["token"],
```

The invitation accept endpoint applies only the global `UserRateThrottle` (240/min). An attacker with a valid session could brute-force short or predictable tokens (though the token entropy is 256 bits — see positive note below). More concretely, a timing oracle could be constructed by submitting many token guesses and measuring which ones take slightly longer (hash comparison time) to respond. No dedicated per-endpoint throttle exists.

**Recommendation:** Add a custom throttle class (e.g., `InvitationAcceptThrottle` at 10/hr/user) to this endpoint. Also apply constant-time comparison via `hmac.compare_digest` instead of `==` for the hash lookup (currently the lookup is a DB query by `token_hash` index, which is safe enough, but an explicit constant-time check is belt-and-suspenders).

---

### FINDING 11 — LOW: `AdminInvitationFactory` in tests uses predictable token_hash

**File:** `backend/apps/organizations/tests/factories.py:50`
**Evidence:**
```python
class AdminInvitationFactory(DjangoModelFactory):
    token_hash = factory.Sequence(lambda n: f"hash-{n:0>64}")
```

The test factory uses a trivially guessable `token_hash`. While this is test-only code and the production token path uses `secrets.token_urlsafe(32)`, a test that creates an `AdminInvitationFactory` row and then tries `accept_invitation(token_plaintext="hash-0")` would succeed because the "hash" and the "plaintext" are the same value (sha256("hash-0") != "hash-0", so it actually wouldn't match). The risk is not in production but in the test suite: any test using `AdminInvitationFactory` without calling `create_invitation` service would have an invitation row with an invalid hash format (64-char non-hex string), which could mask test bugs.

**Recommendation:** Change the factory to use `factory.LazyFunction(lambda: hashlib.sha256(secrets.token_urlsafe(32).encode()).hexdigest())` and also store the plaintext as a class attribute so invitation-accept tests can use a proper round-trip.

---

### FINDING 12 — LOW: `_OrgMembershipPermission` silently passes when `org is None` — potential bypass for new routes

**File:** `backend/apps/organizations/permissions.py:85–89`
**Evidence:**
```python
        org = _resolve_org_from_view(view)
        if org is None:
            # Resource-level views without an org slug pass through here;
            # object-level permission filters at the queryset layer.
            return True
```

This is a footgun for future developers: any new view that uses `IsOrgAdminOrOwner` or `IsOrgMember` but has a URL pattern where `_resolve_org_from_view` returns `None` (e.g., misnamed kwarg, typo in URL pattern) will silently allow all authenticated users. The comment says "object-level permission filters at the queryset layer" but that requires the developer to remember to add queryset-level filtering.

**Recommendation:** Add a docstring with a warning and consider making this configurable via a class attribute (`require_org: bool = True`). When `require_org=True` and org resolution returns `None`, return `False` to fail closed.

---

### FINDING 13 — LOW: `OrganizationSerializer` exposes `suspended_reason` to all org members

**File:** `backend/apps/organizations/serializers.py:27–48`
**Evidence:**
```python
class OrganizationSerializer(serializers.ModelSerializer):
    class Meta:
        fields = [
            ...
            "suspended_reason",
        ]
```

The `suspended_reason` field (a free-text admin note) is visible to all org members via `GET /api/orgs/{slug_or_uuid}/`. This field may contain internal notes about why an org was suspended (e.g., "suspected fraud", "payment failure"). Only super-admins should see the raw suspension reason; members should see a sanitized message at most.

**Recommendation:** Exclude `suspended_reason` from `OrganizationSerializer` (used by member-facing endpoints) or override it to return a sanitized string (e.g., "Organization suspended — contact support") for non-superusers.

---

### FINDING 14 — LOW: Invitation email `from_email=None` with `fail_silently=True` — silent delivery failure

**File:** `backend/apps/organizations/services/invitation.py:213–225`
**Evidence:**
```python
        try:
            send_mail(
                subject=f"You've been invited to {org.name}",
                message=(...),
                from_email=None,  # uses DEFAULT_FROM_EMAIL
                recipient_list=[email],
                fail_silently=True,
            )
        except Exception:  # noqa: BLE001 — never break the verb on email
            pass
```

`fail_silently=True` AND a bare `except Exception: pass` — two layers of silencing. If email delivery fails for any reason (misconfigured SMTP, invalid `DEFAULT_FROM_EMAIL`, etc.), the invitation is created in the DB but the invitee never receives the token. There is no notification back to the inviter, no retry mechanism, and no audit record of the email failure.

**Recommendation:** Log the exception at `WARNING` level instead of silently ignoring it. Consider adding an `email_sent_at` field on `AdminInvitation` and a separate retry mechanism.

---

### FINDING 15 — INFO: Positive — Token entropy is sufficient (256 bits via `secrets.token_urlsafe(32)`)

**File:** `backend/apps/organizations/services/invitation.py:88–90`
**Evidence:**
```python
def _generate_token() -> str:
    """Opaque URL-safe token (32 bytes ≈ 256 bits of entropy)."""
    return secrets.token_urlsafe(32)
```

The token generation uses `secrets.token_urlsafe(32)` (cryptographically secure PRNG, 256 bits of entropy) and the DB stores only `sha256(token)` — not the plaintext. Token comparison on accept uses a DB hash lookup. This is correctly implemented.

---

### FINDING 16 — INFO: Positive — Session cycling on invite accept is implemented

**File:** `backend/apps/organizations/services/invitation.py:319`
**Evidence:**
```python
    # Session-cycle outside the transaction so it survives commit.
    _cycle_session(request)
```

Anti-session-fixation cycling is called outside the transaction, which is the correct placement (so a transaction rollback doesn't undo the session rotation).

---

### FINDING 17 — INFO: No raw SQL, `.extra()`, command injection, or template injection found

Audited all service, view, model, and migration files. No raw SQL (`cursor.execute`, `.raw()`, `.extra()`), OS command execution (`subprocess`, `os.system`), or template injection vectors found. All DB queries use the Django ORM with parameterized queries.

---

## Gaps (forward-looking)

| # | Area | Gap | Effort | Blocking |
|---|------|-----|--------|---------|
| G1 | Cross-org isolation tests | No test asserts that User A (member of Org A) cannot access `/api/orgs/{org_b_uuid}/members/`, `/api/orgs/{org_b_uuid}/invitations/`, or other org-scoped endpoints with Org B's UUID. Required by invariant #2. | S | Yes |
| G2 | Invitation accept: email binding | No check that `accepting_user.email == inv.email`. Any authenticated user with the token can accept. | S | Yes |
| G3 | Rate limiting on sensitive verbs | `OrgMemberRemoveView` (DELETE), `InvitationAcceptView` (POST), `OrgInvitationsView` (POST) — all have only global 240/min user throttle. Dedicated per-verb throttles needed. | S | No |
| G4 | 404-vs-403 info leak on OrgDetailView | Non-members get 403 disclosing org existence; should return 404. | S | No |
| G5 | `suspended_reason` exposed to members | Should be admin-only or sanitized before returning to regular members. | S | No |
| G6 | `event_id` idempotency missing on member remove | Invariant #3 requires all mutation endpoints to accept a client-generated `event_id`. | M | No |
| G7 | No prod settings file audited | Only `base.py` and `dev.py` exist; a `prod.py` is needed with `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, `HSTS`, `SECURE_PROXY_SSL_HEADER` etc. explicitly enforced and not relying on `not DEBUG`. | M | No |
| G8 | `AdminInvitation.invited_by` — PII in invitation list | `invited_by` user ID exposed in invitation listing to all org admins. Consider expanding to display name only. | L | No |
