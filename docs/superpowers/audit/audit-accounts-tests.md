# Audit Report: accounts app — Test Gaps

**Date:** 2026-06-04
**Scope:** `backend/apps/accounts` — missing cross-org isolation tests, permission-denied/negative tests, state-machine/blocked-transition tests, idempotent-replay tests, untested error paths.
**Auditor lens:** ONLY identifying missing tests — not evaluating existing coverage positively.

---

## Summary

The accounts test suite has solid coverage of happy-path flows (signup, login, 2FA service, password-reset service, audit emission). However it has **zero negative/permission-denied tests** for all `IsAuthenticated` endpoints, **zero cross-org isolation tests**, **zero state-machine / blocked-transition tests** for 2FA enrollment and email verification, **no tests for the `reauth` endpoint or the `require_recent_password_reauth` decorator**, and several untested error paths in views and services.

---

## Findings

### F-01 — No test: unauthenticated access to `GET/PATCH /api/accounts/me/` returns 403 not 401

**Severity:** high
**File:** `backend/apps/accounts/views.py:418` (`me_view`), `backend/apps/accounts/tests/` (all test files — zero such test)
**Evidence:**
```python
# views.py:417-418
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def me_view(request: Request) -> Response:
```
`SessionAuthentication` + `IsAuthenticated` returns HTTP 403 (not 401) for anonymous requests — the KNOWN ISSUES section of the task spec calls this out as a real bug (`/api/accounts/me/ returns 403 not 401 when logged-out -> premature error banner on /login`). There is no test asserting the actual status code returned to an anonymous caller, so the bug is invisible in the test suite.
**Why it matters:** Invariant 15 is "session auth; no JWT" — this means the SPA relies on the response code to decide whether to show a login redirect or an error banner. A missing test means this regression goes undetected.
**Recommendation:** Add `test_me_returns_403_when_unauthenticated` asserting `APIClient().get(reverse("accounts:me")).status_code == 403` and document the deliberate 403-not-401 behavior. Separately, either fix the status to 401 (requires a custom `UNAUTHENTICATED_RESPONSE` or `authentication_classes` override) or update the SPA to treat 403 on `/me` as "not logged in."

---

### F-02 — No test: unauthenticated access to all `IsAuthenticated` endpoints (logout, reauth, 2FA, soft-delete)

**Severity:** high
**File:** `backend/apps/accounts/views.py` lines 259, 277, 337, 356, 371, 392, 452; `backend/apps/accounts/tests/` (all files)
**Evidence:**
```python
# views.py:259-260 (logout)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_view(request: Request) -> Response:

# views.py:337-338 (2fa enroll)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def twofa_enroll_view(request: Request) -> Response:
```
None of the six `IsAuthenticated`-gated endpoints (`logout`, `reauth`, `twofa_enroll`, `twofa_confirm`, `twofa_disable`, `twofa_recovery_regenerate`) has a test verifying that an anonymous POST returns a 4xx and is not processed.
**Why it matters:** While Django's `IsAuthenticated` will enforce this, the test suite provides no regression guard — a future refactor (e.g., moving to a custom permission class or adding `AllowAny` fallback) could silently open these endpoints.
**Recommendation:** Parametrize a single test over all `IsAuthenticated` endpoint URLs, assert that an anonymous `APIClient()` gets 403 from each.

---

### F-03 — No test: non-superuser calling `POST /api/accounts/users/{id}:soft_delete/` is rejected (403)

**Severity:** high
**File:** `backend/apps/accounts/views.py:452-455`; `backend/apps/accounts/tests/test_audit_emission.py:148`
**Evidence:**
```python
# views.py:454-455
if not actor.is_superuser:
    return Response({"detail": "forbidden"}, status=status.HTTP_403_FORBIDDEN)
```
`test_soft_delete_by_super_admin_emits_event` only tests the success path (superuser deletes another user). There is no test asserting a regular authenticated user is rejected with 403, and no test asserting a user cannot soft-delete themselves.
**Why it matters:** The 403 branch exists in code but is untested. A regression that accidentally drops the `is_superuser` check would go undetected.
**Recommendation:** Add `test_soft_delete_by_regular_user_returns_403` and `test_soft_delete_self_returns_403`.

---

### F-04 — No test: `require_recent_password_reauth` decorator enforces window and rejects stale/absent stamp

**Severity:** high
**File:** `backend/apps/accounts/decorators.py:23-57`; no test file for this module exists
**Evidence:**
```python
# decorators.py:23-24
def require_recent_password_reauth(within_minutes: int | None = None):
    """DRF view decorator. 403s with {"detail": "password_reauth_required"}
    if the session has no recent reauth marker within within_minutes"""
```
The decorator has zero tests. It is used as a security gate for "sensitive verbs" (v1Users.md B.18), but nothing verifies: (a) a request with no stamp returns 403, (b) a request with a stamp older than the window returns 403, (c) a request with a fresh stamp passes through, (d) the configurable `within_minutes` override works.
**Why it matters:** This decorator is the sole enforcement layer for the B.18 re-prompt requirement. An untested decorator is an unverified security control.
**Recommendation:** Create `backend/apps/accounts/tests/test_decorators.py` with at least four parametrized cases covering the four scenarios above.

---

### F-05 — No test: `POST /api/accounts/auth/reauth/` endpoint — wrong password, correct password, session stamp set

**Severity:** high
**File:** `backend/apps/accounts/views.py:277-285`; no test covers this view
**Evidence:**
```python
# views.py:281-285
if not user.check_password(password):
    return Response({"detail": "invalid_password"}, status=status.HTTP_400_BAD_REQUEST)
request.session["last_password_reauth"] = timezone.now().isoformat()
return Response({"status": "ok"})
```
The `reauth_view` is registered in URLs and is the companion to `require_recent_password_reauth`. No test exists for: (a) wrong password returns 400, (b) correct password sets session stamp and returns 200, (c) unauthenticated call returns 403.
**Why it matters:** Without tests, the session stamp that gates B.18 sensitive verbs could silently stop being set without any failing test.
**Recommendation:** Add `test_reauth_wrong_password_returns_400`, `test_reauth_correct_password_sets_session_stamp`, `test_reauth_unauthenticated_returns_403`.

---

### F-06 — No test: email verification blocked transitions — expired token, already-used token, nonexistent token

**Severity:** high
**File:** `backend/apps/accounts/views.py:155-186` (`verify_email`); `backend/apps/accounts/tests/test_audit_emission.py:43` (only tests the success path)
**Evidence:**
```python
# views.py:165-169
if token is None or token.is_used or token.is_expired:
    return Response(
        {"detail": "invalid_or_expired_token"},
        status=status.HTTP_400_BAD_REQUEST,
    )
```
Three rejection branches exist in `verify_email` — token not found, token already used, token expired — but none are tested. The only test (`test_email_verification_emits_email_verified`) exercises the happy path only.
**Why it matters:** These are state-machine blocked transitions for the `User.is_active` state (`inactive → active` must be idempotent-safe and token-gated). A regression could allow replay of a used token, activating already-deleted accounts or leaking that verification succeeded.
**Recommendation:** Add three tests in a new `test_verify_email.py` or in `test_audit_emission.py`: expired token returns 400, used token returns 400, nonexistent token returns 400. Also add a test asserting double-verification of the same valid token (two concurrent calls) only activates the user once (using `select_for_update`).

---

### F-07 — No test: `confirm_totp` blocked transitions — wrong TOTP code, no pending enrollment, already-confirmed re-confirm

**Severity:** high
**File:** `backend/apps/accounts/services/twofa.py:119-157`; `backend/apps/accounts/tests/test_twofa_service.py`
**Evidence:**
```python
# twofa.py:126-136
device = (
    TwoFactorDevice.objects.select_for_update()
    .filter(user=user, confirmed_at__isnull=True)
    ...
)
if device is None:
    raise ValueError("No pending 2FA enrollment for this user.")
...
if not _verify_totp(secret, code):
    raise ValueError("Invalid TOTP code.")
```
`test_twofa_service.py` tests the happy path and some recovery-code paths, but never tests: (a) `confirm_totp` with an invalid TOTP code raises `ValueError`, (b) `confirm_totp` when no pending enrollment exists raises `ValueError`, (c) calling `twofa_confirm_view` (HTTP) with an invalid code returns 400.
**Why it matters:** These are blocked transitions in the 2FA enrollment state machine. The error-path code is exercised in production but never in tests.
**Recommendation:** Add `test_confirm_totp_invalid_code_raises`, `test_confirm_totp_no_pending_raises`, and a view-layer test `test_twofa_confirm_view_invalid_code_returns_400`.

---

### F-08 — No view-layer tests for any 2FA HTTP endpoints

**Severity:** medium
**File:** `backend/apps/accounts/views.py:337-396`; `backend/apps/accounts/tests/test_twofa_service.py`
**Evidence:**
The entire `test_twofa_service.py` calls service functions directly (e.g., `twofa_svc.enroll_totp(user)`). No test ever calls the DRF API views at `auth/2fa/enroll/`, `auth/2fa/confirm/`, `auth/2fa/disable/`, or `auth/2fa/recovery_codes:regenerate/`.
**Why it matters:** View-layer tests are needed to catch: wrong content-type, missing request fields, throttle headers, session cycling after confirm/disable (`cycle_session_on_role_change` is called in the view but not the service — it is only testable at the view layer), and correct HTTP status codes.
**Recommendation:** Add `test_twofa_views.py` with at least one success test and one negative test per 2FA endpoint, plus a test that `session.session_key` changes after `twofa_confirm_view` and `twofa_disable_view`.

---

### F-09 — No test: cross-org isolation — `PATCH /api/accounts/me/` with `last_active_org_id` pointing to an org the user does not belong to

**Severity:** high
**File:** `backend/apps/accounts/serializers.py:117` (`last_active_org_id` in writable fields); `backend/apps/accounts/views.py:423-441`
**Evidence:**
```python
# serializers.py:107-132
class Meta:
    model = User
    fields = (
        ...
        "last_active_org_id",   # writable — NOT in read_only_fields
        ...
    )
    read_only_fields = (
        "id", "email", "is_superuser", "has_2fa_enrolled",
        "twofa_enrolled_at", "email_verified_at", "memberships",
        "last_active_org_slug", "deleted_at",
    )
```
`last_active_org_id` is a plain `UUIDField` that is writable via `PATCH /me/`. The serializer performs no membership check. A user can write any arbitrary UUID, including one belonging to an org they are not a member of. When the SPA then reads `last_active_org_slug` via `get_last_active_org_slug`, it resolves the foreign org's slug — leaking the org slug.
**Why it matters:** This is an invariant #2 violation: cross-org data (org slug) can be read by any authenticated user who guesses or enumerates an org's UUID. There is no test for this path at all.
**Recommendation:** Add a serializer-level `validate_last_active_org_id` that checks `OrganizationMembership.objects.filter(user=instance, organization_id=value, is_active=True).exists()` and raises `ValidationError` if not. Then add `test_me_patch_last_active_org_id_foreign_org_rejected` asserting 400, and `test_me_patch_last_active_org_id_own_org_accepted` asserting 200.

---

### F-10 — No test: `GET /api/accounts/me/` memberships serializer does not leak other-org memberships

**Severity:** medium
**File:** `backend/apps/accounts/serializers.py:134-140`
**Evidence:**
```python
# serializers.py:134-140
def _active_memberships(self, user):
    from apps.organizations.models import OrganizationMembership
    return (
        OrganizationMembership.objects.filter(user=user, is_active=True)
        .select_related("organization")
    )
```
The filter correctly scopes to `user=user`. However, there is no test asserting that User A's `GET /me/` response does NOT include memberships belonging to User B, even in the presence of org data with overlapping orgs.
**Why it matters:** Invariant #2. While the filter looks correct, a missing isolation test means a future change (e.g., adding `OR` condition for org-level queries) could silently leak cross-user data.
**Recommendation:** Add `test_me_memberships_scoped_to_requesting_user`: create two users in the same org; user A's `/me/` must not include user B's memberships.

---

### F-11 — No test: `perform_signup` idempotency replay when `event_id` was used but the org was subsequently deleted

**Severity:** medium
**File:** `backend/apps/accounts/services/signup.py:168-205` (`_replay_from_idempotency`)
**Evidence:**
```python
# signup.py:183-188
user = User.objects.filter(pk=audit_row.target_id).first()
if user is None:
    # Audit exists but user was hard-deleted — refuse to replay
    return None
...
org = Organization.objects.filter(pk=org_id).first()  # can be None
```
If a replay is attempted and the org referenced in the audit payload no longer exists (e.g., was cleaned up), `_replay_from_idempotency` returns a `SignupResult` with `organization=None` and `created=False`. The calling code (`perform_signup`) does not re-run the signup but instead returns this partial result — silently leaving the user without an org. This error path is untested.
**Why it matters:** The invariant is that "re-submitting returns the existing record." If the org is missing the caller gets a structurally broken result with no error.
**Recommendation:** Add `test_signup_idempotency_replay_with_deleted_org` that deletes the org post-signup and re-replays the `event_id`, asserting the service either re-creates the chain or raises explicitly.

---

### F-12 — No test: `POST auth/password_reset_complete/` view layer — invalid token, expired token, reused token return 400

**Severity:** medium
**File:** `backend/apps/accounts/views.py:312-323`; `backend/apps/accounts/tests/test_password_reset.py`
**Evidence:**
```python
# views.py:315-323
try:
    password_reset_svc.complete_password_reset(...)
except ValueError as exc:
    return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
return Response({"status": "ok"})
```
`test_password_reset.py` tests the service layer directly for expired/used tokens, but no test calls the view (`POST auth/password_reset_complete/`) with an invalid or expired token to assert a 400 HTTP response. View-layer error translation could silently break.
**Why it matters:** The service raises `ValueError`; the view catches it and converts to 400. An accidental removal of the try/except would surface as a 500 in production with no failing test.
**Recommendation:** Add `test_password_reset_complete_view_expired_token_returns_400` and `test_password_reset_complete_view_invalid_token_returns_400` against the HTTP endpoint.

---

### F-13 — No test: `POST auth/login/` with a soft-deleted user returns 403 `account_inactive`

**Severity:** medium
**File:** `backend/apps/accounts/views.py:222-224`
**Evidence:**
```python
# views.py:222-224
if not user.is_active or user.deleted_at is not None:
    return Response({"detail": "account_inactive"}, status=status.HTTP_403_FORBIDDEN)
```
No test exercises the `deleted_at is not None` branch. While `is_active=False` would be set by `soft_delete()`, the explicit `deleted_at` check is a belt-and-suspenders guard and is independently untested.
**Why it matters:** Soft-deleted users have anonymized PII (`deleted-{id}@invalid` email), so the `authenticate()` call would fail first — but the code path is still worth testing explicitly for the case where a user is marked `deleted_at` but `is_active=True` (e.g., a manual DB edit scenario).
**Recommendation:** Add `test_login_soft_deleted_user_returns_403` using a `UserFactory` with `deleted_at=timezone.now()` but valid credentials.

---

### F-14 — No test: signup with missing required fields (email, password) returns 400 from serializer validation

**Severity:** low
**File:** `backend/apps/accounts/serializers.py:14-31`; `backend/apps/accounts/views.py:105-106`
**Evidence:**
```python
# serializers.py:14-31
class SignupSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, min_length=12)
    ...
# views.py:105-106
serializer = SignupSerializer(data=request.data)
serializer.is_valid(raise_exception=True)
```
No test submits a payload missing `email` or `password`, or uses a password shorter than 12 characters, to assert the 400 response. Serializer validation is implicitly trusted.
**Why it matters:** Low risk for Django's serializer framework, but zero coverage means any regression in `SignupSerializer` field definitions (e.g., accidentally removing `min_length`) goes undetected.
**Recommendation:** Add parametrized `test_signup_invalid_payload` cases: missing email, missing password, password too short, invalid email format.

---

### F-15 — No test: `PATCH /api/accounts/me/` unauthenticated returns 403, and `GET /me/` shape is never tested

**Severity:** medium
**File:** `backend/apps/accounts/views.py:418-441`; `backend/apps/accounts/tests/`
**Evidence:**
`test_audit_emission.py:130` tests `PATCH /me/` for audit emission but only after authenticating. No test: (a) verifies the JSON shape of `GET /me/` (fields: id, email, name, is_superuser, memberships, etc.), (b) verifies `PATCH /me/` with invalid field (e.g., `email`) is rejected (email is read-only), (c) verifies unauthenticated `PATCH /me/` returns 403.
**Why it matters:** The `/me/` response shape is what the SPA bootstraps from. Shape regressions (e.g., a field going missing) are invisible without a schema test.
**Recommendation:** Add `test_me_get_shape`, `test_me_patch_email_is_rejected`, and `test_me_unauthenticated_returns_403`.

---

## Gaps (Forward-Looking)

| # | Item | Missing | Needed For | Blocking | Effort |
|---|------|---------|-----------|---------|--------|
| G-01 | `last_active_org_id` membership validation | `validate_last_active_org_id` in `MeSerializer`; tests | Invariant #2 (cross-org isolation) | Yes — potential data leak now | S |
| G-02 | View-layer 2FA tests (`auth/2fa/*`) | HTTP-level tests; session-cycle assertions | Regression safety for 2FA views | No | M |
| G-03 | `require_recent_password_reauth` decorator tests | Dedicated `test_decorators.py` | B.18 security control verification | No | S |
| G-04 | `/api/accounts/auth/reauth/` endpoint tests | Three targeted tests | B.18 session stamp verification | No | S |
| G-05 | Email verification blocked-transition tests | `test_verify_email.py` with expired/used/nonexistent token cases | State-machine coverage | No | S |
| G-06 | Parametrized permission-denied sweep | Single parametrized test over all `IsAuthenticated` URLs | Regression safety for auth gating | No | S |
| G-07 | `/me/` response shape test | `test_me_get_shape` asserting all required fields present | SPA bootstrap regression | No | S |
| G-08 | `soft_delete` non-superuser 403 test | Two negative tests | Permission-denied coverage | No | XS |
| G-09 | Signup serializer validation tests | Parametrized bad-payload cases | Serializer regression | No | S |
| G-10 | Password reset complete view-layer error tests | Two HTTP-level tests (expired/invalid token) | View error-translation coverage | No | XS |
