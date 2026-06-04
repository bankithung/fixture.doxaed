# Correctness & Logic Bug Audit — Phase 1A Backend

**Date:** 2026-06-04
**Scope:** backend/apps/{accounts,organizations,permissions,audit,sadmin}
**Lens:** wrong conditionals, off-by-one, races, wrong queryset filters,
missing transaction.atomic/on_commit, serializer<->model mismatch,
wrong HTTP status (idempotent replay must be 200), None handling, tz math.

---

## Findings

### F-01 [CRITICAL] `effective_modules` early-return guard uses wrong default — anonymous users get full module access

**File:** `backend/apps/permissions/services/resolver.py:113`

```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

The default for `getattr(user, "is_authenticated", ...)` is `True`. This means any object that lacks an `is_authenticated` attribute (including `AnonymousUser` instances that explicitly set it to `False` via the property) passes the guard correctly by attribute lookup, but **any unrelated truthy object** passed as `user` that doesn't have `is_authenticated` will skip the `frozenset()` short-circuit and proceed into the DB queries. More critically, the pattern intended by every other caller in the codebase uses `False` as the default (see `organizations/permissions.py:82`, `scope.py:43`, `scope.py:70`, `permissions/permissions.py:41`). The inconsistency is a logic inversion: if `is_authenticated` is absent, the default `True` means "treat as authenticated", which is the opposite of the safe default.

**Why it matters:** If a caller passes a plain dict or dataclass as `user` (e.g., in a test helper or a future refactor), the guard silently passes and the function attempts `getattr(user, "id", None)` which may return `None`, causing a no-op. The function still returns `frozenset()` in that specific path, but the guard logic is inverted and will cause correctness failures in any future caller that passes a non-User object. It also causes confusing test failures because the guard fires incorrectly.

**Fix:** Change the default to `False`:
```python
if user is None or not getattr(user, "is_authenticated", False):
    return frozenset()
```

---

### F-02 [HIGH] `accept_invitation` does not verify the accepting user's email matches the invited email

**File:** `backend/apps/organizations/services/invitation.py:230-322`

The `accept_invitation` function looks up the invitation by token hash and creates a membership for `accepting_user` without checking that `accepting_user.email == inv.email`. Any authenticated user who obtains (or guesses) the plaintext token can accept an invitation addressed to a different email address and join the organization under an unintended account.

**Evidence:** No check like `if accepting_user.email != inv.email:` exists anywhere in the `accept_invitation` flow. The only field from the invitation used to gate acceptance is `inv.status`, `inv.is_expired()`, and `org.status`.

**Why it matters:** Invitation tokens are sent by email, so token possession should be a sufficient proxy for email ownership. However, if a token is forwarded, leaked, or the accepting user has multiple accounts, this allows the wrong account to join. Security-sensitive because the membership grant carries real org privileges.

**Fix:** Add an email-match check inside the `transaction.atomic()` block:
```python
if accepting_user.email != inv.email:
    raise ValidationError("This invitation was sent to a different email address.")
```

---

### F-03 [HIGH] `_rate_limit_hit` race: counter can be bypassed at the cache-eviction boundary

**File:** `backend/apps/accounts/services/password_reset.py:45-59`

```python
current = cache.get(key, 0)
if current >= limit:
    return True
try:
    cache.add(key, 0, window_seconds)
    cache.incr(key)
```

There is a TOCTOU race: `cache.get` reads the current count, then `cache.add` + `cache.incr` are two separate atomic cache operations. If the key expires between `get` and `add`, `cache.add` succeeds (sets to 0) and `incr` returns 1, which is below the limit — even if the caller should have been rate-limited. In the locmem backend this is unlikely, but with Redis (the production backend) under high concurrency this window is real.

More concretely, when `current == limit - 1` (one under the budget), `get` returns `limit - 1`, the check passes (`limit-1 < limit`), `add` is a no-op (key exists), `incr` goes to `limit`, and the call proceeds. On the next concurrent request `get` returns `limit`, the check fires, and rate limiting kicks in. This is correct. The real race is only at eviction; the logic is mostly sound but the `add(key, 0, ...)` + `incr` pattern is fragile compared to a single `incr` with `nx` on Redis or using `cache.incr` directly with a try/catch.

**Why it matters:** An attacker who can time requests around cache-key expiry can slightly exceed the rate budget. This is a minor bypass, not a complete bypass.

**Fix:** Use a single atomic operation: `cache.get_or_set` + atomic `incr`, or in production Redis use `INCR` with `EXPIRE`.

---

### F-04 [HIGH] `signup` view: idempotent replay returns 200 but duplicate-email returns 201

**File:** `backend/apps/accounts/views.py:118-126`

```python
# Idempotent replay -> return 200 with same status payload.
if not result.created and not result.duplicate_email:
    return Response({"status": "pending_verification"}, status=status.HTTP_200_OK)

# Duplicate-email path is enumeration-safe per B.11: identical 201.
if result.duplicate_email:
    return Response(
        {"status": "pending_verification"}, status=status.HTTP_201_CREATED
    )
```

Architectural invariant 3 states "Re-submitting returns the existing record (200, not 201)." The idempotent replay correctly returns 200. However, the duplicate-email path returns 201. While the comments say this is intentional for enumeration-safety (B.11), this is inconsistent with the invariant and may surprise clients that treat 201 as "a new resource was created." A duplicate email is not a newly created resource. The comment says "identical 201" but the normal fresh-signup also returns 201 — the choice is arguably correct for B.11, but it means the response code now carries no idempotency signal at all for this path.

**Why it matters:** Clients implementing the idempotency contract per invariant 3 expect 200 on replay. A duplicate email silently returns 201, which signals "created" to compliant clients, causing them to interpret a no-op as a new resource creation.

**Recommendation:** Return 200 for the duplicate-email path as well. The body `{"status": "pending_verification"}` is already enumeration-safe. If 201 is intentional here, document it explicitly as a B.11 carve-out in the invariant list.

---

### F-05 [MEDIUM] `OrgDetailView.patch` does not check for `is_org_owner` — any admin (not just owners) can update org name/timezone

**File:** `backend/apps/organizations/views.py:203-219`

```python
if not OrganizationMembership.objects.filter(
    user=request.user,
    organization=org,
    is_active=True,
    role=MembershipRole.ADMIN,
).exists():
    raise PermissionDenied("Admin role required.")
```

The check allows any active admin membership, including non-owner admins. The `is_org_owner` field is not checked. Whether this is intentional depends on the spec; v1Users.md §2.5 and §2.7 do not clearly grant PATCH to non-owner admins for these settings fields. By contrast, `OrgArchiveView` does check `is_org_owner`. This inconsistency may allow co-admins (if the admin role is ever shared) to modify org name/TZ.

**Recommendation:** Clarify intent. If owner-only was intended, add `is_org_owner=True` to the filter or use the `IsOrgOwner` permission class.

---

### F-06 [MEDIUM] `_invalidate_all_sessions_for_user` deletes sessions INSIDE a `@transaction.atomic` decorated function — deletions visible before commit

**File:** `backend/apps/accounts/services/password_reset.py:126-173`

```python
@transaction.atomic
def complete_password_reset(...) -> User:
    ...
    user.set_password(new_password)
    user.save(...)
    token.used_at = timezone.now()
    token.save(...)
    _invalidate_all_sessions_for_user(user)
    emit_audit(...)
    return user
```

`_invalidate_all_sessions_for_user` calls `Session.objects.iterator(...)` and `session.delete()` inside the `@transaction.atomic` scope. If the transaction rolls back (e.g., the audit emit fails), the session deletions are rolled back too — which is correct. However, the broader issue is that session deletions happen before the password change is committed, so there is a brief window where other processes can see the sessions being deleted before the new password is active. In production with `ATOMIC_REQUESTS=True` and `SESSION_ENGINE=django.contrib.sessions.backends.db`, the session table participates in the same transaction, so this is safe. But if the session engine is ever changed to a non-DB backend (Redis sessions), `_invalidate_all_sessions_for_user` will operate outside any transaction context and deletions will proceed even on rollback.

**Why it matters:** The current code is correct for the configured DB-backed session engine. The fragility is a forward-looking concern that should be documented.

**Recommendation:** Move `_invalidate_all_sessions_for_user` call to `transaction.on_commit(...)` to decouple it from the transaction atomicity. This also applies to `sadmin/services/superadmin_verbs.py:185` (`suspend_user` -> `_delete_sessions_for_user`).

---

### F-07 [MEDIUM] `_OrgMembershipPermission.has_permission` returns `True` when org cannot be resolved from URL kwargs

**File:** `backend/apps/organizations/permissions.py:86-89`

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

When no organization can be resolved from the URL kwargs, the permission returns `True` unconditionally. This means any authenticated user passes `IsOrgAdminOrOwner` or `IsOrgOwner` on any view that doesn't carry an org identifier in its kwargs. This is a dangerous default: if a new view is registered without an org context and uses these permission classes, all authenticated users gain access.

**Why it matters:** The comment says "object-level permission filters at the queryset layer" but there is no enforcement that such a fallback actually exists on any given view. This is a footgun for Phase 1B.

**Recommendation:** Return `False` instead of `True` when no org context can be resolved, unless the view is known to be non-org-scoped. Add a `trust_missing_org_context = False` class attribute that views can opt into.

---

### F-08 [MEDIUM] `signup_svc.perform_signup` — race condition between duplicate-email check and User creation

**File:** `backend/apps/accounts/services/signup.py:241-254`

```python
if User.objects.filter(email=email).exists():
    return SignupResult(..., duplicate_email=True)

with transaction.atomic():
    user = User.objects.create_user(email=email, ...)
```

The duplicate-email check runs OUTSIDE the `transaction.atomic()` block. Between the `filter(...).exists()` check and the `create_user(...)` call, a concurrent signup with the same email can slip through. The second concurrent call will hit a DB `UNIQUE` constraint violation on `accounts_user.email` and raise an `IntegrityError` — which is NOT caught. This will surface as a 500 error instead of a clean duplicate-email response.

**Why it matters:** Under concurrent load (e.g., aggressive retry from a flaky client), two requests with the same email can race and one gets a 500. The idempotency guard at the top (event_id) only helps when the same `event_id` is reused.

**Fix:** Either move the duplicate check inside `transaction.atomic()` with `select_for_update`, or catch `IntegrityError` from `create_user` and return the duplicate-email result.

---

### F-09 [MEDIUM] `OrgMembersBySlugView` — `id` in aggregated entry is the first membership row's ID, not the user's ID; misleading for the client

**File:** `backend/apps/organizations/views.py:527-548`

```python
agg[r.user_id] = {
    "id": r.id,   # <-- this is the OrganizationMembership PK, not the user PK
    "user_id": r.user_id,
    ...
}
```

The aggregated dict uses `r.id` (the `OrganizationMembership` UUID) as the top-level `"id"` field. If a user has multiple membership rows (multi-role), subsequent rows update `roles`, `is_org_owner`, and `joined_at` but NOT `"id"`. So `"id"` is the ID of the first-seen membership row for that user, not a stable user identity. The `OrgMemberDetailSerializer` exposes this `id` field. Client code may use it as a member identifier to construct per-member API URLs, which would be wrong.

**Fix:** Change `"id"` to `r.user_id` (which is stable across multiple memberships) or remove the `id` field from `OrgMemberDetailSerializer` entirely. The `user_id` field already carries the user identity.

---

### F-10 [MEDIUM] `verify_email` view — token expiry is checked via `is_expired` property which calls `timezone.now()` twice if both `is_used` and `is_expired` are evaluated

**File:** `backend/apps/accounts/views.py:165`

```python
if token is None or token.is_used or token.is_expired:
```

`is_expired` calls `timezone.now()` internally. This is correct but it means two calls to `timezone.now()` if both `is_used` is False and `is_expired` is True (short-circuit evaluation stops at first `True`). This is not a bug but means that the `now` used for the expiry check is not captured atomically with the `select_for_update()`. In theory, a token could expire between the lock acquisition and the `is_expired` check. This is negligibly unlikely in practice but is a design inconsistency with the `PasswordResetToken.complete_password_reset` which uses the same pattern.

**Note:** This is informational. No fix required unless tokens have very tight TTLs.

---

### F-11 [MEDIUM] `_pick_unique_slug` — reads slug availability without holding a lock; race between availability check and org creation

**File:** `backend/apps/accounts/services/signup.py:119-154`

```python
def _slug_taken(slug: str) -> bool:
    if Organization.objects.filter(slug=slug).exists():
        return True
    ...

def _pick_unique_slug(seed: str) -> str:
    ...
```

`_pick_unique_slug` checks slug availability outside any transaction lock. Concurrent signups can both find a slug free and then collide at `Organization.objects.create(slug=slug, ...)`, resulting in a DB `UNIQUE` constraint violation (IntegrityError) that propagates as a 500. This mirrors the duplicate-email race (F-08) but for slugs.

**Fix:** Catch `IntegrityError` in the `Organization.objects.create(...)` call inside the `with transaction.atomic():` block and retry slug generation.

---

### F-12 [LOW] `suspend_org` in `sadmin/services/superadmin_verbs.py` double-wraps `@transaction.atomic` around a delegate that also uses `transaction.atomic`

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:94-128`

```python
@transaction.atomic
def suspend_org(*, org, suspended_by, reason, request):
    ...
    return svc_suspend(org=org, suspended_by=suspended_by, ...)
```

`svc_suspend` (from `lifecycle.py`) wraps its body in `with transaction.atomic():`. Django's `transaction.atomic()` is re-entrant via savepoints, so this is safe. However, the `@transaction.atomic` decorator on `suspend_org` is redundant and misleading — it implies the outer function adds atomicity that it doesn't because the delegate already provides it.

**Recommendation:** Remove the `@transaction.atomic` decorator from the thin wrapper functions in `superadmin_verbs.py` that immediately delegate to `lifecycle.py` services.

---

### F-13 [LOW] `impersonate_stop` audit row uses `uuid.uuid4()` as target_id when neither actor nor target can be resolved

**File:** `backend/apps/sadmin/services/superadmin_verbs.py:376-383`

```python
emit_audit(
    ...
    target_id=target_id or (actor.id if actor and getattr(actor, "is_authenticated", False) else uuid.uuid4()),
    ...
)
```

When `impersonating_user_id` is not in the session AND the actor is unauthenticated, `target_id` is a fresh random `uuid.uuid4()`. This creates an audit row that cannot be correlated to any real entity. The audit invariant (invariant 5) says rows are append-only but does not guarantee all rows are meaningful. However, a random PK in `target_id` is a dead link and defeats forensic value.

**Fix:** Use a sentinel value (e.g., a fixed nil UUID `00000000-...`) or log a warning and skip the audit row if neither actor nor target can be resolved.

---

### F-14 [LOW] `set_grant` emits audit with `uuid.uuid4()` target_id when the grant row is deleted (state=DEFAULT)

**File:** `backend/apps/permissions/services/grants.py:113-130`

```python
emit_audit(
    ...
    target_id=(row.id if row else uuid.uuid4()),
    ...
)
```

When `state == GrantState.DEFAULT` and the row is deleted, `row` is `None`, so `target_id` becomes a random `uuid.uuid4()`. The audit row cannot be traced back to the deleted grant. Same issue exists in `bulk_set_grants` (line ~192) and `clear_grants` (line 247 uses `row_id` which is correct).

**Fix:** Store the ID before deletion (`existing.id if existing else uuid.uuid4()`) and pass `existing.id` to `emit_audit`. `clear_grants` already does this correctly — `set_grant` and `bulk_set_grants` should match.

---

## Gaps (Forward-Looking)

| Area | Gap | Blocking | Effort |
|------|-----|----------|--------|
| Cross-worker cache invalidation | `effective_modules` cache is `LocMemCache` in dev and will not be invalidated across ASGI workers in production. `invalidate_cache` has a TODO (Appendix B.3) for Redis pub/sub. | No (single process in Phase 1A) | M |
| Session engine coupling | `_invalidate_all_sessions_for_user` only works with the DB session backend. If moved to Redis sessions (likely in production), it becomes a no-op. No abstraction layer exists. | No | S |
| `accept_invitation` email-match enforcement (F-02) | No test asserts that a user whose email differs from `inv.email` is rejected. | No | S |
| Slug uniqueness under concurrent signups (F-11) | `IntegrityError` on concurrent slug collision propagates as 500. Should be caught and retried. | No | S |
| `/api/accounts/me/` returns 403 not 401 when unauthenticated | DRF's default `SessionAuthentication` raises `NotAuthenticated` (401) but the default `EXCEPTION_HANDLER` does not carry CSRF failure → 403 via CSRF middleware before auth runs. The SPA login page receives 403 on preflight, showing a premature error banner. | No | S |
| `ATOMIC_REQUESTS=True` interaction with `@transaction.atomic` decorators | With `ATOMIC_REQUESTS=True`, every request is already wrapped in a transaction. Inner `@transaction.atomic` uses savepoints. Session deletions inside the atomic scope are fine now but fragile if session backend changes. | No | S |
