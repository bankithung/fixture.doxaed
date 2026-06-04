# Security Audit: apps/accounts — Broken Access Control, Injection, Auth/Session, Crypto, CSRF, Mass-Assignment, Rate-Limiting

**Date:** 2026-06-04
**Scope:** `backend/apps/accounts/` (models, views, serializers, services, throttling, urls, migrations, settings/base.py)
**Lens:** Broken access control / IDOR, injection (raw SQL / template / command), hardcoded secrets, weak crypto, auth/session flaws, CSRF gaps, DRF mass-assignment / over-exposed fields, SSRF, missing rate limits, 404-vs-403 info leak, token entropy / hashing.

---

## Findings

---

### F-01 [CRITICAL] — Plaintext super-admin password committed in `.env`

**File:** `backend/.env:6-7`

```
SUPERUSER_EMAIL=graceschooledu@gmail.com
SUPERUSER_PASSWORD=DoxaEd33@
```

**Why it matters:** The `.env` file contains real credentials for the super-admin account. Although `.gitignore` lists `.env`, if this file was ever committed (even once) those credentials are in git history. Any teammate, CI worker, or third-party tool with repo access can read them.

**Recommendation:** Rotate the `SUPERUSER_PASSWORD` and `SECRET_KEY` immediately. Audit git history (`git log --all --full-diff -- .env`) to confirm no commit contains it. Prefer vault/secrets-manager injection in production and never put real passwords in any file under the repo root, even a gitignored one.

---

### F-02 [HIGH] — Weak symmetric key derivation for TOTP secret encryption (SHA-256 of SECRET_KEY → Fernet)

**File:** `backend/apps/accounts/services/_crypto.py:35-38`

```python
raw = settings.SECRET_KEY.encode("utf-8")
digest = hashlib.sha256(raw).digest()
key = base64.urlsafe_b64encode(digest)
return Fernet(key)
```

**Why it matters:** The Fernet key is derived directly from `SECRET_KEY` via a single SHA-256 call with no salt, no KDF rounds, and no domain separation. SHA-256 is not a password/key derivation function. An attacker who obtains the Django `SECRET_KEY` (e.g., from a leaked `.env`) immediately gets the Fernet key with zero extra work. Additionally, rotating `SECRET_KEY` silently breaks all existing encrypted TOTP secrets without a re-key procedure.

**Recommendation:** Derive the envelope key using HKDF or PBKDF2 with a separate, dedicated `TWOFA_ENCRYPTION_KEY` env var. Or use a KMS-backed key as already noted in `v1Users.md B.21`. At minimum, add a separate `TWOFA_ENCRYPTION_KEY` env var so rotation of the Django session-signing key does not break 2FA.

---

### F-03 [HIGH] — Login endpoint has no explicit DRF throttle class; relies solely on django-axes for brute-force protection

**File:** `backend/apps/accounts/views.py:196-253` (login_view) and `backend/apps/accounts/throttling.py`

```python
@api_view(["POST"])
@permission_classes([AllowAny])
def login_view(request: Request) -> Response:
```

No `@throttle_classes([...])` decorator is present. The default `AnonRateThrottle` (`60/min`) applies, which is far above a useful brute-force ceiling. django-axes provides lockout after N failures, but axes requires the middleware to be active. The conftest (`backend/apps/accounts/tests/conftest.py:16`) disables axes globally by default:

```python
@pytest.fixture(autouse=True)
def _disable_axes(settings):
    settings.AXES_ENABLED = False
```

This means CI does not enforce axes on the vast majority of login-path tests. If axes is ever misconfigured in production, the only remaining defence is the 60/min anon throttle — insufficient against a slow distributed attack.

**Recommendation:** Add a dedicated `LoginRateThrottle` (e.g., 10/5min/IP) decorated on `login_view` as a second layer of defence, independent of axes. This is the same pattern already used on signup and is consistent with `v1Users.md B.11`.

---

### F-04 [HIGH] — Unvalidated `last_active_org_id` write via PATCH `/me/` — IDOR / cross-org probe vector

**File:** `backend/apps/accounts/serializers.py:107-132` and `backend/apps/accounts/views.py:423-441`

```python
fields = (
    ...
    "last_active_org_id",   # writable — NOT in read_only_fields
    ...
)
read_only_fields = (
    "id", "email", "is_superuser", "has_2fa_enrolled", ...
    # last_active_org_id is absent from read_only_fields
)
```

`last_active_org_id` accepts any UUID from the client and is written to the DB without checking that the org exists or that the user is a member of it. A user can set their `last_active_org_id` to any random UUID, which:
1. Causes the `get_last_active_org_slug` resolver to issue a DB query for a foreign org's slug — leaking "yes, that UUID belongs to an org" vs. "no" (timing / boolean oracle).
2. Sets up confusion in any future code that reads `last_active_org_id` and assumes membership.

**Recommendation:** Either move `last_active_org_id` to `read_only_fields` and let the server update it on successful dashboard load, OR add a custom `validate_last_active_org_id` validator in `MeSerializer` that checks `OrganizationMembership.objects.filter(user=request.user, organization_id=value, is_active=True).exists()`.

---

### F-05 [HIGH] — `X-Forwarded-For` trust without proxy header validation — IP spoofing for rate-limit bypass

**File:** `backend/apps/accounts/services/password_reset.py:39-42`

```python
def _client_ip(request: HttpRequest | None) -> str | None:
    if request is None:
        return None
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    return forwarded or request.META.get("REMOTE_ADDR") or None
```

The code naively takes the first value of `X-Forwarded-For` as the client IP without any allowlisting of trusted proxies. An attacker can send `X-Forwarded-For: 1.2.3.4` from any IP and have the per-IP rate limit bucket keyed to the spoofed address, entirely bypassing the `PASSWORD_RESET_RATE_PER_IP_HOUR` control.

Django's `IPWARE_TRUSTED_PROXIES` (or axes' `AXES_IPWARE_PROXY_COUNT`) should be used, or the code should rely on Django's `request.META["REMOTE_ADDR"]` (set by nginx/reverse proxy before it reaches Django) and remove the hand-rolled XFF parsing.

**Recommendation:** Remove the custom `_client_ip` helper. Use `django-ipware`'s `get_client_ip(request)` which honours `settings.IPWARE_META_PRECEDENCE_ORDER` and a trusted-proxy list. The same pattern is already imported from `axes.helpers` (`get_client_ip_address`) in `views.py` line 27 — use that consistently.

---

### F-06 [MEDIUM] — Account-inactive path returns HTTP 403 instead of 401 / 400, leaking account existence

**File:** `backend/apps/accounts/views.py:222-223`

```python
if not user.is_active or user.deleted_at is not None:
    return Response({"detail": "account_inactive"}, status=status.HTTP_403_FORBIDDEN)
```

This branch is only reached after `authenticate()` succeeds (correct password). An attacker trying to enumerate accounts can distinguish:
- `400 invalid_credentials` → wrong password (or email doesn't exist)
- `403 account_inactive` → correct password, but account is inactive/deleted

The 403 response leaks that the correct password was supplied, which is an account-existence oracle stronger than the already-defended 201/duplicate-email path.

**Recommendation:** Return the same `400 invalid_credentials` response regardless of whether the failure is a wrong password or an inactive account. The audit row differentiates the cases internally without exposing it to the caller.

---

### F-07 [MEDIUM] — `twofa_disable_view` and `twofa_recovery_regenerate_view` do not require a recent password reauth

**File:** `backend/apps/accounts/views.py:369-396`

```python
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_disable_view(request: Request) -> Response:
    # No @require_recent_password_reauth
    ...
    twofa_svc.disable_2fa(...)

@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_recovery_regenerate_view(request: Request) -> Response:
    # No @require_recent_password_reauth
    ...
```

Disabling 2FA or regenerating recovery codes are high-privilege security-state changes that v1Users.md B.18 explicitly mandates must re-prompt for password. The `require_recent_password_reauth` decorator exists in `backend/apps/accounts/decorators.py` but is not applied to these two views. An attacker who hijacks an authenticated session can immediately downgrade the account's 2FA protection.

**Recommendation:** Apply `@require_recent_password_reauth()` to both `twofa_disable_view` and `twofa_recovery_regenerate_view`.

---

### F-08 [MEDIUM] — Password-reset token hashed with SHA-256 only; no timing-safe token lookup

**File:** `backend/apps/accounts/services/password_reset.py:34-35` and `views.py:65-66`

```python
def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
```

And the lookup:
```python
token = PasswordResetToken.objects.select_for_update()
    .filter(token_hash=token_hash).first()
```

SHA-256 is a fast hash. If an attacker obtains the `token_hash` column (e.g., DB dump), they can brute-force the 48-byte `secrets.token_urlsafe` token (which has ~288 bits of entropy, so SHA-256 preimage resistance is the real defence here — acceptable). However, the DB query compares `token_hash` using Postgres string equality which is not timing-safe at the application layer. In practice Django/Postgres string comparisons do not expose timing channels across the network, so this is low-risk in a typical deployment.

The bigger concern: the same `_hash_token` function is duplicated verbatim in three places (`views.py:65`, `password_reset.py:34`, `signup.py:88`). Any future divergence can silently break token validation.

**Recommendation:** Extract `_hash_token` to a shared utility module (`apps.accounts.services._crypto` already exists for this purpose) and import from one canonical location.

---

### F-09 [MEDIUM] — Session invalidation on password reset is O(N) over the entire session table

**File:** `backend/apps/accounts/services/password_reset.py:176-192`

```python
def _invalidate_all_sessions_for_user(user: User) -> None:
    target_id = str(user.pk)
    for session in Session.objects.iterator(chunk_size=500):
        try:
            data = session.get_decoded()
        ...
        if str(data.get("_auth_user_id", "")) == target_id:
            session.delete()
```

This walks every active session in the DB, decoding each one. The comment acknowledges "O(n) over active sessions". With a shared VPS at scale (even 50k sessions) this is a DoS vector: triggering many password resets simultaneously will saturate CPU decoding sessions. It also holds `select_for_update` row locks on individual sessions rather than a set-delete.

**Recommendation:** Use `django-user-sessions` or extend the session model to store `user_id` as an indexed column, enabling `Session.objects.filter(user_id=user.pk).delete()` — an O(1) indexed delete. Alternatively, implement a `user_session_key` signed into the session payload and store it on the user, then invalidate by regenerating the key.

---

### F-10 [MEDIUM] — `MeSerializer` exposes `deleted_at` to users

**File:** `backend/apps/accounts/serializers.py:121,131`

```python
fields = (..., "deleted_at", ...)
read_only_fields = (..., "deleted_at", ...)
```

A soft-deleted user whose `is_active=False` cannot log in, so this is not directly exploitable. However, `deleted_at` is an internal implementation detail (PII/forensic timestamp) that has no business being served in the SPA API response for a live user. If this field ever appears for a non-deleted active user (e.g., during a brief soft-delete/reactivate window), it would surface.

**Recommendation:** Remove `deleted_at` from `MeSerializer.fields`. It is not needed by the SPA; the SPA only needs to know the user is active (which login enforces). Internal admin tooling should use a separate serializer.

---

### F-11 [LOW] — `ATOMIC_REQUESTS = True` + `@transaction.atomic` on `verify_email` can mask exceptions

**File:** `backend/fixture/settings/base.py:102` + `backend/apps/accounts/views.py:154`

```python
DATABASES["default"]["ATOMIC_REQUESTS"] = True
...
@transaction.atomic
def verify_email(request: Request) -> Response:
```

Double-nesting `@transaction.atomic` inside an already-atomic request means a `select_for_update` failure in an inner block (e.g., deadlock) rolls back the inner savepoint but the outer request transaction still commits — silently losing the update. This is a known Django footgun with `ATOMIC_REQUESTS`.

**Recommendation:** Remove the `@transaction.atomic` decorator from `verify_email` (and all other views that already run inside `ATOMIC_REQUESTS`). Wrap only the critical section at the service layer if sub-transaction isolation is needed.

---

### F-12 [LOW] — `SESSION_COOKIE_AGE = 30 days` with no idle timeout or re-auth for privilege actions (except B.18 reauth window)

**File:** `backend/fixture/settings/base.py:147`

```python
SESSION_COOKIE_AGE = 60 * 60 * 24 * 30  # 30 days "remember me"
```

A 30-day non-idle session is a very long window for a session-cookie-only auth scheme on an admin/scoring platform. If a device is shared or stolen, an attacker has a 30-day window. There is no absolute session expiry enforced server-side; the `SESSION_COOKIE_AGE` is client-honoured (browser may keep the cookie longer).

**Recommendation:** Consider splitting into a short-lived session (8h) that auto-extends on activity, or implement a server-side `last_activity_at` timestamp checked on every request and invalidate idle sessions after, say, 8 hours.

---

### F-13 [INFO] — `CSRF_COOKIE_HTTPONLY = False` is correct for SPA use but must be documented

**File:** `backend/fixture/settings/base.py:149`

```python
CSRF_COOKIE_HTTPONLY = False  # JS reads token for SPA + HTMX
```

This is intentional (the CSRF token must be readable by the SPA JavaScript) and is the standard approach. However, if the codebase ever introduces a subdomain that can inject scripts, this becomes exploitable. The comment is good; no code change needed.

**Recommendation:** Document in the security baseline that `CSRF_COOKIE_HTTPONLY = False` requires `Content-Security-Policy` to prevent XSS-based CSRF token exfiltration. Ensure CSP headers are set at the nginx layer.

---

### F-14 [INFO] — `twofa_enroll_view` does not check if user already has 2FA enrolled before creating a new device

**File:** `backend/apps/accounts/views.py:336-346` + `twofa.py:78`

```python
def enroll_totp(user: User) -> dict[str, Any]:
    # Replace any prior pending enrollment so a user can re-scan the QR.
    TwoFactorDevice.objects.filter(user=user, confirmed_at__isnull=True).delete()
```

Re-enrolling while already confirmed deletes only the unconfirmed row; the confirmed row is preserved, and the new unconfirmed row is created alongside it. The intent seems fine, but a user can call `enroll` repeatedly, generating new unconfirmed rows that could be confirmed to replace the existing confirmed device. This is by design ("re-scan"), but there is no reauth gate here — a session hijacker can enroll a new authenticator without knowing the password.

**Recommendation:** Apply `@require_recent_password_reauth()` to `twofa_enroll_view` as well, consistent with the B.18 mandate for security-state changes.

---

## Gaps (forward-looking, not yet bugs but missing before Phase 1B)

| # | Item | Missing | Needed for | Effort |
|---|------|---------|------------|--------|
| G-01 | KMS-backed TOTP key | v1Users.md B.21 is logged as a TODO — Fernet key currently derived from `SECRET_KEY` | Production hardening | M |
| G-02 | Login endpoint explicit throttle | No `LoginRateThrottle` class; only axes lockout | Defence-in-depth per B.11 | S |
| G-03 | Dedicated session-user index | `_invalidate_all_sessions_for_user` O(N) will degrade at scale | Phase 1B with concurrent users | M |
| G-04 | `last_active_org_id` PATCH validation | No membership check on write | Needed before org-switcher UI ships | S |
| G-05 | `reauth` gate on 2FA enroll + disable + recovery regen | Three security-state-change views missing `require_recent_password_reauth` | B.18 compliance | S |
| G-06 | CSP headers | No CSP policy observed in settings/middleware | Mitigates XSS + CSRF token exfiltration risk from F-13 | M |
| G-07 | `deleted_at` removed from `MeSerializer` | Currently exposed as read-only but unnecessary | API hygiene | S |
| G-08 | Consistent `_hash_token` function | Three identical copies across `views.py`, `password_reset.py`, `signup.py` | Code hygiene / drift risk | S |
| G-09 | Session idle timeout | 30-day static cookie with no server-side idle check | Hardening for admin accounts | M |
