# Audit Report: accounts — Error-Handling Lens

**Date:** 2026-06-04
**Scope:** `backend/apps/accounts/` (views, serializers, services/*, models, throttling, decorators)
**Lens:** bare/broad except, except:pass, masking fallbacks, missing validation, unguarded None/KeyError, non-atomic multi-writes, 500-on-bad-input where 400 is right, inconsistent error bodies.

---

## Findings

### F-01 · HIGH · Bare `except Exception` silently swallows `effective_modules` failure in `MeSerializer.get_memberships`

**File:** `backend/apps/accounts/serializers.py:169-172`

```python
try:
    modules = list(effective_modules(user, org))
except Exception:
    modules = []
```

**Why it matters:** Any exception from the permissions resolver — including DB errors, programming bugs, or a missing `PermissionModule` row — is swallowed silently. The caller receives `effective_modules: []` with no indication something went wrong. A misconfigured permission module will make every org look like it has no modules; users lose access to all features with no visible error. The broad catch also hides genuine bugs that should surface loudly during development.

**Recommendation:** Narrow to expected exceptions (e.g., `ObjectDoesNotExist`). Re-raise or log with `logger.exception` anything unexpected so Sentry/logfiles catch it. At minimum add `logger.exception("effective_modules failed for user=%s org=%s", user.pk, org.pk)` inside the catch before falling back to `[]`.

---

### F-02 · HIGH · `_invalidate_all_sessions_for_user` bare `except Exception: continue` silently skips corrupt sessions but also hides decode errors that could affect the user

**File:** `backend/apps/accounts/services/password_reset.py:185-187`

```python
try:
    data = session.get_decoded()
except Exception:  # pragma: no cover - garbled session payload
    continue
```

**Why it matters:** A corrupt session is acceptable to skip, but using `except Exception` (rather than the specific `SuspiciousOperation` / `BadSignature` Django raises on tampered sessions) also silently absorbs `OperationalError`, `DatabaseError`, or any bug inside `get_decoded`. If the session table itself is broken, the loop finishes without invalidating any sessions, password reset "succeeds," but old sessions remain live. There is no log entry because the `continue` does not log, so the incident is invisible.

**Recommendation:** Log `logger.warning` on the except branch. Narrow to `Exception as exc: logger.warning("Skipping undecodable session %s: %s", session.session_key, exc)` so the exception type is visible. Consider also narrowing to `(django.core.signing.BadSignature, django.utils.datastructures.MultiValueDictKeyError)` which are the realistic causes.

---

### F-03 · HIGH · `enroll_totp` bare `except Exception` for QR code generation hides `cryptography` import errors — decrypt fails downstream

**File:** `backend/apps/accounts/services/twofa.py:101-102`

```python
except Exception:  # pragma: no cover - QR is best-effort
    logger.exception("Failed to render 2FA QR code; returning URI only")
```

**Why it matters:** The comment says QR is best-effort — that is fine. However the `except Exception` block also catches `ImportError` raised if `qrcode` is missing, which is expected. The issue is that this same broad catch would also mask an exception from the `buf.getvalue()` or `base64.b64encode` lines — which can only fail due to logic errors, not missing deps. The `logger.exception` call does at least log the traceback, so this is a lower-severity broad-except compared to F-01/F-02. Still, `# pragma: no cover` means the branch is never exercised in tests, so errors go undetected until production.

**Recommendation:** Wrap only the `import qrcode` in a `try/except ImportError`. Wrap the generation lines in a separate narrower block. Mark the generation block as best-effort log only, not blanket `except Exception`.

---

### F-04 · HIGH · `perform_signup` bare `except Exception` on `Organization.objects.create` converts DB errors to `ValidationError` — loses the real error

**File:** `backend/apps/accounts/services/signup.py:277-279`

```python
except Exception as exc:  # pragma: no cover - defensive
    logger.exception("Path B signup: org create failed")
    raise ValidationError("Unable to provision organization for signup.") from exc
```

**Why it matters:** Converting any `Exception` to `ValidationError` (a Django form-level error) will bubble up through DRF and — since `ValidationError` from Django (not DRF) is not automatically handled by DRF exception handler — will likely produce a 500 instead of a 400. `IntegrityError` (slug collision race) would produce a 500 here. The whole signup transaction is already wrapped in `transaction.atomic()`, so a DB error will roll back correctly, but the client receives an unhelpful 500.

**Recommendation:** Catch `IntegrityError` specifically to map slug/unique-constraint races to a 400 `ValidationError`. Let other `Exception` types propagate unmasked. Remove the blanket conversion.

---

### F-05 · MEDIUM · `_crypto.decrypt_secret` silently returns stored ciphertext when Fernet is unavailable — TOTP shared secret exposed in DB as plaintext fallback is not guarded

**File:** `backend/apps/accounts/services/_crypto.py:59-62`

```python
if f is None:  # pragma: no cover - mismatch only in degraded prod
    return stored
```

**Why it matters:** If `cryptography` is somehow not installed (CI pip error, corrupted venv), `decrypt_secret` returns the `fernet$...` token string as-is, and `pyotp.TOTP(stored)` will fail with an unhandled `binascii.Error` or `ValueError` — not a graceful 400. This turns a missing dependency into an opaque 500 during login for every 2FA user.

**Recommendation:** Add an explicit guard: if `_HAS_FERNET` is False and the stored value starts with `_PREFIX`, raise a `RuntimeError("cryptography package required for 2FA but not installed")` rather than returning junk. This surfaces the operational error loudly rather than propagating invalid data silently.

---

### F-06 · MEDIUM · `login_view` returns HTTP 403 (not 401) for `account_inactive`; `/api/accounts/me/` already returns HTTP 403 for unauthenticated requests (known issue) — inconsistent 4xx semantics across the auth surface

**File:** `backend/apps/accounts/views.py:222-223`

```python
if not user.is_active or user.deleted_at is not None:
    return Response({"detail": "account_inactive"}, status=status.HTTP_403_FORBIDDEN)
```

**Why it matters:** RFC 9110: 401 = "not authenticated / credential invalid"; 403 = "authenticated but not authorized." A soft-deleted or inactive account fails authentication — the right code is 401 or 400 (axes uses 403; many clients treat 403 as "authenticated but forbidden"). More concretely, the SPA checks for 403 from `/me/` to decide whether to show an error banner (the KNOWN ISSUE); this 403 from login also triggers that banner prematurely.

**Recommendation:** Return 400 with `{"detail": "account_inactive"}` (matching the pattern of `invalid_credentials`) or 401. Align with the `/me/` 401 fix.

---

### F-07 · MEDIUM · `_verify_recovery` iterates all 10 recovery-code hashes in application code without `select_for_update` — race condition allows double-spend under concurrent logins

**File:** `backend/apps/accounts/services/twofa.py:197-213`

```python
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
```

**Why it matters:** Two simultaneous login requests with the same recovery code will both read the `used_at__isnull=True` queryset before either writes, and both will verify the hash successfully and mark the row used. The second write silently overwrites the first's `used_at`. The net effect: a recovery code can be consumed twice, violating the "single-use enforced" guarantee (B.14). This is a non-atomic read-then-write.

**Recommendation:** Add `select_for_update()` to the queryset inside a `transaction.atomic` block (the caller `verify_totp_or_recovery` is not itself atomic). Or use a `filter(used_at__isnull=True).update(used_at=now)` returning the number of rows updated (1 = success, 0 = already consumed).

---

### F-08 · MEDIUM · `signup_view` calls `perform_signup` which itself checks `User.objects.filter(email=email).exists()` then `User.objects.get(email=email)` — two separate queries; race between them can cause `User.DoesNotExist` → 500

**File:** `backend/apps/accounts/services/signup.py:242-249`

```python
if User.objects.filter(email=email).exists():
    return SignupResult(
        user=User.objects.get(email=email),
        ...
    )
```

**Why it matters:** Between the `.exists()` and the `.get()` call, the user could be hard-deleted (or an adversary race-conditions a deletion). In that case `.get()` raises `User.DoesNotExist` which is unhandled and produces a 500. Probability is low but the fix is trivial.

**Recommendation:** Replace with a single `User.objects.filter(email=email).first()` and check `if user is not None`.

---

### F-09 · MEDIUM · `reauth_view` stores `timezone.now().isoformat()` as a naive datetime string in the session; `decorators.py` then applies `timezone.make_aware` only conditionally — TZ-aware/naive mismatch when `USE_TZ=True`

**File:** `backend/apps/accounts/views.py:284`

```python
request.session["last_password_reauth"] = timezone.now().isoformat()
```

**File:** `backend/apps/accounts/decorators.py:44-47`

```python
if timezone.is_naive(when):
    when = timezone.make_aware(when, timezone.get_current_timezone())
```

**Why it matters:** `timezone.now()` with `USE_TZ=True` returns a timezone-aware datetime. Its `.isoformat()` includes the UTC offset (`+00:00`). `datetime.fromisoformat(stamp)` on Python 3.11+ correctly re-parses the offset, producing an aware datetime — and `timezone.is_naive` is False, so `make_aware` is skipped and comparison works. On Python 3.10 and below, `fromisoformat` does NOT parse timezone offsets and returns a naive datetime, causing an `AwareLocalTimeAsNaive` comparison error in the subtraction `timezone.now() - when`. The project targets Python 3.13 so this is currently benign, but the code path is fragile and not obvious.

**Recommendation:** Store and read the session timestamp as a UTC Unix timestamp (float) rather than an ISO string, eliminating the parsing ambiguity entirely: `request.session["last_password_reauth"] = timezone.now().timestamp()`.

---

### F-10 · MEDIUM · `password_reset_complete_view` catches only `ValueError` from `complete_password_reset` — `IntegrityError` or other DB exceptions produce 500

**File:** `backend/apps/accounts/views.py:315-322`

```python
try:
    password_reset_svc.complete_password_reset(...)
except ValueError as exc:
    return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
```

**Why it matters:** `complete_password_reset` is wrapped in `@transaction.atomic`. If `_invalidate_all_sessions_for_user` or any `session.delete()` inside it raises a DB exception (e.g., `OperationalError` under load), the exception propagates unhandled through the view to Django's 500 handler. The service successfully sets the new password before reaching session invalidation, so the DB transaction would roll back (password change also lost), but the response is an unhelpful 500.

**Recommendation:** Add `except Exception as exc: logger.exception(...); return Response({"detail": "server_error"}, status=500)` or let DRF's global exception handler do it, but document the boundary clearly. Alternatively, extract `_invalidate_all_sessions_for_user` from the atomic block so a session-table failure does not roll back the password change.

---

### F-11 · LOW · `twofa_enroll_view` and `twofa_recovery_regenerate_view` have no protection against concurrent duplicate enrollments or duplicate-code regeneration; service uses `delete()` then `create()` without a lock

**File:** `backend/apps/accounts/services/twofa.py:77-78`

```python
TwoFactorDevice.objects.filter(user=user, confirmed_at__isnull=True).delete()
...
device = TwoFactorDevice.objects.create(...)
```

**Why it matters:** Two simultaneous POST `/2fa/enroll/` requests will both delete the prior unconfirmed device and each create a new one, leaving two unconfirmed devices. The `confirm_totp` service then takes the latest by `order_by("-created_at").first()`, so only one secret survives — but the other is silently orphaned and the user never gets confirmation about the failure. Similarly `regenerate_recovery_codes` deletes all old codes then calls `_generate_recovery_codes` without `select_for_update`, so two simultaneous regenerations produce 20 codes from the second call and delete the first call's output.

**Recommendation:** Wrap enroll in `transaction.atomic` with a `select_for_update` on the user row (or use `get_or_create` with a unique constraint). Wrap `regenerate_recovery_codes` in `transaction.atomic` if not already.

---

### F-12 · LOW · `verify_email` view uses `@transaction.atomic` decorator but also calls `emit_audit` which may do its own DB write — if `emit_audit` raises, the token is already marked used but the audit row is absent

**File:** `backend/apps/accounts/views.py:154-186`

```python
@transaction.atomic
def verify_email(request: Request) -> Response:
    ...
    token.save(update_fields=["used_at"])
    emit_audit(...)
    return Response({"status": "verified"})
```

**Why it matters:** `emit_audit` is called after `token.save`. If `emit_audit` raises a DB error (unlikely but possible under load), `@transaction.atomic` will roll back the entire transaction — meaning the token is not actually marked used but the user already received a 200 response. This is an edge case but the verify_email endpoint is idempotent enough that a retry would succeed (token still valid, not yet marked used). The real risk is the audit guarantee: a partially-written audit record.

**Recommendation:** Move `emit_audit` inside the transaction but ensure it is called last and any exception from it is only logged (not re-raised) if the primary operation already succeeded.

---

### F-13 · LOW · `me_view` PATCH reads `user.last_active_org_id` for the `before` snapshot before `serializer.save()` but `after` reads the user object in memory — if `save()` updates the DB but `user` is not refreshed, `after` might be stale for fields not on the serializer

**File:** `backend/apps/accounts/views.py:425-430`

```python
before = {"name": user.name, "last_active_org_id": str(user.last_active_org_id) if user.last_active_org_id else None}
serializer.save()
after = {
    "name": user.name,
    "last_active_org_id": str(user.last_active_org_id) if user.last_active_org_id else None,
}
```

**Why it matters:** `ModelSerializer.save()` calls `instance.save()` which updates the in-memory object as well as the DB. `user.name` and `user.last_active_org_id` are indeed updated in-memory after `serializer.save()`. This is fine for these fields. However if `MeSerializer` is later extended with additional writable fields, developers must ensure that the `after` dict tracks all of them. This is a pattern fragility rather than a current bug.

**Recommendation:** Add `user.refresh_from_db(fields=["name", "last_active_org_id"])` after `serializer.save()` to guarantee the `after` snapshot is canonical regardless of future serializer changes.

---

### F-14 · LOW · `SignupSerializer` has no `max_length` on `password` — overly long passwords (e.g., 10 MB) reach `set_password` and trigger Django's bcrypt computation (bcrypt truncates at 72 bytes, but DRF won't reject the input)

**File:** `backend/apps/accounts/serializers.py:28`

```python
password = serializers.CharField(write_only=True, min_length=12)
```

**Why it matters:** No `max_length` is set. A malicious actor can POST a 10 MB password string; Django's `set_password` will hash it with PBKDF2/bcrypt. PBKDF2 (Django default) does not truncate and will attempt to hash the full plaintext, making this a CPU-exhaustion DoS vector (though partially mitigated by the `SignupRateThrottle` at 3/hr/IP). The `PasswordResetCompleteSerializer` has the same omission.

**Recommendation:** Add `max_length=4096` (generous but bounded) to both `password` fields.

---

### F-15 · INFO · `_hash_token` is defined identically in three separate modules: `views.py`, `services/password_reset.py`, `services/signup.py`

**Files:**
- `backend/apps/accounts/views.py:65-66`
- `backend/apps/accounts/services/password_reset.py:34-35`
- `backend/apps/accounts/services/signup.py:88-89`

**Why it matters:** Triple duplication is a maintenance hazard. If the hashing scheme changes (e.g., switching to SHA-3 or HMAC), three locations must be updated. A missed update would leave different modules computing different hashes for the same token, breaking token lookup.

**Recommendation:** Move `_hash_token` to `apps/accounts/services/_crypto.py` (the dedicated crypto helpers module) and import it everywhere.

---

## Gaps (forward-looking, not current bugs)

| ID | Area | Missing | Effort | Blocking? |
|----|------|---------|--------|-----------|
| G-01 | `_invalidate_all_sessions_for_user` | O(n) full-session-table scan scales poorly. Phase 1A is fine on a single VPS (<10k sessions). Phase 1B+ needs a `user_id` → `session_key` index (custom session backend or a `UserSession` join table). | M | No |
| G-02 | Password reset email | Reset link is `/auth/reset?token=...` — a bare relative path, not an absolute URL. When sent from a background worker or a non-request context, there is no `request.build_absolute_uri`. Email client will not resolve the relative URL. | S | No |
| G-03 | `twofa_disable_view` | No `@require_recent_password_reauth` guard. Disabling 2FA is a sensitive verb (v1Users.md B.18), but the decorator is never applied. Any session can disable 2FA without re-entering a password. | S | Yes (security) |
| G-04 | Recovery code verification | `_verify_recovery` is O(10) in application code running argon2id per row. With 10 codes this is acceptable (~100 ms). If `RECOVERY_CODE_COUNT` is raised, the CPU cost scales linearly. A better approach is a per-code indexed hash lookup with a single argon2id verify, not a full scan. | S | No |
| G-05 | `me_view` PATCH `last_active_org_id` | No validation that the supplied `last_active_org_id` UUID actually belongs to an `Organization` where the user has an active membership. A user can set `last_active_org_id` to any arbitrary UUID, including an org they don't belong to. | S | No (but a data-integrity gap) |
| G-06 | `VerifyEmailSerializer` | `token` field has no `max_length`. A 10 MB token will hash fine but wastes CPU and memory. Add `max_length=256`. | XS | No |
| G-07 | `TwoFAConfirmSerializer` | `code` field has no `max_length` or digit-only validator at the serializer level. Validation is done in `_verify_totp` (returns False if not `.isdigit()`), but a 10 MB non-digit string still passes the serializer and reaches the service before being rejected. | XS | No |
| G-08 | `complete_password_reset` | No min-length validation in `password_reset_svc.complete_password_reset` — it relies solely on the serializer's `min_length=12`. If the service is called directly (e.g., a management command) with a short password, Django's password validators are not run. Recommend calling `validate_password(new_password)` in the service. | S | No |
