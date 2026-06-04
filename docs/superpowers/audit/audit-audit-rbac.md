# RBAC Audit: `backend/apps/audit` + supporting permission infrastructure

**Scope:** Is every mutating + sensitive read endpoint gated server-side by role/module? Covers `effective_modules` resolver, per-user grants, owner-only verbs, invite tree, `single_org_per_admin_user`, default-deny, and password-reprompt.

**Date:** 2026-06-04

---

## Summary

The audit app itself (`OrgAuditListView`) has a correct module gate (`HasModule("org.audit_log")`), correct cross-org isolation via `organization_id` filter, correct append-only enforcement via DB-level triggers, and adequate test coverage. The surrounding permission infrastructure (resolver, grants service, `HasModule`, `IsOrgAdminOrOwner`) is structurally sound with good test coverage.

**Three findings require attention:**

1. **Critical / low exploitability** — `effective_modules()` resolver has an inverted default in its authenticated-user guard, which would return modules to an object lacking `is_authenticated` entirely (edge case, but logically wrong).
2. **High** — The `require_recent_password_reauth` decorator exists and is defined but is **never applied to any sensitive-verb view** (ownership transfer, org suspend/unsuspend, impersonation start). v1Users.md Appendix B.18 requires it.
3. **Medium** — `OrgAuditListView.get_organization()` silently returns `None` for a malformed slug, which causes `HasModule._resolve_organization` to also return `None`, which fails closed (403). This is safe behavior but produces a misleading 403 instead of 404 for the caller.

---

## Findings

### F-01 — Inverted default in `effective_modules()` unauthenticated guard

**Severity:** high (logic defect, low immediate exploitability because Django/DRF anonymous users always carry `is_authenticated = False`)
**File:** `backend/apps/permissions/services/resolver.py:113`

**Evidence:**
```python
if user is None or not getattr(user, "is_authenticated", True):
    return frozenset()
```

The default for `getattr(user, "is_authenticated", True)` is `True`, not `False`. The intent is the opposite: if the attribute is absent (e.g., a raw object passed by a test or a future caller), the guard should treat it as unauthenticated and return empty. With `True` as default, an object that has no `is_authenticated` attribute at all would pass the check and reach the DB query.

In practice, Django's `AnonymousUser` always has `is_authenticated = False`, so normal request paths are safe. The risk arises in: (a) unit tests that pass a mock user object without the attribute, (b) future callers passing non-Django user objects.

**Why it matters:** If exploited, a request with a user-like object missing `is_authenticated` would see module grants computed against any org — a module-bypass. Even absent exploit, it is a correctness defect in the RBAC resolver that contradicts every parallel guard in the codebase (all of which default to `False`).

**Recommendation:** Change line 113 to:
```python
if user is None or not getattr(user, "is_authenticated", False):
```
This is a one-character fix, consistent with `apps/permissions/permissions.py:41`, `apps/permissions/scope.py:70`, and `apps/organizations/permissions.py:82`.

---

### F-02 — Password-reprompt (`require_recent_password_reauth`) defined but never applied to sensitive verbs

**Severity:** high
**File:** `backend/apps/accounts/decorators.py:23` (definition) — missing from `backend/apps/organizations/views.py` and `backend/apps/sadmin/views/users.py`

**Evidence (definition only, no usages):**
```python
def require_recent_password_reauth(within_minutes: int | None = None):
    """DRF view decorator. 403s with ``{"detail": "password_reauth_required"}``
    if the session has no recent reauth marker within ``within_minutes``
    (default ``settings.SENSITIVE_REAUTH_WINDOW_MINUTES``).

    The companion ``POST /api/accounts/auth/reauth/`` endpoint sets
    ``request.session[REAUTH_SESSION_KEY] = now.isoformat()`` on success.
    """
```

Search across all `.py` files in `backend/` shows this function is imported nowhere and applied to no view.

**Sensitive verbs that lack the decorator (per v1Users.md Appendix B.18):**
- `OrgTransferOwnershipView.post` (`organizations/views.py:323`) — transfers org ownership
- `OrgSuspendView.post` (`organizations/views.py:251`) — suspends entire org
- `OrgUnsuspendView.post` (`organizations/views.py:271`) — unsuspends org
- `OrgArchiveView.post` (`organizations/views.py:286`) — archives org
- `user_verb` for `impersonate_start` (`sadmin/views/users.py:103`) — impersonation
- `user_verb` for `suspend`/`unsuspend`/`force_logout_all`/`force_password_reset` (`sadmin/views/users.py:78-101`)
- 2FA disable view (`accounts/views.py:370`) — strips 2FA

**Why it matters:** An attacker who hijacks a valid authenticated session (e.g., XSS, stolen cookie) can immediately perform high-impact verbs — ownership transfer, org archival, impersonation — without needing to know the account password. The reauth window is the only server-side control for this class of attack.

**Recommendation:** Apply `@require_recent_password_reauth()` to each sensitive-verb view/method. For class-based views, call it inside the method body:
```python
from apps.accounts.decorators import require_recent_password_reauth

# In OrgTransferOwnershipView.post / OrgSuspendView.post / etc.:
@require_recent_password_reauth()
def post(self, request, uuid):
    ...
```
Or wire it as a DRF permission class wrapping `request.session`. Write at least one integration test per sensitive verb confirming a 403 is returned without a recent reauth stamp.

---

### F-03 — Soft 403 on unknown slug in `OrgAuditListView.get_organization()`

**Severity:** low (behavior is safe; UX issue only)
**File:** `backend/apps/audit/views.py:105-107`

**Evidence:**
```python
def get_organization(self):
    slug = self.kwargs.get("slug")
    return _resolve_org_by_slug_or_uuid(slug)
```

When the slug does not resolve to any Organization (deleted, misspelled, or org does not exist), `_resolve_org_by_slug_or_uuid` returns `None`. `HasModule._resolve_organization` calls `view.get_organization()`, receives `None`, and returns `None`, causing `has_permission` to return `False` → **403 Forbidden**.

The `get()` handler (line 125-127) also checks: `if org is None: raise Http404`. This guard is never reached because the permission gate fires first with 403.

**Why it matters:** A caller who mistyped an org slug cannot distinguish "org does not exist" (expected 404) from "you lack the module for this org" (expected 403). This is a minor API contract bug. The cross-org isolation is still correct — a user who lacks `org.audit_log` on an existing org also gets 403, so no information is leaked about the org's existence via the status code difference.

**Recommendation:** In `get_organization()`, raise `Http404` when the org is `None` rather than returning `None`, so the permission check passes through (or the framework converts it to 404 before the permission layer). Alternatively, add a pre-check in `has_permission` that resolves the org and raises 404 explicitly.

---

### F-04 — `bulk_email_api` and `archive_feedback_api` use `@csrf_exempt` without DRF CSRF protection

**Severity:** medium
**File:** `backend/apps/sadmin/views/superadmin.py:47`, `backend/apps/sadmin/views/superadmin.py:95`

**Evidence:**
```python
@superadmin_required
@require_POST
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:
```

Both `bulk_email_api` and `archive_feedback_api` are Django function-based views (not DRF `APIView`) decorated with `@csrf_exempt`. They are `superadmin_required` (session auth required, not token auth). Session-authenticated endpoints must NOT be CSRF-exempt — CSRF exemption on session-backed routes is a CSRF vulnerability.

DRF's `APIView` enforces CSRF for session auth, but plain Django views decorated with `@csrf_exempt` bypass it entirely.

**Why it matters:** A CSRF attack on `bulk_email_api` allows an attacker to send bulk email to all users on behalf of a Super-admin if they can trick the SA into visiting a malicious page. On `archive_feedback_api` it allows arbitrary Feedback archival. Both are audited but audit alone does not prevent the action.

**Recommendation:** Remove `@csrf_exempt` from both views. Session-backed Django views (non-AJAX) should use the standard CSRF token. For AJAX, include `X-CSRFToken` header as the rest of the SPA does (invariant 15).

---

## Assessment: Correctly Implemented Areas

The following areas were audited and found correct:

| Area | Status | Evidence |
|------|--------|----------|
| `OrgAuditListView` module gate | Correct | `permission_classes = [IsAuthenticated, HasModule("org.audit_log")]` at `views.py:103` |
| `org.audit_log` default roles | Correct | `modules.json` sets `["admin", "co_organizer", "game_coordinator", "referee"]` |
| Cross-org isolation in queryset | Correct | `AuditEvent.objects.filter(organization_id=org.id)` at `views.py:129` with org resolved from the module-gated `get_organization()` |
| DB-level append-only trigger | Correct | `0002_audit_append_only.py` installs `BEFORE UPDATE OR DELETE` trigger via `plpgsql`; 4 tests confirm raw SQL paths also blocked |
| `HasModule` default-deny | Correct | `has_permission` returns `False` when org is `None`; superuser bypass is explicit |
| `UserGrantsView` / `UserGrantsBySlugView` admin-only gate | Correct | `permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]`; regression tests parametrize over all non-admin roles |
| `MatrixView` admin-only gate | Correct | `permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]`; documented DEFECT-J regression tests pass |
| `MembershipModuleGrant` keyed (user, org, module) | Correct | Multi-role deny-win test `test_deny_wins_over_multi_role_union` |
| Cache invalidation on grant write | Correct | `invalidate_cache(user.id, organization.id)` in `set_grant`, `bulk_set_grants`, `clear_grants`; `test_set_grant_invalidates_cache` confirms |
| `set_grant` / `bulk_set_grants` reason ≥20 chars | Correct | `MIN_REASON_LEN = 20`; `GrantValidationError` if not met |
| Audit emission on every grant change | Correct | One `module_grant_changed` row per changed module; no-op rows are skipped; `test_grant_audit.py` covers all paths |
| Superadmin console `@superadmin_required` | Correct | All sadmin views decorated; non-SA gets 404 (not 403); `test_access_control.py` covers anonymous + regular + SA |
| Team-manager denied `org.audit_log` | Correct | `test_team_manager_denied_by_module_gate` asserts 403 |
| Permission matrix parametrized test | Correct | `test_permission_matrix.py` covers every (role × module) cell from `modules.json` |
| `emit_audit` called inline with state change | Correct | Every verb in `accounts/views.py`, `organizations/views.py`, `grants.py`, `superadmin_verbs.py` follows B.4 pattern |
| Idempotent audit emission | Correct | `emit_audit` checks `idempotency_key` uniqueness before INSERT |

---

## Gaps (Forward-Looking)

| Gap | Missing | Blocking | Effort |
|-----|---------|----------|--------|
| `tournament.audit_log` endpoint | No view exists yet — module catalog entry is present but the Phase 1B endpoint is not built | No (Phase 1B) | M |
| Password-reprompt tests | Even after wiring the decorator, integration tests per sensitive-verb are absent | No | S |
| Cross-worker cache invalidation | `invalidate_cache()` has a `TODO (Appendix B.3)` — in multi-worker prod, a cache hit on another ASGI worker will serve stale module grants for up to 5 minutes after a grant change | No (Phase 1B) | M |
| `single_org_per_admin_user` enforcement at the API layer | DB constraint exists on `OrganizationMembership`; however there is no test asserting the DRF endpoint returns a coherent error (not a 500) when the constraint fires | No | S |
| Audit detail endpoint | Only list (paginated) exists; no `/api/audit/orgs/{slug}/{id}/` detail view — referenced in `serializers.py` as "Phase 1B" | No | S |
| PII redaction on `actor_email_at_time` | Serializer comment says "PII redaction applied at the email field per B.11 if a non-Super-admin viewer fetches a row authored by another user" — current `get_actor_email_at_time` returns the live email without any redaction check | No (Phase 1A gap) | S |
