# Silent Failures Audit — backend/ (Phase 1A)

Date: 2026-06-04
Lens: bare/broad `except`, `except:pass`, masking fallbacks, missing validation, unguarded None/KeyError, non-atomic multi-writes, 500-on-bad-input where 400 is right, inconsistent error bodies.

---

## Critical

### F-01 — `effective_modules()` wrong default inverts the auth gate

**File:** `backend/apps/permissions/services/resolver.py:113`

**Evidence:**
```python
if user is None or not getattr(user, "is_authenticated", True):
```

**Why it matters:** The default for the `getattr` is `True`, not `False`. If `user` is any object that lacks the `is_authenticated` attribute (e.g. a mock, a service-layer caller, or an unusual middleware-produced sentinel), the guard `not True` evaluates to `False` — so the guard **passes** and the function proceeds to compute a module set for an unauthenticated identity. Every other auth guard in the codebase (8 other callsites) uses `False` as the default. The inconsistency is the bug.

**Impact:** If called with an anonymous-like object, `effective_modules()` computes the module resolver's full DB queries (role lookups, grant overrides, cache writes) under the identity of an unauthenticated caller. `HasModule()` sits above it and has its own `is_authenticated` check, but `effective_modules` is also called directly from `MeSerializer.get_memberships()` and `MatrixView` — both paths would silently return a non-empty module set for an object that is not a real user, and cache the result.

**Recommendation:** Change `True` to `False`:
```python
if user is None or not getattr(user, "is_authenticated", False):
```

**Confidence:** 1.0

---

## High

### F-02 — `_delete_sessions_for_user()` runs inside `@transaction.atomic` but mutates the sessions table (non-transactional side-effect)

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:166–185, 222–234`

**Evidence:**
```python
@transaction.atomic
def suspend_user(*, user, ...):
    user.is_active = False
    user.save(update_fields=["is_active"])
    _delete_sessions_for_user(user.id)     # <-- iterates + deletes
```

`_delete_sessions_for_user` scans the `django_session` table and calls `session.delete()` inside the same `@transaction.atomic` block. The sessions table is also used by Django's session middleware during the same request. If the outer transaction later rolls back (e.g. because `emit_audit()` raises), the `is_active = False` write is also rolled back — but the session rows are *already deleted* (the delete statement committed if we are inside `ATOMIC_REQUESTS=True` and there is no savepoint). This creates the inverse of the invariant: the user's sessions are gone but the account appears active to the DB.

The same pattern repeats in `force_logout_all()` (line 259).

**Recommendation:** Move `_delete_sessions_for_user()` into a `transaction.on_commit` callback so it only runs if the DB write commits:
```python
transaction.on_commit(lambda: _delete_sessions_for_user(user.id))
```

**Confidence:** 0.85

---

### F-03 — `force_password_reset()` swallows failure silently, still emits audit row as if it succeeded

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:274–300`

**Evidence:**
```python
@transaction.atomic
def force_password_reset(*, user, requested_by, reason, request):
    try:
        from apps.accounts.services.password_reset import request_password_reset
        request_password_reset(user.email, request=request)
    except Exception:
        logger.exception("force_password_reset: underlying service failed")

    emit_audit(..., event_type="force_password_reset_issued", ...)
    return user
```

If `request_password_reset` raises (DB failure, email backend crash, etc.), the exception is swallowed, and the audit row is written with `event_type="force_password_reset_issued"` — implying success. The Super-admin UI will show the action as successful when the reset was never actually queued. No `PasswordResetToken` exists; the user's email was never sent.

Additionally, `request_password_reset` itself may silently no-op (rate limit hit, user inactive) without signalling that to the caller; the verb blindly audits success in those cases too.

**Recommendation:** Either propagate the exception (and let the caller handle the 400/500 display) or at minimum change the audit `event_type` to reflect attempted-but-unconfirmed status. Add a return value or raise so the sadmin view can show the real outcome.

**Confidence:** 0.95

---

### F-04 — `sadmin_login` open redirect via unvalidated `?next=` parameter

**File:** `backend/apps/sadmin/views/auth.py:51–52`

**Evidence:**
```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```

`next_url` is taken directly from the query string without validating that it is a relative path on the same host. An attacker can craft `/sadmin/login/?next=https://evil.example.com/` to redirect a Super-admin to an attacker-controlled URL after authentication. This is a classic open-redirect.

**Recommendation:** Validate `next_url` using Django's `url_has_allowed_host_and_scheme`:
```python
from django.utils.http import url_has_allowed_host_and_scheme
if not url_has_allowed_host_and_scheme(next_url, allowed_hosts=request.get_host()):
    next_url = reverse("sadmin:dashboard")
```

**Confidence:** 1.0

---

### F-05 — `FeedbackSubmitView` returns HTTP 500 for routine DB-layer errors that should be 503/400

**File:** `backend/apps/sadmin/views/feedback.py:183–197`

**Evidence:**
```python
try:
    fb = submit_feedback(...)
except Exception:
    logger.exception("feedback submit failed")
    return Response({"detail": "Could not record feedback."}, status=HTTP_500_INTERNAL_SERVER_ERROR)
```

A `ValidationError` from `submit_feedback`, a bad `event_id`, or a constraint violation (e.g. duplicate row) will all produce HTTP 500. DRF convention is 400 for client errors, 500 for genuine server crashes. The catch-all on top of a function that raises `Exception` for both client-errors and server-errors masks the distinction.

**Recommendation:** Catch `django.core.exceptions.ValidationError` and `GrantValidationError` (client errors) separately and return 400; let genuine server errors return 500 or let DRF's default exception handler catch them.

**Confidence:** 0.9

---

### F-06 — `bulk_email` service applies arbitrary ORM filter kwargs from caller-supplied dict

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:408–412`

**Evidence:**
```python
qs = User.objects.filter(deleted_at__isnull=True, is_active=True)
if target_filter:
    for k, v in target_filter.items():
        qs = qs.filter(**{k: v})
```

`target_filter` comes from the JSON body of `POST /sadmin/api/bulk-email/` (validated only as `isinstance(target_filter, dict)`). Any key becomes an ORM lookup — including traversals like `org_memberships__organization__id__in`, relationship traversals across models, or even `__gt`/`__lt` on `deleted_at`. This is an ORM injection risk when a Super-admin can be impersonated or when the API is reachable.

**Recommendation:** Whitelist the allowed filter keys before applying them:
```python
ALLOWED_FILTER_KEYS = {"is_active", "email__endswith", ...}
for k, v in target_filter.items():
    if k not in ALLOWED_FILTER_KEYS:
        raise ValueError(f"Disallowed filter key: {k}")
    qs = qs.filter(**{k: v})
```

**Confidence:** 0.85

---

## Medium

### F-07 — `decrypt_secret()` does not handle `InvalidToken` — corrupt TOTP secrets cause unhandled 500

**File:** `backend/apps/accounts/services/_crypto.py:52–62`, called from `backend/apps/accounts/services/twofa.py:134, 232`

**Evidence:**
```python
def decrypt_secret(stored: str) -> str:
    if not stored.startswith(_PREFIX):
        return stored
    f = _fernet()
    if f is None:
        return stored
    body = stored[len(_PREFIX):].encode("ascii")
    return f.decrypt(body).decode("utf-8")   # raises InvalidToken if tampered/rotated
```

`Fernet.decrypt()` raises `cryptography.fernet.InvalidToken` if the ciphertext is corrupted or was encrypted with a different key (e.g., after a `SECRET_KEY` rotation). This exception propagates up uncaught through `confirm_totp()` and `verify_totp_or_recovery()`, causing a 500 response from the login endpoint instead of a controlled `{"detail": "invalid_2fa"}` 400.

**Recommendation:** Wrap the `f.decrypt()` call and map `InvalidToken` to a clear `ValueError`:
```python
try:
    return f.decrypt(body).decode("utf-8")
except InvalidToken as exc:
    raise ValueError("TOTP secret could not be decrypted (possible key rotation)") from exc
```

**Confidence:** 0.9

---

### F-08 — `users_detail` sadmin view swallows membership-load failure silently, showing empty list without any indication

**File:** `backend/apps/sadmin/views/users.py:48–54`

**Evidence:**
```python
try:
    memberships = list(
        subject.org_memberships.select_related("organization").filter(is_active=True)
    )
except Exception:
    memberships = []
```

If the memberships query fails (e.g., DB connection blip, migration mismatch), the Super-admin sees an empty memberships list for the user — indistinguishable from "user has no memberships". No log call, no error banner. Bugs here could cause an SA to incorrectly conclude a user is standalone when they actually hold admin rights.

**Recommendation:** At minimum log the exception:
```python
except Exception:
    logger.exception("Could not load memberships for user %s", subject.id)
    memberships = []
```

**Confidence:** 0.95

---

### F-09 — `MeSerializer.get_memberships()` silently swallows `effective_modules()` failures, returns empty list

**File:** `backend/apps/accounts/serializers.py:169–172`

**Evidence:**
```python
try:
    modules = list(effective_modules(user, org))
except Exception:
    modules = []
```

If the permissions resolver raises (DB error, broken cache, migration pending), `effective_modules` is silently replaced by `[]`. The SPA receives an empty module list and hides all module-gated UI surfaces (e.g., audit log, member directory). The user sees a partially-broken dashboard without any error signal. The exception is not logged here.

**Recommendation:** Add a `logger.exception(...)` call inside the except block so the error surfaces in the application log.

**Confidence:** 0.9

---

### F-10 — `HasModule` permission class silently swallows `get_organization()` exceptions, denies access instead of propagating

**File:** `backend/apps/permissions/permissions.py:63–65`

**Evidence:**
```python
if hasattr(view, "get_organization"):
    try:
        return view.get_organization()
    except Exception:
        return None
```

If `get_organization()` raises (e.g., DB error in org lookup), the permission class returns `None` for the org and denies access (returns `False`). The caller (view) receives 403 instead of 500, masking the real server error.

**Recommendation:** Only catch `Http404`/`DoesNotExist` exceptions (expected cases) and let others propagate:
```python
from django.core.exceptions import ObjectDoesNotExist
from django.http import Http404
try:
    return view.get_organization()
except (Http404, ObjectDoesNotExist):
    return None
```

**Confidence:** 0.8

---

### F-11 — `_cycle_session()` in invitation service swallows ALL exceptions including genuine session corruption

**File:** `backend/apps/organizations/services/invitation.py:66–80`

**Evidence:**
```python
try:
    from apps.accounts.services.session_security import cycle_session_on_role_change
    cycle_session_on_role_change(request)
    return
except Exception:  # noqa: BLE001 — fallback path; helper not yet shipped
    pass

if request is not None and hasattr(request, "session"):
    try:
        request.session.cycle_key()
    except Exception:  # noqa: BLE001 — anonymous / no session
        pass
```

The code was originally written when `session_security` didn't exist yet and used `ImportError` as the intent. Now that the module **is** shipped (v1Users.md §B.11 lock), the broad `except Exception: pass` on the import will catch `ImportError` on the import attempt but if the module IS found and `cycle_session_on_role_change` itself raises for a legitimate reason (e.g., expired session, backend unavailable), that error is silently swallowed. The session fixation defense is bypassed without any log or notification.

**Recommendation:** Now that `session_security` is shipped, remove the try/except entirely and call `cycle_session_on_role_change(request)` directly at the `accept_invitation` callsite.

**Confidence:** 0.85

---

### F-12 — Non-atomic sequence in `signup.py`: duplicate-email check → create is a TOCTOU race

**File:** `backend/apps/accounts/services/signup.py:242–261`

**Evidence:**
```python
# -- Duplicate email guard (enumeration-safe per B.11) ---------------
if User.objects.filter(email=email).exists():
    return SignupResult(..., duplicate_email=True)

# ...
with transaction.atomic():
    user = User.objects.create_user(email=email, ...)
```

The `exists()` check and the `create_user()` are separated by several lines and no lock. Under concurrent signup with the same email (race window ~microseconds), both requests can pass the `exists()` check, then both attempt `create_user()`, and the second will hit the `UNIQUE` constraint on `email` and raise `IntegrityError`. This will bubble as an unhandled 500.

The `email` field has a DB-level `UNIQUE` constraint, so data integrity is safe, but the UX is a 500 instead of a clean 400.

**Recommendation:** Catch `IntegrityError` around `create_user()` and return the `duplicate_email=True` path, or use `get_or_create()` with a select-for-update on the email.

**Confidence:** 0.85

---

### F-13 — `audit_search` (sadmin) silently ignores invalid UUID for `?org=` but shows empty results without feedback

**File:** `backend/apps/sadmin/views/audit.py:28–32`

**Evidence:**
```python
if org_raw:
    try:
        qs = qs.filter(organization_id=uuid.UUID(org_raw))
    except (ValueError, TypeError):
        pass
```

When an invalid UUID is typed in the org filter, the queryset is left unfiltered (no `organization_id` filter applied), and all audit events are shown — not what the Super-admin intended. Silently falling back to unfiltered results could expose audit rows the SA did not mean to see, and is confusing UX.

**Recommendation:** Return a 400 or set a template error message when the UUID is invalid. Do not silently reset to unfiltered.

**Confidence:** 0.8

---

## Low / Info

### F-14 — `_delete_sessions_for_user` O(N) full-table scan on every suspend/force-logout

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:226`

**Evidence:**
```python
for session in Session.objects.iterator(chunk_size=500):
    data = session.get_decoded()
    if str(data.get("_auth_user_id", "")) == target_id:
        session.delete()
```

This scans every session row in the table and decodes each one. With `<10k sessions` this is acceptable for v1 (as the comment notes), but there is no protection against very large session tables and no index. The pattern is duplicated in `password_reset.py:_invalidate_all_sessions_for_user`.

**Recommendation:** Add a `_auth_user_id` index to session data (requires session storage change) or switch to `django-session-timeout` / Redis-backed sessions keyed by user ID. Acceptable for v1 but document the growth ceiling.

**Confidence:** 0.95

---

### F-15 — `signup` view: `result.user.email` accessed unconditionally on the `duplicate_email` path

**File:** `backend/apps/accounts/views.py:118–148`

**Evidence:**
```python
if result.duplicate_email:
    return Response({"status": "pending_verification"}, status=HTTP_201_CREATED)

plaintext = result.verification_token_plaintext
if plaintext:
    ...
    recipient_list=[result.user.email],
```

On the `duplicate_email=True` path, `result.user` IS populated (see `signup.py:243`), so this is not a current crash. However the control flow is fragile: the early-return on line 123 prevents reaching the email send, but if the control flow ever changes order, `result.user.email` after soft-delete would be `deleted-{uuid}@invalid`. This is a latent defect.

**Recommendation:** Guard with an explicit check: `if result.user and not result.user.is_deleted` before using `result.user.email` in email sends.

**Confidence:** 0.6

---

## Gaps (forward-looking, not current defects)

| # | Area | Current state | Missing | Needed for |
|---|------|--------------|---------|------------|
| G-01 | `_delete_sessions_for_user` | O(N) full-table scan; duplicated in two modules | Indexed session deletion or on_commit wrapping | Correct atomicity + scalability |
| G-02 | `effective_modules` cache invalidation | Single-process locmem only | Redis pub/sub invalidation across ASGI workers (noted as TODO B.3) | Correct cross-worker behaviour when Phase 1B deploys |
| G-03 | `force_password_reset` rate limiter interaction | Calls `request_password_reset` which has its own rate limit; SA-triggered resets count against the target user's email rate | Separate rate limit key for SA-triggered resets | Prevents SA from accidentally locking the user out of self-service resets |
| G-04 | `bulk_email` ORM injection surface | Filter keys not whitelisted | Allowlist validation | Security before Phase 1B wires actual send |
| G-05 | Token URL in verification email | `/auth/verify?token=<plaintext>` — relative URL only | Frontend absolute base URL config | Email links must be clickable in production |
| G-06 | `ATOMIC_REQUESTS=True` + session deletion side-effects | Session deletes inside request transactions may be partially committed | Move session cleanup to `on_commit` throughout | Correct rollback semantics |
| G-07 | `suspend_org`/`unsuspend_org` in `superadmin_verbs` | `except (ImportError, AttributeError)` fallback paths still present even though `lifecycle.py` is shipped | Remove dead fallback paths | Code clarity; the fallbacks mask future AttributeErrors in the real service |
