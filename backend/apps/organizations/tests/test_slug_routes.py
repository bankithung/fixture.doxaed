"""Slug-routed alias endpoints (proxy to the existing UUID-based logic).

Frontend SPA was built against slug URLs (`/api/orgs/{slug}/...`); the
backend originally only exposed UUID URLs. These tests cover the slug
aliases plus the body-shape extensions (roles[], event_id idempotency,
to_user_id alias).
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from django.core.management import call_command
from django.urls import reverse
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.audit.models import AuditEvent
from apps.organizations.models import (
    AdminInvitation,
    InviteStatus,
    MembershipRole,
    OrganizationMembership,
)
from apps.organizations.tests.factories import (
    AdminInvitationFactory,
    OrganizationFactory,
    OrganizationMembershipFactory,
)


pytestmark = pytest.mark.django_db


@pytest.fixture
def loaded_modules():
    """Load the Module catalog so HasModule("org.member_directory") works."""
    call_command("load_modules")


@pytest.fixture
def admin_org():
    """Admin user (owner) + organization with the user already seated."""
    org = OrganizationFactory(slug="acme")
    admin = UserFactory()
    OrganizationMembershipFactory(
        user=admin,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=True,
    )
    return admin, org


def _api(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Members by slug
# ---------------------------------------------------------------------------


def test_members_by_slug_returns_aggregated_shape(admin_org, loaded_modules):
    """User with admin + co_organizer rows → ONE entry, roles=[both]."""
    admin, org = admin_org
    multi = UserFactory(name="Alice Smith", email="alice@example.test")
    OrganizationMembershipFactory(
        user=multi, organization=org, role=MembershipRole.CO_ORGANIZER
    )
    # Second active row for same user under a different role.
    OrganizationMembership.objects.create(
        user=multi,
        organization=org,
        role=MembershipRole.GAME_COORDINATOR,
        is_active=True,
    )

    resp = _api(admin).get(f"/api/orgs/{org.slug}/members/")
    assert resp.status_code == 200, resp.content
    rows = resp.json()
    # Should have 2 entries: admin and multi.
    by_user = {r["user_id"]: r for r in rows}
    assert str(multi.id) in by_user
    multi_row = by_user[str(multi.id)]
    assert set(multi_row["roles"]) == {
        MembershipRole.CO_ORGANIZER,
        MembershipRole.GAME_COORDINATOR,
    }
    assert multi_row["is_org_owner"] is False
    # Admin row has is_org_owner True.
    assert by_user[str(admin.id)]["is_org_owner"] is True


def test_members_by_slug_404_when_org_not_found(admin_org, loaded_modules):
    """Unknown slug → no access. The SPA treats 403 and 404 the same; we
    accept either since the permission check fails-closed when the slug
    can't resolve to an org.
    """
    admin, _ = admin_org
    resp = _api(admin).get("/api/orgs/no-such-org/members/")
    assert resp.status_code in (403, 404), resp.content


def test_members_by_slug_includes_full_name_and_joined_at(
    admin_org, loaded_modules
):
    admin, org = admin_org
    member = UserFactory(name="Bob Jones", email="bob@example.test")
    OrganizationMembershipFactory(
        user=member, organization=org, role=MembershipRole.REFEREE
    )
    resp = _api(admin).get(f"/api/orgs/{org.slug}/members/")
    assert resp.status_code == 200
    data = {r["user_id"]: r for r in resp.json()}
    bob = data[str(member.id)]
    assert bob["full_name"] == "Bob Jones"
    assert bob["email"] == "bob@example.test"
    assert bob["joined_at"]  # non-empty ISO string
    assert bob["is_active"] is True


# ---------------------------------------------------------------------------
# Invitations by slug
# ---------------------------------------------------------------------------


def test_invitation_create_accepts_roles_list(admin_org):
    admin, org = admin_org
    eid = str(_uuid.uuid4())
    resp = _api(admin).post(
        f"/api/orgs/{org.slug}/invitations/",
        data={
            "email": "newbie@example.test",
            "roles": [MembershipRole.ADMIN],
            "event_id": eid,
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["role"] == MembershipRole.ADMIN
    assert body["email"] == "newbie@example.test"
    # Audit row exists, idempotency key set.
    assert AuditEvent.objects.filter(
        event_type="member_invite_sent",
        idempotency_key=eid,
    ).count() == 1


def test_invitation_create_idempotent_on_event_id(admin_org):
    admin, org = admin_org
    eid = str(_uuid.uuid4())
    resp1 = _api(admin).post(
        f"/api/orgs/{org.slug}/invitations/",
        data={
            "email": "dup@example.test",
            "roles": [MembershipRole.CO_ORGANIZER],
            "event_id": eid,
        },
        format="json",
    )
    assert resp1.status_code == 201, resp1.content
    inv_id = resp1.json()["id"]

    resp2 = _api(admin).post(
        f"/api/orgs/{org.slug}/invitations/",
        data={
            "email": "dup@example.test",
            "roles": [MembershipRole.CO_ORGANIZER],
            "event_id": eid,
        },
        format="json",
    )
    assert resp2.status_code == 201, resp2.content
    assert resp2.json()["id"] == inv_id
    # Only one DB row.
    assert AdminInvitation.objects.filter(
        organization=org, email="dup@example.test"
    ).count() == 1


def test_invitation_create_picks_highest_tier_role(admin_org):
    admin, org = admin_org
    resp = _api(admin).post(
        f"/api/orgs/{org.slug}/invitations/",
        data={
            "email": "tier@example.test",
            "roles": [
                MembershipRole.REFEREE,
                MembershipRole.ADMIN,
                MembershipRole.MATCH_SCORER,
            ],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.json()["role"] == MembershipRole.ADMIN


def test_invitations_list_by_slug(admin_org):
    admin, org = admin_org
    AdminInvitationFactory(organization=org)
    resp = _api(admin).get(f"/api/orgs/{org.slug}/invitations/")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
    assert len(resp.json()) >= 1


def test_invitation_revoke_by_slug(admin_org):
    admin, org = admin_org
    inv = AdminInvitationFactory(organization=org, status=InviteStatus.PENDING)
    resp = _api(admin).delete(
        f"/api/orgs/{org.slug}/invitations/{inv.id}/"
    )
    assert resp.status_code == 204
    inv.refresh_from_db()
    assert inv.status == InviteStatus.REVOKED


# ---------------------------------------------------------------------------
# Ownership transfer by slug
# ---------------------------------------------------------------------------


def test_ownership_transfer_by_slug_accepts_to_user_id(admin_org):
    admin, org = admin_org
    successor = UserFactory()
    OrganizationMembershipFactory(
        user=successor,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=False,
    )
    resp = _api(admin).post(
        f"/api/orgs/{org.slug}/ownership/transfer/",
        data={
            "to_user_id": str(successor.id),
            "reason": "stepping down",
            "event_id": str(_uuid.uuid4()),
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    # Successor now owner.
    succ_row = OrganizationMembership.objects.get(user=successor, organization=org)
    assert succ_row.is_org_owner is True


def test_ownership_transfer_by_slug_still_accepts_canonical_field(admin_org):
    admin, org = admin_org
    successor = UserFactory()
    OrganizationMembershipFactory(
        user=successor,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=False,
    )
    resp = _api(admin).post(
        f"/api/orgs/{org.slug}/ownership/transfer/",
        data={
            "new_owner_user_id": str(successor.id),
            "reason": "stepping down",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content


# ---------------------------------------------------------------------------
# Invitation accept by path alias
# ---------------------------------------------------------------------------


def test_invitations_accept_by_path(admin_org, rf):
    """POST /api/orgs/invitations/accept/ accepts a token like the
    existing /api/invitations:accept/ endpoint.
    """
    admin, org = admin_org
    accepting = UserFactory()
    # Generate an invitation via the service so the token plaintext is known.
    from apps.organizations.services import invitation as invitation_svc

    request = rf.post("/")
    from django.contrib.sessions.backends.db import SessionStore

    request.session = SessionStore()
    request.session.create()
    inv, plaintext = invitation_svc.create_invitation(
        org=org,
        email=accepting.email,
        role=MembershipRole.CO_ORGANIZER,
        invited_by=admin,
        request=request,
    )
    resp = _api(accepting).post(
        "/api/orgs/invitations/accept/",
        data={"token": plaintext},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    inv.refresh_from_db()
    assert inv.status == InviteStatus.ACCEPTED


# ---------------------------------------------------------------------------
# Existing UUID routes still work
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Regression: canonical IsOrgAdminOrOwner works for both UUID and slug routes
# without 500. Previously `_resolve_org_from_view` did
# `Organization.objects.filter(pk=candidate)` which Postgres-cast a slug
# string to UUID and raised ValidationError → 500.
# ---------------------------------------------------------------------------


def test_canonical_is_org_admin_or_owner_works_for_slug_kwarg(admin_org):
    """Hitting a slug-routed admin-gated endpoint as an admin must
    return 2xx — not 500. The endpoint of choice is
    `/api/orgs/{slug}/invitations/` (now using the canonical
    `IsOrgAdminOrOwner` after the shadow class deletion).
    """
    admin, org = admin_org
    resp = _api(admin).get(f"/api/orgs/{org.slug}/invitations/")
    assert resp.status_code == 200, resp.content


def test_canonical_is_org_admin_or_owner_works_for_uuid_kwarg(admin_org):
    """The UUID-routed admin-gated endpoint still works (regression
    against accidental coupling to slug-only logic)."""
    admin, org = admin_org
    resp = _api(admin).get(f"/api/orgs/{org.id}/invitations/")
    assert resp.status_code == 200, resp.content


def test_canonical_is_org_owner_works_for_slug_kwarg(admin_org):
    """The owner-only ownership-transfer slug route still works under
    the canonical `IsOrgOwner` (which now resolves slug kwargs)."""
    admin, org = admin_org
    successor = UserFactory()
    OrganizationMembershipFactory(
        user=successor,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=False,
    )
    resp = _api(admin).post(
        f"/api/orgs/{org.slug}/ownership/transfer/",
        data={
            "new_owner_user_id": str(successor.id),
            "reason": "Slug-routed owner check works without 500.",
            "event_id": str(_uuid.uuid4()),
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content


def test_resolve_org_from_view_does_not_500_on_slug():
    """Direct unit test of the resolver — slug input must not raise."""
    from apps.organizations.permissions import _resolve_org_from_view

    org = OrganizationFactory(slug="resolver-target")

    # Simulate a DRF view with `slug` kwarg.
    class _FakeView:
        kwargs = {"slug": "resolver-target"}

    resolved = _resolve_org_from_view(_FakeView())
    assert resolved is not None
    assert resolved.id == org.id

    # Simulate the UUID branch.
    class _FakeViewUUID:
        kwargs = {"uuid": str(org.id)}

    assert _resolve_org_from_view(_FakeViewUUID()).id == org.id

    # Unknown slug → None (not exception).
    class _FakeViewUnknown:
        kwargs = {"slug": "no-such-org"}

    assert _resolve_org_from_view(_FakeViewUnknown()) is None

    # Garbage non-UUID, non-slug input → None (not exception).
    class _FakeViewGarbage:
        kwargs = {"slug_or_uuid": "Doxaed"}  # mixed-case, doesn't match lower-cased slug

    # Will normalize to lower-case and fail to find — must not 500.
    res = _resolve_org_from_view(_FakeViewGarbage())
    assert res is None


def test_uuid_routes_still_work(admin_org, loaded_modules):
    admin, org = admin_org

    # GET /api/orgs/{uuid}/members/  (canonical)
    resp = _api(admin).get(f"/api/orgs/{org.id}/members/")
    assert resp.status_code == 200, resp.content

    # GET /api/orgs/{uuid}/invitations/
    resp = _api(admin).get(f"/api/orgs/{org.id}/invitations/")
    assert resp.status_code == 200, resp.content

    # POST /api/orgs/{uuid}/invitations/  (legacy single-role body)
    resp = _api(admin).post(
        f"/api/orgs/{org.id}/invitations/",
        data={
            "email": "legacy@example.test",
            "role": MembershipRole.CO_ORGANIZER,
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content

    # POST /api/orgs/{uuid}:transfer_ownership/
    successor = UserFactory()
    OrganizationMembershipFactory(
        user=successor,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=False,
    )
    resp = _api(admin).post(
        f"/api/orgs/{org.id}:transfer_ownership/",
        data={"new_owner_user_id": str(successor.id)},
        format="json",
    )
    assert resp.status_code == 200, resp.content
