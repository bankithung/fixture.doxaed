# Security Audit: backend/apps/audit

Audited: 2026-06-04
Scope: broken access control/IDOR, injection (raw SQL/.extra/command/template), hardcoded secrets, weak crypto, auth/session flaws, CSRF gaps, DRF mass-assignment/over-exposed fields (PII/hashes), SSRF, missing rate limits, 404-vs-403 info leak, token entropy/hashing.

---

## Findings

### 1. [HIGH] Unauthenticated request returns 403 not 401 — info leak on audit endpoint

**File:** `backend/apps/audit/views.py:103`
**Evidence:**
```python
permission_classes = [IsAuthenticated, HasModule("org.audit_log")]
```
Test at `tests/test_audit_list_view.py:240` explicitly accepts `in (401, 403)`. With DRF `SessionAuthentication` and no `WWW-Authenticate` challenge header, unauthenticated requests receive a `403 Forbidden` response instead of `401 Unauthorized`. This is the same project-wide issue noted for `/api/accounts/me/` (known issue b in the task brief). Applied here: a crawler can distinguish "endpoint exists and requires auth" (403) from "endpoint does not exist" (404), weakening obscurity of the audit surface.

**Why it matters:** Any unauthenticated party probing `/api/audit/orgs/<slug>/` learns the slug resolves successfully (because the check order is `IsAuthenticated` → 403 before `HasModule` → org lookup). Combined with org slug enumeration this leaks org existence.

**Recommendation:** Add `BasicAuthentication` or set `WWW-Authenticate` via a custom authentication class so DRF returns 401 for completely unauthenticated requests; OR guard the view with a `require_login` check that returns 401. Consistent with fix needed project-wide.

---

### 2. [HIGH] IP spoofing via unvalidated X-Forwarded-For header — audit log poisoning

**File:** `backend/apps/audit/services.py:53-55`
**Evidence:**
```python
ip = (
    request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    or request.META.get("REMOTE_ADDR", "")
)
```
The first value in `X-Forwarded-For` is taken unconditionally with no check that the app is actually behind a trusted proxy. An attacker can trivially forge this header to log any IP address they choose (e.g. `X-Forwarded-For: 127.0.0.1`). Since the audit log's `ip_address` field is the forensic record of who performed an action, a spoofed IP undermines the integrity of the entire audit trail.

**Why it matters:** The audit log is a security control. Forensic IP evidence is worthless if any actor can self-nominate their IP. If the platform is later used for dispute resolution (Phase 1B: disputes app), false IPs could be cited as evidence.

**Recommendation:** Either (a) use `django-ipware` with `IPWARE_TRUSTED_PROXY_LIST` configured to the known reverse proxy/nginx, or (b) use `REMOTE_ADDR` only until proxy infrastructure is confirmed and documented. Also mirrors the same pattern in `apps/accounts/services/password_reset.py:41` which has the same issue.

---

### 3. [MEDIUM] PII (email) over-exposure: serializer docstring claims redaction but none is implemented

**File:** `backend/apps/audit/serializers.py:4-6`, `serializers.py:50-58`
**Evidence (docstring):**
```python
# PII redaction is applied at the email field per B.11 if a non-Super-admin
# viewer fetches a row authored by another user.
```
**Evidence (actual implementation):**
```python
def get_actor_email_at_time(self, obj: AuditEvent) -> str | None:
    if obj.actor_user_id is None:
        return obj.deleted_user_handle or None
    try:
        return obj.actor_user.email  # type: ignore[union-attr]
    except Exception:
        return obj.deleted_user_handle or None
```
The `get_actor_email_at_time` method unconditionally returns the actor's live email address to every caller who passes the `HasModule("org.audit_log")` check. There is no check of `request.user.is_superuser` or role level, and no masking (e.g., `r***@example.com`). The docstring's claim of per-B.11 PII redaction is dead letter.

**Why it matters:** An admin can see the email address of any user who ever triggered an auditable event in their org, including referees and scorers they did not personally invite. This could expose PII of external/cross-org actors if their events are ever associated with this org's `organization_id`. The docstring contract is a lie that could mislead future developers into thinking protection is already in place.

**Recommendation:** Either implement the B.11 redaction (mask emails for non-super-admin viewers reading other users' events) or remove the false docstring claim. Removing the claim is the minimum fix; implementing masking is the correct fix.

---

### 4. [MEDIUM] Payload JSONB exposed verbatim — no redaction of sensitive fields before serving to org members

**File:** `backend/apps/audit/serializers.py:65-70`
**Evidence:**
```python
def get_payload(self, obj: AuditEvent) -> dict[str, Any] | None:
    return obj.payload_after or obj.payload_before
```
The JSONB `payload_before` / `payload_after` blobs are served verbatim to any org member with `org.audit_log`. Callers of `emit_audit` currently write things like `{"email": target.email, "deleted_at": None}` (accounts/views.py:461), full name+org snapshots (`{"name": ..., "last_active_org_id": ...}` at accounts/views.py:425), and `{"is_active": False}` membership changes. There is no scrubbing layer. Future callers (Phase 1B) will emit match-related payloads that could include sensitive data — the absence of a scrubbing layer is a design gap.

**Why it matters:** A game coordinator with `org.audit_log` can read the email address of any soft-deleted user from the `user_soft_deleted` payload, bypassing the PII intent described in the serializer docstring. This is a mass-assignment / over-exposure of PII via JSONB.

**Recommendation:** Implement a `serialize_payload` function (the stub at `models.py:103` is already named for this purpose) that: (a) filters known PII keys before storing or before serving, and (b) gates full payload visibility behind `is_superuser`. Non-super-admin viewers should receive a redacted payload or none at all for events targeting other users.

---

### 5. [MEDIUM] Missing rate limit on the audit list endpoint — enumeration / DoS vector

**File:** `backend/apps/audit/views.py:90-200`
**Evidence:** No `throttle_classes` declared on `OrgAuditListView`. No DRF `DEFAULT_THROTTLE_CLASSES` in `settings/base.py`.

The endpoint supports `limit=200` (max page size). A user with `org.audit_log` (which includes admin, co-organizer, game coordinator, referee — four of the five non-super-admin roles) can paginate through every audit event ever recorded for an org with no rate control. With a sufficiently large audit table this is a scraping / bulk data exfiltration vector. It also allows a malicious insider to enumerate every action taken by every member without any server-side throttle.

**Why it matters:** Audit logs often contain sensitive operational data. Unrestricted read access in bulk with no throttle means a legitimate but rogue authorized user can quietly exfiltrate the full history.

**Recommendation:** Add `throttle_classes = [UserRateThrottle]` (or a custom `AuditReadThrottle`) to `OrgAuditListView`. Consider a lower per-minute limit (e.g., 30 requests/min) for read-heavy audit endpoints.

---

### 6. [MEDIUM] `event_type` filter — unbounded string passed directly to ORM exact-match

**File:** `backend/apps/audit/views.py:142-144`
**Evidence:**
```python
event_type = (request.query_params.get("event_type") or "").strip()
if event_type:
    qs = qs.filter(event_type=event_type)
```
The `event_type` value is taken verbatim from the query string with only `.strip()` normalization and passed to `qs.filter(event_type=event_type)`. While Django ORM parameterizes this against SQL injection, there is no allowlist validation. An attacker/tester can send arbitrarily long or bizarre strings (e.g., a 10 KB string, or a glob pattern), causing needless DB work and surprising response shapes.

**Why it matters:** Not SQL injection (ORM is safe), but without a maximum length or enum check: (a) it generates unnecessary DB queries on garbage values, (b) it could expose information about whether a particular event_type string exists in the table (timing oracle if index is present — `event_type` IS indexed at `models.py:68`), and (c) future code assuming `event_type` is always a known enum could break if callers pass unexpected values.

**Recommendation:** Validate `event_type` against a known set of allowed event type strings (or at minimum enforce `len(event_type) <= 64` to match the DB column width). Return 400 for unrecognized event types.

---

### 7. [LOW] `serialize_payload` stub is dead code and creates a false safety net

**File:** `backend/apps/audit/models.py:103-107`
**Evidence:**
```python
def serialize_payload(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Stub for payload serialization. Real impl belongs to the audit agent.
    UUIDs and datetimes need normalization. Placeholder for now.
    """
    return d
```
The function is defined but never called anywhere in the codebase (`emit_audit` in services.py passes raw dicts directly). It is therefore a stub that provides a false sense of completeness. If a future developer calls it believing it sanitizes the payload, they will get the raw dict back unmodified.

**Why it matters:** Calling `serialize_payload` gives no protection. The misleading docstring ("UUIDs and datetimes need normalization") implies it does something useful. Combined with finding #4, this creates a gap where PII normalization is expected but never applied.

**Recommendation:** Either implement the function (UUID/datetime normalization + PII field scrubbing) or delete it to avoid confusion. Add a `# TODO: implement` comment at minimum.

---

### 8. [LOW] 404 vs 403 org existence leak via `Http404` raise

**File:** `backend/apps/audit/views.py:124-128`
**Evidence:**
```python
org = self.get_organization()
if org is None:
    raise Http404("Organization not found.")
```
The org-resolution check happens AFTER `IsAuthenticated` + `HasModule("org.audit_log")` pass. This means an authenticated user without `org.audit_log` on a non-existent org slug gets 403 (from HasModule — because the org doesn't exist so org resolution fails in HasModule), but an authenticated user WITH `org.audit_log` on a different org who types a nonexistent slug gets a `404`. This inconsistency allows a user with `org.audit_log` in any org to distinguish "this slug doesn't exist" (404) from "this slug exists but you can't access it" (403 from HasModule).

**Why it matters:** A low-risk IDOR / information leak: a legitimately authorized user for org A can enumerate whether org slugs for other orgs exist by observing 404 vs 403 response codes.

**Recommendation:** Return 403 for all "org not found or not authorized" cases from a user's perspective, or at minimum document the deliberate distinction. Standard pattern: resolve org first and if null or if the user lacks permission, always return 403.

---

### 9. [LOW] `HasModule` silently swallows exceptions in `get_organization()`

**File:** `backend/apps/permissions/permissions.py:61-65`
**Evidence:**
```python
if hasattr(view, "get_organization"):
    try:
        return view.get_organization()
    except Exception:
        return None
```
Any exception thrown by `get_organization()` is silently caught and treated as "org not found" → permission denied. This means a DB error, a misconfigured view, or a programming mistake will silently grant a 403 instead of surfacing the error. This can mask bugs in production.

**Why it matters:** A crash in org resolution causes a silent 403 instead of a 500, making it undetectable via normal error monitoring. Also means a DoS condition (e.g., DB outage) degrades to "all users lose access silently" rather than a clear error.

**Recommendation:** Catch only specific exceptions (e.g., `Organization.DoesNotExist`) rather than bare `Exception`. Re-raise unexpected exceptions or log them at ERROR level.

---

## Gaps (forward-looking, not yet implemented)

| # | Item | Missing | Needed for | Effort | Blocking |
|---|------|---------|-----------|--------|---------|
| G1 | Payload PII scrubbing layer | `serialize_payload` is a stub; no fields are redacted before storage or serving | GDPR / any deletion right; Phase 1B dispute evidence | M | No (Phase 1B) |
| G2 | Cross-worker cache invalidation for `effective_modules` | `invalidate_cache` does not publish to Redis pub/sub; documented TODO at resolver.py:46-50 | Multi-worker ASGI deployment (Phase 1B) | M | No |
| G3 | Audit endpoint detail view | Only the list endpoint exists; no `/api/audit/orgs/<slug>/<event_id>/` detail with full diff | Phase 1B requirement mentioned in serializers.py:69 | S | No |
| G4 | Production Postgres role REVOKE for app role | Migration adds a trigger but trigger fires for all roles including superuser; trigger is defense-in-depth only; REVOKE UPDATE/DELETE on `audit_event` from the app role is mentioned in migration comment but not implemented in any migration | Production deploy hardening | S | No |
| G5 | Rate limit on audit list endpoint | No `throttle_classes`; project has no global throttle defaults | Insider bulk-exfiltration prevention | S | No |
| G6 | Allowlist validation for `event_type` filter | Free-form string passed to ORM with no validation | API hardening / timing-oracle mitigation | S | No |
| G7 | `ip_address` / `user_agent` excluded from API response | `ip_address` and `user_agent` are stored but NOT in the serializer `fields` list — this is correct. Verify this stays intentional when a detail endpoint is added. | Privacy / least-privilege | - | No |
