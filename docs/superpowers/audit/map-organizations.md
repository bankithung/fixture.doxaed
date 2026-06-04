# Organizations App — Structural Map

**Date:** 2026-06-04
**Area:** `backend/apps/organizations/`
**Status:** Phase 1A (fully implemented and tested)

---

## Purpose

The `organizations` app is the multi-tenancy boundary for the entire platform (Invariant #2). It owns:

- `Organization` — the primary tenant unit (slug, lifecycle status, soft-delete).
- `OrganizationMembership` — the join table binding a `User` to an `Organization` with a role.
- `AdminInvitation` — email-token invite lifecycle (create → accept / revoke / expire).
- `SlugRedirect` — audit trail of slug renames; powers 301 redirects.

Supporting infrastructure: four service modules (`lifecycle`, `ownership`, `invitation`, `slug`), a scope-filter mixin (`scope.py`), permission classes (`permissions.py`), DRF serializers, and a `manage.py` command for orphan detection.

---

## Key Files

| File | Role |
|------|------|
| `models.py` | Four models + three enums (`OrgStatus`, `MembershipRole`, `InviteStatus`) + two custom managers |
| `constants.py` | `SLUG_REGEX` + `RESERVED_SLUGS` frozenset (~35 entries) |
| `views.py` | 15 DRF APIView/GenericAPIView classes; dual UUID + slug routing |
| `urls.py` | 17 URL patterns; AIP-136 colon-verb + slug-alias patterns |
| `permissions.py` | `IsOrgMember`, `IsOrgAdminOrOwner`, `IsOrgOwner`, `IsSuperUser` |
| `serializers.py` | 11 serializer classes; read/write split throughout |
| `scope.py` | `ScopedQuerySetMixin` + `OrgScopedQuerySet` for downstream tenant filtering |
| `services/lifecycle.py` | `create_organization`, `approve_org`, `reject_org`, `suspend_org`, `unsuspend_org`, `archive_org`, `detect_orphaned` |
| `services/invitation.py` | `create_invitation`, `accept_invitation`, `revoke_invitation` |
| `services/ownership.py` | `transfer_ownership` (atomic two-step swap) |
| `services/slug.py` | `validate_slug`, `change_slug`, `resolve_slug` |
| `management/commands/mark_orphaned_orgs.py` | Cron-safe wrapper over `detect_orphaned()` |
| `migrations/0001_initial.py` | Single migration; creates all four tables + all indexes + all constraints |
| `tests/` | 8 test modules; ~65 tests covering happy paths, constraint violations, slug redirects, audit emission, ownership transfer, orphan detection |

---

## Models

### `Organization`
- PK: UUID v7 via `apps.accounts.models.uuid7` (Invariant #1 satisfied).
- `slug` unique CharField(63); `name` CharField(200); `time_zone` CharField(64) defaulting to `"Asia/Kolkata"`.
- `status` TextChoices: `pending_review | active | suspended | archived | orphaned`.
- Soft-delete: `deleted_at` nullable DateTimeField; `active_objects` manager filters `deleted_at__isnull=True`.
- `created_by` SET_NULL FK to User.
- Missing: no `description` or logo field (PRD §3 does not require them in v1, so this is expected).

### `OrganizationMembership`
- PK: UUID v7.
- `user` + `organization` + `role` — role is part of the uniqueness key (multi-role per user/org allowed).
- `is_org_owner` Boolean — only valid when `role=admin` (enforced by CheckConstraint).
- `is_active` + `removed_at` for soft-removal.
- `created_by` SET_NULL FK.
- DB constraints (all in migration):
  - `unique_active_role_per_user_per_org`: partial unique on `(user, org, role)` where `is_active=True`.
  - `one_owner_per_org`: partial unique on `(organization,)` where `is_org_owner=True AND is_active=True`.
  - `single_org_per_admin_user`: partial unique on `(user,)` where `role='admin' AND is_active=True`.
  - `owner_flag_only_on_admin_role`: CheckConstraint `is_org_owner=False OR role='admin'`.

### `AdminInvitation`
- PK: UUID v7.
- `token_hash` = `sha256(plaintext)` (plaintext emailed only, never stored).
- `status` TextChoices: `pending | accepted | expired | revoked`.
- `effective_status` property materialises expiry at read-time (no background sweep needed).
- DB constraint: `unique_pending_invite_per_email_per_org` partial unique on `(org, email)` where `status='pending'`.
- `email.lower()` enforced in `save()`.

### `SlugRedirect`
- PK: UUID v7.
- `old_slug` unique CharField(63); FK to `Organization` CASCADE.
- Written atomically by `slug_svc.change_slug()`; `validate_slug()` also blocks new slugs that collide with any `SlugRedirect.old_slug`.

---

## Endpoints / Routes

All mounted under `/api/orgs/` via `fixture.urls`.

| Method | Pattern | View | Auth |
|--------|---------|------|------|
| GET | `/api/orgs/` | `OrgListCreateView` | IsAuthenticated |
| POST | `/api/orgs/` | `OrgListCreateView` | IsAuthenticated + is_superuser |
| GET/PATCH | `/api/orgs/<slug_or_uuid>/` | `OrgDetailView` | IsAuthenticated + membership/superuser |
| POST | `/api/orgs/<uuid>:change_slug/` | `OrgChangeSlugView` | IsAuthenticated + IsOrgAdminOrOwner |
| POST | `/api/orgs/<uuid>:suspend/` | `OrgSuspendView` | IsAuthenticated + IsSuperUser |
| POST | `/api/orgs/<uuid>:unsuspend/` | `OrgUnsuspendView` | IsAuthenticated + IsSuperUser |
| POST | `/api/orgs/<uuid>:archive/` | `OrgArchiveView` | IsAuthenticated + owner/superuser check inline |
| POST | `/api/orgs/<uuid>:transfer_ownership/` | `OrgTransferOwnershipView` | IsAuthenticated + IsOrgOwner |
| GET | `/api/orgs/<uuid>/members/` | `OrgMembersListView` | IsAuthenticated + HasModule("org.member_directory") |
| DELETE | `/api/orgs/<uuid>/members/<membership_id>/` | `OrgMemberRemoveView` | IsAuthenticated + IsOrgAdminOrOwner |
| GET/POST | `/api/orgs/<uuid>/invitations/` | `OrgInvitationsView` | IsAuthenticated + IsOrgAdminOrOwner |
| POST | `/api/orgs/<uuid>/invitations/<id>:revoke/` | `OrgInvitationRevokeView` | IsAuthenticated + IsOrgAdminOrOwner |
| POST | `/api/invitations:accept/` | `InvitationAcceptView` | IsAuthenticated |
| GET/POST | `/api/orgs/<slug>/members/` | `OrgMembersBySlugView` | IsAuthenticated + HasModule("org.member_directory") |
| GET/POST | `/api/orgs/<slug>/invitations/` | `OrgInvitationsBySlugView` | IsAuthenticated + IsOrgAdminOrOwner |
| DELETE | `/api/orgs/<slug>/invitations/<id>/` | `OrgInvitationByIdSlugView` | IsAuthenticated + IsOrgAdminOrOwner |
| POST | `/api/orgs/<slug>/ownership/transfer/` | `OwnershipTransferBySlugView` | IsAuthenticated + IsOrgOwner |
| POST | `/api/orgs/invitations/accept/` | `InvitationAcceptByPathView` | IsAuthenticated |

**No DRF endpoints** exist for `approve_org` / `reject_org` — those are sadmin-console-only (HTMX views at `/sadmin/orgs/<id>/<verb>/`). This is intentional per v1Users.md §1.5 (no Django admin; sadmin only).

---

## Findings

### F-01 — CRITICAL: UUID-routed invitation POST will KeyError when `roles` array is sent

**Severity:** critical
**File:line:** `views.py:427`
**Evidence:** `role=ser.validated_data["role"]`

The `AdminInvitationCreateSerializer.validate()` only injects `attrs["role"] = MembershipRole.CO_ORGANIZER` when *neither* `role` nor `roles` is present. When the SPA sends `{"roles": ["co_organizer"]}` (which the slug-routed view handles correctly via `.get()`), the UUID-routed `OrgInvitationsView.post()` calls `ser.validated_data["role"]` as a hard dict lookup — `KeyError` → unhandled 500.

The slug-routed `OrgInvitationsBySlugView.post()` (line 574–581) uses `.get()` and passes both `role` and `roles` correctly. The UUID route is the legacy/canonical route; fixing it to match the slug route is the right action.

**Recommendation:** Change line 424–430 in `OrgInvitationsView.post()` to mirror `OrgInvitationsBySlugView.post()`:
```python
inv, _plaintext = invitation_svc.create_invitation(
    org=org,
    email=ser.validated_data["email"],
    role=ser.validated_data.get("role"),
    roles=ser.validated_data.get("roles"),
    invited_by=request.user,
    request=request,
    event_id=ser.validated_data.get("event_id"),
)
```

---

### F-02 — HIGH: UUID-routed invitation POST does not forward `event_id` (idempotency broken)

**Severity:** high
**File:line:** `views.py:424–430`
**Evidence:** `invitation_svc.create_invitation(... invited_by=request.user, request=request)` — no `event_id` kwarg.

Invariant #3 requires every mutation to accept a client-generated `event_id` for idempotency. The slug-routed view (line 581) forwards it; the UUID-routed canonical view does not. A client replaying a POST to the UUID route will get a second invitation row or a 400 (duplicate pending invite), never a 200 replay.

**Recommendation:** Forward `event_id` in `OrgInvitationsView.post()` (same fix as F-01 above).

---

### F-03 — HIGH: `one_owner_per_org` constraint is NOT deferrable — comment in code says it is

**Severity:** high
**File:line:** `models.py:218–222`, `services/ownership.py:7–20`, `services/ownership.py:91`
**Evidence:**
- `models.py:218`: "NOTE (accounts agent deferral): Django prohibits combining `condition` with `deferrable`…"
- `services/ownership.py:91`: "# Atomic swap. Thanks to DEFERRABLE INITIALLY DEFERRED, the constraint is checked at COMMIT"

The comment in `ownership.py` thanks a constraint that does not actually exist as deferred. The workaround (clear outgoing owner first, then set incoming) is correct in practice because the partial-unique condition has zero matches between the two saves. However the comment is misleading and the promised follow-up `RunSQL` migration (models.py:219: "added by a follow-up RunSQL migration owned by the organizations agent") was never written. The test for the atomic swap passes only because the workaround works — not because of DEFERRABLE behaviour.

**Recommendation:** Either add the `RunSQL` migration that adds `DEFERRABLE INITIALLY DEFERRED` to the `one_owner_per_org` constraint (correct the spec's intent), or update the comment in `ownership.py:91` to explain that the constraint is IMMEDIATE but the ordering prevents violation. The missing migration is a documentation/correctness gap; the runtime is safe.

---

### F-04 — HIGH: No cross-org isolation test for the organizations API layer itself

**Severity:** high
**File:line:** `tests/` (all test modules)
**Evidence:** Searching all test files in `apps/organizations/tests/` found zero tests asserting that a user from Org A cannot read/write data belonging to Org B through the organizations endpoints.

The invariant ("CI tests assert no cross-org leak via any DRF / SSE / WebSocket endpoint") is stated in CLAUDE.md. The audit app has `test_cross_org_leak_blocked` at `apps/audit/tests/test_audit_list_view.py:120`. The organizations app has no equivalent. A logged-in user in Org A can query `/api/orgs/<uuid_of_org_B>/members/` — the view does check membership (`OrganizationMembership.objects.filter(..., is_active=True).exists()`) at line 187–191 for `OrgDetailView`, but there is no parametrized cross-org boundary test covering all endpoints.

**Recommendation:** Add `test_cross_org_isolation.py` parametrized over all guarded endpoints asserting 403/404 when requesting Org B data as an Org A-only member.

---

### F-05 — MEDIUM: `OrgMembersListView` (UUID route) and `OrgMembersBySlugView` (slug route) return different shapes

**Severity:** medium
**File:line:** `views.py:349–365` (UUID route) vs `views.py:502–549` (slug route)
**Evidence:**
- UUID route (`/api/orgs/<uuid>/members/`) returns `OrganizationMembershipSerializer` — one row per membership, field `user` is UUID only.
- Slug route (`/api/orgs/<slug>/members/`) returns `OrgMemberDetailSerializer` — aggregated per user, with `roles[]`, `email`, `full_name`, `joined_at`.

The SPA uses the slug route (which has the richer shape). The UUID route exists as the "canonical AIP-136" shape but returns raw membership rows that include no user email/name. This is a divergence: the two routes to the same resource expose different schemas. A consumer using the UUID route does not get the user's email without a second request.

**Recommendation:** Either (a) align the UUID route to return the same aggregated `OrgMemberDetailSerializer` shape, or (b) explicitly document the intentional divergence in the URL config comment and make the slug route the canonical public one. Option (a) is preferred for Phase 1B, when TournamentMembership will add a third variant.

---

### F-06 — MEDIUM: `OrgArchiveView` re-implements the owner check inline instead of using `IsOrgOwner`

**Severity:** medium
**File:line:** `views.py:289–315`
**Evidence:** `permission_classes = [IsAuthenticated]` then an inline check at lines 295–303:
```python
is_owner = OrganizationMembership.objects.filter(
    user=request.user, organization=org, is_active=True,
    role=MembershipRole.ADMIN, is_org_owner=True,
).exists()
if not is_owner:
    raise PermissionDenied(...)
```

All other owner-gated views use the `IsOrgOwner` class declared in `permissions.py`. This inline check is functionally equivalent but bypasses the unified permission class, making it harder to audit and potentially diverge if `IsOrgOwner` logic changes.

**Recommendation:** Change `OrgArchiveView.permission_classes` to `[IsAuthenticated, IsOrgOwner]` to match the other owner-gated views.

---

### F-07 — MEDIUM: `detect_orphaned()` iterates in Python (no bulk update)

**Severity:** medium
**File:line:** `services/lifecycle.py:265–298`
**Evidence:**
```python
for org in candidates:
    has_admin = OrganizationMembership.objects.filter(...).exists()
    if not has_admin:
        with transaction.atomic():
            org.save(...)
```

One `SELECT` per org + one `UPDATE` per orphaned org. For a platform with hundreds of orgs this is N+1 queries. This is a `manage.py` command with no SLA, but it will be slow at scale.

**Recommendation:** Rewrite using a subquery to identify orgs with no active admin in a single query, then use `Organization.objects.filter(id__in=orphan_ids).update(status=OrgStatus.ORPHANED)` plus a bulk `emit_audit` sweep. Audit emission prevents a true single-SQL approach, but batching the SELECT at least halves the query count.

---

### F-08 — MEDIUM: Invitation expiry sweep is read-time only; no cron to flip stale rows

**Severity:** medium
**File:line:** `models.py:323–329`, `serializers.py:163–167`
**Evidence:**
- `AdminInvitation.effective_status` materialises expiry at read-time.
- `AdminInvitationSerializer` doc: "we don't run a cron — read-time materialization."

A DB query that filters `status='pending'` to find valid invitations will return rows that are logically expired (their `expires_at` is past but `status` column is still `'pending'`). The `accept_invitation` service correctly handles this, but any raw queryset used outside the service (e.g., reporting, admin) will count expired-but-still-pending rows.

**Recommendation:** Add a `management/commands/sweep_expired_invitations.py` that runs `AdminInvitation.objects.filter(status='pending', expires_at__lt=now()).update(status='expired')`. Wire it to the same systemd timer as `mark_orphaned_orgs`. This is low-priority but important for data hygiene before Phase 1B adds invitation reporting.

---

### F-09 — MEDIUM: `_OrgMembershipPermission.has_permission` returns `True` when org cannot be resolved

**Severity:** medium
**File:line:** `permissions.py:86–89`
**Evidence:**
```python
org = _resolve_org_from_view(view)
if org is None:
    # Resource-level views without an org slug pass through here;
    # object-level permission filters at the queryset layer.
    return True
```

When the URL kwarg cannot be resolved to an org (e.g., an unknown slug, or a view that doesn't carry an org kwarg), the permission class returns `True` (pass-through). This is the deliberate design for views that do their own filtering, but it means the permission class silently passes when applied to a view type it wasn't designed for. Misapplication (e.g., a future view that accidentally lacks an org kwarg) would silently allow access.

**Recommendation:** Add a note in the `_OrgMembershipPermission` docstring making the pass-through explicit and consider a `require_org: bool = False` class attribute that, when `True`, returns `False` instead of `True` when no org resolves.

---

### F-10 — LOW: User-facing string literals in `views.py` and `services/` are not wrapped in `gettext`

**Severity:** low
**File:line:** `views.py:143`, `views.py:191`, `views.py:200`, `views.py:303`, `services/lifecycle.py:92`, `services/lifecycle.py:116`, etc.
**Evidence:** `raise PermissionDenied("Only super-admins can create organizations.")` — bare string literal.

Invariant #13 requires all user-visible strings to be wrapped in `gettext` / `_()` even though only English ships in v1. Error messages and permission denial messages are user-visible (they appear in API responses). None of the string literals in `views.py` or the service layer are wrapped.

**Recommendation:** Wrap all user-facing string literals with `from django.utils.translation import gettext_lazy as _` and `_("...")`.

---

### F-11 — LOW: `OrganizationFactory` default status is `ACTIVE`, not `PENDING_REVIEW`

**Severity:** low
**File:line:** `tests/factories.py:27`
**Evidence:** `status = OrgStatus.ACTIVE`

The `Organization` model defaults to `pending_review` in production (`models.py:122`), but the test factory defaults to `active`. This means tests using `OrganizationFactory()` without an explicit status skip the `pending_review → active` lifecycle and may miss bugs in code that guards on `org.status in (ACTIVE,)`.

**Recommendation:** Either change the factory default to `PENDING_REVIEW` to match the real default, or add a `OrganizationFactory.with_status_active()` trait. At minimum, document the deviation.

---

### F-12 — LOW: `_cycle_session` stub in `invitation.py` references a non-existent module with bare `except`

**Severity:** low
**File:line:** `services/invitation.py:66–79`
**Evidence:**
```python
try:
    from apps.accounts.services.session_security import cycle_session_on_role_change
    cycle_session_on_role_change(request)
    return
except Exception:  # noqa: BLE001 — fallback path; helper not yet shipped
    pass
```

`apps.accounts.services.session_security` now exists (it was referenced in the accounts app grep results), so the import should succeed. If `cycle_session_on_role_change` does exist, the stub silently swallows any exception from it and falls through to the weaker `request.session.cycle_key()` fallback. This means a bug in `cycle_session_on_role_change` would be invisible.

**Recommendation:** Now that the accounts agent's `session_security` module is importable, remove the bare `except Exception` wrapper and import directly. The comment "stub is removed once accounts agent's helper is importable" (line 13–14) is still there — act on it.

---

### F-13 — INFO: `approve_org` / `reject_org` have no DRF endpoints — sadmin-only

**Severity:** info
**File:line:** `views.py` (absent), `services/lifecycle.py:84–144`

The `approve_org` and `reject_org` service functions are implemented and tested but are only callable through the sadmin HTMX interface (`sadmin/views/orgs.py`). There are no DRF colon-verb endpoints for these. This is correct per v1Users.md §1.5 (sadmin-only). Noted here so Phase 1B does not accidentally assume these are API-accessible.

---

### F-14 — INFO: `Deferrable` imported in `models.py` but never used

**Severity:** info
**File:line:** `models.py:22`
**Evidence:** `from django.db.models import Deferrable, Q, UniqueConstraint, CheckConstraint`

`Deferrable` is imported but no model uses it (the deferrable constraint is deferred to a RunSQL migration per models.py:219). This is a minor unused-import linting issue.

**Recommendation:** Remove `Deferrable` from the import or add the RunSQL migration that actually uses it.

---

## Gaps

| Gap | Description | Priority |
|-----|-------------|----------|
| Cross-org isolation tests | No test asserts that a member of Org A cannot access org B's members/invitations/details via the DRF API. Required by CLAUDE.md invariant. | Critical |
| UUID invitation POST diverged from slug POST | `roles[]` and `event_id` not forwarded (F-01, F-02). | Critical |
| `one_owner_per_org` RunSQL migration | Promised follow-up migration to add `DEFERRABLE INITIALLY DEFERRED` not written (F-03). | High |
| Expired invitation sweep command | No cron command to flip stale `pending` rows to `expired`; all expiry is read-time only (F-08). | Medium |
| Member endpoint shape divergence | UUID and slug member list routes return different serializer shapes (F-05). | Medium |
| `OrgArchiveView` inline permission check | Should use `IsOrgOwner` permission class (F-06). | Medium |
| i18n on error strings | `gettext` not applied in views or services (F-10). | Low |
| `_cycle_session` stub | Accounts session_security module now exists; stub should be cleaned up (F-12). | Low |
| `Deferrable` unused import | Minor linting gap (F-14). | Low |
| `OrganizationFactory` status default | Factory defaults to `ACTIVE` but model defaults to `PENDING_REVIEW` (F-11). | Low |
