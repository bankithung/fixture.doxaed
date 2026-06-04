# Accounts App — Structural Map

**Area:** `backend/apps/accounts`
**Mapped:** 2026-06-04
**Status:** Phase 1A — fully implemented and running.

---

## Purpose

Provides the foundational user identity layer for the Fixture Platform. Covers:

- Custom `User` model (UUID v7 PK, email-as-login, soft-delete, 2FA flags, email-verification fields).
- Path B self-signup flow (User + Organization + OrganizationMembership + EmailVerificationToken, one atomic transaction).
- Email verification via single-use hashed token.
- Login / logout / session-fixation defense / reauth gate.
- Password reset (hashed token, TTL, per-email + per-IP rate limiting, session invalidation on complete).
- TOTP 2FA enrollment, confirmation, recovery codes (argon2id-hashed), disable, regeneration.
- `/me` self-service GET/PATCH endpoint.
- Super-admin soft-delete (`POST users/{uuid}:soft_delete/`).
- Audit emission on every state-changing verb.

---

## Key Files

| File | Role |
|---|---|
| `models.py` | `User`, `TwoFactorDevice`, `RecoveryCode`, `PasswordResetToken`, `EmailVerificationToken` |
| `views.py` | 13 DRF function-based views, all `@api_view` + `@extend_schema` |
| `serializers.py` | 12 lean `Serializer` / `ModelSerializer` classes |
| `urls.py` | 17 URL patterns (with underscore + hyphen aliases for some) |
| `throttling.py` | `SignupRateThrottle` (per-IP, scope `signup`, default 3/hr) |
| `decorators.py` | `require_recent_password_reauth` — session-age guard for sensitive verbs |
| `services/signup.py` | `perform_signup` — full Path B atomic chain |
| `services/twofa.py` | TOTP enroll/confirm/verify/disable/recovery |
| `services/password_reset.py` | `request_password_reset` + `complete_password_reset` |
| `services/session_security.py` | `cycle_session_on_role_change` wrapper |
| `services/_crypto.py` | Fernet encryption for TOTP shared secret at rest |
| `migrations/0001_initial.py` | Creates `accounts_user` (UUID v7, email unique, no username) |
| `migrations/0002_…py` | Adds `email_verified_at`, `last_password_change_at`, `EmailVerificationToken`, `PasswordResetToken`, `RecoveryCode`, `TwoFactorDevice` |
| `tests/` | 7 test modules (≈70 test functions) covering model, login, signup, password-reset, 2FA service, audit emission |

---

## Models

### `User` (`accounts_user`)
- PK: `UUIDField` (default `uuid7`) — invariant 1 satisfied.
- `username = None` — email is `USERNAME_FIELD`.
- `email`: `EmailField(unique=True)` — lowercased on every `save()`.
- `name`: `CharField(max_length=200)`.
- `deleted_at`: soft-delete timestamp (null = live).
- `has_2fa_enrolled`, `twofa_enrolled_at`: enrollment trail.
- `email_verified_at`, `last_password_change_at`: verification + rotation tracking.
- `last_active_org_id`: `UUIDField(null=True)` — SPA org-switcher hint. **NOT a FK — no DB referential integrity.**
- `is_active = True` in migration default; service layer creates with `is_active=False` and flips on email verification.
- `soft_delete()`: anonymizes PII (email → `deleted-{id}@invalid`, name → `[Deleted]`), sets `is_active=False`.
- `UserManager.create_superuser`: sets `is_active=True` (bypasses email-verification gate for admin bootstrapping — correct).

### `TwoFactorDevice` (`accounts_twofactor_device`)
- PK: UUID v7. FK → `User`.
- `secret_b32`: `CharField(max_length=512)` — stores `fernet$<token>` ciphertext when `cryptography` installed.
- `confirmed_at`: null = pending enrollment; non-null = active.
- Unique constraint: `UniqueConstraint(fields=["user"], condition=Q(confirmed_at__isnull=False))` — one confirmed device per user enforced at DB level.

### `RecoveryCode` (`accounts_recovery_code`)
- PK: UUID v7. FK → `User`.
- `code_hash`: argon2id hash of the 10-char recovery code.
- `used_at`: single-use enforced by service layer (not DB constraint).
- Index: `(user, used_at)`.

### `PasswordResetToken` (`accounts_password_reset_token`)
- PK: UUID v7. FK → `User`.
- `token_hash`: sha256 hex of the plaintext token (length 64 → field max_length 128 — adequate).
- `expires_at`, `used_at`: TTL + single-use.
- `requested_ip`: stored for forensics.
- Index: `(user, -created_at)`.

### `EmailVerificationToken` (`accounts_email_verification_token`)
- PK: UUID v7. FK → `User`.
- `token_hash`, `expires_at`, `used_at`: same pattern as `PasswordResetToken`.
- No additional index beyond the `db_index=True` on `token_hash`.

---

## Endpoints / Routes

All mounted at `/api/accounts/`.

| Method | Path | View | Auth | Throttle |
|---|---|---|---|---|
| POST | `auth/signup/` | `signup` | AllowAny | `SignupRateThrottle` (3/hr/IP) |
| POST | `auth/verify_email/` | `verify_email` | AllowAny | — |
| POST | `auth/verify-email/` | `verify_email` (alias, unnamed) | AllowAny | — |
| POST | `auth/login/` | `login_view` | AllowAny | `axes` middleware (10 failures → lockout) |
| POST | `auth/logout/` | `logout_view` | IsAuthenticated | — |
| POST | `auth/reauth/` | `reauth_view` | IsAuthenticated | — |
| POST | `auth/password_reset_request/` | `password_reset_request_view` | AllowAny | cache-backed per-email + per-IP |
| POST | `auth/password-reset-request/` | same (alias, unnamed) | AllowAny | — |
| POST | `auth/password_reset_complete/` | `password_reset_complete_view` | AllowAny | — |
| POST | `auth/password-reset-complete/` | same (alias, unnamed) | AllowAny | — |
| POST | `auth/2fa/enroll/` | `twofa_enroll_view` | IsAuthenticated | — |
| POST | `auth/2fa/confirm/` | `twofa_confirm_view` | IsAuthenticated | — |
| POST | `auth/2fa/disable/` | `twofa_disable_view` | IsAuthenticated | — |
| POST | `auth/2fa/recovery_codes:regenerate/` | `twofa_recovery_regenerate_view` | IsAuthenticated | — |
| GET/PATCH | `me/` | `me_view` | IsAuthenticated | — |
| POST | `users/<uuid:user_id>:soft_delete/` | `user_soft_delete_view` | IsAuthenticated (superuser check inside) | — |

---

## Findings

### F-01 — HIGH — `/api/accounts/me/` returns HTTP 403 instead of 401 for unauthenticated requests

**File:** `backend/fixture/settings/base.py:153-157`
```python
"DEFAULT_PERMISSION_CLASSES": [
    "rest_framework.permissions.IsAuthenticated",
],
```
DRF's `SessionAuthentication` does not set `WWW-Authenticate` and raises `PermissionDenied` (403) rather than `NotAuthenticated` (401) for unauthenticated requests. The `me/` view uses `@permission_classes([IsAuthenticated])`, and when the session cookie is absent the SPA receives a 403. The login page interprets this as an error banner rather than "not logged in yet." Known issue per task brief.

**Recommendation:** Add a custom `IsAuthenticatedOrUnauthorized` permission class (or override `get_authenticate_header`) that returns 401 with `WWW-Authenticate: Session` for unauthenticated hits, or set `"UNAUTHENTICATED_USER": None` and handle it at the view layer. Alternatively configure `"DEFAULT_AUTHENTICATION_CLASSES"` to include `BasicAuthentication` only on that endpoint to force 401.

---

### F-02 — HIGH — Duplicate URL patterns for password reset and email verification create drf-spectacular operationId collisions

**File:** `backend/apps/accounts/urls.py:17,26-27,31-32`
```python
path("auth/verify-email/", views.verify_email),  # SPA hyphen alias
path("auth/password-reset-request/", views.password_reset_request_view),
path("auth/password-reset-complete/", views.password_reset_complete_view),
```
The named patterns (`verify_email`, `password_reset_request`, `password_reset_complete`) each have an unnamed alias with a hyphenated URL pointing to the same view. drf-spectacular generates duplicate `operationId` values (e.g. `accounts_auth_verify_email_create` appears twice) which causes schema generation warnings and is invalid per the OpenAPI 3.x spec (operationId must be unique).

**Recommendation:** Either (a) remove the aliases and redirect at nginx level, or (b) annotate the alias routes with `@extend_schema(exclude=True)` or use `operation_id` override. Option (a) is simpler and avoids maintaining two paths.

---

### F-03 — MEDIUM — `SignupRateThrottle` uses `LocMemCache` in dev/test, so per-IP state is in-process only and is not shared across workers or tests

**File:** `backend/fixture/settings/base.py:192-197`
```python
"BACKEND": "django.core.cache.backends.locmem.LocMemCache",
```
`SignupRateThrottle` and the password-reset cache-rate-limit both rely on `django.core.cache.cache`. In dev (and CI) this is `LocMemCache`. This means:
- Throttle state is lost on process restart / test teardown.
- In production (multi-worker Gunicorn/Daphne), workers do not share throttle state unless Redis cache is configured.

**Recommendation:** Enforce Redis cache in production settings and document the requirement. Add an explicit `CACHES` production config block. The migration of `CHANNEL_LAYERS` to Redis (known issue d) should accompany the cache migration.

---

### F-04 — MEDIUM — `last_active_org_id` is a bare `UUIDField` with no FK constraint

**File:** `backend/apps/accounts/models.py:86`
```python
last_active_org_id = models.UUIDField(null=True, blank=True)
```
There is no `ForeignKey` to `Organization`. If an org is deleted (hard or soft) the field silently becomes a dangling pointer. `get_last_active_org_slug` in `MeSerializer` handles the missing-org case gracefully (`org.slug if org else None`), so it doesn't crash — but the stale value is never cleared.

**Recommendation:** Either convert to `ForeignKey(Organization, null=True, on_delete=SET_NULL)` or add a post-delete signal on `Organization` that NULLs the field for all affected users. A FK is cleaner and the migration cost is low at this stage.

---

### F-05 — MEDIUM — `verify_email` view uses `@transaction.atomic` at the function level but the session-cycle after email verification is absent

**File:** `backend/apps/accounts/views.py:154-186`

`verify_email` correctly atomically flips `is_active=True` and marks the token used. However, after email verification the user's session is NOT cycled. If an attacker had pre-seeded a session cookie (session fixation), the now-verified account can be accessed with the old cookie. The login path and 2FA paths both call `cycle_session_on_role_change`; `verify_email` does not.

**Recommendation:** Add `cycle_session_on_role_change(request)` after the successful verification block (line 185), consistent with the existing pattern in `login_view` and `twofa_confirm_view`.

---

### F-06 — MEDIUM — `_invalidate_all_sessions_for_user` is O(n) scan over entire session table

**File:** `backend/apps/accounts/services/password_reset.py:176-192`
```python
for session in Session.objects.iterator(chunk_size=500):
    data = session.get_decoded()
    if str(data.get("_auth_user_id", "")) == target_id:
        session.delete()
```
The comment acknowledges this. At v1 scale (<10k sessions on a single VPS) it is acceptable. However, `session.delete()` inside a loop does N individual DELETEs. If a user has multiple sessions (e.g. multiple devices), each is deleted individually within the outer `@transaction.atomic` block, which holds the write lock until all N DELETEs complete.

**Recommendation:** Accept for v1 as noted, but refactor when adding Redis session backend. Add a TODO comment. For a quick win, batch-delete: collect all matching session keys and call `Session.objects.filter(session_key__in=keys).delete()`.

---

### F-07 — MEDIUM — `ATOMIC_REQUESTS = True` in settings conflicts with `@transaction.atomic` decorators on views

**File:** `backend/fixture/settings/base.py:102`
```python
DATABASES["default"]["ATOMIC_REQUESTS"] = True
```
With `ATOMIC_REQUESTS=True`, every HTTP request is already wrapped in a transaction. The `@transaction.atomic` on `verify_email` (view) and on service functions like `confirm_totp`, `complete_password_reset`, `disable_2fa`, `regenerate_recovery_codes` creates savepoints (nested transactions). This is functionally correct in Postgres but adds overhead. More importantly, `transaction.on_commit` hooks inside nested `transaction.atomic` blocks fire only when the outermost transaction commits — the service-layer comments reference `on_commit` for Redis pub/sub (Phase 1B), and developers writing Phase 1B services inside service calls that are already inside `ATOMIC_REQUESTS` must be careful that their `on_commit` handlers fire at request-end, not at the inner block boundary.

**Recommendation:** Document the `ATOMIC_REQUESTS` + `on_commit` interaction in the CLAUDE.md invariants section for Phase 1B developers. Optionally remove redundant `@transaction.atomic` decorators from views that do not add meaningful rollback scope beyond what `ATOMIC_REQUESTS` provides (but keep them in service layer for correctness when called outside HTTP context, e.g. from management commands).

---

### F-08 — MEDIUM — `user_soft_delete_view` checks `actor.is_superuser` in application code rather than via DRF permission class

**File:** `backend/apps/accounts/views.py:452-455`
```python
if not actor.is_superuser:
    return Response({"detail": "forbidden"}, status=status.HTTP_403_FORBIDDEN)
```
This is a manual inline guard. It works, but it bypasses DRF's permission framework (no `IsSuperUser` permission class), which means drf-spectacular cannot document the required permission, and the pattern is inconsistent with how other super-admin endpoints are protected (e.g., sadmin views use `SadminRequiredMixin`). If `is_superuser` logic changes (e.g., to allow a `SA_DELEGATE` role), all inline guards must be found and updated.

**Recommendation:** Extract a `IsSuperUser` DRF permission class into `apps.accounts.permissions` (or `apps.permissions`) and apply it via `@permission_classes([IsSuperUser])`. Remove the inline check.

---

### F-09 — LOW — `MeSerializer.get_memberships` silently swallows `effective_modules` resolver errors

**File:** `backend/apps/accounts/serializers.py:169-173`
```python
try:
    modules = list(effective_modules(user, org))
except Exception:
    modules = []
```
Any resolver exception returns an empty modules list without logging. A broken permission resolver would silently strip all module access from the SPA bootstrap payload, causing every module-guarded surface to disappear from the UI without any error signal.

**Recommendation:** At minimum, log the exception via `logger.exception(...)`. Consider returning a sentinel field `"modules_error": True` so the SPA can show a degraded-mode banner instead of appearing broken.

---

### F-10 — LOW — `_actor_role` in `views.py` returns `ActorRole.ADMIN` for all non-superuser authenticated users

**File:** `backend/apps/accounts/views.py:69-74`
```python
def _actor_role(user: User | None) -> ActorRole:
    if user is None or not user.is_authenticated:
        return ActorRole.SYSTEM
    if user.is_superuser:
        return ActorRole.SUPER_ADMIN
    return ActorRole.ADMIN
```
Same shortcut exists in `twofa.py:_actor_role_for`. A `VIEWER` or `SCORER` role user authenticating has their audit events tagged `ADMIN`. This inflates audit telemetry fidelity. Acceptable for Phase 1A (noted in `twofa.py:283`), but should be resolved in Phase 1B when the org-membership-aware resolver is in place.

**Recommendation:** Wire `apps.permissions.services.resolver` into the `_actor_role` helper for Phase 1B. Add a TODO comment in `views.py:74`.

---

### F-11 — LOW — `get_client_ip_address` imported but unused; kept via `_ = get_client_ip_address` hack

**File:** `backend/apps/accounts/views.py:26,479`
```python
from axes.helpers import get_client_ip_address
...
_ = get_client_ip_address
```
The comment says "kept available for future extension wiring axes." This is a code-smell: keeping a dead import alive via a dummy assignment just to suppress the linter is fragile. If `axes` is upgraded and `get_client_ip_address` is renamed/removed, this silently breaks.

**Recommendation:** Remove the import. Use `axes.helpers.get_client_ip_address` directly at the call site when needed, or wrap it in a helper in `services/session_security.py`.

---

### F-12 — LOW — Email body uses a relative path for the verification link

**File:** `backend/apps/accounts/views.py:136-141`
```python
f"/auth/verify?token={plaintext}"
```
And similarly in `password_reset.py:99`:
```python
reset_link = f"/auth/reset?token={plaintext}"
```
These are relative paths. The email client will not resolve `/auth/verify` unless the user's email client knows the base URL. In production the link will be broken unless there is a base-URL wrapper in the email template or the path is prefixed with the full domain.

**Recommendation:** Add a `FRONTEND_BASE_URL` setting (e.g., `https://fixture.doxaed.com`) and prefix both link constructions. This should be a settings variable, not hardcoded.

---

### F-13 — LOW — `SignupRateThrottle.get_cache_key` is marked `# pragma: no cover - thin` but has a real code path that can return `None`

**File:** `backend/apps/accounts/throttling.py:32-36`
```python
def get_cache_key(self, request, view) -> str | None:  # pragma: no cover - thin
    ident = self.get_ident(request)
    if ident is None:
        return None
```
If `ident` is `None` (e.g., a request behind a misconfigured proxy), the throttle returns `None` and DRF skips throttling entirely, allowing unlimited signup attempts from that request. The `# pragma: no cover` annotation means this path is never exercised in tests.

**Recommendation:** Add a test asserting that a request with no IP identity is either rejected or throttled under a fallback key. Remove the `no cover` pragma once tested.

---

### F-14 — LOW — `is_active` field default in migration (0001) is `True`, but the model doc says `is_active=False` until email verification

**File:** `backend/apps/accounts/migrations/0001_initial.py:56-62`
```python
"is_active",
models.BooleanField(
    default=True,
    ...
),
```
The migration preserves Django's `AbstractUser.is_active` default of `True`. The service layer correctly passes `is_active=False` when creating users via `perform_signup`. However, a developer who calls `User.objects.create(email=..., password=...)` directly (without the service) will get `is_active=True` by default — an unverified account that can log in immediately.

**Recommendation:** Override the default to `False` in `models.py` and generate a data migration (or squash 0001) so the model default matches the expected invariant. Current `create_superuser` explicitly passes `is_active=True` so that path is safe.

---

### F-15 — INFO — `require_recent_password_reauth` decorator is defined but not applied to any existing view

**File:** `backend/apps/accounts/decorators.py:23`
```python
def require_recent_password_reauth(within_minutes: int | None = None):
```
The decorator is correctly implemented and tested indirectly via the `reauth_view`, but no current view in `views.py` uses it. The spec (v1Users.md B.18) requires it on sensitive verbs: suspend, impersonate, transfer ownership, force-disable 2FA, delete Org. `user_soft_delete_view` and `twofa_disable_view` do not apply it.

**Recommendation:** Apply `@require_recent_password_reauth()` to `user_soft_delete_view` and `twofa_disable_view` as a minimum. Phase 1B must apply it to org-transfer and org-delete verbs.

---

### F-16 — INFO — `apps.py` retains `default_auto_field = BigAutoField` even though all models use UUID v7 PKs

**File:** `backend/apps/accounts/apps.py:3`
```python
default_auto_field = "django.db.models.BigAutoField"
```
This is harmless (all models explicitly declare their PK), but it's misleading and could silently apply `BigAutoField` to any model that forgets to declare a PK — a regression vector.

**Recommendation:** Set `default_auto_field = "django.db.models.UUIDField"` in `apps.py` (and project-wide `DEFAULT_AUTO_FIELD` in settings) so any accidentally missing PK declaration is caught early and defaults to the right type.

---

### F-17 — INFO — `first_name` and `last_name` fields are present in the migration but not used

**File:** `backend/apps/accounts/migrations/0001_initial.py:38-46`
The migration inherits `first_name` and `last_name` from `AbstractUser`. The model uses a single `name` field and the serializers expose only `name`. These two fields add dead columns in `accounts_user`.

**Recommendation:** Add a migration to remove `first_name` and `last_name` from `accounts_user`. The fields can be removed with `migrations.RemoveField` — no data loss since they are not written.

---

### F-18 — INFO — No per-email throttle on signup (only per-IP)

**File:** `backend/apps/accounts/throttling.py` and `backend/apps/accounts/views.py:89`

v1Users.md B.11 specifies "3/hr/IP, 1/day/email" for Path B signup. The `SignupRateThrottle` implements the per-IP limit. The per-email (`1/day/email`) limit is NOT implemented. The duplicate-email guard (enumeration-safe no-op) provides some protection, but a burst of fresh-email registrations from one IP that slips through the 3/hr bucket is not email-rate-limited.

**Recommendation:** Add an `email`-keyed cache counter check in `perform_signup` (or as a second throttle class on the view) that enforces the 1/day/email limit specified by B.11.

---

## Gaps

| Gap | Severity | Notes |
|---|---|---|
| No per-email signup rate limit (B.11 1/day/email) | medium | Spec says 1/day/email; only per-IP is implemented |
| Session not cycled after email verification | medium | F-05; login and 2FA confirm both cycle |
| Email verification and password-reset links are relative paths | low | F-12; will be broken in real email clients |
| `require_recent_password_reauth` not applied to soft-delete or 2FA-disable | low | F-15; B.18 explicitly requires it |
| `last_active_org_id` has no FK constraint | medium | F-04; dangling pointer risk |
| `first_name` / `last_name` dead columns | info | F-17; minor cleanup |
| `is_active` model default is `True` (AbstractUser inheritance) | low | F-14; service layer is correct but bare `User.objects.create` is unsafe |
| No `IsSuperUser` DRF permission class; inline check in view | medium | F-08; inconsistent pattern |
| `effective_modules` errors swallowed silently in `MeSerializer` | low | F-09; needs logging at minimum |
| `get_client_ip_address` import is dead code | info | F-11 |
| Duplicate URL aliases create drf-spectacular operationId collisions | high | F-02; invalid OpenAPI |
| `/me/` returns 403 not 401 when unauthenticated | high | F-01; confirmed known issue |
| LocMemCache used for throttle/rate-limit state; not shared across workers | medium | F-03; must move to Redis in prod |
