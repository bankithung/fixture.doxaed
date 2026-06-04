# Deep-Dive Audit — Auth / Session / 2FA / Recovery / Reset / Reauth

**Scope:** `backend/apps/accounts/` — full call-path trace of login → session →
2FA(TOTP) → recovery-code → password-reset → reauth.
**Pass:** Second, deeper pass (beyond pass-1 map). Exploit-style reasoning with
exact `file:line` and quoted evidence.
**Date:** 2026-06-04
**Confidence legend:** HIGH = code path proven from source; MED = depends on
runtime/config not fully visible; LOW = speculative / needs runtime confirm.

---

## Call-path map (as actually wired)

```
POST auth/login/        login_view            views.py:197
  authenticate()  -> axes backend + ModelBackend   views.py:205
  is_active/deleted gate                            views.py:222
  has_2fa_enrolled gate                             views.py:225
    verify_totp_or_recovery()  twofa.py:217
      _verify_totp (pyotp valid_window=1)           twofa.py:111
      _verify_recovery (argon2, O(n))               twofa.py:197
  login() + cycle_session_on_role_change()          views.py:243-244

POST auth/reauth/       reauth_view           views.py:277
  check_password -> session['last_password_reauth'] views.py:282-284

require_recent_password_reauth (decorator)    decorators.py:23
  *** NEVER APPLIED TO ANY VIEW ***

POST auth/password_reset_request/  -> request_password_reset  password_reset.py:62
POST auth/password_reset_complete/ -> complete_password_reset password_reset.py:126
POST auth/2fa/{enroll,confirm,disable,recovery:regenerate}    views.py:338-396
```

---

## TOP FINDINGS (ranked by exploitability)

---

### F1 — 2FA / recovery-code brute force: NO rate limit on the second factor (HIGH, Critical)

**Files:** `backend/apps/accounts/views.py:194-241`,
`backend/apps/accounts/services/twofa.py:111-247`,
`backend/fixture/settings/base.py:160-183`.

**The defect.** The TOTP/recovery second factor is checked *after* the password
factor succeeds, and nothing rate-limits the second factor.

1. `login_view` calls `authenticate(...)` (views.py:205). With a **correct
   password**, axes treats this as a success. `AXES_RESET_ON_SUCCESS = True`
   (base.py:183) so axes **resets the failure counter to zero on every correct
   password**.
2. The 2FA branch runs only after that success:
   ```python
   225  if user.has_2fa_enrolled:
   226      if not totp_code:
   227          return Response({"requires_2fa": True}, status=...200)
   231      if not twofa_svc.verify_totp_or_recovery(user, totp_code, request=request):
   241          return Response({"detail": "invalid_2fa"}, status=400)
   ```
3. A wrong 2FA code returns `400` but **does NOT touch axes** — axes only
   instruments the `authenticate()` credential check, and that check *passed*.
   No `AxesBackend` failure is recorded for a bad TOTP. Confirmed: the only
   axes signals come from the password path; there is no axes call on the 2FA
   branch (grep of `AXES_*` shows wiring only in settings + the password test).
4. The login endpoint carries **only** the default `AnonRateThrottle` = `60/min`
   (base.py:161-168). It has no view-scoped throttle (grep: the only
   `@throttle_classes` in the app is `SignupRateThrottle` on `signup`,
   views.py:89). So an attacker who knows the victim's password (phished,
   re-used, or leaked) can submit **60 TOTP guesses per minute, indefinitely**,
   because each request re-supplies the correct password and re-zeros axes.

**TOTP exploitability.** `_verify_totp` uses `valid_window=1` (twofa.py:115),
i.e. 3 acceptable 30s windows. A 6-digit code = 10^6 space; with 3 live codes
the per-guess hit probability is ~3/10^6. At 60/min that is ~86,400 guesses/day
→ ~p≈0.26 chance/day of a hit, and the valid window keeps sliding so the search
never "expires". This is a textbook bypassable second factor.

**Recovery-code exploitability is worse.** Recovery codes are 10 base32-ish
chars but only `string.ascii_uppercase + string.digits` (twofa.py:47), and the
**same login endpoint accepts a recovery code in the `totp_code` field**
(`verify_totp_or_recovery` tries TOTP then recovery, twofa.py:217-247). There
are 10 live codes per user; an attacker grinding the login endpoint is grinding
both factors at once with no lockout.

**Even axes would not help** as currently configured: `AXES_LOCKOUT_PARAMETERS
= ["ip_address", "username"]` (base.py:182) keys on the *credential* attempt.
The 2FA branch never reaches the credential backend on a 2FA-only failure, so
the counter is not incremented and `AXES_RESET_ON_SUCCESS` actively erases any
prior count on each correct-password submission.

**Fix.** Add a dedicated per-(user|ip) throttle/lockout on the 2FA branch
(separate cache counter, e.g. 5 failures → 15-min cooldown, mirroring axes),
increment it inside the `if not verify_totp_or_recovery` block, and do NOT reset
it on TOTP success only after N failures. Alternatively split login into a
password step that mints a short-lived "2fa_pending" token and rate-limit the
2FA submission on that token.

---

### F2 — Sensitive-verb reauth enforcement is dead code; B.18 not enforced anywhere (HIGH, High)

**Files:** `backend/apps/accounts/decorators.py:23-57`,
`backend/apps/accounts/views.py:277-285, 369-382, 449-474`.

**The defect.** `require_recent_password_reauth(...)` is fully implemented
(decorators.py:23) and `reauth_view` correctly writes
`request.session["last_password_reauth"]` (views.py:284), but **the decorator
is applied to zero views**. Grep across the entire backend:

```
backend\apps\accounts\decorators.py:23:def require_recent_password_reauth(...)
   ── that is the ONLY occurrence. No `@require_recent_password_reauth` call site exists.
```

v1Users.md B.18 (quoted in decorators.py:4-7) requires: "any 'sensitive verb'
(suspend, impersonate, transfer ownership, **force-disable 2FA, delete Org**)
MUST re-prompt for password regardless of session age." The sensitive verbs
present in this app are unguarded:

- `twofa_disable_view` (views.py:369-382) — disables 2FA with **no reauth
  check**. An attacker who hijacks a live session (XSS-stolen cookie, shared
  machine, fixation) can strip the victim's 2FA outright, then change nothing
  else is required. This is the exact "force-disable 2FA" verb B.18 names.
- `user_soft_delete_view` (views.py:449-474) — super-admin destructive verb,
  no reauth.
- `twofa_recovery_regenerate_view` (views.py:391-396) — regenerates recovery
  codes (invalidates the victim's printed codes, mints attacker-known ones),
  no reauth.

**Exploit.** Hijacked/borrowed session → `POST auth/2fa/disable/` succeeds with
just the session cookie + CSRF token (both readable: `CSRF_COOKIE_HTTPONLY =
False`, base.py:149). 2FA defeated with no password challenge. B.18 invariant
violated.

**Fix.** Decorate `twofa_disable_view`, `twofa_recovery_regenerate_view`,
`user_soft_delete_view` (and future suspend/impersonate/transfer/delete-org
verbs) with `@require_recent_password_reauth()`. Add a test asserting these
return `403 password_reauth_required` without a fresh reauth marker.

---

### F3 — Per-IP rate limits trust spoofable `X-Forwarded-For` (HIGH, High)

**Files:** `backend/apps/accounts/services/password_reset.py:38-42, 78-83`.

**The defect.** `_client_ip` takes the **first** value of `X-Forwarded-For`
verbatim, with no proxy-count validation:

```python
38  def _client_ip(request):
41      forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
42      return forwarded or request.META.get("REMOTE_ADDR") or None
```

The per-IP password-reset budget keys on this value
(`per_ip_key = f"pwreset:ip:{ip}"`, password_reset.py:80). Since a client fully
controls the `X-Forwarded-For` header, an attacker rotates it on every request
(`X-Forwarded-For: 1.1.1.<n>`) and the per-IP limit
(`PASSWORD_RESET_RATE_PER_IP_HOUR = 10`, base.py:212) is trivially bypassed.
The per-email limit (5/hr) still caps per-target, but the per-IP control —
intended to stop a single host from spraying *many* accounts — is defeated,
enabling mass reset-email flooding / user enumeration timing across many
addresses. Same blind-XFF pattern likely feeds `requested_ip` stored on the
token (password_reset.py:96), poisoning forensic data.

**Related (MED):** `SignupRateThrottle.get_cache_key` (throttling.py:32-36)
uses DRF `self.get_ident(request)`, which honors `NUM_PROXIES`. `NUM_PROXIES`
is **not set** anywhere in settings (grep: absent), so DRF default also reads
the client-supplied XFF chain — the 3/hr signup limit is likewise IP-spoofable.
In production behind nginx/Caddy the platform MUST set `NUM_PROXIES` and switch
`_client_ip` to use the same trusted-proxy logic (or `axes.helpers.
get_client_ip_address`, which is imported but unused — views.py:26,479).

**Fix.** Set `NUM_PROXIES` (or `IPWARE_*`/trusted-proxy config) and derive the
client IP only from the trusted hop. Replace `_client_ip` with the
proxy-aware helper. Until then the per-IP limits are advisory only.

---

## Additional findings

### F4 — Login 2FA gate leaks 2FA-enrollment status (MED, Low/Medium)

`login_view` returns `{"requires_2fa": True}` (views.py:227-230) on a
**correct password** for a 2FA user, but `{"status":"ok"}` for a correct
password without 2FA. An attacker with a candidate password can therefore learn
both (a) that the password is valid and (b) whether the account has 2FA — useful
target selection. Worse, this 200 response on correct-password+no-TOTP is the
same surface F1 abuses. Consider returning an opaque "continue" state and not
distinguishing 2FA presence until the second step.

### F5 — `verify_email` enables the account but does NOT cycle the session / is unauthenticated-safe but mass-assign-adjacent (MED, Low)

`verify_email` (views.py:155-186) flips `is_active=True` purely from a token,
`AllowAny`. That is correct for the flow, but note it has **no throttle** and
the token is `secrets.token_urlsafe(48)` (signup.py:292) → ~288 bits, sha256 at
rest — entropy is fine (HIGH confidence not brute-forceable). No finding on
entropy; flagged only that this endpoint, like login, has no per-IP throttle if
it is ever used to probe token validity timing.

### F6 — Reset/verify token entropy & storage: SOUND (HIGH, informational)

- Password-reset token: `secrets.token_urlsafe(48)` = 384 bits
  (password_reset.py:90), sha256-hashed at rest (models.py:211), single-use via
  `used_at` under `select_for_update()` (password_reset.py:143-161), TTL 60 min
  (base.py:210). No entropy/leak issue. The plaintext is only emailed; the
  *audit* row stores `token_id`, not plaintext (password_reset.py:121) — good.
- Email-verification token: same 48-byte urlsafe + sha256 (signup.py:292,
  models.py:253). Sound.
- **Caveat (LOW):** reset link is logged via console email backend in dev
  (dev.py:24) and the link is built as `/auth/reset?token=<plaintext>`
  (password_reset.py:99). If any prod logging captures email bodies the token
  leaks; keep tokens out of access logs. Informational.

### F7 — Recovery-code verification timing & correctness (MED→LOW)

`_verify_recovery` (twofa.py:197-214) iterates the user's unused codes and
argon2-verifies each. Argon2 verify is constant-time per comparison, but the
**loop short-circuits on first match** and the number of remaining unused codes
varies (10 → 0), so total response time is weakly correlated with how many
codes remain. Not a practical secret-leak (codes are high-entropy and the
per-attempt cost is dominated by argon2), but combined with F1's missing 2FA
throttle the argon2 cost is the *only* brake on recovery-code grinding — and 10
argon2 verifies per request at 60 req/min is a CPU-DoS lever against the single
4-vCPU VPS. Confidence MED.

### F8 — `recovery_code_consumed` audit, but no alert on TOTP-vs-recovery downgrade (LOW)

When a recovery code is consumed during login, audit fires
(`recovery_code_consumed`, twofa.py:237-245) — good. But there is no
notification to the user and no signal that a *second factor was downgraded to a
recovery code*, which is a common account-takeover indicator. v1 gap, not a
direct vuln.

### F9 — Session fixation defense is correct but partial (HIGH, informational)

`cycle_session_on_role_change` (session_security.py:21-31) calls
`session.cycle_key()` and is invoked after login (views.py:244), 2FA confirm
(views.py:365), and 2FA disable (views.py:381). `django.contrib.auth.login`
already cycles, so this is belt-and-suspenders — fine. **Gap:** `reauth_view`
(views.py:277-285) writes a privilege-elevating marker
(`last_password_reauth`) into the session but does **not** cycle the key. Low
risk because the marker only matters for verbs that are themselves unguarded
(see F2), but once F2 is fixed, an attacker who fixed a session pre-reauth and
then phishes the victim into reauthing would inherit the elevated marker.
Recommend cycling on reauth too (cheap, preserves data).

### F10 — `_invalidate_all_sessions_for_user` is O(n) full-table scan (LOW, availability)

`complete_password_reset` → `_invalidate_all_sessions_for_user`
(password_reset.py:176-192) decodes **every** row in `django_session` to find
the user's sessions. Documented as acceptable <10k sessions. With the LocMem
cache backend in base.py (CACHES, base.py:191-196) and DB-backed sessions this
is correct, but it is a self-inflicted latency/DoS multiplier inside a
`transaction.atomic` (ATOMIC_REQUESTS = True, base.py:102) holding a row lock
on the reset token. On a busy table a reset request can hold a transaction open
for the full scan. Prefer an indexed lookup (store `user_id` in a side table or
use `django-user-sessions`). Confidence MED.

---

## Cross-cutting config observations

- `CSRF_COOKIE_HTTPONLY = False` (base.py:149) is required for the SPA/HTMX to
  read the token, consistent with invariant 15 (session auth, no JWT). Combined
  with F2 (no reauth on sensitive verbs) it raises the blast radius of any XSS:
  a stolen session + readable CSRF token = full sensitive-verb access. Fixing F2
  is the mitigating control.
- `SESSION_COOKIE_AGE = 30 days` (base.py:147) "remember me" — long-lived
  sessions amplify F1/F2/F9. Acceptable per spec but note the interaction.
- Default cache is **LocMemCache** (base.py:191-196). All rate limiters
  (password reset, signup throttle, the F1 fix if cache-based) are **per-process
  and non-shared**. On a multi-worker ASGI deploy each worker has its own
  counter, multiplying every limit by the worker count. The prod cache MUST be
  Redis for any of these limits to hold. HIGH confidence this undermines F3/F1
  mitigations until Redis is wired.

---

## Suggested remediation order

1. **F1** — add 2FA-attempt lockout (critical; bypassable second factor).
2. **F2** — apply `require_recent_password_reauth` to disable-2fa, regenerate-
   recovery, soft-delete (and future suspend/impersonate/transfer/delete-org).
3. **F3** — trusted-proxy IP resolution + `NUM_PROXIES`; replace blind XFF.
4. **Config** — Redis cache in prod (makes 1 & 3 actually enforceable).
5. F9/F10/F7 hardening.
