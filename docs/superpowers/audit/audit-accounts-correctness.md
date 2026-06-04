# Accounts App — Correctness & Logic Bug Audit

**Audit date:** 2026-06-04  
**Scope:** `backend/apps/accounts/` — wrong conditionals, off-by-one, races, wrong queryset filters, missing `transaction.atomic` / `on_commit`, serializer-model mismatch, wrong HTTP status (idempotent replay must be 200), `None` handling, tz math.  
**Lens:** Correctness only (no style, no performance unless it is a correctness risk).

---

## Findings

---

### F-01 — MEDIUM | Wrong HTTP status on duplicate-email path (views.py:125)

**File:** `backend/apps/accounts/views.py:118–127`

**Evidence:**
```python
# Idempotent replay → return 200 with same status payload.
if not result.created and not result.duplicate_email:
    return Response({"status": "pending_verification"}, status=status.HTTP_200_OK)

# Duplicate-email path is enumeration-safe per B.11: identical 201.
if result.duplicate_email:
    return Response(
        {"status": "pending_verification"}, status=status.HTTP_201_CREATED
    )
```

**Why it matters:**  
The comment correctly calls the second branch the "duplicate-email path" and deliberately returns 201 (enumeration-safe). However the first branch — the true idempotency replay — also falls through to the view's final `return Response(..., status=HTTP_201_CREATED)` at line 148 *only if both flags are False* and goes through the `send_mail` block. The condition at line 118 says `not result.created and not result.duplicate_email` → returns 200. That is architecturally correct for the idempotency replay path.

The real bug is the `duplicate_email` path returning 201 while the idempotency replay returns 200. Architectural invariant 3 states "re-submitting returns the existing record (200, not 201)". A `duplicate_email` hit is NOT a new creation — a user already exists. The view sends 201, which tells the client "a new resource was created." This is factually incorrect and clients that check the status code to decide whether to display "check your inbox" vs "welcome" will be confused. The correct status is 200 (consistent with the idempotency replay branch).

**Recommendation:** Change the `duplicate_email` branch to return `HTTP_200_OK` to be consistent with invariant 3 and with the idempotency replay branch. The enumeration-safe requirement is met by the *identical response body*, not by the status code.

---

### F-02 — HIGH | Race condition: duplicate-email check is outside `transaction.atomic` (signup.py:242–250)

**File:** `backend/apps/accounts/services/signup.py:242–254`

**Evidence:**
```python
# -- Duplicate email guard (enumeration-safe per B.11) ---------------
if User.objects.filter(email=email).exists():
    return SignupResult(
        user=User.objects.get(email=email),
        ...
        duplicate_email=True,
    )

ttl_hours = getattr(settings, "EMAIL_VERIFICATION_TTL_HOURS", 48)

with transaction.atomic():
    # 1. User
    user = User.objects.create_user(...)
```

**Why it matters:**  
The `exists()` + `get()` + `create_user()` sequence is not inside a single `transaction.atomic` block. Two concurrent signups with the same email can both pass the `exists()` guard (both see False), then both attempt `create_user()`. The second one hits the unique DB constraint on `email` and raises `IntegrityError`, which is unhandled — the user sees a 500. Even if the `IntegrityError` were caught and handled, the `get(email=email)` at line 248 has a TOCTOU window: between the `exists()` and the `get()`, the row could be inserted by another request, making the `get()` succeed coincidentally (race) or the row could be deleted, making `get()` raise `DoesNotExist`.

**Recommendation:** Wrap the entire guard + atomic create in one outer `transaction.atomic()`, or use `select_for_update()` / `get_or_create()` with a unique constraint catch (`IntegrityError` → return `duplicate_email=True`). The simplest fix is to catch `IntegrityError` inside the existing `with transaction.atomic():` block if `create_user` raises it.

---

### F-03 — HIGH | `_verify_recovery` is not atomic — double-spend window (twofa.py:197–214)

**File:** `backend/apps/accounts/services/twofa.py:197–214`

**Evidence:**
```python
def _verify_recovery(user: User, code: str) -> bool:
    candidate = _normalize_recovery(code)
    qs = RecoveryCode.objects.filter(user=user, used_at__isnull=True)
    for row in qs:
        try:
            _HASHER.verify(row.code_hash, candidate)
        except VerifyMismatchError:
            continue
        ...
        row.used_at = timezone.now()
        row.save(update_fields=["used_at"])
        return True
    return False
```

**Why it matters:**  
Two simultaneous login requests with the same recovery code can both iterate the queryset, both find the unused row (because `used_at` is still `NULL` at DB read time), pass argon2id verification, and both call `row.save(used_at=now)`. Both succeed — the same recovery code is consumed twice, creating a double-spend. This is especially dangerous because recovery codes are the fallback when the TOTP device is lost.

The queryset `filter(used_at__isnull=True)` does not hold a row-level lock; it is a snapshot read.

**Recommendation:** Use `select_for_update()` on the recovery code queryset, wrapped in `transaction.atomic()`. Alternatively, use `RecoveryCode.objects.filter(id=row.id, used_at__isnull=True).update(used_at=now())` and check the returned rowcount equals 1 before treating it as consumed.

---

### F-04 — HIGH | `/api/accounts/me/` returns 403 instead of 401 when unauthenticated (views.py:416)

**File:** `backend/apps/accounts/views.py:416`

**Evidence:**
```python
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def me_view(request: Request) -> Response:
```

**Why it matters:**  
DRF's `IsAuthenticated` permission class returns HTTP 403 by default when no authentication credentials are present (because DRF's default authenticator yields an `AnonymousUser` rather than raising `NotAuthenticated`). When `DEFAULT_AUTHENTICATION_CLASSES` does not include session auth returning a 401 challenge, an unauthenticated GET `/api/accounts/me/` returns 403. The frontend login page at `/login` polls or lazy-checks `/api/accounts/me/` to determine whether the user is logged in. Getting 403 instead of 401 causes a premature "forbidden" error banner in the SPA (already listed as a known issue). This is a correctness bug: "forbidden" (403) means "authenticated but not allowed"; "unauthenticated" should be 401.

**Recommendation:** Add `authentication_classes` that includes `SessionAuthentication` on `me_view` (or globally), and ensure `SessionAuthentication` raises `NotAuthenticated` for anonymous requests (DRF raises 401 when authentication fails with `WWW-Authenticate`). Alternatively, explicitly check `request.user.is_authenticated` at the top of the view and return 401 manually.

---

### F-05 — MEDIUM | `_invalidate_all_sessions_for_user` iterates inside `@transaction.atomic` (password_reset.py:176)

**File:** `backend/apps/accounts/services/password_reset.py:126–173`

**Evidence:**
```python
@transaction.atomic
def complete_password_reset(...) -> User:
    ...
    _invalidate_all_sessions_for_user(user)
    ...

def _invalidate_all_sessions_for_user(user: User) -> None:
    ...
    for session in Session.objects.iterator(chunk_size=500):
        ...
        if str(data.get("_auth_user_id", "")) == target_id:
            session.delete()
```

**Why it matters:**  
`_invalidate_all_sessions_for_user` is called *inside* `complete_password_reset`'s `@transaction.atomic` block. The session deletions therefore participate in the same transaction as the password change. If the outer transaction later rolls back (e.g., due to an exception in `emit_audit`), the password is not changed but the sessions are already marked for deletion within the transaction — in practice the session rows will be deleted only when the transaction commits, so if it rolls back, sessions are preserved. That part is safe.

However, iterating `Session.objects.iterator()` inside a transaction holds the DB connection open for potentially many rows (O(n) over all sessions), which increases lock contention and latency under load. More importantly, on a database that stores sessions in the same Postgres instance (which is the case here), iterating a large session table while holding an open transaction on the `accounts_password_reset_token` row can cause deadlock patterns if concurrent requests also touch sessions.

Additionally, `session.delete()` inside the loop performs one DELETE per row inside one transaction, rather than a bulk delete — this is O(n) round-trips.

**Recommendation:** Move `_invalidate_all_sessions_for_user` to run in a separate transaction after the main one commits, using `transaction.on_commit`. Or, if same-transaction guarantees are required, replace the per-row loop with a bulk approach (decode + collect IDs, then `Session.objects.filter(pk__in=ids).delete()`).

---

### F-06 — MEDIUM | `reauth_view` stores naive datetime in session (views.py:284)

**File:** `backend/apps/accounts/views.py:284`

**Evidence:**
```python
request.session["last_password_reauth"] = timezone.now().isoformat()
```

`timezone.now()` returns a timezone-aware datetime when `USE_TZ=True`. `.isoformat()` on an aware datetime includes the `+00:00` suffix (e.g., `"2026-06-04T12:00:00+00:00"`).

**File:** `backend/apps/accounts/decorators.py:41–47`

```python
when = datetime.fromisoformat(stamp)
...
if timezone.is_naive(when):
    when = timezone.make_aware(when, timezone.get_current_timezone())
```

**Why it matters:**  
`datetime.fromisoformat()` in Python 3.11+ correctly parses the `+00:00` suffix and returns a timezone-aware object. However, in Python 3.10 and earlier, `datetime.fromisoformat()` cannot parse the `+00:00` suffix and raises `ValueError`, which is caught and sets `when = None`, causing the decorator to always return 403 (reauth required) even immediately after a valid reauth — breaking the sensitive-verb gate entirely. The project specifies Python 3.13, so this is not a current bug, but it becomes a footgun if the runtime is ever downgraded.

More practically, the `timezone.get_current_timezone()` used in the naive-datetime fallback branch may differ from UTC — if a server timezone is misconfigured, the comparison `timezone.now() - when <= timedelta(minutes=window)` could produce an off-by-(hours) error. The aware path is correct; the naive fallback branch uses local server timezone rather than UTC.

**Recommendation:** Store the session stamp as a UTC integer timestamp (`int(timezone.now().timestamp())`) and compare as `time.time() - stamp <= window_seconds`. This is immune to parsing and timezone-offset bugs. If ISO format is preferred, parse with `datetime.fromisoformat` and handle the aware case explicitly rather than relying on the naive fallback branch.

---

### F-07 — MEDIUM | `perform_signup` calls `User.objects.get()` after `exists()` — potential `DoesNotExist` (signup.py:248)

**File:** `backend/apps/accounts/services/signup.py:244–249`

**Evidence:**
```python
if User.objects.filter(email=email).exists():
    return SignupResult(
        user=User.objects.get(email=email),
        ...
    )
```

**Why it matters:**  
Between `exists()` returning `True` and `get()` executing, another request or admin action could soft-delete (which anonymizes the email to `deleted-{id}@invalid`) or hard-delete the user. In that case `get()` raises `User.DoesNotExist`, which is unhandled and surfaces as an unhandled 500.

**Recommendation:** Replace the `exists()` + `get()` pair with a single `filter(...).first()` and check the result for `None`.

---

### F-08 — LOW | `verify_email` view uses `@transaction.atomic` decorator but `emit_audit` is NOT on_commit (views.py:154)

**File:** `backend/apps/accounts/views.py:154–186`

**Evidence:**
```python
@api_view(["POST"])
@permission_classes([AllowAny])
@transaction.atomic
def verify_email(request: Request) -> Response:
    ...
    user.save(update_fields=["is_active", "email_verified_at"])
    token.save(update_fields=["used_at"])
    emit_audit(...)
    return Response({"status": "verified"})
```

**Why it matters:**  
Architectural invariant 4 states "Every state-changing action publishes to Redis pub/sub *after* the DB transaction commits (`transaction.on_commit`)." The `emit_audit` call here is inside the atomic block — which is correct for DB-consistency of the audit row itself. However, if `emit_audit` were ever changed to also push to Redis (or if a caller wraps this in another transaction), the push would happen before commit. This is a latent invariant violation rather than an active bug today, since `emit_audit` currently only writes to DB.

More concretely: if `emit_audit` raises (e.g., DB constraint on AuditEvent), the entire `verify_email` transaction rolls back — including the `user.is_active = True` save. The user's email is then not verified. There is no retry, so the user is permanently stuck with an unusable token (it was not marked `used_at` because the rollback wiped that too) and an unverified account. This is a crash-leaves-inconsistency risk.

**Recommendation:** Emit audit with `emit_audit_on_commit` for the `email_verified` event so that the audit write failure cannot roll back the verification state. The token mark-as-used and user activation are the critical state changes; the audit is a side-effect.

---

### F-09 — LOW | `_pick_unique_slug` checks slug availability outside any transaction (signup.py:119–154)

**File:** `backend/apps/accounts/services/signup.py:119–154`

**Evidence:**
```python
def _pick_unique_slug(seed: str) -> str:
    ...
    if Organization.objects.filter(slug=slug).exists():
        return True
    ...
    return candidate
```

`_pick_unique_slug` is called from `_derive_slug`, which is called inside `with transaction.atomic()` at line 264. However, the slug availability check (`_slug_taken`) uses a plain `exists()` without `select_for_update()`. Two concurrent signups with the same org name can both pick the same slug, both pass `_slug_taken()`, and then both attempt `Organization.objects.create(slug=...)`. One will fail with `IntegrityError` if the slug column has a unique constraint, or both will succeed with duplicate slugs if it does not.

**Why it matters:**  
A duplicate slug on Organization would break all public URL routing (slug is used in public-facing URLs).

**Recommendation:** The `Organization.slug` field should carry a `unique=True` constraint at the DB level (check that the Organization model enforces this). Within the signup transaction, catch `IntegrityError` on `Organization.objects.create()` and retry slug selection. This is the standard Django pattern for unique-slug allocation under concurrency.

---

### F-10 — LOW | `MeSerializer.get_memberships` — `m.role` stored as string in list, compared with `not in` (serializers.py:160)

**File:** `backend/apps/accounts/serializers.py:160`

**Evidence:**
```python
if m.role not in entry["roles"]:
    entry["roles"].append(m.role)
```

**Why it matters:**  
`m.role` is a Django `TextChoices` / `CharField` value — it is a string. The comparison `not in` against a list of previously appended values works correctly as a string equality check, so there is no crash. However, if the same user has two `OrganizationMembership` rows for the same org with the same role (which is possible if the model has no unique constraint on `(user, organization, role)`), this guard deduplicates correctly. No active bug, but it silently hides a data-model invariant violation.

**Recommendation:** Verify that `OrganizationMembership` carries a `UniqueConstraint` on `(user, organization, role)`. If not, add one. This is a data-model gap rather than a serializer bug.

---

### F-11 — LOW | `_rate_limit_hit` has a TOCTOU race between `cache.get` and `cache.incr` (password_reset.py:45–59)

**File:** `backend/apps/accounts/services/password_reset.py:45–59`

**Evidence:**
```python
def _rate_limit_hit(key: str, limit: int, window_seconds: int = 3600) -> bool:
    current = cache.get(key, 0)
    if current >= limit:
        return True
    try:
        cache.add(key, 0, window_seconds)
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, window_seconds)
    return False
```

**Why it matters:**  
Between `cache.get(key, 0)` returning `limit - 1` and `cache.incr(key)` executing, two concurrent requests can both read `limit - 1`, both pass the guard, and both increment — ending up at `limit + 1`. For the password-reset rate-limit, this means `limit + (n_concurrent - 1)` requests can slip through instead of `limit`. This is a minor over-allowance (not a security hole that bypasses the limit entirely), but it means the rate limit is not precise under concurrency.

With `LocMemCache` (current dev default), this is not thread-safe at all. With Redis, `INCR` is atomic but the `GET + conditional-ADD + INCR` sequence is not.

**Recommendation:** Replace with an atomic Redis `INCR` + `EXPIRE` sequence (use `cache.incr` and set TTL via a pipeline or Lua script), or use Django's `cache.add` return value to detect first-add and build on atomic incr. Django's `cache.incr` on a missing key raises `ValueError`, so the current fallback is intentional, but the check-then-act pattern is still racy.

---

### F-12 — INFO | `login_view` — 2FA verified but `login()` called unconditionally after 2FA branch (views.py:225–253)

**File:** `backend/apps/accounts/views.py:225–253`

**Evidence:**
```python
if user.has_2fa_enrolled:
    if not totp_code:
        return Response({"requires_2fa": True}, status=status.HTTP_200_OK)
    if not twofa_svc.verify_totp_or_recovery(user, totp_code, request=request):
        ...
        return Response({"detail": "invalid_2fa"}, status=status.HTTP_400_BAD_REQUEST)

login(request, user)
```

**Why it matters:**  
The control flow is correct: if 2FA is enrolled and the code is missing, the function returns early. If the code is wrong, it returns early. Only if the code is correct (or 2FA is not enrolled) does `login()` execute. No bug here, but worth noting that the `login()` call is not inside an `else:` block — its correctness depends entirely on the `return` statements in the branches above. This is safe but fragile to future edits (adding a new branch without a `return` would inadvertently call `login()`).

**Recommendation:** Refactor the 2FA block into an explicit `else: login(...)` structure for defensive clarity.

---

### F-13 — INFO | `soft_delete` does not revoke active sessions (models.py:103)

**File:** `backend/apps/accounts/models.py:103–111`

**Evidence:**
```python
def soft_delete(self) -> None:
    self.deleted_at = timezone.now()
    self.email = f"deleted-{self.id}@invalid"
    self.name = "[Deleted]"
    self.is_active = False
    self.save(update_fields=["deleted_at", "email", "name", "is_active"])
```

**Why it matters:**  
Setting `is_active = False` prevents new logins but does NOT invalidate active sessions. Django's `AuthenticationMiddleware` caches the user object on the session and checks `is_active` on each request, but this depends on `SESSION_COOKIE_AGE` and the session backend. Until session expiry, a soft-deleted user's existing session cookie continues to authenticate requests successfully (for up to the session age, typically 2 weeks).

The `complete_password_reset` service correctly calls `_invalidate_all_sessions_for_user()`. The `soft_delete` path does not.

**Recommendation:** Call `_invalidate_all_sessions_for_user(self)` (or a similar session-clearing function) inside `soft_delete()`. The function lives in `password_reset.py` — extract it to a shared utility or replicate it in the user model/service layer.

---

## Gaps (forward-looking, not active bugs)

| # | Area | Gap | Needed for | Effort |
|---|------|-----|-----------|--------|
| G-01 | Signup | No test exercises the concurrent duplicate-email race (F-02) — only sequential coverage exists. | CI confidence | M |
| G-02 | 2FA | `_verify_recovery` has no concurrent-use test (F-03). Add a test that fires two simultaneous login requests with the same recovery code and asserts only one succeeds. | Security | M |
| G-03 | `/me` 401 | No test asserts that an unauthenticated GET `/api/accounts/me/` returns 401, not 403 (F-04 known issue). | Frontend login-flow UX | S |
| G-04 | Session invalidation on soft-delete | No test asserts that a soft-deleted user's active session is immediately invalidated (F-13). | Security | S |
| G-05 | `Organization.slug` uniqueness | No evidence of a `unique=True` DB constraint on `Organization.slug` from this audit; needs verification in the organizations app (F-09). | Data integrity | S |
| G-06 | `_invalidate_all_sessions_for_user` scalability | O(n) full-table scan is acceptable at v1 scale (<10k sessions), but there is no index on `django_session` keyed by user_id — session invalidation after password reset walks every row. As session count grows this becomes slow. | Scalability | L |
| G-07 | Password reset `complete_password_reset` — no test for the crash-leaves-inconsistency scenario where `emit_audit` fails mid-transaction (F-08). | Resilience | M |
