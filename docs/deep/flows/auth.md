# Deep Flow — Auth Lifecycle (signup → verify → login → 2FA → session → reset)

Source-of-truth trace of the complete authentication lifecycle across the Django
backend (`apps.accounts`, `apps.organizations`, `apps.audit`, `django.contrib.auth`,
`django-axes`) and the React/Vite SPA (`features/auth`, `features/layout`, `api/`,
`lib/`). Every claim is cited as `file:symbol` with a line range. **Verified against
source on 2026-06-08** — not copied from the breadth-pass note; the breadth note
(`docs/superpowers/analysis/flow-auth.md`) was cross-checked and corrected where
imprecise (see "Corrections vs. breadth-pass note" at the end).

Two distinct account-creation paths exist and must not be conflated:

- **Path B (public self-signup)** — creates a *new* tenant. Routes through
  `apps/accounts/views.py:signup`.
- **Path A (invite-accept)** — joins an *existing* tenant. Routes through
  `apps/organizations/views.py:InvitationAcceptView`. NOT through `signup`.

---

## Participants (concrete modules/files)

| Alias | Concrete module |
| --- | --- |
| SPA | `frontend/src/features/auth/*` (`LoginPage.tsx`, `SignupPage.tsx`, `VerifyEmailPage.tsx`, `PasswordResetRequestPage.tsx`, `PasswordResetCompletePage.tsx`, `TwoFactorEnrollPage.tsx`, `TwoFactorChallengePage.tsx`) |
| authStore | `frontend/src/features/auth/authStore.ts` (Zustand) |
| authApi | `frontend/src/api/auth.ts` |
| apiFetch | `frontend/src/api/client.ts:apiFetch` |
| csrf | `frontend/src/lib/csrf.ts:getCsrfToken` |
| qc | `frontend/src/api/queryClient.ts` (`QueryCache.onError` + `onAuthEvent` bus) |
| Guard | `frontend/src/features/layout/ProtectedRoute.tsx` |
| Views | `backend/apps/accounts/views.py` |
| Ser | `backend/apps/accounts/serializers.py` |
| signupSvc | `backend/apps/accounts/services/signup.py:perform_signup` |
| twofaSvc | `backend/apps/accounts/services/twofa.py` |
| pwresetSvc | `backend/apps/accounts/services/password_reset.py` |
| sessionSec | `backend/apps/accounts/services/session_security.py:cycle_session_on_role_change` |
| mailer | `backend/apps/accounts/services/mailer.py` |
| inviteSvc | `backend/apps/organizations/services/invitation.py` |
| inviteView | `backend/apps/organizations/views.py:InvitationAcceptView` |
| audit | `backend/apps/audit/services.py:emit_audit` |
| djAuth | `django.contrib.auth.{authenticate,login,logout}` |
| axes | `django-axes` (`AxesStandaloneBackend`) |
| DB | Postgres (`accounts_user`, `accounts_email_verification_token`, `accounts_password_reset_token`, `accounts_twofactor_device`, `accounts_recovery_code`, `audit_*`, `django_session`) |
| cache | Django cache (LocMem in dev; rate-limit + 2FA-lockout counters) |

---

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant SPA as SPA (features/auth)
    participant Store as authStore.ts
    participant Fetch as api/client.apiFetch
    participant CSRF as lib/csrf
    participant V as accounts/views.py
    participant S as accounts/serializers.py
    participant SU as services/signup.perform_signup
    participant TF as services/twofa
    participant PR as services/password_reset
    participant SS as session_security.cycle_session_on_role_change
    participant DJ as django.contrib.auth
    participant AX as django-axes
    participant A as audit.services.emit_audit
    participant DB as Postgres
    participant C as Django cache
    participant M as services/mailer + send_mail

    rect rgb(235,245,255)
    note over U,M: 1. SIGNUP (Path B — new tenant)
    U->>SPA: SignupPage submit {email,password,name}
    SPA->>Fetch: authApi.signup(payload)
    Fetch->>CSRF: getCsrfToken() (csrftoken cookie)
    Fetch->>V: POST /api/accounts/auth/signup/ (X-CSRFToken, credentials:include)
    V->>V: SignupRateThrottle (scope=signup, 3/hr/IP) [cache]
    V->>S: SignupSerializer.is_valid (password min_length=12)
    V->>SU: perform_signup(email,password,name,org_name,event_id,request)
    SU->>DB: AuditEvent WHERE idempotency_key=event_id (replay short-circuit)
    SU->>DB: User WHERE email=? (duplicate-email guard)
    rect rgb(255,250,230)
    note over SU,DB: transaction.atomic() — 5 rows commit together
    SU->>DB: create User(is_active=False)
    SU->>DB: create Organization(status=PENDING_REVIEW)
    SU->>DB: create OrganizationMembership(role=ADMIN,is_org_owner=True,is_active=False)
    SU->>DB: create EmailVerificationToken(sha256 hash, 48h TTL)
    SU->>A: emit_audit("user_signup", idempotency_key=event_id)
    A->>DB: INSERT AuditEvent (same txn)
    end
    SU-->>V: SignupResult(created/duplicate_email)
    V->>M: send_verification_email (best-effort, only on fresh create)
    V-->>SPA: 201 {"status":"pending_verification"} (identical for dup-email)
    end

    rect rgb(235,255,235)
    note over U,M: 2. EMAIL VERIFICATION
    U->>SPA: click email link → /verify-email?token=...
    SPA->>Fetch: authApi.verifyEmail(token)
    Fetch->>V: POST /api/accounts/auth/verify-email/ {token}
    rect rgb(255,250,230)
    note over V,DB: @transaction.atomic
    V->>DB: select_for_update EmailVerificationToken WHERE token_hash=sha256(token)
    V->>V: reject None / is_used / is_expired → 400
    V->>DB: User.is_active=True, email_verified_at=now
    V->>DB: token.used_at=now
    V->>A: emit_audit("email_verified", role=SYSTEM)
    end
    V-->>SPA: 200 {"status":"verified"}
    end

    rect rgb(255,240,240)
    note over U,M: 3. LOGIN (+ unverified gate + axes)
    U->>SPA: LoginPage submit {email,password}
    SPA->>Store: login(payload)
    Store->>Fetch: authApi.login(payload)
    Fetch->>V: POST /api/accounts/auth/login/ {email,password[,totp_code]}
    V->>S: LoginSerializer.is_valid
    V->>DJ: authenticate(request, username=email, password)
    DJ->>AX: AxesStandaloneBackend (failure limit=10, lockout [ip,username])
    AX-->>DJ: None if locked
    alt authenticate() is None
        V->>DB: User WHERE email (check unverified+check_password) → 403 email_not_verified
        V->>A: emit_audit("user_login_failed") (if email row exists)
        V-->>SPA: 400 invalid_credentials
    else inactive / soft-deleted
        V-->>SPA: 403 account_inactive
    end
    end

    rect rgb(255,245,235)
    note over U,M: 4. 2FA GATE (only if user.has_2fa_enrolled)
    V->>C: twofa_is_locked(user) (cache counter)
    alt locked
        V->>A: emit_audit("user_login_failed", reason=2fa_locked)
        V-->>SPA: 429 twofa_locked
    else no totp_code yet
        V-->>SPA: 200 {"requires_2fa": true}  (NO session yet)
        Store->>Store: stash pendingCredentials (module scope), user=null
        SPA->>SPA: ProtectedRoute → /2fa/challenge
        U->>SPA: enter 6-digit code
        Store->>Fetch: re-POST /login/ {email,password,totp_code}
        V->>TF: verify_totp_or_recovery(user, totp_code)
        alt invalid
            V->>C: twofa_record_failure (incr)
            V-->>SPA: 400 invalid_2fa OR 429 twofa_locked
        else valid
            V->>C: twofa_reset_attempts (delete counter)
        end
    end
    end

    rect rgb(235,255,245)
    note over U,M: 5. SESSION ESTABLISH (success)
    V->>DJ: login(request, user)  (writes django_session, sets sessionid cookie)
    V->>SS: cycle_session_on_role_change(request)  (B.11 — AFTER login)
    SS->>DB: session.cycle_key() (rotate session key)
    V->>A: emit_audit("user_login_success")
    V-->>SPA: 200 {"status":"ok"}
    Store->>Fetch: authApi.me() (re-hydrate)
    Fetch->>V: GET /api/accounts/me/
    V-->>Store: 200 MeSerializer {id,email,memberships[],...}
    Store->>SPA: set user; resolveDestination() → navigate
    end

    rect rgb(245,235,255)
    note over U,M: 6. SESSION USE + LOGOUT
    SPA->>Fetch: any GET (credentials:include sends sessionid)
    Fetch->>V: 401 anywhere → ApiError.isUnauthenticated
    Fetch->>qc: QueryCache.onError emits {type:"unauthenticated"}
    qc->>SPA: AuthBusBridge: authStore.clear() + navigate(/login)
    U->>SPA: logout
    Store->>V: POST /api/accounts/auth/logout/
    V->>A: emit_audit("user_logout")  (BEFORE flush)
    V->>DJ: logout(request)  (flush session)
    V-->>Store: 200 ; clear local state
    end

    rect rgb(255,235,245)
    note over U,M: 7. PASSWORD RESET
    U->>SPA: PasswordResetRequestPage {email}
    SPA->>V: POST /api/accounts/auth/password-reset-request/
    V->>PR: request_password_reset(email,request)
    PR->>C: _rate_limit_hit pwreset:email (5/hr) + pwreset:ip (10/hr)
    PR->>DB: User WHERE email,is_active,not deleted (silent no-op if none)
    PR->>DB: create PasswordResetToken(sha256, 60-min TTL)
    PR->>M: send_mail(reset link, fail_silently)
    PR->>A: emit_audit("password_reset_requested")
    V-->>SPA: 200 {"status":"ok"}  (always, enumeration-safe)
    U->>SPA: PasswordResetCompletePage {token,new_password}
    SPA->>V: POST /api/accounts/auth/password-reset-complete/
    rect rgb(255,250,230)
    note over V,DB: @transaction.atomic
    V->>PR: complete_password_reset(token,new_password,request)
    PR->>DB: select_for_update PasswordResetToken WHERE token_hash
    PR->>PR: reject used/expired → ValueError → 400
    PR->>DB: set_password + last_password_change_at
    PR->>DB: token.used_at=now
    PR->>DB: _invalidate_all_sessions_for_user (O(n) scan of django_session)
    PR->>A: emit_audit("password_reset_completed")
    end
    V-->>SPA: 200 {"status":"ok"}
    end
```

---

## Ordered numbered walkthrough (with file:function + line ranges)

### 1. Signup — Path B (public self-signup → new tenant)

1. **SPA submit.** `SignupPage` (`frontend/src/features/auth/SignupPage.tsx:50-60`)
   validates with a zod schema (`password.min(12)`, `accept_terms` literal `true`)
   then calls `authApi.signup` (`frontend/src/api/auth.ts:55-56`). Body shape =
   `{email, password, name}` (`SignupPayload`, `auth.ts:31-36`).
2. **Transport.** `api/client.apiFetch` (`frontend/src/api/client.ts:31-86`) sends
   `credentials:"include"` (line 69) and, because POST is an unsafe verb
   (`UNSAFE_METHODS`, line 4), attaches `X-CSRFToken` read from the `csrftoken`
   cookie via `lib/csrf.getCsrfToken` (`frontend/src/lib/csrf.ts:8-12`). JSON body
   serialized + `Content-Type: application/json` (lines 52-57).
3. **Throttle.** `accounts/views.py:signup` (`views.py:84-138`) is
   `@permission_classes([AllowAny])` + `@throttle_classes([SignupRateThrottle])`.
   `SignupRateThrottle` (`accounts/throttling.py:21-37`) has `scope="signup"` keyed
   by client IP; the rate `3/hour` comes from
   `settings.base:REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['signup']`
   (`fixture/settings/base.py:176`).
4. **Validation.** `SignupSerializer` (`serializers.py:14-31`): `email` EmailField,
   `password` `min_length=12`, optional `name`/`org_name`, optional UUID `event_id`.
5. **Service dispatch.** View calls `signup_svc.perform_signup(...)`
   (`views.py:110-117`) forwarding `request._request` (the raw `HttpRequest`).
6. **Idempotency replay (BEFORE the txn).**
   `perform_signup` (`services/signup.py:213-327`): if `event_id` is given,
   `_replay_from_idempotency` (`signup.py:168-205`) looks up the prior
   `AuditEvent` by `idempotency_key` + `event_type="user_signup"`, rebuilds the
   `SignupResult` from `payload_after` (`organization_id`/`membership_id`) with
   `created=False`. **Idempotency point #1.**
7. **Duplicate-email guard (BEFORE the txn).** `User.objects.filter(email=email).exists()`
   (`signup.py:242-250`) → returns `SignupResult(duplicate_email=True, created=False)`
   with no Org/membership and **no email sent** — enumeration-safe.
8. **TRANSACTION BOUNDARY — `with transaction.atomic()` (`signup.py:254-318`).**
   Five rows commit atomically:
   - `User.objects.create_user(is_active=False)` (`signup.py:256-261`) via
     `UserManager._create_user` (`models.py:38-48`) which lowercases the email and
     `set_password`s.
   - `Organization.objects.create(status=PENDING_REVIEW)` (`signup.py:270-276`),
     slug from `_derive_slug`/`_pick_unique_slug` checking `Organization.slug` +
     `SlugRedirect.old_slug` + `RESERVED_SLUGS` (`signup.py:110-165`).
   - `OrganizationMembership.objects.create(role=ADMIN, is_org_owner=True, is_active=False)`
     (`signup.py:282-289`) — *pending until SA approves the org*.
   - `EmailVerificationToken.objects.create(token_hash=sha256, expires_at=now+48h)`
     (`signup.py:292-297`); plaintext = `secrets.token_urlsafe(48)`, hashed by
     `_hash_token` (`signup.py:88-89`). **Only the hash is stored.**
   - `emit_audit("user_signup", idempotency_key=event_id)` (`signup.py:303-318`)
     INSIDE the txn (`audit/services.py:24-77`), so audit + state commit together.
9. **Response branch.** `views.py:119-138`:
   - replay (`not created and not duplicate_email`) → **200** `{"status":"pending_verification"}`.
   - duplicate-email → **201** identical `{"status":"pending_verification"}` (no email).
   - fresh → **201** + `mailer.send_verification_email`
     (`services/mailer.py:49-59`) renders `emails/verify_email.{html,txt}`, link =
     `{FRONTEND_BASE_URL}/verify-email?token={plaintext}`, `fail_silently=True`
     (best-effort; a send failure does not roll back the committed rows since the
     mail call is OUTSIDE the txn).

### 2. Email verification

10. **SPA.** `VerifyEmailPage` (`frontend/src/features/auth/VerifyEmailPage.tsx:17-37`)
    reads `?token=` and on mount calls `authApi.verifyEmail(token)`
    (`auth.ts:57-58`) → `POST /api/accounts/auth/verify-email/` (the hyphen alias).
11. **Route.** `accounts/urls.py:16-17` routes both `auth/verify_email/` and the
    hyphen alias `auth/verify-email/` to the same view.
12. **TRANSACTION BOUNDARY — `@transaction.atomic` (`views.py:144`).**
    `verify_email` (`views.py:141-176`):
    - `EmailVerificationToken.objects.select_for_update().select_related("user").filter(token_hash=_hash_token(plaintext)).first()`
      (`views.py:149-154`). `_hash_token` (`views.py:67-68`).
    - Reject `None` / `is_used` / `is_expired` → **400 invalid_or_expired_token**
      (`views.py:155-159`). `is_used`/`is_expired` are model properties
      (`models.py:261-267`).
    - Flip `user.is_active=True` + `email_verified_at=now`, mark `token.used_at=now`
      (`views.py:160-166`). `select_for_update` + `is_used` check makes the consume
      **idempotency point #2** (a double-click second request sees `is_used` → 400).
    - `emit_audit("email_verified", role=ActorRole.SYSTEM)` (`views.py:168-175`).
    - **200** `{"status":"verified"}`.
13. **Resend (optional).** `resend_verification` (`views.py:179-217`,
    `auth/resend-verification/` route) is `AllowAny` + `SignupRateThrottle`. Always
    returns **202** regardless of whether the email maps to a pending account
    (enumeration-safe). Only acts for `is_active=False, email_verified_at IS NULL`
    users; it invalidates older unused tokens (`update(used_at=now)`) before minting
    a fresh one — *single live link invariant*.

### 3. Login (+ unverified gate, axes, audit)

14. **SPA.** `LoginPage.onCredSubmit` (`LoginPage.tsx:109-126`) → `authStore.login`
    (`authStore.ts:63-104`) → `authApi.login` (`auth.ts:52-53`) →
    `POST /api/accounts/auth/login/`. `login_view` is `AllowAny` (`views.py:225-228`).
15. **Validate + normalize.** `LoginSerializer` (`serializers.py:38-41`); email is
    `.strip().lower()` (`views.py:231`).
16. **Authenticate through axes.** `authenticate(request, username=email, password=...)`
    (`views.py:236`). The `username` kwarg MUST equal `USERNAME_FIELD="email"`
    (`models.py:88`) because `AxesStandaloneBackend` is registered in
    `AUTHENTICATION_BACKENDS` (`settings/base.py:130-134`). Axes can short-circuit
    to `None` once locked: `AXES_FAILURE_LIMIT=10`, `AXES_COOLOFF_TIME=0.25` (15 min),
    `AXES_LOCKOUT_PARAMETERS=["ip_address","username"]`, `AXES_RESET_ON_SUCCESS=True`
    (`settings/base.py:190-193`).
17. **`authenticate` → None branches** (`views.py:237-268`):
    - **Unverified-but-correct-password gate**: if the email row exists, is
      `not is_active`, `email_verified_at is None`, AND `check_password(password)`
      passes → **403** `{"detail":"email_not_verified","email":...}` (`views.py:242-254`).
      Revealed only to whoever knows the password → not enumeration. *Note: this runs
      a second password hash after `authenticate` already failed.*
    - Else, if the email row exists, emit `user_login_failed` best-effort
      (`views.py:255-267`) and return **400 invalid_credentials** (`views.py:268`).
18. **Inactive / soft-deleted** (`views.py:270-271`): `not user.is_active or
    user.deleted_at is not None` → **403 account_inactive**.

### 4. 2FA gate (only when `user.has_2fa_enrolled`)

19. `views.py:273-313`, guard `if user.has_2fa_enrolled:` (`models.py:78`):
    - **Locked**: `twofa_svc.twofa_is_locked(user)` (`twofa.py:208-210`, cache key
      `2fa-attempts:<id>` ≥ `TWOFA_MAX_ATTEMPTS=5`) → emit `user_login_failed`
      (reason `2fa_locked`) → **429 twofa_locked** (`views.py:274-287`).
    - **No code yet**: `if not totp_code:` → **200** `{"requires_2fa": true}` with
      **no session created** (`views.py:288-292`). The SPA must re-call `/login/`.
    - **Wrong code**: `verify_totp_or_recovery` (`twofa.py:252-282`) false →
      `twofa_record_failure` (incr cache, `twofa.py:213-220`) + audit + **400
      invalid_2fa** or **429 twofa_locked** (`views.py:293-312`).
    - **Correct code**: `twofa_reset_attempts(user)` (`twofa.py:223-224`, deletes the
      cache counter) (`views.py:313`).
20. **2FA verification internals.** `verify_totp_or_recovery` (`twofa.py:252-282`):
    - TOTP: fetch the confirmed device, `decrypt_secret`, `_verify_totp` with
      `pyotp.TOTP(...).verify(code, valid_window=1)` (`twofa.py:118-122`, 261-269).
    - Recovery: `_verify_recovery` (`twofa.py:227-249`) argon2id-verifies against
      unused `RecoveryCode` rows then claims one via a **conditional single-use
      UPDATE**: `RecoveryCode.objects.filter(pk=row.pk, used_at__isnull=True).update(used_at=now)`;
      only `rowcount == 1` wins under concurrency (`twofa.py:243-248`). **Idempotency/
      single-use point #3.** On match, emit `recovery_code_consumed` (`twofa.py:271-280`).
21. **CRITICAL SEPARATION.** The 2FA lockout cache counter
    (`TWOFA_MAX_ATTEMPTS=5`, `TWOFA_LOCK_SECONDS=15min`, `twofa.py:53-54`) is
    deliberately SEPARATE from the axes password counter (which has
    `AXES_RESET_ON_SUCCESS=True`). A correct password must NOT reset the attacker's
    second-factor budget. Guarded by `tests/test_twofa_ratelimit.py`.

### 5. Session establishment (success path)

22. **`login()` then cycle — order matters** (`views.py:315-316`):
    1. `login(request, user)` (`django.contrib.auth`) writes the `django_session` row
       and sets the `sessionid` cookie.
    2. `cycle_session_on_role_change(request)` (`session_security.py:21-31`) calls
       `request.session.cycle_key()` — rotates the session key while preserving data
       (B.11 session-fixation defense). **It must run AFTER `login()`.**
23. `emit_audit("user_login_success")` (`views.py:317-324`). Return **200**
    `{"status":"ok"}` (`views.py:325`) — note: the login response carries **no user
    object**; the SPA re-fetches `/me/`.
24. **SPA hydrate.** `authStore.login` (`authStore.ts:63-91`): on `requires_2fa`
    false, `user = res.user ?? (await authApi.me())` (`authStore.ts:83`); since
    `login` returns only `{status:"ok"}`, this always falls through to `authApi.me()`
    (`GET /api/accounts/me/`, `auth.ts:51`). `me_view` (`views.py:488-513`) returns
    `MeSerializer` (`serializers.py:95-185`): `id,email,name,is_superuser,
    has_2fa_enrolled,email_verified_at,last_active_org_id,last_active_org_slug,
    memberships[],deleted_at`. `memberships` aggregates `(user,org,role)` rows and
    resolves `effective_modules` per org (`serializers.py:142-175`).
25. **Routing.** `LoginPage.resolveDestination` (`LoginPage.tsx:102-107`) honors
    `?next=` (validated by `safeNext`, `LoginPage.tsx:44-48`, refuses `//` and
    non-`/`), else `pickLandingPathForUser(user)`.
26. **2FA challenge leg client-side.** On `requires_2fa`, `authStore.login` stashes
    `pendingCredentials` in **module scope** (NOT Zustand state — never in devtools)
    and sets `user=null, requires2FA=true` (`authStore.ts:67-80`). `ProtectedRoute`
    redirects to `/2fa/challenge` when `requires2FA && !user`
    (`ProtectedRoute.tsx:41-43`). `completeTotp` (`authStore.ts:106-137`) re-POSTs
    `/login/` with `{email,password,totp_code}` — there is **no separate challenge
    endpoint**. A page reload mid-challenge loses `pendingCredentials` → `completeTotp`
    throws `no_pending_credentials` → "Session expired" (`authStore.ts:107-110`).

### 6. Session use + logout + global 401

27. **Per-request session use.** Every `apiFetch` sends `credentials:"include"`
    (`client.ts:69`); DRF `SessionAuthentication` (`settings/base.py:161-163`)
    authenticates from the `sessionid` cookie. Cookie flags:
    `SESSION_COOKIE_HTTPONLY=True`, `SESSION_COOKIE_SAMESITE="Lax"`,
    `SESSION_COOKIE_AGE=30 days`, `SESSION_COOKIE_SECURE = not DEBUG`
    (`settings/base.py:152-156`).
28. **Logout — audit BEFORE flush** (`logout_view`, `views.py:328-343`,
    `IsAuthenticated`): `emit_audit("user_logout")` runs while `request.user` is
    still authenticated, THEN `logout(request)` flushes the session. Order is
    load-bearing. SPA `authStore.logout` (`authStore.ts:139-152`) clears local state
    even on transport failure.
29. **Global 401 bus.** `apiFetch` throws `ApiError` on non-2xx (`client.ts:76-78`).
    `queryClient.ts:QueryCache.onError` (`queryClient.ts:35-43`) emits
    `{type:"unauthenticated"}` for `ApiError.isUnauthenticated`. `App.tsx:AuthBusBridge`
    (`App.tsx:64-78`) subscribes via `onAuthEvent` (`queryClient.ts:15-18`), calls
    `authStore.clear()` and `navigate(routes.login())`. Mutations can also call
    `authBus.emit` directly (`queryClient.ts:47`).
30. **Boot hydrate.** `main.tsx:8` fires `useAuthStore.getState().bootstrap()` before
    render. `bootstrap` (`authStore.ts:44-61`) calls `authApi.me()`; a `401`
    sets `{user:null, bootstrapped:true}` (no error), any other error keeps
    `bootstrapped:true` with `error`. `ProtectedRoute` blocks on `bootstrapped`
    (`ProtectedRoute.tsx:29-39`), then: `requires2FA&&!user → /2fa/challenge`;
    `!user → /login?next=<path>`; authenticated with zero memberships and not
    super-admin and not on an `ORG_OPTIONAL_PATHS` surface → `/orgs`
    (`ProtectedRoute.tsx:41-69`).

### 7. Password reset

31. **Request.** `PasswordResetRequestPage` → `POST /api/accounts/auth/password-reset-request/`
    (hyphen alias, `urls.py:31`) → `password_reset_request_view` (`views.py:365-376`,
    `AllowAny`) → `pwresetSvc.request_password_reset` (`password_reset.py:62-123`):
    - Per-email + per-IP cache rate limits: `pwreset:email:<e>`
      (`PASSWORD_RESET_RATE_PER_EMAIL_HOUR=5`) and `pwreset:ip:<ip>`
      (`PASSWORD_RESET_RATE_PER_IP_HOUR=10`) via `_rate_limit_hit`
      (`password_reset.py:45-59`, settings at `base.py:223-225`).
    - **Silent no-op** if no active, non-deleted user (`password_reset.py:85-88`).
    - Mint `PasswordResetToken(sha256, expires_at=now+60min, requested_ip)`
      (`password_reset.py:90-97`; `PASSWORD_RESET_TTL_MINUTES=60`, `base.py:223`).
    - `send_mail` link `{FRONTEND_BASE_URL}/password-reset/complete?token={plaintext}`
      `fail_silently=True` (`password_reset.py:99-113`).
    - `emit_audit("password_reset_requested")` (`password_reset.py:115-123`) — **not**
      wrapped in an explicit `transaction.atomic`; runs in the request's autocommit /
      ambient transaction.
    - View always returns **200** `{"status":"ok"}` (`views.py:376`). Enumeration-safe.
32. **Complete.** `PasswordResetCompletePage` → `POST /api/accounts/auth/password-reset-complete/`
    → `password_reset_complete_view` (`views.py:379-395`) → **TRANSACTION BOUNDARY —
    `@transaction.atomic` `complete_password_reset` (`password_reset.py:126-173`)**:
    - `select_for_update().select_related("user").filter(token_hash=...)` (`password_reset.py:142-147`).
    - Reject None/`is_used`/`is_expired` → `ValueError` → view maps to **400**
      (`password_reset.py:148-153`, `views.py:393-394`). The `select_for_update` +
      `is_used` check is **idempotency/single-use point #4**.
    - `set_password` + `last_password_change_at`, `token.used_at=now`
      (`password_reset.py:155-161`).
    - `_invalidate_all_sessions_for_user` (`password_reset.py:176-192`): O(n) scan of
      `django_session` decoding each payload and deleting rows whose
      `_auth_user_id` matches — forces re-login everywhere (implicit session cycle).
    - `emit_audit("password_reset_completed")` (`password_reset.py:165-172`).
    - **200** `{"status":"ok"}`.

### 8. 2FA enrollment / disable / recovery (self-service, authenticated)

33. **Enroll.** `twofa_enroll_view` (`views.py:403-418`, `IsAuthenticated`) →
    `twofa_svc.enroll_totp` (`twofa.py:77-115`): deletes any prior *unconfirmed*
    device, creates a new `TwoFactorDevice` with `secret_b32 = encrypt_secret(secret)`
    (Fernet via `_crypto`), returns `otpauth_uri` + base64 QR data-URI + `device_id`.
    No audit, no session cycle here (device is unconfirmed).
34. **Confirm.** `twofa_confirm_view` (`views.py:421-438`) → **TRANSACTION BOUNDARY —
    `@transaction.atomic` `confirm_totp` (`twofa.py:125-164`)**:
    `select_for_update` the unconfirmed device, `_verify_totp` (raise `ValueError` →
    400 on mismatch), set `confirmed_at`, set `user.has_2fa_enrolled=True` +
    `twofa_enrolled_at`, mint 10 argon2id recovery codes (`_generate_recovery_codes`,
    `twofa.py:187-196`), emit `twofa_enrolled`. Returns plaintext codes **shown once**.
    THEN the view calls `cycle_session_on_role_change(request)` (`views.py:437`) —
    auth-state change.
35. **Disable.** `twofa_disable_view` (`views.py:441-454`) → **`@transaction.atomic`
    `disable_2fa` (`twofa.py:290-307`)**: delete devices + recovery codes, set
    `has_2fa_enrolled=False`, emit `twofa_disabled`; then `cycle_session_on_role_change`
    (`views.py:453`).
36. **Regenerate recovery codes.** `twofa_recovery_regenerate_view`
    (`views.py:457-468`) → **`@transaction.atomic` `regenerate_recovery_codes`
    (`twofa.py:167-184`)**: delete all prior `RecoveryCode` rows, mint 10 new, emit
    `recovery_codes_regenerated`. (No session cycle — credentials unchanged.)

### Path A — invite-accept (the *other* account-creation entry)

37. **Endpoint.** `POST /api/invitations:accept/` →
    `organizations/views.py:InvitationAcceptView.post` (`views.py:467-547`,
    `AllowAny`; routed at `fixture/urls.py:34-35`; path alias
    `/api/orgs/invitations/accept/` at `organizations/urls.py:92-95`).
38. **Token lookup.** `inviteSvc.get_invitation_by_token` (`invitation.py:540-547`,
    sha256 compare) → reject non-`PENDING` → 400 `invalid_or_used_invitation`
    (`views.py:484-486`).
39. **Account-takeover guard.** If an **active** account already owns the invite email
    → **401 login_required** (`views.py:489-495`). The email comes from the *signed
    invite*, NEVER the request body.
40. **Pre-existing unverified account** → activate + set `email_verified_at`, **never
    reset the password** (a body-supplied password is ignored — security-review HIGH
    fix) (`views.py:497-508`). Otherwise `User.objects.create_user(is_active=True,
    email=invite.email)` after `validate_password` (`views.py:509-526`). Then
    `login(request, user, backend="...ModelBackend")` (`views.py:527`).
41. **Accept.** `inviteSvc.accept_invitation` (`invitation.py:335-392`) — **TRANSACTION
    BOUNDARY `with transaction.atomic()` (`invitation.py:363-387`)**: `select_for_update`
    the invite, status pre-checks, `_accept_invitation_row` (`invitation.py:238-332`)
    idempotently creates a `TournamentMembership` (tournament-scoped invite) or
    `OrganizationMembership` (org-level), flips invite to `ACCEPTED`, emits
    `member_invite_accepted`.
42. **Session cycle AFTER commit.** `_cycle_session(request)` (`invitation.py:390`,
    helper at `invitation.py:61-81`) runs **outside** the atomic block so it survives
    commit; it delegates to `session_security.cycle_session_on_role_change`, falling
    back to `request.session.cycle_key()`.
43. **Subtle ordering.** Expiry is *materialized outside* the atomic block
    (`invitation.py:354-361`) so the `PENDING→EXPIRED` flip survives a later
    `ValidationError` rollback — a refactor must preserve this.

---

## Transaction boundaries & `transaction.on_commit` points

| Operation | File:function | Boundary | Notes |
| --- | --- | --- | --- |
| Signup (Path B) | `services/signup.py:perform_signup:254-318` | `with transaction.atomic()` | 5 rows (User, Org, Membership, EmailVerificationToken, AuditEvent) commit together; replay + dup-email guards run BEFORE the block; `mailer.send_verification_email` runs in the VIEW after the service returns (outside txn). |
| Email verify | `views.py:verify_email:144` | `@transaction.atomic` | `select_for_update` token; state + `email_verified` audit atomic. |
| Login success | `views.py:login_view:315-324` | **No explicit atomic** | `login()` + `cycle_key()` + audit run in the request's ambient autocommit; ordering (`login` → `cycle` → audit) is the invariant, not a txn. |
| Logout | `views.py:logout_view:332-342` | No explicit atomic | audit BEFORE `logout()` flush. |
| Password reset request | `password_reset.py:request_password_reset:62-123` | No explicit atomic | token create + audit in ambient autocommit. |
| Password reset complete | `password_reset.py:complete_password_reset:126` | `@transaction.atomic` | `select_for_update` token; set_password + token-consume + session-invalidate + audit atomic. |
| 2FA confirm | `twofa.py:confirm_totp:125` | `@transaction.atomic` | `select_for_update` device; device confirm + user flag + recovery mint + audit atomic; session cycle in VIEW (`views.py:437`). |
| 2FA disable | `twofa.py:disable_2fa:290` | `@transaction.atomic` | session cycle in VIEW (`views.py:453`). |
| Recovery regenerate | `twofa.py:regenerate_recovery_codes:167` | `@transaction.atomic` | — |
| Invite accept | `invitation.py:accept_invitation:363-387` | `with transaction.atomic()` | session cycle AFTER commit (`invitation.py:390`); expiry flip materialized OUTSIDE the block. |

**`transaction.on_commit`:** the auth flows do **NOT** use `transaction.on_commit`.
`audit/services.py:emit_audit_on_commit` (`services.py:80-87`) exists for deferred
emission but every auth verb deliberately uses the inline `emit_audit` so the audit
row shares the verb's atomicity (B.4). The only post-commit step in this flow is the
invite-accept session cycle, sequenced manually *after* `transaction.atomic()` exits
(`invitation.py:387-390`), not via `on_commit`.

---

## Idempotency points

1. **Signup `event_id`** — `signup.py:_replay_from_idempotency:168-205` + `emit_audit`
   idempotency on `idempotency_key` (`audit/services.py:45-48`). Replay returns the
   prior result with `created=False`; the view downgrades 201→200 (`views.py:120-121`).
   The AuditEvent row is the storage of record (architectural invariant 3).
2. **Email-verify token consume** — `select_for_update` + `is_used` reject
   (`views.py:149-159`); a replayed token returns 400, never re-activates.
3. **Recovery-code single-use claim** — conditional `UPDATE ... WHERE used_at IS NULL`,
   only `rowcount == 1` consumes (`twofa.py:243-248`). Concurrency-safe single use.
4. **Password-reset token consume** — `select_for_update` + `is_used`/`is_expired`
   reject (`password_reset.py:142-153`).
5. **Invite-accept** — `accept_invitation_by_id`/`accept_invitation` create-or-fetch
   membership idempotently and re-activate a soft-removed membership rather than
   duplicating (`invitation.py:266-308`); invite-create also honors `event_id`
   (`invitation.py:162-169`).
6. **`emit_audit` itself** is idempotent on `idempotency_key` everywhere
   (`audit/services.py:45-48`).

---

## Client ↔ server contracts this flow depends on

These must stay in lockstep across a restructuring; each is consumed verbatim on the
opposite side.

- **CSRF header name** `X-CSRFToken` (`client.ts:60-61`) ↔ Django default
  `CSRF_HEADER_NAME`; the cookie `csrftoken` must be JS-readable, enforced by
  `CSRF_COOKIE_HTTPONLY=False` (`settings/base.py:157`). Read by `lib/csrf.ts:8-12`.
- **Session cookie** `sessionid`, HttpOnly, SameSite=Lax, sent on every request via
  `credentials:"include"` (`client.ts:69`); DRF `SessionAuthentication`
  (`settings/base.py:161-163`).
- **Login response shape** — consumed verbatim in `authStore.ts` + `LoginPage.tsx`:
  - `{"requires_2fa": true}` (200) → `authStore.ts:67-80`, `ProtectedRoute.tsx:41`.
  - `{"detail":"email_not_verified","email":...}` (403) → `LoginPage.tsx:120-123`
    triggers the inline resend UI.
  - `{"detail":"invalid_credentials"}` (400), `account_inactive` (403),
    `twofa_locked` (429), `invalid_2fa` (400) → `LoginPage.friendlyAuthError:19-28`.
  - Success body is `{"status":"ok"}` with **no user** → the SPA always re-fetches
    `/me/` (`authStore.ts:83`).
- **`MeSerializer` field set** (`serializers.py:109-121`) ↔ `frontend/src/types/user`
  (`GetMeResponse = User`, `auth.ts:10`) — `memberships[]` drives `ProtectedRoute`'s
  zero-membership redirect and role landing.
- **2FA enroll/confirm field names**: response `{otpauth_uri, qr_data_uri, device_id}`
  (`TwoFAEnrollResponseSerializer`, `serializers.py:57-60`); confirm reads `code`
  (NOT `totp`) and returns `{recovery_codes:[...]}` (`serializers.py:63-68`,
  `auth.ts:86-90`).
- **Route hyphen aliases**: `auth/verify-email/`, `auth/resend-verification/`,
  `auth/password-reset-request/`, `auth/password-reset-complete/` all exist alongside
  the underscore canonical names (`accounts/urls.py:17,19,31,37`). `auth.ts` uses the
  hyphen forms (`auth.ts:58,61,65,69`). Removing an alias silently breaks the SPA.
- **Signup body** `{email,password,name}` (`auth.ts:31-36`) ↔ `SignupSerializer`
  (`serializers.py:14-31`); response `{"status":"pending_verification"}`.
- **Email links**: `{FRONTEND_BASE_URL}/verify-email?token=` (`mailer.py:52`) and
  `{FRONTEND_BASE_URL}/password-reset/complete?token=` (`password_reset.py:99`) ↔ SPA
  routes `/verify-email` and `/password-reset/complete` (`App.tsx:113,118-121`);
  `FRONTEND_BASE_URL` default `http://localhost:5173` (`settings/base.py:216`).
- **Invite-accept**: `POST /api/invitations:accept/` body `{token,password?,name?}`,
  response `{org_slug, tournament_id}` or `{detail:"login_required",email}` (401) /
  `{detail:"password_required"}` (400) (`views.py:491-547`).
- **Global 401 contract**: any endpoint returning 401 → `ApiError.isUnauthenticated`
  → `unauthenticated` bus event → redirect to `/login` (`queryClient.ts:35-43`,
  `App.tsx:64-78`).

---

## Invariants this flow enforces

- **Session auth, no JWT** (architectural invariant 15): all state in the Django
  session cookie; the SPA holds only a hydrated `/me` snapshot in Zustand + a
  transient module-scoped credential during the 2FA leg.
- **Session cycles on every auth-state change** (B.11 fixation defense): login,
  invite-accept, 2FA confirm/disable; password reset wipes all sessions implicitly.
  The cycle call MUST come *after* `django.contrib.auth.login`.
- **Tokens stored as sha256 hashes** (email-verify, password-reset, invite);
  plaintext only emailed. Recovery codes argon2id-hashed (`models.py:162-191`,
  `twofa.py:187-196`); TOTP secret Fernet-encrypted (`twofa.py:88-91`).
- **`is_active` is the verification gate** (`models.py:13` default False, flipped only
  by verify-email `views.py:162` or invite-accept `views.py:505/523`). `authenticate`
  cannot mint a session for an inactive user.
- **Enumeration safety**: signup duplicate-email = identical 201 (`views.py:125-128`);
  `resend_verification` always 202 (`views.py:217`); `password_reset_request` always
  200 (`views.py:376`).
- **Audit is append-only, service-layer-emitted, txn-shared** (invariant 5, B.4):
  every auth verb calls `emit_audit` inline inside the verb's transaction.
- **2FA lockout counter is separate from axes** — a correct password must not reset
  the second-factor budget (`twofa.py:50-54`; `tests/test_twofa_ratelimit.py`).

---

## Failure modes / sharp edges (verified)

- **Email is best-effort** (`fail_silently=True` in `mailer.py:38-46`,
  `password_reset.py:110`, `signup` view send). A signup/reset can commit with no mail
  delivered; the user is stuck unless `resend_verification` works.
- **`_invalidate_all_sessions_for_user` is an O(n) full-table scan** decoding every
  `django_session` row (`password_reset.py:176-192`); the docstring caps the
  assumption at <10k active sessions.
- **2FA challenge has no server-side challenge token**: the SPA re-sends the password,
  so credentials persist client-side (module scope) for the challenge duration; a page
  reload mid-challenge loses `pendingCredentials` → "Session expired"
  (`authStore.ts:107-110`).
- **`email_not_verified` runs a second `check_password`** after `authenticate` already
  failed (`views.py:249`) — extra hash cost, and that branch bypasses axes counting.
- **Cache-backed limiters lose state on flush/restart** (password-reset limiter
  `password_reset.py:45-59`, 2FA lockout `twofa.py:208-220`); `LocMemCache` is
  per-process, so counters are ineffective across multiple workers in dev.
- **Route hyphen-alias drift** (above) silently breaks the SPA if an alias is removed.

---

## Corrections vs. breadth-pass note (`docs/superpowers/analysis/flow-auth.md`)

The breadth note is accurate in substance. Precision corrections applied here:

- The note implies signup's verification email is inside the service; it is **sent in
  the VIEW** (`views.py:130-136`) AFTER `perform_signup` returns — i.e. **outside** the
  atomic block, which is why a mail failure cannot roll back the committed rows.
- `accept_invitation`'s session cycle is sequenced *after* `transaction.atomic()`
  exits by ordinary control flow (`invitation.py:387-390`), **not** via
  `transaction.on_commit`. No auth verb in this flow uses `on_commit`.
- Login success returns `{"status":"ok"}` with **no user payload**; the SPA therefore
  always performs a follow-up `GET /me/` (`authStore.ts:83`) — the `res.user ?? me()`
  fallback always takes the `me()` branch.
