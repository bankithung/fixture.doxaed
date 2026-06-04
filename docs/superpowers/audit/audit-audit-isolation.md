# Audit App — Tenant Isolation Audit

**Date:** 2026-06-04
**Scope:** `backend/apps/audit/` — every endpoint, queryset, and emission path assessed for cross-org data leakage.
**Lens:** Invariant #2 — multi-tenancy by Organization; no cross-org leak via any endpoint.

---

## Summary

The audit app has one DRF API endpoint (`OrgAuditListView`) and one sadmin HTML view (`audit_search`). The DRF endpoint is correctly isolated. The sadmin view is intentionally cross-org but properly protected by superadmin-only access. Five medium-to-high issues were found, none of them critical data-leakage bugs in the current codebase, but several represent meaningful forward-looking risks or partial design gaps.

---

## Findings

### FINDING 1 — HIGH: `organization_id` is a bare UUIDField with no FK constraint; malicious callers of `emit_audit()` can write any UUID as `organization_id`

**File:** `backend/apps/audit/models.py:63`
**Evidence:**
```python
organization_id = models.UUIDField(null=True, blank=True, db_index=True)
```
`organization_id` is stored as a raw `UUIDField`, not a `ForeignKey`. The DB has no referential integrity check: any arbitrary UUID — including a valid Org B UUID — can be persisted as the `organization_id` on a row that logically belongs to Org A. Because `OrgAuditListView` queries `AuditEvent.objects.filter(organization_id=org.id)`, a row written with a faked org UUID would surface to that org's admins.

**Why it matters:** Any future code path that calls `emit_audit(organization_id=<wrong_uuid>)` — whether by bug or careless copy-paste — silently routes an audit row into the wrong org's feed without any DB-level safeguard. In the current codebase all callers appear to pass the correct org UUID, but there is no enforcement to prevent future drift.

**Recommendation:** Add a `ForeignKey` to `Organization` with `on_delete=PROTECT` and `db_constraint=True` (or at minimum a DB-level `CHECK` trigger). If keeping it a bare UUID for performance or denormalization reasons, add an application-layer validation in `emit_audit()` that confirms the UUID exists.

---

### FINDING 2 — HIGH: `emit_audit()` trusts `HTTP_X_FORWARDED_FOR` directly for IP recording — spoofable without proxy trust configuration

**File:** `backend/apps/audit/services.py:53-55`
**Evidence:**
```python
ip = (
    request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    or request.META.get("REMOTE_ADDR", "")
)
```
The raw `X-Forwarded-For` header is accepted from the request without checking whether the request originated from a trusted proxy. Any client can forge `X-Forwarded-For: <victim-IP>` and have that value stored as the actor IP in every audit row they produce. This does not cause cross-org data leakage directly, but it undermines the forensic integrity of the audit log — an actor can make their actions appear to originate from a trusted internal IP or another user's IP.

**Why it matters:** The audit log is the system of record for accountability (invariant #5). Forged IP addresses degrade the quality of evidence for incident response, compliance review, and dispute resolution.

**Recommendation:** Use Django's `SECURE_PROXY_SSL_HEADER` and `TRUSTED_PROXIES` / a custom middleware that strips untrusted `X-Forwarded-For` hops before they reach views, or use `django-ipware` with `IPWARE_TRUSTED_PROXY_LIST`. Do not trust the leftmost hop blindly.

---

### FINDING 3 — MEDIUM: `OrgAuditListView` calls `get_organization()` twice — once inside `HasModule` permission check and once at the top of `get()` — with no request-level caching

**File:** `backend/apps/audit/views.py:105-129`
**Evidence:**
```python
def get_organization(self):
    slug = self.kwargs.get("slug")
    return _resolve_org_by_slug_or_uuid(slug)
...
def get(self, request, slug: str):
    org = self.get_organization()          # second DB hit
    if org is None:
        raise Http404("Organization not found.")
    qs = AuditEvent.objects.filter(organization_id=org.id)
```
`HasModule._resolve_organization()` calls `view.get_organization()` during the permission check (one DB query), and then `get()` calls it again (a second DB query). Both calls must agree on the same org object. While not a data-leakage issue today, if `_resolve_org_by_slug_or_uuid` were changed to return different results under race conditions (e.g., org soft-deleted between the two calls), the DB filter in `get()` could use an org that passed the permission gate but is now gone, causing a 200 with zero rows. More importantly, it is an TOCTOU pattern at the permission layer.

**Why it matters:** The permission decision (which org?) must be evaluated against the exact same org object that the queryset is scoped to. Currently both calls are synchronous and hit the same Postgres read replica, so the risk is low — but the pattern should be resolved.

**Recommendation:** Cache the resolved org on `self` within the view (e.g., `self._org = ...`) so `get_organization()` is idempotent across calls. This eliminates the double DB hit and removes the TOCTOU window.

---

### FINDING 4 — MEDIUM: Audit rows with `organization_id=NULL` are invisible through the org-scoped endpoint but have no alternative filtered endpoint for non-sadmin users

**File:** `backend/apps/audit/views.py:129`
**Evidence:**
```python
qs = AuditEvent.objects.filter(organization_id=org.id)
```
Many `emit_audit()` call sites emit rows without an `organization_id` (e.g., `user_login_success`, `email_verified`, `user_logout`, password-reset events — all in `accounts/views.py`). These rows have `organization_id=NULL`. They belong to no tenant and are accessible only via the sadmin surface. However, they contain user PII (target_id = user UUID, actor email) that an org admin may legitimately need to see (e.g., "did user X log in recently?").

This is not a leakage bug today (null rows are simply absent from org feeds), but it creates a correctness gap: an org admin auditing "did user X accept our invitation?" will see no login event in the org feed even though one occurred.

**Why it matters:** Design gap — null-org audit rows are a dead zone for org-level consumers. Future Phase 1B work will want to surface some of these (e.g., login events for org members).

**Recommendation:** Decide which event types require org tagging even when the triggering action is not org-scoped (e.g., `user_login_success` for a user who belongs to one or more orgs should carry the primary org). Document in `emit_audit()` signature which fields are required vs. optional, and add a validation warning when an org-relevant event is emitted without an `organization_id`.

---

### FINDING 5 — LOW: The cross-org isolation test does not cover the `MembershipModuleGrant` explicit-grant path

**File:** `backend/apps/audit/tests/test_audit_list_view.py:120-146`
**Evidence:**
```python
def test_cross_org_leak_blocked(loaded_modules, client, org, admin_user):
    other_org = OrganizationFactory(slug="other-co")
    _seed_audit(other_org, count=2)
    _seed_audit(org, count=1)
    # Admin attempting to read the other org → 403 (no membership = ...)
    other_resp = client.get(url_other)
    assert other_resp.status_code == 403, other_resp.content
```
The test correctly covers the "no membership at all" path. But it does not cover the case where a user has an explicit `MembershipModuleGrant(state=GRANT)` for `org.audit_log` in Org A but no `OrganizationMembership` row in Org B. The `has_module` resolver runs `_user_active_roles` first: if roles are empty, `_base_modules_for_roles` returns an empty set. Then `_apply_overrides` only queries grants for `(user, org)` — but only those with `OrganizationMembership` rows. A grant without a membership row would be a data inconsistency, but it is not tested.

More importantly, there is no test covering: user has `TEAM_MANAGER` in Org A (no audit_log default) but a manual `GRANT` override for `org.audit_log` in Org A — does that override correctly give access to Org A's feed but not Org B's feed?

**Why it matters:** The RBAC grant-override path is the most likely attack surface for privilege escalation bugs. Its interaction with cross-org isolation should be explicitly tested.

**Recommendation:** Add a parametrized test:
1. User has `MembershipModuleGrant(state=GRANT, module=org.audit_log)` in Org A (no default role membership) → can read Org A feed.
2. Same user hits Org B endpoint → 403.
3. User has a revoked (`state=DENY`) `org.audit_log` grant in Org A despite being an Admin → 403 on Org A feed.

---

### FINDING 6 — INFO: `AuditEventSerializer.get_actor_email_at_time` exposes the actor's current email (not a historical snapshot) — PII leakage risk when an org admin views events authored by a user from another org

**File:** `backend/apps/audit/serializers.py:50-58`
**Evidence:**
```python
def get_actor_email_at_time(self, obj: AuditEvent) -> str | None:
    if obj.actor_user_id is None:
        return obj.deleted_user_handle or None
    try:
        return obj.actor_user.email   # current email, not historical
    except Exception:
        return obj.deleted_user_handle or None
```
The serializer comment acknowledges the historical-snapshot gap ("no historical email snapshot stored"). But it does not redact the actor's email when the viewing org admin is looking at a system-generated row whose actor belongs to a different org. For example, if a Super-admin performed an action on behalf of Org A, the Super-admin's email address is returned to Org A's admin via this field.

**Why it matters:** The PRD serializer comment mentions "PII redaction applied at the email field per B.11 if a non-Super-admin viewer fetches a row authored by another user" — this redaction is not yet implemented.

**Recommendation:** Implement the B.11 redaction: if `request.user` is not a super-admin, and the `actor_user` is not a member of the organization being queried, redact the email to a hash or omit it.

---

## Gaps (No Code Yet / Forward-Looking)

| # | Item | Missing | Needed For | Effort | Blocking? |
|---|------|---------|-----------|--------|-----------|
| G1 | No detail endpoint for single AuditEvent | `/api/audit/orgs/<slug>/<id>/` endpoint does not exist | Phase 1B: full before/after diff in UI | M | No |
| G2 | No tournament-scoped or match-scoped audit feed endpoint | Only org-scoped feed exists; `tournament_id` and `match_id` fields are stored but not queryable via API | Phase 1B: tournament admin audit trail | M | No |
| G3 | Redis pub/sub cache invalidation for `effective_modules` not implemented | Only local-mem cache; cross-worker stale cache can allow or deny access incorrectly for up to 5 minutes after a grant change | Phase 1B: multi-worker production deploy | L | No (single-worker dev) |
| G4 | No explicit test for `MembershipModuleGrant(state=DENY)` blocking an Admin from audit feed | Test gap documented in Finding 5 | RBAC correctness | S | No |
| G5 | `actor_email_at_time` PII redaction per B.11 not implemented | Serializer comment acknowledges this; code is not present | Compliance / privacy | S | No |
| G6 | `TRUSTED_PROXIES` / proxy trust not configured in settings | `emit_audit` trusts raw `X-Forwarded-For` | Production forensic integrity | S | No |
| G7 | No FK constraint on `AuditEvent.organization_id` | Pure UUID field; DB cannot enforce referential integrity | Data integrity across org lifecycle | M | No |
