# Security Audit — fixture.doxaed.com backend/fixture (Phase 1A)

**Auditor:** Claude Code  
**Date:** 2026-06-04  
**Scope:** `backend/` Python source — broken access control/IDOR, injection, hardcoded secrets, weak crypto, auth/session flaws, CSRF gaps, DRF mass-assignment / over-exposed fields, SSRF, missing rate limits, 404-vs-403 info-leak, token entropy/hashing.  
**Excluded:** `backend/.venv/`, `frontend/node_modules/`, Phase 1B (not built).

---

## Findings

---

### CRITICAL-1: Real credentials committed to `.env` (hardcoded secrets)

**File:** `backend/.env:1-9`  
**Evidence:**
```
SECRET_KEY=dev-only-not-for-prod-replace-me-please-change-this-now
DATABASE_URL=postgres://postgres:postgress@localhost:5432/fixturedb
SUPERUSER_EMAIL=graceschooledu@gmail.com
SUPERUSER_PASSWORD=DoxaEd33@
```
**Why it matters:** `SUPERUSER_EMAIL` and `SUPERUSER_PASSWORD` are real credentials for the production super-admin account, committed in plaintext. The Postgres password and a weak but real-looking Django `SECRET_KEY` are also present. The `.gitignore` correctly lists `backend/.env`, but if this repo is ever pushed to a remote (or if `.gitignore` is added after the first commit), these credentials can be leaked via git history. Additionally, `SECRET_KEY` is used as the Fernet key derivation input (see `_crypto.py:35`); if the key is predictable, TOTP shared secrets can be decrypted.

**Recommendation:**
1. Immediately rotate the super-admin password and the `SECRET_KEY`.
2. Ensure `backend/.env` is listed in `.gitignore` *before* any first commit and verify git history contains no `.env` file (`git log --all --full-history -- backend/.env`).
3. Use a placeholder like `SUPERUSER_PASSWORD=CHANGEME` (as the `.env.example` already does); set real values via a secrets manager or environment injection at deploy time.
4. Consider using `django-environ`'s `env.str("SECRET_KEY")` with a dedicated high-entropy value and separate it from what `_crypto.py` uses for TOTP encryption (the TOTP key should be its own secret, not derived from `SECRET_KEY`).

**Confidence:** High

---

### HIGH-1: `@csrf_exempt` on super-admin JSON API endpoints (CSRF gap)

**File:** `backend/apps/sadmin/views/superadmin.py:47,97`  
**Evidence:**
```python
@superadmin_required
@require_POST
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:
    ...

@superadmin_required
@require_POST
@csrf_exempt
def archive_feedback_api(request: HttpRequest, feedback_id: uuid.UUID) -> HttpResponse:
```
**Why it matters:** Both endpoints mutate state (bulk_email_drafted audit + feedback archive). Removing CSRF enforcement on session-authenticated HTML-console endpoints means a cross-site request forgery attack can trigger these verbs from any page the SA visits while logged in. The decorators are ordered `@superadmin_required → @csrf_exempt`; DRF's `SessionAuthentication` does enforce CSRF for DRF views, but these are raw Django views, not DRF. The `@csrf_exempt` decorator removes Django's CSRF middleware check entirely for these two views.

**Recommendation:** Remove `@csrf_exempt`. Accept JSON bodies via Django's standard CSRF-protected POST mechanism (the SA console can include a CSRF token via the `{% csrf_token %}` template tag or as a cookie-to-header pattern for JS fetch calls). If the intent was to allow cross-origin AJAX from the sadmin JS frontend, configure `CSRF_TRUSTED_ORIGINS` instead of exempting CSRF wholesale.

**Confidence:** High

---

### HIGH-2: Open redirect on sadmin login `?next=` parameter

**File:** `backend/apps/sadmin/views/auth.py:51-52`  
**Evidence:**
```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```
**Why it matters:** The `?next=` value is used verbatim for a redirect after successful super-admin login. An attacker can craft a link `https://fixture.doxaed.com/sadmin/login/?next=https://evil.com` that, after SA authentication, sends the browser to an external site. Because the SA has already authenticated at that point, this is a phishing vector that also bypasses standard "redirect after auth" warnings.

**Recommendation:** Validate the `next` parameter using Django's built-in `url_has_allowed_host_and_scheme` (import from `django.utils.http`) before redirecting:
```python
from django.utils.http import url_has_allowed_host_and_scheme
if not url_has_allowed_host_and_scheme(next_url, allowed_hosts=request.get_host(), require_https=not settings.DEBUG):
    next_url = reverse("sadmin:dashboard")
```

**Confidence:** High

---

### HIGH-3: ORM injection via unsanitised `target_filter` keys in `bulk_email`

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:409-411`  
**Evidence:**
```python
if target_filter:
    for k, v in target_filter.items():
        qs = qs.filter(**{k: v})
```
**Why it matters:** `target_filter` is an arbitrary `dict` supplied by the SA from the JSON body of `POST /sadmin/api/bulk-email/`. Django ORM filter kwargs are not SQL-injection vectors in the traditional sense (they are parameterised), but they **are** ORM traversal vectors. A key like `"password__startswith"` can test password hash prefixes; `"recovery_codes__code_hash__startswith"` can extract argon2 hashes by binary search. This constitutes a data exfiltration path for a compromised or malicious SA account — and during impersonation it could leak other users' data. While the attacker must be an authenticated SA, the principle of least privilege says SA's bulk-email filter should only accept whitelisted fields.

**Recommendation:** Replace the unconstrained `filter(**{k: v})` with an explicit allowlist:
```python
_ALLOWED_BULK_EMAIL_FILTERS = {"email__endswith", "is_active", "has_2fa_enrolled", ...}
for k, v in target_filter.items():
    if k not in _ALLOWED_BULK_EMAIL_FILTERS:
        raise PermissionError(f"Disallowed filter field: {k}")
    qs = qs.filter(**{k: v})
```

**Confidence:** High

---

### HIGH-4: TOTP secret encryption key derived from `SECRET_KEY` — single-secret dependency

**File:** `backend/apps/accounts/services/_crypto.py:35-38`  
**Evidence:**
```python
raw = settings.SECRET_KEY.encode("utf-8")
digest = hashlib.sha256(raw).digest()
key = base64.urlsafe_b64encode(digest)
return Fernet(key)
```
**Why it matters:** The same `SECRET_KEY` that signs Django sessions and CSRF tokens also derives the Fernet key used to encrypt TOTP shared secrets (`TwoFactorDevice.secret_b32`). If `SECRET_KEY` must be rotated (e.g., after a leak), all TOTP secrets become undecryptable simultaneously — users lose 2FA access. Conversely, anyone who learns `SECRET_KEY` can decrypt every stored TOTP secret directly from the database, enabling total 2FA bypass. The code comment acknowledges "KMS-backed keys is tracked under v1Users.md B.21" but the fallback path (storing TOTP secrets in plaintext) is also present if `cryptography` fails to import.

**Recommendation:**
1. Add a dedicated `TOTP_ENCRYPTION_KEY` environment variable, distinct from `SECRET_KEY`.
2. Remove the plaintext fallback path or at minimum raise `ImproperlyConfigured` rather than silently storing in plaintext.
3. Track a migration that re-encrypts existing TOTP secrets when the key changes.

**Confidence:** High

---

### HIGH-5: `X-Forwarded-For` trusted without `SECURE_PROXY_SSL_HEADER` / trusted-proxy list

**Files:** `backend/apps/accounts/services/password_reset.py:41`, `backend/apps/audit/services.py:54`, `backend/apps/sadmin/middleware.py:22`  
**Evidence:**
```python
forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
return forwarded or request.META.get("REMOTE_ADDR") or None
```
**Why it matters:** All three IP-extraction points trust the first value from `X-Forwarded-For` directly from the request headers, without any proxy trust configuration. If the app is exposed without a trusted reverse proxy (or if the proxy is misconfigured), any client can spoof their IP address by sending `X-Forwarded-For: 10.0.0.1`, bypassing:
- The per-IP password-reset rate limit (`pwreset:ip:<ip>`).
- The sadmin IP allowlist (`SADMIN_IP_ALLOWLIST`) — an attacker can supply a whitelisted IP in the header and access `/sadmin/` if only this middleware guards it.
- Audit log IP attribution.

**Recommendation:**
1. Set `SECURE_PROXY_SSL_HEADER` and Django's `USE_X_FORWARDED_HOST` appropriately, or use `django-ipware` with `IPWARE_META_PRECEDENCE_ORDER` limited to trusted proxy layers.
2. The sadmin IP allowlist is especially dangerous: if nginx is not stripping `X-Forwarded-For` before forwarding, the allowlist provides no real protection. Document clearly that nginx must strip client-supplied `X-Forwarded-For` before Django receives the request.

**Confidence:** High

---

### MEDIUM-1: `MeSerializer` exposes `deleted_at` field to authenticated users

**File:** `backend/apps/accounts/serializers.py:108-132`  
**Evidence:**
```python
class Meta:
    model = User
    fields = (
        ...
        "deleted_at",
    )
    read_only_fields = (
        ...
        "deleted_at",
    )
```
**Why it matters:** The `deleted_at` timestamp is a soft-delete sentinel. The `GET /api/accounts/me/` endpoint includes it in the response. For a user whose soft-delete has not been finalised (rare edge case), they can see their own `deleted_at`. More importantly, the `user_soft_delete_view` sets `deleted_at` but then the user can still call `/api/accounts/me/` and observe the field. The field is low-risk individually but it reveals internal platform implementation details and could be useful for timing attacks to enumerate deletion cadence.

**Recommendation:** Remove `deleted_at` from `MeSerializer.Meta.fields`. The SPA only needs to know whether the account is active — communicate that via `is_active` or a `status` field, not raw DB timestamps.

**Confidence:** Medium

---

### MEDIUM-2: Admin PATCH `/api/orgs/{uuid}/` only checks `role=admin`, not `is_org_owner`

**File:** `backend/apps/organizations/views.py:203-209`  
**Evidence:**
```python
if not OrganizationMembership.objects.filter(
    user=request.user,
    organization=org,
    is_active=True,
    role=MembershipRole.ADMIN,
).exists():
    raise PermissionDenied("Admin role required.")
```
**Why it matters:** Any admin (not just the owner) can patch `name` and `time_zone` on the org via this endpoint. The `IsOrgAdminOrOwner` permission class used elsewhere allows all admins, which is intentional per v1Users.md. However the PATCH body is passed through `OrganizationUpdateSerializer` which only accepts `name` and `time_zone` — it is correctly restricted. The concern is that both the slug-change verb and this PATCH path have different admin requirements documented inconsistently (OrgChangeSlugView uses `IsOrgAdminOrOwner` permission class, while OrgDetailView.patch does manual filtering), which could diverge during future modifications.

**Recommendation:** Consistently use `IsOrgAdminOrOwner` permission class (instead of inline `OrganizationMembership.objects.filter` checks) in `OrgDetailView.patch()` to keep RBAC enforcement in one place and avoid drift.

**Confidence:** Medium

---

### MEDIUM-3: `OrgMembersListView` (UUID route) does not verify org membership before returning all active members

**File:** `backend/apps/organizations/views.py:349-365`  
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
**Why it matters:** `HasModule("org.member_directory")` calls `_resolve_organization(request, view)`, which calls `view.get_organization()`. If `get_organization()` succeeds but the module resolver cannot find the org context (unlikely given the implementation), it returns `None` → `False`. More critically: the module check is `has_module(user, org, module_code)` which calls `effective_modules(user, org)`. That function returns `frozenset()` for a user with no membership in `org`. So `has_module` correctly returns `False` for a non-member. This path appears safe on review. However, the behavior is not tested with a cross-org user (User in Org A calling the member list for Org B with the `org.member_directory` module enabled in Org A). The permission gate is correct but the cross-org test coverage gap means a future bug could enable IDOR. Confidence lowered to medium.

**Recommendation:** Add an explicit cross-org isolation test for `GET /api/orgs/{uuid}/members/` to the existing isolation test suite; ensure a user with `org.member_directory` in Org A cannot enumerate members of Org B.

**Confidence:** Medium

---

### MEDIUM-4: `SESSION_COOKIE_AGE` set to 30 days with no idle-expiry mechanism

**File:** `backend/fixture/settings/base.py:147`  
**Evidence:**
```python
SESSION_COOKIE_AGE = 60 * 60 * 24 * 30  # 30 days "remember me"
```
**Why it matters:** Sessions last 30 days from creation regardless of whether the user is active. There is no `SESSION_EXPIRE_AT_BROWSER_CLOSE` set to `True` for non-"remember me" sessions, and no idle-expiry mechanism. If a user logs in on a shared device and closes the browser, their session is valid for 30 days. For a platform handling sports organization admin functions (invitations, suspensions, etc.), session lifetime should be much shorter for non-remembered logins.

**Recommendation:** Implement two-tier sessions: a short default (e.g., 8-12 hours) and an explicit "remember me" opt-in that extends to 30 days. Consider `SESSION_EXPIRE_AT_BROWSER_CLOSE = True` as the secure default with the user able to opt into persistence.

**Confidence:** Medium

---

### MEDIUM-5: `password_reset_complete_view` leaks token validity state via different error messages

**File:** `backend/apps/accounts/services/password_reset.py:148-153`  
**Evidence:**
```python
if token is None:
    raise ValueError("Invalid token.")
if token.is_used:
    raise ValueError("Token already used.")
if token.is_expired:
    raise ValueError("Token expired.")
```
**Why it matters:** The three distinct error messages reveal whether: (a) the token never existed, (b) it was valid but already consumed, or (c) it existed but expired. An attacker who obtained a used reset token can confirm it was once valid. While this is low severity individually, the spec mandates enumeration-safe responses for security-sensitive flows (v1Users.md B.11). This endpoint already returns 200 unconditionally for the *request* side, but the *complete* side leaks state.

**Recommendation:** Collapse all failure cases to a single generic `"Invalid or expired token."` response at the view layer (`views.py:322`) while keeping the distinct `ValueError` types internally for logging/audit purposes.

**Confidence:** Medium

---

### MEDIUM-6: `FeedbackSubmitView` accepts `screenshot_data_uri` up to ~3.7 MB — no DoS protection beyond throttle

**File:** `backend/apps/sadmin/serializers.py:33-37`  
**Evidence:**
```python
screenshot_data_uri = serializers.CharField(
    max_length=5_000_000,  # ~3.7 MB worth of base64 — generous cap.
    required=False,
    allow_blank=True,
)
```
**Why it matters:** While the view discards the screenshot data URI (it is not persisted), the serializer still forces Django to read and deserialise up to 5 MB per request. The `FeedbackSubmitThrottle` limits to 10/hour/user, but 10 × 5 MB = 50 MB per hour from a single authenticated user is well within DoS territory for a single 4-vCPU VPS. The rate limit only applies after the request body is fully parsed by Django.

**Recommendation:** Add a `DATA_UPLOAD_MAX_MEMORY_SIZE` setting override for this endpoint (or set a global limit in settings), and/or move the screenshot to a separate pre-signed upload URL so the 5 MB payload never hits Django's main WSGI/ASGI process. At minimum note the DoS surface in a production checklist.

**Confidence:** Medium

---

### LOW-1: `_hash_token` uses SHA-256 without HMAC — timing oracle if DB lookup fails

**Files:** `backend/apps/accounts/views.py:66`, `backend/apps/accounts/services/password_reset.py:34`, `backend/apps/organizations/services/invitation.py:93`  
**Evidence:**
```python
def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
```
**Why it matters:** The tokens are high-entropy random values (`secrets.token_urlsafe(48)`, `secrets.token_urlsafe(32)`), so a rainbow-table attack on SHA-256 is infeasible. However, SHA-256 without a secret makes offline brute-force possible if the hash column is ever leaked (vs. HMAC-SHA256 with `SECRET_KEY` as the key, which would require both). The DB lookup itself is constant-time via ORM (no timing oracle in the comparison), and `select_for_update()` is used for the sensitive paths. This is low severity given the token entropy, but HMAC would be strictly better.

**Recommendation:** Use `hmac.new(settings.SECRET_KEY.encode(), plaintext.encode(), hashlib.sha256).hexdigest()` instead of bare SHA-256. This adds no overhead and prevents offline brute-force even if the hash column is leaked.

**Confidence:** Medium (impact Low, confidence Medium on the issue being real)

---

### LOW-2: `sadmin` login `?next=` redirect hint leaks that the SA is authenticated

**File:** `backend/apps/sadmin/decorators.py:33`  
**Evidence:**
```python
return HttpResponseRedirect(f"{login_url}?next={request.path}")
```
**Why it matters:** When an unauthenticated user accesses any `/sadmin/` path (except `/sadmin/login/`), they are redirected to `/sadmin/login/?next=/sadmin/users/`. This reveals the existence of the SA console path they requested, partially undermining the §1.5 "don't leak the surface" invariant. A security scanner hitting `/sadmin/users/` gets a 302 → `/sadmin/login/?next=/sadmin/users/` rather than a 404, confirming the path exists.

**Recommendation:** Redirect unauthenticated SA access to `/sadmin/login/` without a `?next=` parameter, or redirect to `/sadmin/login/` with a generic next (always the dashboard). This eliminates path enumeration via redirect hints.

**Confidence:** Low (the login URL itself is already known; the additional path leakage is marginal)

---

### LOW-3: `OrgMemberDetailSerializer` exposes user email addresses in member list

**File:** `backend/apps/organizations/serializers.py:127`  
**Evidence:**
```python
class OrgMemberDetailSerializer(serializers.Serializer):
    ...
    email = serializers.EmailField()
```
**Why it matters:** `GET /api/orgs/{slug}/members/` returns full email addresses for all members. This is gated by `HasModule("org.member_directory")`, which is correct. However, an Admin who legitimately has this module enabled can harvest all member email addresses. This is probably intentional (admins need to contact members), but:
1. There is no audit row emitted for member-list reads.
2. If the module gate is misconfigured or has a bug in the permission resolver, emails are freely enumerable.

**Recommendation:** (a) Add an audit emission for bulk member-list reads if PII enumeration is a concern. (b) Document that `org.member_directory` grants email visibility. (c) Consider returning masked emails for non-admin roles if the module is ever opened to lower-privilege roles.

**Confidence:** Low (by-design, module-gated)

---

### INFO-1: No `SECURE_HSTS_SECONDS`, `SECURE_SSL_REDIRECT`, or `SECURE_CONTENT_TYPE_NOSNIFF` in base settings

**File:** `backend/fixture/settings/base.py`  
**Evidence:** Searched for `SECURE_SSL_REDIRECT`, `SECURE_HSTS`, `SECURE_PROXY_SSL`, `X_FRAME_OPTIONS`, `SECURE_CONTENT` — none found.  
**Why it matters:** Django's `SecurityMiddleware` is installed, but none of the security hardening flags are set. In production this means no HSTS, no forced HTTPS redirect, no content-type sniff protection. `X_FRAME_OPTIONS` defaults to `SAMEORIGIN` via `XFrameOptionsMiddleware` (which is installed), so clickjacking is partially mitigated, but the other headers need explicit configuration for production.

**Recommendation:** Create a `backend/fixture/settings/prod.py` with:
```python
SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 63072000  # 2 years
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
```

**Confidence:** High (these are missing; not yet critical because prod settings file doesn't exist yet)

---

### INFO-2: `axes` lockout limit of 10 failed attempts is generous

**File:** `backend/fixture/settings/base.py:180-182`  
**Evidence:**
```python
AXES_FAILURE_LIMIT = 10  # PRD §2.9 invariant
AXES_COOLOFF_TIME = 0.25  # 15 minutes
```
**Why it matters:** 10 attempts before lockout allows password-spraying attacks. OWASP recommends 3-5 attempts. The 15-minute cooloff is reasonable. The PRD §2.9 sets 10 as the invariant; this is a deliberate product decision, not a bug. Documented for awareness.

**Recommendation:** If the PRD decision is firm, leave at 10. Consider adding progressive delay (1s, 2s, 4s…) for failed attempts before the lockout threshold is reached. Also confirm that `AXES_LOCKOUT_PARAMETERS = ["ip_address", "username"]` correctly handles the axes lockout under the IP spoofing scenario described in FINDING HIGH-5.

**Confidence:** High (observation only; PRD-mandated)

---

### INFO-3: `LocMemCache` used for rate-limit counters in dev — silently incorrect in multi-process prod

**File:** `backend/fixture/settings/base.py:190-196`  
**Evidence:**
```python
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "fixture-default-cache",
    },
}
```
**Why it matters:** The password-reset rate limiter (`_rate_limit_hit` in `password_reset.py:45-59`), the sadmin B.21 alarm counters, and the `effective_modules` cache all rely on `django.core.cache`. `LocMemCache` is per-process and not shared between ASGI workers. In production with multiple Gunicorn/Daphne workers, each worker has its own counter — the effective rate limit becomes N × configured limit where N = worker count. This is a **known issue** (the CLAUDE.md lists it as item (d)), but it directly undermines the security controls.

**Recommendation:** Configure `channels-redis` and Redis cache backend for production (CHANNEL_LAYERS and CACHES). This is listed as a gap item and confirmed here.

**Confidence:** High (confirmed from settings; cross-references known issue (d))

---

## Gaps (forward-looking, not current bugs)

| Item | What is missing | Needed for | Effort | Blocking |
|------|----------------|------------|--------|----------|
| Production settings file | `prod.py` with HSTS, SSL redirect, content-type sniff, referrer policy | Go-live | S | Yes |
| Redis cache + channel layer | Phase 1B live features; rate-limit accuracy in multi-worker prod | Phase 1B deploy | S | Yes (for multi-worker) |
| TOTP key rotation story | No migration to re-encrypt TOTP secrets when `SECRET_KEY` changes | Ops | M | No (but painful) |
| Cross-org IDOR isolation tests | Explicit parametrised test: User(OrgA) → member list OrgB → 403 | Phase 1A test suite | S | No (gap in tests) |
| `next=` redirect validation in sadmin login | `url_has_allowed_host_and_scheme` missing | Security hardening | S | No |
| Audit log for member-list reads | PII enumeration audit trail | Phase 1B | S | No |
| Separate TOTP encryption key env var | Decouple TOTP from `SECRET_KEY` | Security hardening | S | No |
| Allowlist for `target_filter` in `bulk_email` | ORM injection via arbitrary keys | Before Phase 1B bulk-email send | M | No (Phase 1A only records draft) |
| CSRF on sadmin JSON API endpoints | Remove `@csrf_exempt` | Security hardening | S | No |

---

*End of audit report.*
