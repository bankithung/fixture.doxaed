# RBAC Security Audit — fixture.doxaed.com Phase 1A

**Date:** 2026-06-04
**Scope:** All mutating and sensitive-read endpoints in `backend/apps/` (Phase 1A only: accounts, organizations, permissions, audit, sadmin, sports). Phase 1B apps (tournaments, matches, live, notifications, disputes) do not yet exist.
**Lens:** Server-side role/module enforcement — effective_modules resolver, per-user grants, owner-only verbs, invite tree, single_org_per_admin_user, default-deny, password-reprompt.

---

## Summary

Phase 1A RBAC is substantially well-implemented. The `effective_modules` resolver, `HasModule` factory, `IsOrgAdminOrOwner`/`IsOrgOwner` permission classes, and `superadmin_required` decorator all do their jobs. Cross-org isolation is correctly enforced at the queryset level and through membership-scoped module resolution. Three confirmed bugs and several gaps were found.

---

## Findings

### F-01 — CRITICAL: `effective_modules` resolver wrong default in unauthenticated guard

**File:** `backend/apps/permissions/services/resolver.py:113`

```python
if user is None or not getattr(user, "is_authenticated", True):
```

The `getattr` default is `True`. If `user` is a custom/test object that lacks an `is_authenticated` attribute, the resolver treats it as authenticated and proceeds to the DB lookup. The intent is clearly to default-deny, so the default must be `False`.

In production this only matters when the resolver is called directly from non-DRF code paths (e.g., a future management command, celery task, or mis-wired view) with a non-Django user object. Any view protected by DRF's `IsAuthenticated` will always have a proper Django `User` object, so the blast radius today is low. But the guard is semantically wrong and will cause a hard-to-debug security hole if the resolver is called outside of a DRF request cycle.

**Why it matters:** default-deny is an architectural invariant (#12). A wrong default violates it.

**Recommendation:** Change line 113 to `getattr(user, "is_authenticated", False)`. Add a unit test that calls `effective_modules(AnonymousUser(), org)` and asserts `frozenset()`.

**Confidence:** High

---

### F-02 — HIGH: No password re-prompt on any sensitive verb (architectural invariant gap)

**Files (all lack `@require_recent_password_reauth`):**
- `backend/apps/organizations/views.py:321` — `OrgTransferOwnershipView` (POST)
- `backend/apps/organizations/views.py:635` — `OwnershipTransferBySlugView` (POST)
- `backend/apps/organizations/views.py:289` — `OrgArchiveView` (POST)
- `backend/apps/accounts/views.py:371` — `twofa_disable_view` (POST)
- `backend/apps/accounts/views.py:391` — `twofa_recovery_regenerate_view` (POST)
- `backend/apps/sadmin/views/users.py:70` — `user_verb` (impersonate_start, suspend, force_logout_all, force_password_reset)

The `require_recent_password_reauth` decorator exists in `backend/apps/accounts/decorators.py` and the session key `SENSITIVE_REAUTH_WINDOW_MINUTES = 5` is set in settings. However, the decorator is **never applied** to any view. The `POST /api/accounts/auth/reauth/` endpoint exists and correctly writes the session timestamp, but nothing enforces it on the verbs that need it.

v1Users.md §343 explicitly lists: "sensitive verbs (delete Org, ownership transfer, role changes, rule amend post-freeze, override suspension) re-prompt for password regardless." sadmin §1.8 / §233 require `@password_reprompt` on impersonation, suspend, force-logout.

**Why it matters:** An attacker with a hijacked long-lived session (30-day cookie) can transfer org ownership or impersonate users without re-authentication. This is a core defense-in-depth measure named in the spec.

**Recommendation:** Apply `@require_recent_password_reauth()` to: `OrgTransferOwnershipView.post`, `OwnershipTransferBySlugView.post`, `OrgArchiveView.post`, `twofa_disable_view`, `twofa_recovery_regenerate_view`, and the `impersonate_start` branch of `user_verb`. Note: DRF class-based views need the decorator on the method or via a custom permission class.

**Confidence:** High

---

### F-03 — MEDIUM: `UserGrantsView.get_target_user()` does not verify target is a member of the org

**File:** `backend/apps/permissions/views.py:161-165`

```python
def get_target_user(self):
    from apps.accounts.models import User
    user_uuid = self.kwargs.get("user_uuid")
    return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))
```

The lookup is global — any valid User UUID resolves regardless of membership in the requested org. An org admin can therefore:

1. **Read** (GET) effective modules of any platform user with respect to their org — the response is limited to that org's context (no cross-org data leaks), but it confirms that the UUID belongs to a real user (IDOR user enumeration).
2. **Write** (PUT) module grants for any platform user into their org — the `MembershipModuleGrant` model has no DB-level constraint requiring the user to have a membership in the org. This creates dangling grant rows for non-members that silently activate if that user later joins the org.

**Why it matters:** User enumeration violates PRD §7.7 enumeration-safe requirements. Dangling grants violate the expected invariant that grants only apply to current members.

**Recommendation:** Add a membership existence check before returning from `get_target_user()` (or inline in the handler): `OrganizationMembership.objects.filter(user=target_user, organization=org, is_active=True).exists()` — if False, raise `Http404` or `PermissionDenied`. Apply to both GET and PUT paths.

**Confidence:** High

---

### F-04 — MEDIUM: `OrgArchiveView` uses `permission_classes = [IsAuthenticated]` + inline check instead of declarative `IsOrgOwner`

**File:** `backend/apps/organizations/views.py:289`

```python
class OrgArchiveView(APIView):
    """Owner or super-admin only."""
    permission_classes = [IsAuthenticated]

    def post(self, request, uuid):
        org = _resolve_org(uuid)
        if not request.user.is_superuser:
            is_owner = OrganizationMembership.objects.filter(...).exists()
            if not is_owner:
                raise PermissionDenied(...)
```

Functionally correct (the inline check is equivalent to `IsOrgOwner`), but DRF's `has_permission` runs before the view body so schema generators, test decorators, and future middleware can see that the view has a meaningful permission class. If a developer adds another HTTP method (e.g., `get` for preview) and forgets the inline check, access control silently degrades to `IsAuthenticated`.

All other owner-only verb views (`OrgTransferOwnershipView`, `OwnershipTransferBySlugView`) correctly use `IsOrgOwner` declaratively.

**Recommendation:** Change `permission_classes = [IsAuthenticated]` to `permission_classes = [IsAuthenticated, IsOrgOwner]` and remove the inline check.

**Confidence:** High

---

### F-05 — MEDIUM: `@csrf_exempt` on two sadmin API endpoints that perform destructive actions

**File:** `backend/apps/sadmin/views/superadmin.py:47, 97`

```python
@superadmin_required
@require_POST
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse: ...

@superadmin_required
@require_POST
@csrf_exempt
def archive_feedback_api(...) -> HttpResponse: ...
```

Both are POST endpoints gated by `@superadmin_required` (correct). `SESSION_COOKIE_SAMESITE = "Lax"` provides some mitigation against cross-origin CSRF, but "Lax" only blocks cross-origin POSTs from third-party iframes; a same-site or open-redirect trick could bypass it. `@csrf_exempt` is not needed for HTMX — HTMX can include the CSRF token from the cookie using `hx-headers`.

**Why it matters:** A CSRF attack against the bulk_email endpoint could trigger a mass-email blast to all platform users.

**Recommendation:** Remove `@csrf_exempt` from both endpoints. Update the HTMX templates to include the CSRF token via `hx-headers='{"X-CSRFToken": "..."}'` (Django's template tag `{% csrf_token %}` provides the value).

**Confidence:** High

---

### F-06 — MEDIUM: `MyEffectiveModulesView` and `MyModulesBySlugView` do not verify caller has any membership in the queried org

**Files:**
- `backend/apps/permissions/views.py:111-136` — `MyEffectiveModulesView.get()`
- `backend/apps/permissions/views.py:295-300` — `MyModulesBySlugView.get()`

Both endpoints return the authenticated user's own effective modules for any org UUID/slug they supply. The response is correct and empty (frozenset) for non-members — `effective_modules` calls `_user_active_roles` which filters `is_active=True` and returns empty set for non-members, so no actual modules leak.

However, the endpoint also confirms the org's existence (returns 404 only if org is soft-deleted). A non-member can probe whether an org UUID or slug resolves to an active organization — a minor information disclosure.

**Why it matters:** Org enumeration violates the "no cross-org leak" principle even if the data payload is empty.

**Recommendation:** After resolving the org, add a membership check: if not superuser and no active membership, return 404 or 403. Alternatively, use the existing `Organization.active_objects` only when the user has a membership in it.

**Confidence:** Medium (actual module data is not leaked; only org existence)

---

### F-07 — LOW: `sadmin_login` `?next=` parameter has no URL safety validation (potential open redirect)

**File:** `backend/apps/sadmin/views/auth.py:51`

```python
next_url = request.GET.get("next") or reverse("sadmin:dashboard")
return HttpResponseRedirect(next_url)
```

Django's `url_has_allowed_host_and_scheme` is not called. An attacker could craft `https://sadmin.fixture.doxaed.com/sadmin/login/?next=https://evil.com` and after a successful SA login the SA is redirected to the attacker's site. Impact limited since sadmin is on a separate subdomain with IP allowlist (B.15), and the superadmin is a single trusted user.

**Recommendation:** Validate `next_url` with `django.utils.http.url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()})` before using it.

**Confidence:** High (the redirect happens; severity limited by context)

---

### F-08 — INFO: `IsOrgMember` permission class imported but unused in any view's `permission_classes`

**File:** `backend/apps/organizations/views.py:39`

```python
from apps.organizations.permissions import (
    IsOrgAdminOrOwner,
    IsOrgMember,   # ← never used in permission_classes
    IsOrgOwner,
    IsSuperUser,
)
```

Not a security issue. Dead import. Could be needed for Phase 1B module-gated read surfaces where ordinary members should have access.

**Recommendation:** Remove the import until it is needed, to reduce maintenance surface.

**Confidence:** High

---

## Gaps (forward-looking)

| # | Item | Missing | Needed for | Effort | Blocking |
|---|------|---------|------------|--------|----------|
| G-01 | Cross-worker cache invalidation | Redis pub/sub for `effective_modules` cache (Appendix B.3 TODO in `resolver.py:47`) | Phase 1B multi-process prod | M | No (single-process dev fine) |
| G-02 | Permission-matrix endpoint authorization tests | DRF-level test asserting non-admin role returns 403 on `MatrixView` / `UserGrantsView` PUT | Pre-production | M | No |
| G-03 | Cross-org endpoint isolation tests for org verbs | `test_cross_org_access_blocked` tests on `OrgMembersListView`, `OrgInvitationsView`, `UserGrantsView`, `OrgMemberRemoveView` | CI quality gate | M | No |
| G-04 | Phase 1B RBAC scaffolding | `HasModule("tournament.editor")`, `HasModule("match.scoring_console")` etc. on all Phase 1B views; `ScopedQuerySet` on Tournament/Match/Team models | Phase 1B launch | XL | Yes (Phase 1B) |
| G-05 | Suspended/archived org gate on mutation endpoints | Views that mutate org data (invite, grant, remove) should reject requests to orgs in `suspended`/`archived` status | Hardening | S | No |
| G-06 | Rate limiting on grant write endpoints | `PUT /api/permissions/orgs/{slug}/users/{uuid}/grants/` has no per-endpoint throttle | Hardening | S | No |
| G-07 | `password_reprompt` decorator for sadmin verbs | `@password_reprompt` referenced in sadmin `decorators.py` doc-comment (line 127 of v1Users.md) but not implemented; only `@superadmin_required` is wired | sadmin hardening | S | No |
