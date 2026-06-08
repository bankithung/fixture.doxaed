# Flow: Auth Lifecycle (signup → verify → login → 2FA → session → logout → reset)

End-to-end trace across the Django backend (`apps.accounts`, `apps.organizations`, `apps.audit`) and the React/Vite SPA (`features/auth`, `features/layout`, `api/`). Citations are `file::symbol`.

## Subsystems crossed

- **accounts** — `views.py`, `serializers.py`, `models.py`, `throttling.py`, services `signup.py` / `twofa.py` / `password_reset.py` / `session_security.py` / `mailer.py`.
- **organizations** — `services/invitation.py`, `views.py::InvitationAcceptView` (Path A).
- **audit** — `services.py::emit_audit` (the single write path for `AuditEvent`).
- **Django auth/session/CSRF/axes** — `django.contrib.auth.login/logout/authenticate`, session middleware, `django-axes` lockout.
- **Frontend** — `features/auth/authStore.ts`, `api/auth.ts`, `api/client.ts`, `api/queryClient.ts`, `lib/csrf.ts`, `features/layout/ProtectedRoute.tsx`, `features/auth/LoginPage.tsx`, `App.tsx::AuthBusBridge`.

## Ordered walkthrough

### Signup — Path B (org self-signup)

1. SPA `POST /api/accounts/auth/signup/` → `accounts.views::signup` (`AllowAny`, throttled by `accounts.throttling::SignupRateThrottle`, scope `signup` = `3/hour` per IP from `settings.base::REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']`).
2. `SignupSerializer` validates (`password min_length=12`, optional `org_name`, optional `event_id`).
3. `accounts.services.signup::perform_signup` runs **one `transaction.atomic()`** creating five rows: `User(is_active=False)` via `UserManager.create_user`, `Organization(status=PENDING_REVIEW)` with slug from `_derive_slug`/`_pick_unique_slug` (checks `Organization.slug` + `SlugRedirect.old_slug` + `RESERVED_SLUGS`), `OrganizationMembership(role=ADMIN, is_org_owner=True, is_active=False)`, `EmailVerificationToken` (sha256 hash stored, 48h TTL), and `emit_audit(event_type="user_signup", idempotency_key=event_id)`.
4. Idempotency/enumeration branches return distinct shapes: `_replay_from_idempotency` (replay → `created=False`), duplicate email → `duplicate_email=True` (no email sent, **enumeration-safe identical 201**), fresh → 201 + `mailer::send_verification_email` (best-effort, `fail_silently`).

### Signup — Path A (invite-accept)

NOT routed through `signup`. `organizations.views::InvitationAcceptView.post` (`AllowAny`):
1. `invitation_svc::get_invitation_by_token` (sha256 compare) → reject non-`PENDING`.
2. If an **active** account already owns the invite email → `401 login_required` (account-takeover guard; email comes from the signed invite, **never the request body**).
3. Pre-existing **unverified** account → activate + set `email_verified_at`, **never reset the password** (security-review fix). Otherwise `User.objects.create_user(is_active=True, email=invite.email)`, `validate_password`, set `email_verified_at`. Then Django `login(...)`.
4. `invitation_svc::accept_invitation` → atomic `select_for_update` on the invite, status pre-checks, `_accept_invitation_row` creates a `TournamentMembership` (tournament-scoped invite) or `OrganizationMembership` (org-level), flips invite `ACCEPTED`, emits `member_invite_accepted`.
5. **Session cycle fires after commit** via `_cycle_session` (delegates to `session_security::cycle_session_on_role_change`, fallback `request.session.cycle_key()`).

### Email verification

`POST /api/accounts/auth/verify_email/` (hyphen alias also routed) → `accounts.views::verify_email` (`@transaction.atomic`): `EmailVerificationToken.select_for_update()` by `_hash_token`; reject if `None`/`is_used`/`is_expired`; set `user.is_active=True` + `email_verified_at`, mark token `used_at`, `emit_audit("email_verified", role=SYSTEM)`.

### Login (+ unverified gate, audit, axes)

`POST /api/accounts/auth/login/` → `accounts.views::login_view` (`AllowAny`):
1. `LoginSerializer` → `authenticate(request, username=email, password=...)`. `username` must equal `USERNAME_FIELD=email` because `AxesStandaloneBackend` is in `AUTHENTICATION_BACKENDS`; axes (`AXES_FAILURE_LIMIT=10`, `COOLOFF=0.25h`, params `[ip_address, username]`, `RESET_ON_SUCCESS=True`) can short-circuit `authenticate` to `None` once locked.
2. `authenticate` → `None`: if the email belongs to an **unverified** user whose password checks out, return `403 {"detail":"email_not_verified","email":...}` (revealed only to whoever knows the password → not enumeration). Otherwise emit `user_login_failed` (best-effort, only if the email row exists) and `400 invalid_credentials`.
3. Inactive/soft-deleted → `403 account_inactive`.
4. **2FA gate** (`user.has_2fa_enrolled`): `twofa_svc::twofa_is_locked` → `429 twofa_locked`; no `totp_code` → `200 {"requires_2fa": True}` (no session yet); wrong code → `twofa_record_failure` + audit + `400 invalid_2fa` or `429 twofa_locked`; correct → `twofa_reset_attempts`. Verification is `twofa_svc::verify_totp_or_recovery` (TOTP `valid_window=1`, else single-use argon2id recovery code claimed via conditional `UPDATE ... WHERE used_at IS NULL`).
5. Success: Django `login(request, user)` **then** `session_security::cycle_session_on_role_change` (B.11 fixation defense), then `emit_audit("user_login_success")`, return `200 {"status":"ok"}`.

### 2FA enrollment / disable / recovery

`twofa/enroll/` → `twofa_svc::enroll_totp` (deletes prior unconfirmed device, creates one, returns `otpauth_uri` + QR data-URI; secret Fernet-encrypted via `_crypto::encrypt_secret`). `twofa/confirm/` → `confirm_totp` (`@transaction.atomic`, `select_for_update`, verify, set `confirmed_at` + `user.has_2fa_enrolled=True`, mint 10 argon2id recovery codes) **then `cycle_session_on_role_change`** in the view. `disable/` and `recovery_codes:regenerate/` mirror this; disable also cycles the session.

### Logout

`POST /api/accounts/auth/logout/` (`IsAuthenticated`) → `emit_audit("user_logout")` **then** Django `logout(request)` (flushes session). Order matters: audit before flush so `request.user` is still authenticated.

### Password reset

- Request: `password_reset_request_view` (`AllowAny`) → `password_reset::request_password_reset` — cache rate limits `pwreset:email:<e>` (`PASSWORD_RESET_RATE_PER_EMAIL_HOUR=5`) and `pwreset:ip:<ip>` (`=10`); silent no-op if no active user (**enumeration-safe, always 200**); mints `PasswordResetToken` (sha256, 60-min TTL), emails the link, emits `password_reset_requested`.
- Complete: `password_reset_complete_view` → `complete_password_reset` (`@transaction.atomic`): `select_for_update` token, reject used/expired, `set_password` + `last_password_change_at`, mark token used, **`_invalidate_all_sessions_for_user`** (O(n) scan of `django_session` decoding `_auth_user_id`), emit `password_reset_completed`. `ValueError` → `400`.

### Frontend authStore + ProtectedRoute interplay

- Boot: `main.tsx` calls `useAuthStore.getState().bootstrap()` → `authApi.me()`. `401` → `{user:null, bootstrapped:true}`; success hydrates `user`.
- `ProtectedRoute` (`features/layout/ProtectedRoute.tsx`): not bootstrapped → `role="status"` spinner; `requires2FA && !user` → `/2fa/challenge`; `!user` → `/login?next=<path>`; authenticated with **zero memberships** and not super-admin → `/orgs` (unless on an `ORG_OPTIONAL_PATHS` surface — prevents the new-user redirect loop).
- Login: `authStore::login` → `authApi.login`. `requires_2fa` → stash `pendingCredentials` in **module scope** (never in Zustand/devtools), `user=null`, `requires2FA=true`. `completeTotp` re-POSTs `/login/` with `{email,password,totp_code}` (no separate challenge endpoint). `LoginPage::onCredSubmit` catches `email_not_verified` → inline resend via `authApi.resendVerification`. `resolveDestination` honors `?next=` then `pickLandingPathForUser`.
- Global 401 bus: `api/client.ts::apiFetch` sends `credentials:"include"` + `X-CSRFToken` (from `lib/csrf::getCsrfToken` reading the `csrftoken` cookie) on unsafe verbs, throws `ApiError`. `api/queryClient.ts::QueryCache.onError` emits `{type:"unauthenticated"}` on `ApiError.isUnauthenticated`; `App.tsx::AuthBusBridge` subscribes via `onAuthEvent`, calls `authStore.clear()` + navigates to `/login`.

## Diagram-in-prose

`SPA form → api/client.apiFetch (cookie+CSRF) → DRF view → serializer → service (atomic) → models + emit_audit → Response`. Out-of-band: services → `mailer`/`send_mail` → email link → SPA verify/reset pages. Session state lives in the Django session cookie; the SPA holds only a hydrated `/me` snapshot in Zustand + a transient module-scoped credential during the 2FA leg. Any 401 anywhere funnels through the QueryCache bus back to `/login`.

## Invariants this flow depends on

- **Session cycles on every auth-state change** (login, invite-accept, 2FA confirm/disable, and implicitly via session wipe on password reset) — B.11 fixation defense. The cycle call must come *after* `django.contrib.auth.login`.
- **Tokens stored as sha256 hashes** (email-verify, password-reset, invite); plaintext only emailed. Recovery codes argon2id-hashed (`models` note B.14).
- **`is_active` is the verification gate** (`User.is_active` default `False`, flipped only by verify-email or invite-accept). `authenticate` cannot create a session for an inactive user.
- **Enumeration safety**: signup duplicate-email = identical 201; `resend_verification` always 202; `password_reset_request` always 200.
- **Idempotency**: signup honors client `event_id` via the `AuditEvent.idempotency_key` (audit row is the storage of record); `emit_audit` is idempotent on that key.
- **Audit is append-only and service-layer-emitted** (invariant 5/B.4); it shares the verb's transaction so audit + state change commit atomically.
- **2FA lockout is a separate cache counter** from axes (axes resets on password success; the 2FA counter must not, else a correct password resets the attacker's second-factor budget — the exact bug `test_twofa_ratelimit` guards).

## Failure modes

- **Email send is best-effort** (`fail_silently`): a fresh signup or reset can succeed with no email delivered; the user is then stuck unless `resend_verification` works.
- **`_invalidate_all_sessions_for_user` is an O(n) full-table scan** decoding every session — degrades as active sessions grow (the docstring caps the assumption at <10k).
- **Cache-backed limiters lose state on cache flush/restart** (password-reset limiter, 2FA lockout) — limits reset, and `LocMemCache` per-process makes them ineffective across workers.
- **2FA `requires_2fa` has no server-side challenge token**: the SPA must re-send the password, so credentials persist client-side (module scope) for the duration of the challenge; a page reload mid-challenge loses `pendingCredentials` → "Session expired" in `completeTotp`.
- **Login `email_not_verified` runs an extra `check_password`** after `authenticate` already failed — a second bcrypt cost, and it bypasses axes counting for that branch.
- **Frontend/backend route drift**: `api/auth.ts` uses hyphen aliases (`verify-email`, `password-reset-request`); both underscore and hyphen paths exist in `accounts/urls.py`. Removing an alias breaks the SPA silently.
- **`accept_invitation` pre-materializes expiry outside the atomic block** so the EXPIRED flip survives a later rollback — subtle ordering that a refactor could regress.

## Restructuring seams

- **Unify a `tokens` abstraction.** `EmailVerificationToken` and `PasswordResetToken` are near-identical (hash, TTL, `used_at`, `is_used`/`is_expired`); `_hash_token` is duplicated in `views.py`, `signup.py`, `password_reset.py`, and `invitation.py`. One `HashedToken` model + a `consume()` helper would collapse four copies.
- **Make 2FA a real two-step challenge.** Replace the "re-send password + `requires_2fa`" pattern with a short-lived server-side challenge token (`/login` → `2fa_token`; `/2fa/verify`) — removes client-held credentials and the lost-`pendingCredentials`-on-reload failure.
- **Centralize enumeration-safety + rate limiting.** Three different mechanisms coexist (DRF `SignupRateThrottle`, ad-hoc `password_reset::_rate_limit_hit`, `twofa` cache counters). A single throttle/limiter policy module would make the B.11 budgets auditable in one place.
- **Replace session-table scan with an indexed lookup** (store sessions keyed by user, or use a `last_password_change_at` check in an auth middleware to reject stale sessions lazily) — removes the O(n) reset cost.
- **Lift the session-cycle into middleware or `user_logged_in` signal** so views can't forget it; today it is a manual call duplicated across `login_view`, `twofa_confirm_view`, `twofa_disable_view`, and `invitation` (with its own fallback stub).
- **Collapse Path A/Path B account creation.** Both `signup::perform_signup` and `InvitationAcceptView` create users with overlapping verification/activation logic; a shared `create_account(verified: bool)` service would unify them.

## Sync / ordering / transaction flags

- **Client↔server must stay in sync**: login response contract (`requires_2fa`, `email_not_verified`+`email`, `account_inactive`, `twofa_locked`) consumed verbatim in `authStore.ts`/`LoginPage.tsx`; CSRF header name `X-CSRFToken` (`client.ts` ↔ Django `CSRF_COOKIE_HTTPONLY=False`); `MeSerializer` field set ↔ `types/user`; route hyphen aliases ↔ `accounts/urls.py`.
- **Ordering**: `login()` then `cycle_session_on_role_change`; `emit_audit("user_logout")` then `logout()`; invite session-cycle **after** `transaction.atomic()` commit.
- **Transactions**: `verify_email`, `confirm_totp`, `complete_password_reset`, `disable_2fa`, `perform_signup`, and `accept_invitation` all wrap state change + audit in one atomic block (`select_for_update` on the consumed token/device/invite). `emit_audit_on_commit` exists for deferred cases but the auth flows deliberately use the inline `emit_audit` to share atomicity.
