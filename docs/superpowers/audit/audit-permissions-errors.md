# Audit: backend/apps/permissions — Error Handling & Silent Failures

Date: 2026-06-04  
Scope: `backend/apps/permissions/` — bare/broad except, except:pass, masking
fallbacks, missing validation, unguarded None/KeyError, non-atomic multi-writes,
500-on-bad-input-where-400-is-right, inconsistent error bodies.

---

## Finding 1 — CRITICAL: Wrong `getattr` default inverts the auth guard in `effective_modules`

**File:** `backend/apps/permissions/services/resolver.py:113`  
**Severity:** critical

```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

The default is `True`, not `False`. If the `user` object passed in lacks an
`is_authenticated` attribute, `getattr` returns `True`, the `not True` branch is
**skipped**, and the function proceeds to resolve modules for an anonymous/arbitrary
object. Every other auth guard in this codebase uses `False` as the default (see
`scope.py:55`, `scope.py:70`, `scope.py:89`, `permissions.py:41`). This is a
copy-paste typo that silently grants unauthenticated-equivalent objects a computed
module set, and poisons any downstream `has_module()` check that relies on this
guard as the first line of defence.

**Recommendation:** Change the default to `False`:
```python
if user is None or not getattr(user, "is_authenticated", False):
```

---

## Finding 2 — HIGH: Bare `except Exception` silently swallows `get_organization` errors in `HasModule`

**File:** `backend/apps/permissions/permissions.py:61-65`  
**Severity:** high

```python
if hasattr(view, "get_organization"):
    try:
        return view.get_organization()
    except Exception:
        return None
```

Any exception from `view.get_organization()` — database error, programming
mistake, `IntegrityError`, `ImproperlyConfigured` — is silently swallowed and
causes the permission check to **return `False`** (org resolves to `None` →
`has_permission` returns `False`). This means a mis-configured view silently
becomes a 403 rather than raising loudly during development. A real DB error
would be indistinguishable from "this user lacks the module." The broad catch
masks bugs indefinitely.

**Recommendation:** Narrow the catch to the expected exceptions only
(`AttributeError`, `ObjectDoesNotExist`) and let unexpected exceptions
propagate:
```python
from django.core.exceptions import ObjectDoesNotExist
try:
    return view.get_organization()
except (AttributeError, ObjectDoesNotExist):
    return None
```

---

## Finding 3 — HIGH: `get_target_user()` raises unhandled `ValueError` (500) on malformed UUID

**File:** `backend/apps/permissions/views.py:164-165`  
**Severity:** high

```python
user_uuid = self.kwargs.get("user_uuid")
return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
```

`uuid.UUID(str(user_uuid))` is called with no try/except. The `user_uuid` kwarg
comes from a `<uuid:user_uuid>` URL converter — which Django enforces — so in
practice a valid URL will always supply a real UUID. However, `UserGrantsBySlugView`
inherits this method and calls it too; if any future URL pattern uses `<str:user_uuid>`
or if the kwarg is `None` (when `user_uuid` is absent from `kwargs`), this raises
`ValueError`/`TypeError` that bubbles up as a 500. Contrast with `get_organization()`
on the same class (lines 156-159), which correctly wraps the UUID parse in
`try/except (ValueError, TypeError)`. The inconsistency is a latent 500.

**Recommendation:** Wrap in try/except and return 400:
```python
def get_target_user(self):
    from apps.accounts.models import User
    user_uuid = self.kwargs.get("user_uuid")
    try:
        uid = uuid.UUID(str(user_uuid))
    except (ValueError, TypeError):
        from django.http import Http404
        raise Http404("Invalid user UUID.")
    return get_object_or_404(User, id=uid)
```

---

## Finding 4 — HIGH: Cache sentinel collision — empty frozenset cached as `frozenset()` is falsy, but `cache.get` check uses `is not None`

**File:** `backend/apps/permissions/services/resolver.py:122-124`  
**Severity:** high

```python
cached = cache.get(key)
if cached is not None:
    return cached
```

`cache.get` returns `None` on a cache miss. An empty `frozenset()` is **not**
`None`, so this works correctly for the empty set. However, if the cache backend
ever serializes/deserializes a `frozenset` as something falsy (e.g., LocMemCache
stores objects by reference — safe; but Redis with pickle could in theory return
`None` on deserialization error or version mismatch), the guard fails open and
re-computes every call, bypassing the TTL. More critically: the current check has
no logging on cache misses/errors. A cache backend exception (`RedisConnectionError`)
from `cache.get` is completely unhandled and will bubble up as a 500 from any view
that calls `effective_modules`. Django's cache framework does NOT catch backend
errors by default.

**Recommendation:** Wrap `cache.get` in a try/except and log cache failures:
```python
try:
    cached = cache.get(key)
except Exception:
    cached = None  # Degrade gracefully; recompute from DB
if cached is not None:
    return cached
```
Similarly wrap `cache.set` and `cache.delete`.

---

## Finding 5 — HIGH: `MyEffectiveModulesView` / `MyModulesBySlugView` leak org membership existence to non-members

**File:** `backend/apps/permissions/views.py:128-136` and `views.py:296-299`  
**Severity:** high

```python
org = Organization.objects.filter(id=org_uuid).first()
if org is None:
    return Response({"detail": "Organization not found."}, status=404)

modules = sorted(effective_modules(request.user, org))
return Response({"modules": modules})
```

Any authenticated user can query `GET /api/permissions/me/modules/?org=<any-uuid>`
and `GET /api/permissions/orgs/<slug>/me/modules/` for **any** organization,
including ones they are not a member of. For a non-member, `effective_modules`
returns an empty `frozenset()` (no memberships → empty base set), so the response
is `{"modules": []}` instead of 403 or 404. This:

1. Leaks that an organization with the given UUID/slug **exists** (org returns 200
   with empty list vs 404 for non-existent org — distinguishable).
2. Violates CLAUDE.md invariant 2: "NO cross-org leak via any endpoint."
3. The `effective_modules` resolver's own empty-frozenset shortcut for
   non-members means this silently returns 200 with empty data instead of 403.

**Recommendation:** Check that the requesting user has at least one active
membership in the org before returning the module list:
```python
from apps.organizations.models import OrganizationMembership
if not OrganizationMembership.objects.filter(
    user=request.user, organization=org, is_active=True
).exists():
    return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
```

---

## Finding 6 — MEDIUM: `IsOrgAdminOrOwner` passes through silently when org cannot be resolved (returns `True`)

**File:** `backend/apps/organizations/permissions.py:86-89` (consumed by permissions app)  
**Severity:** medium

```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

`UserGrantsView` and `MatrixView` are gated by `IsOrgAdminOrOwner`. Both views
override `get_organization()` (called at the view layer), but the **DRF
permission check** runs `_resolve_org_from_view(view)` from the URL kwargs — and
`UserGrantsView.get_organization()` is a view method, **not** the URL-kwarg
resolver. If `view.kwargs` does not contain `org_uuid` (e.g. the view is mounted
on a misconfigured URL), `_resolve_org_from_view` returns `None` and
`has_permission` returns `True`, bypassing the admin gate entirely. This is a
fail-open at the permission-class level when the kwargs path is wrong.

**Recommendation:** `UserGrantsView.get_organization()` and
`_resolve_org_from_view` should be unified, or the permission class should be
made aware of `view.get_organization()`. At minimum, the permission base class
should treat `org is None` as **deny** for views that always have an org in the
URL rather than silently passing through.

---

## Finding 7 — MEDIUM: `bulk_set_grants` issues `emit_audit` **inside** the transaction but after individual deletes — if audit emission fails, the DB mutation is rolled back but the cache is already stale

**File:** `backend/apps/permissions/services/grants.py:159-211`  
**Severity:** medium

```python
with transaction.atomic():
    for module_code, state in grants:
        ...
        if state == GrantState.DEFAULT:
            if existing:
                existing.delete()   # DB mutation
        else:
            row, _ = MembershipModuleGrant.objects.update_or_create(...)
        
        emit_audit(...)  # AuditEvent.objects.create() inside same txn

    invalidate_cache(user.id, organization.id)  # Outside the individual loop but still inside atomic
```

`emit_audit` calls `AuditEvent.objects.create()` inside the same `transaction.atomic()` block as the grant mutations. If `emit_audit` raises (e.g., `IntegrityError` on the audit table, or a DB constraint violation), the whole transaction rolls back, including all grant mutations that had already been processed in the loop — correct behaviour for atomicity. However, `invalidate_cache` is called at the end of the loop (line 211) **inside** the `atomic()` block but **before** the transaction commits. If `invalidate_cache` runs but the transaction later fails (extremely unlikely but possible with a subsequent exception), the cache entry is dropped even though no DB change committed, causing unnecessary full re-resolves on the next request.

The more serious variant: in `set_grant` (line 111), `invalidate_cache` is also called **inside** the `atomic()` block, meaning it runs before the transaction commits. This contradicts CLAUDE.md invariant 4: "Redis publish only in transaction.on_commit." Cache invalidation should use `transaction.on_commit` for the same reason.

**Recommendation:** Move all `invalidate_cache` calls outside the `atomic()` block using `transaction.on_commit`:
```python
transaction.on_commit(lambda: invalidate_cache(user.id, organization.id))
```

---

## Finding 8 — MEDIUM: `load_modules` command silently 500s on a fixture entry missing the `"code"` key

**File:** `backend/apps/permissions/management/commands/load_modules.py:54`  
**Severity:** medium

```python
for entry in data:
    code = entry["code"]   # KeyError if "code" is absent
```

If any entry in `modules.json` lacks the `"code"` key, a bare `KeyError` is
raised, which Django's management framework will print as an unhandled traceback
and exit non-zero — but the `transaction.atomic()` wrapping the loop means any
modules already processed in the same transaction are rolled back. The user gets
a raw Python traceback rather than a helpful error message. All other field accesses
use `.get()` with defaults, so only `"code"` is vulnerable.

**Recommendation:**
```python
code = entry.get("code")
if not code:
    self.stderr.write(self.style.ERROR(f"Entry missing 'code': {entry!r}"))
    raise SystemExit(1)
```

---

## Finding 9 — MEDIUM: `event_id` accepted but fully ignored — idempotency is advertised but not enforced for bulk PUT

**File:** `backend/apps/permissions/serializers.py:110` and `views.py:206-209`  
**Severity:** medium

```python
# event_id is accepted for idempotency but currently ignored at the
# service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B ...)
event_id = serializers.UUIDField(required=False)
```

The SPA sends an `event_id` with every bulk PUT. The serializer accepts and
validates it, but neither the view nor the service layer uses it. Clients that
retry on network failure (as they should, per invariant 3) will get double-writes
producing duplicate audit rows — one per retry. Architecturally the decision to
defer is documented, but the gap should be tracked as a concrete risk: the
endpoint silently discards the idempotency key without informing the caller.

**Recommendation:** Either implement idempotency now (look up existing audit row
by `event_id` and return 200 if found), or at minimum document this in the
endpoint response and add a warning log when `event_id` is provided but ignored.

---

## Finding 10 — LOW: `set_grant` returns `None` when `state == "default"` — callers that don't check get an `AttributeError` on the return value

**File:** `backend/apps/permissions/services/grants.py:91-96` and `:132`  
**Severity:** low

```python
if state == GrantState.DEFAULT:
    if existing:
        existing.delete()
        row = None
    else:
        row = None
...
return row   # None
```

The function signature says `-> MembershipModuleGrant` but can return `None`
(when `state == "default"`). The view in `views.py` does not use the return value
of `set_grant` (it re-queries), so there is no current crash — but any future
caller that does `grant = set_grant(...); grant.state` will `AttributeError`.
The type annotation is also wrong: it should be `MembershipModuleGrant | None`.

**Recommendation:** Update the type signature to `-> MembershipModuleGrant | None`
and add a note in the docstring that `None` is returned when `state="default"`.

---

## Finding 11 — LOW: Inconsistent error body shape — some 404 responses use `raise Http404(str)`, others use `Response({"detail": ...}, 404)`

**File:** `backend/apps/permissions/views.py:298`, `views.py:370` vs `views.py:132`, `views.py:178`, `views.py:215`  
**Severity:** low

`MyModulesBySlugView.get` (line 298) and `MatrixView.get` (line 370) raise
`Http404`, which DRF serializes as `{"detail": "Not found."}` (the generic DRF
message, ignoring the string passed to `Http404`). All other 404 paths in the
same file use `Response({"detail": "Organization not found."}, status=404)`.
The result is inconsistent: some 404s have the descriptive message, others always
say "Not found." The DRF default handler for `Http404` discards the custom
message in production mode (`DEBUG=False` with `EXCEPTION_HANDLER`).

**Recommendation:** Standardize on `Response({"detail": "..."}, status=404)` for
all 404 paths in this views file, or configure DRF's exception handler to preserve
the `Http404` detail string.

---

## Finding 12 — INFO: `_resolve_org_by_slug_or_uuid` does not check `deleted_at` when resolving by slug in the UUID branch fallthrough

**File:** `backend/apps/permissions/views.py:64-70`  
**Severity:** info

```python
if as_uuid is not None:
    return Organization.objects.filter(
        id=as_uuid, deleted_at__isnull=True
    ).first()
return Organization.objects.filter(
    slug=value, deleted_at__isnull=True
).first()
```

Both branches correctly filter by `deleted_at__isnull=True`. This is clean. No
issue — noted for confirmation only.

---

## Gaps (forward-looking)

| # | Gap | Area | Blocking | Effort |
|---|-----|------|----------|--------|
| G1 | `effective_modules` resolver has no test for a user with zero memberships calling the slug-routed `me/modules` view — the 200+empty response (vs 404) is the cross-org leak in Finding 5 | views / isolation tests | yes — isolation invariant | S |
| G2 | `invalidate_cache` is called inside `transaction.atomic()` in all three grant write functions — cross-worker cache inconsistency per Appendix B.3 TODO; becomes a real bug once multiple ASGI workers run in prod | services/grants.py | no (Phase 1B) | M |
| G3 | `event_id` idempotency for bulk PUT is deferred (Finding 9) — double-write on retry produces duplicate audit rows today | views / serializers / grants | yes — invariant 3 | M |
| G4 | No cross-org isolation test for `/me/modules/` and `me/modules-by-slug` endpoints — CLAUDE.md invariant 2 requires every endpoint be covered | tests | yes | S |
| G5 | `GrantValidationError` is a `ValueError` subclass — if the service layer ever calls another function that also raises `ValueError` for a different reason, the view's `except GrantValidationError` catch will incorrectly surface that as a 400 | grants.py / views.py | low risk today | S |
| G6 | `build_matrix` service (`services/matrix.py`) has no error handling around DB queries; a Postgres error mid-computation would 500 with no graceful degradation | matrix.py | no | S |
