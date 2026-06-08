# Backend · accounts (auth/identity) — deep read

**Repo path:** `backend/apps/accounts/`
**Spec authority:** `docs/superpowers/specs/v1Users.md` (supersedes PRD §3.x/§7.5/§8); architectural invariants in `CLAUDE.md`.
**Date of read:** 2026-06-08.

## Purpose

`accounts` is the foundational identity subsystem of the platform. It owns the custom `User` model (the `AUTH_USER_MODEL`, on which every other app's FK chain hangs), and the full authentication surface: Path B public self-signup, email verification, session login/logout, sensitive-verb re-auth, password reset, TOTP 2FA with single-use recovery codes, and super-admin soft-delete. It is "Phase 1A, production-grade and fully tested." Authentication is **session-cookie based (no JWT)**; the SPA is same-origin and CSRF-protected (invariant 15).

## File-by-file roles

- `models.py` — `uuid7()` PK generator; `UserManager` (email-based, username dropped); `User` (`AbstractUser` subclass); `TwoFactorDevice`, `RecoveryCode`, `PasswordResetToken`, `EmailVerificationToken`.
- `views.py` — all 14 endpoints as function-based DRF `@api_view`s with `drf-spectacular` `@extend_schema`. Houses two private helpers: `_hash_token` (sha256) and `_actor_role` (User → `ActorRole`).
- `urls.py` — `app_name="accounts"`; AIP-136 colon-syntax for verb actions (`users/<uuid>:soft_delete/`, `2fa/recovery_codes:regenerate/`); both snake_case and hyphen SPA aliases for verify-email and password-reset routes.
- `serializers.py` — thin input/output serializers; `MeSerializer` is the heavy one (aggregates org memberships + resolves `effective_modules` per org).
- `services/signup.py` — `perform_signup` (Path B atomic chain) + slug derivation helpers + idempotency replay.
- `services/twofa.py` — TOTP enroll/confirm/verify/disable, recovery-code generation/verification, and the **separate** 2FA brute-force lockout (cache-backed).
- `services/password_reset.py` — request + complete, cache rate-limits, all-session invalidation.
- `services/_crypto.py` — Fernet symmetric encryption of the TOTP secret, key derived from `SECRET_KEY`.
- `services/session_security.py` — `cycle_session_on_role_change` (session-fixation defense).
- `services/mailer.py` — branded multipart email (`send_branded_email`, `send_verification_email`).
- `throttling.py` — `SignupRateThrottle` (scope `signup`, 3/hr/IP).
- `decorators.py` — `require_recent_password_reauth` (B.18 sensitive-verb gate). **Currently unused by any view.**
- `tests/` — model, signup Path B, login flow, 2FA service, 2FA ratelimit, password reset, audit emission; `conftest.py` disables axes by default; `factories.py` factory_boy factories.
- `migrations/` — `0001_initial` (User), `0002_*` (verification fields + 4 token/2FA tables incl. partial unique index).

## Data model

- **`User`** (`db_table="accounts_user"`): `id` = UUIDv7 PK; `email` unique (canonical login identifier, lowercased on every `save()` and in `UserManager._create_user`); `name`; `deleted_at` (soft-delete, indexed); `has_2fa_enrolled` + `twofa_enrolled_at`; `email_verified_at`; `last_password_change_at`; `last_active_org_id` (raw UUIDField, **no FK** — for the SPA org switcher). `USERNAME_FIELD="email"`, `REQUIRED_FIELDS=[]`, `username=None`. `is_active` defaults False (flipped True on email verification). `soft_delete()` anonymizes PII (`email→deleted-<id>@invalid`, `name→"[Deleted]"`, `is_active=False`).
- **`TwoFactorDevice`** (`accounts_twofactor_device`): `user` FK, `secret_b32` (Fernet ciphertext, `fernet$`-prefixed), `confirmed_at`. Partial unique index `one_confirmed_totp_per_user` (`UniqueConstraint(fields=[user], condition=Q(confirmed_at__isnull=False))`) — one *confirmed* device per user, but unconfirmed enrollment rows may coexist.
- **`RecoveryCode`** (`accounts_recovery_code`): `user` FK, `code_hash` (argon2id), `used_at`. Index `(user, used_at)`. Single-use enforced at service layer.
- **`PasswordResetToken`** (`accounts_password_reset_token`): `user` FK, `token_hash` (sha256, indexed), `expires_at`, `used_at`, `requested_ip`. Properties `is_used`/`is_expired`.
- **`EmailVerificationToken`** (`accounts_email_verification_token`): same shape minus `requested_ip`.

All PKs are UUIDv7 via `apps.accounts.models.uuid7` (invariant 1). All four token/2FA tables `CASCADE` on user delete (note: this conflicts with soft-delete intent — hard delete would drop the audit-relevant rows; see smells).

## Core algorithms / services (file:function, step-by-step)

### `models.uuid7()`
Wraps `uuid_utils.uuid7()` and re-parses through stdlib `uuid.UUID` so Django's UUIDField stores a native type. Test `test_uuid7_is_time_ordered` asserts monotonic ordering + `.version == 7`. The codebase relies on time-ordering for "newest first" via `order_by("-id")` (e.g. `resend_verification`).

### `signup.perform_signup(*, email, password, name, org_name, event_id, request)`
1. Normalize email/name/org_name.
2. **Idempotency replay**: if `event_id` set, `_replay_from_idempotency` looks up the `user_signup` `AuditEvent` by `idempotency_key`, rebuilds `SignupResult(created=False)` from the audit `payload_after` (`organization_id`, `membership_id`). The audit table is the system of record for replay; the plaintext token is *not* retained.
3. **Duplicate-email guard** (B.11 enumeration-safe): if email already exists, return `SignupResult(created=False, duplicate_email=True)` with no Org/membership created.
4. `transaction.atomic()`: create `User` (`is_active=False`); derive a unique slug (`_derive_slug` → `_slugify_for_org` → `_pick_unique_slug`: tries `seed`, then `seed-2..seed-26`, then random 6-hex suffix, validated against `SLUG_REGEX`, `RESERVED_SLUGS`, existing `Organization.slug` and `SlugRedirect.old_slug`); create `Organization(status=PENDING_REVIEW, time_zone=DEFAULT_ORG_TIMEZONE, created_by=user)`; create `OrganizationMembership(role=ADMIN, is_org_owner=True, is_active=False)`; mint an `EmailVerificationToken` (`secrets.token_urlsafe(48)`, sha256-hashed, TTL `EMAIL_VERIFICATION_TTL_HOURS`=48); `emit_audit(event_type="user_signup", idempotency_key=event_id, payload_after={...,"path":"B"})`.
Returns `SignupResult` with plaintext token (only on fresh create). Test `test_perform_signup_atomic_rollback_on_failure` proves the whole chain unwinds.

### `views.signup`
Validates `SignupSerializer`, calls `perform_signup`. Response mapping: replay → **200** `{"status":"pending_verification"}`; fresh or duplicate → **201** (identical — duplicate is enumeration-safe and sends no email). Only the fresh path calls `mailer.send_verification_email`. Throttled by `SignupRateThrottle` (3/hr/IP).

### `views.verify_email` (`@transaction.atomic`)
`select_for_update` the `EmailVerificationToken` by `_hash_token(plaintext)`; reject if missing/used/expired (400 `invalid_or_expired_token`); set `user.is_active=True`, `email_verified_at=now`, mark token used; `emit_audit("email_verified")`.

### `views.resend_verification`
Enumeration-safe (always 202). For a still-pending, non-deleted user it invalidates all unused verification tokens (`update(used_at=now)`) then mints a fresh one and emails it — guaranteeing one live link at a time.

### `views.login_view`
1. `authenticate(request, username=email, password=password)` — routed through `AxesStandaloneBackend` + `ModelBackend` (axes lockout counts here).
2. If `None`: probe for an unverified-but-correct-password user → 403 `email_not_verified` (deliberate, gated by knowing the password, so not enumeration); else emit `user_login_failed` audit and 400 `invalid_credentials`.
3. If inactive/deleted → 403 `account_inactive`.
4. If `has_2fa_enrolled`: check `twofa_is_locked` (429 `twofa_locked`); if no `totp_code` → 200 `{"requires_2fa": True}`; verify via `verify_totp_or_recovery`; on failure record failure + audit, return 429 or 400; on success `twofa_reset_attempts`.
5. `login(request, user)` then `cycle_session_on_role_change` (B.11 fixation defense), then `emit_audit("user_login_success")`.

### `twofa.confirm_totp` / `verify_totp_or_recovery`
- `enroll_totp`: deletes prior *unconfirmed* device, creates new with `encrypt_secret(secret)`, returns `otpauth_uri` + best-effort QR data URI.
- `confirm_totp` (`@transaction.atomic`): `select_for_update` the latest unconfirmed device, `_verify_totp` (pyotp, `valid_window=1`), set `confirmed_at`, flip `has_2fa_enrolled`, `_generate_recovery_codes` (10× argon2id-hashed), audit `twofa_enrolled`.
- `verify_totp_or_recovery`: try TOTP against the confirmed device first; else `_verify_recovery` — argon2id-verify against unused codes O(10), then an **atomic conditional claim** (`update(...).filter(used_at__isnull=True)` returns 1 only for the first concurrent consumer); audit `recovery_code_consumed`.
- 2FA lockout (`twofa_is_locked`/`twofa_record_failure`/`twofa_reset_attempts`) is **cache-backed and deliberately separate from django-axes** (`TWOFA_MAX_ATTEMPTS=5`, `TWOFA_LOCK_SECONDS=900`) because `AXES_RESET_ON_SUCCESS=True` would let a correct password reset the attacker's second-factor counter (documented BLOCKER in `test_twofa_ratelimit.py`).

### `password_reset.request_password_reset` / `complete_password_reset`
- Request: rate-limit per-email then per-IP (`_rate_limit_hit` over `django.core.cache`); silent no-op for unknown/inactive/deleted; mint sha256-hashed `PasswordResetToken` (TTL `PASSWORD_RESET_TTL_MINUTES`=60); email a `FRONTEND_BASE_URL/password-reset/complete?token=` link via **plain `send_mail`** (not the branded mailer); audit even on success path.
- Complete (`@transaction.atomic`): `select_for_update` token by hash; reject missing/used/expired (`ValueError` → view 400); `set_password`, set `last_password_change_at`, mark used; `_invalidate_all_sessions_for_user` (iterates the entire `Session` table, decodes each, deletes those matching `_auth_user_id`); audit `password_reset_completed`.

### `_crypto.encrypt_secret`/`decrypt_secret`
Fernet key = `urlsafe_b64encode(sha256(SECRET_KEY))`. Ciphertext prefixed `fernet$`. Graceful fallback to plaintext if `cryptography` import fails (B.21 hardening debt). `decrypt_secret` is prefix-aware so plaintext-stored legacy secrets still decode.

## API / endpoint surface (all under `/api/accounts/`)
- `POST auth/signup/` — Path B signup (AllowAny, throttled).
- `POST auth/verify_email/` (+ `verify-email/` alias).
- `POST auth/resend-verification/` (throttled).
- `POST auth/login/`, `POST auth/logout/`, `POST auth/reauth/`.
- `POST auth/password_reset_request/` (+ hyphen alias), `POST auth/password_reset_complete/` (+ hyphen alias).
- `POST auth/2fa/enroll/`, `confirm/`, `disable/`, `recovery_codes:regenerate/`.
- `GET|PATCH me/`.
- `POST users/<uuid:user_id>:soft_delete/` — super-admin only (in-view `is_superuser` check, 403 otherwise).

`MeSerializer` read shape returns `is_superuser`, aggregated `memberships[]` (one per org with `roles[]`, `is_org_owner`, `effective_modules`), and `last_active_org_slug` — letting the SPA route to a dashboard in one round-trip. PATCH only allows `name` and `last_active_org_id` (everything else `read_only`).

## Invariants that MUST be preserved
1. **UUIDv7 PKs** (`uuid7`) everywhere; time-ordering is relied upon (`order_by("-id")`).
2. **Email is canonical + lowercased** on every save; uniqueness is the identity guarantee.
3. **`is_active` lifecycle**: False at signup, True only after email verification.
4. **Tokens hashed at rest**: verification/reset = sha256; recovery codes = argon2id; TOTP secret = Fernet. **Plaintext recovery codes never hit the DB** (B.14, asserted by `test_recovery_codes_are_argon2id_hashed_never_plaintext`).
5. **Single-use** for all four token types (`used_at`), with the recovery-code claim being atomic/race-safe.
6. **Session cycling on every auth-state change** (login, 2FA confirm/disable, invite accept) — fixation defense (B.11).
7. **Password reset invalidates ALL sessions** for the user.
8. **Enumeration safety**: signup duplicate (identical 201), resend (always 202), password reset request (always 200/silent).
9. **Two distinct lockouts**: axes (password, 10 fails / 15 min) and 2FA (5 fails / 15 min) must remain independent.
10. **Idempotent signup** keyed on the `user_signup` audit row.
11. **Every state-changing verb emits an `AuditEvent`** via `emit_audit` (B.4) — the audit suite enforces exact event types.
12. **Path B owns Org+membership creation**; Path A (invite accept) lives in `apps.organizations` and must not be routed here.
13. **Argon2 is the default password hasher** (`PASSWORD_HASHERS[0] = Argon2PasswordHasher`); min length 12.

## Dependencies / coupling

**Outgoing (accounts → others):**
- `apps.audit.services.emit_audit` + `apps.audit.models.ActorRole` — every verb.
- `apps.organizations.models` (`Organization`, `OrganizationMembership`, `MembershipRole`, `OrgStatus`, `SlugRedirect`) and `constants` (`RESERVED_SLUGS`, `SLUG_REGEX`) — only in `signup.py` and `MeSerializer` (lazy import).
- `apps.permissions.services.resolver.effective_modules` — `MeSerializer` (lazy import).
- Third-party: `uuid_utils`, `pyotp`, `qrcode` (optional), `argon2-cffi`, `cryptography`, `django-axes`, `rules` (in `AUTHENTICATION_BACKENDS`), `drf-spectacular`.

**Incoming (others → accounts):** ~20 apps FK to `accounts.User` / call its services. Notable non-FK couplings:
- `apps.audit.services` and `apps.audit.models` import `apps.accounts.models.User` directly → **near-circular** (`accounts.services` import `apps.audit.services`; audit imports `accounts.models`). Currently safe only because accounts imports audit at the *service* layer and audit imports accounts at the *model* layer.
- `apps.organizations.services.invitation` imports `cycle_session_on_role_change` (Path A reuses the fixation defense).
- `apps.sadmin.services.superadmin_verbs` imports `password_reset.request_password_reset` and `accounts.models.User`; `apps.sadmin.views.users` imports `User`.

## Tech debt / smells / duplication
- **`_hash_token` duplicated three times** (`views.py`, `signup.py`, `password_reset.py`) — should be one shared helper (e.g. a `services/tokens.py`).
- **Mailer inconsistency**: signup/resend use the branded `mailer.send_verification_email`; password reset still uses raw `django.core.mail.send_mail` with an inline plaintext body — no branded HTML, and the URL path (`/password-reset/complete`) differs from the route alias style. There is no `reset_password` email template.
- **`require_recent_password_reauth` is dead code** — defined in `decorators.py`, never applied to any view. `reauth_view` sets `session["last_password_reauth"]` but nothing reads it. The B.18 sensitive-verb gate (force-disable 2FA, soft-delete, ownership transfer) is therefore **not enforced** anywhere in accounts despite being scaffolded. `twofa_disable_view` and `user_soft_delete_view` are sensitive verbs that bypass it.
- **`confirm_totp` does not clear prior recovery codes** before generating new ones (unlike `regenerate_recovery_codes`, which deletes first). A re-enroll after a disable that didn't clean up, or any path that reaches confirm twice, could accumulate stale codes. Disable does delete them, so the common path is fine, but the asymmetry is a latent bug.
- **`_invalidate_all_sessions_for_user` is O(n) over the whole session table** with per-row decode — explicitly acknowledged as acceptable only "<10k sessions on a single VPS." Won't scale; no index on the user inside session payload.
- **CASCADE delete of tokens/2FA on user delete** contradicts the soft-delete model — a true hard delete would silently drop 2FA/reset history. Soft-delete is the intended path, but nothing enforces "never hard-delete a User."
- **`last_active_org_id` is a bare UUIDField, not an FK** — no referential integrity; `MeSerializer.get_last_active_org_slug` does a defensive lookup that can return `None` for a stale id.
- **`get_client_ip_address` imported but unused** in `views.py` (kept "for future extension"); the views compute IP via the audit service instead.
- **Login enumeration nuance**: the `email_not_verified` 403 reveals verification state, but only to a caller who already supplied the correct password — an intentional, documented tradeoff worth re-confirming during restructuring.
- **Function-based views with repeated boilerplate** (serializer validate → service → audit → Response) across 14 endpoints; ripe for a thin base or service-result-to-response mapper.

## Restructuring seams & risks
- **Clean service layer already exists** (`services/*`): signup, twofa, password_reset, session_security, mailer, _crypto are import-light and testable in isolation — the natural seam. Views are thin adapters and could be regenerated against any HTTP framework.
- **Token handling is the strongest extraction candidate**: a unified `Token` abstraction (mint/hash/verify/consume/expire) would collapse `EmailVerificationToken`, `PasswordResetToken`, `RecoveryCode` and remove the triplicated `_hash_token`.
- **Audit coupling is the highest-risk dependency**: every verb calls `emit_audit`; the audit suite asserts *exact* `event_type` strings (`user_signup`, `email_verified`, `user_login_success/failed`, `user_logout`, `password_reset_requested/completed`, `twofa_enrolled/disabled`, `recovery_code_consumed`, `recovery_codes_regenerated`, `user_self_update`, `user_soft_deleted`). Renaming any breaks tests and audit-history continuity. The near-circular accounts↔audit import is a refactor hazard.
- **Org provisioning is embedded in signup** — a restructuring that splits "create user" from "create tenant" must preserve atomicity and the idempotency-via-audit-row contract.
- **B.18 reauth gate is unfinished** — restructuring should decide to either wire `require_recent_password_reauth` onto `twofa_disable_view`/`user_soft_delete_view`/org-ownership verbs, or formally drop it.
- **Cache dependency**: 2FA lockout and password-reset rate-limits live entirely in `django.core.cache`; a cache flush silently resets all counters. Persistent storage may be required for prod guarantees.
- **`MeSerializer` reaches into `organizations` and `permissions`** (lazy imports + per-org `effective_modules` calls) — an N+1-ish bootstrap path that couples identity to RBAC; extract to a dedicated bootstrap service.
- **Settings knobs** (`EMAIL_VERIFICATION_TTL_HOURS`, `PASSWORD_RESET_TTL_MINUTES`, `PASSWORD_RESET_RATE_PER_*`, `SENSITIVE_REAUTH_WINDOW_MINUTES`, `TWOFA_ISSUER_NAME`, `FRONTEND_BASE_URL`, `signup` throttle rate) are all read via `getattr`/`settings.*`; keep them as the configuration seam.

**Ambiguities flagged:** whether B.18 reauth is intended for v1 (scaffolded but inert); whether `confirm_totp`'s non-clearing of recovery codes is intentional; whether the password-reset email is expected to be branded like verification (template absent).
