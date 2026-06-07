"""In-app invitations inbox (Increment 13).

Covers the logged-in invitee surface:
  - GET  /api/invitations/                          -> MyInvitationsView
  - POST /api/invitations/{uuid}:accept/            -> InvitationAcceptByIdView
  - POST /api/invitations/{uuid}:decline/           -> InvitationDeclineView

Plus the service-layer email-ownership + status guards. The existing
token-accept tests live in ``test_invitation_flow.py`` and must stay green
(the refactor extracted ``_accept_invitation_row`` shared by both paths).
"""
from __future__ import annotations

import datetime as dt

import pytest
from django.core.exceptions import PermissionDenied, ValidationError
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import (
    InviteStatus,
    MembershipRole,
    OrganizationMembership,
)
from apps.organizations.services import invitation as invitation_svc
from apps.organizations.tests.factories import (
    AdminInvitationFactory,
    OrganizationFactory,
)
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipStatus,
)
from apps.tournaments.scope import accessible_tournaments

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _api(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _tournament(org, name="Cup"):
    return Tournament.objects.create(organization=org, slug=name.lower(), name=name)


# ---------------------------------------------------------------------------
# GET /api/invitations/  — list
# ---------------------------------------------------------------------------


def test_my_invitations_lists_only_mine():
    org = OrganizationFactory()
    inviter = UserFactory()
    me = UserFactory(email="me@example.test")
    tournament = _tournament(org, name="Spring Cup")

    # Tournament-scoped invite to me.
    mine_t = AdminInvitationFactory(
        organization=org,
        tournament=tournament,
        email="me@example.test",
        invited_by=inviter,
        role=MembershipRole.MATCH_SCORER,
    )
    # Org-level invite to me.
    mine_org = AdminInvitationFactory(
        organization=org, email="me@example.test", invited_by=inviter
    )
    # Invite for someone else — must not appear.
    AdminInvitationFactory(organization=org, email="other@example.test")

    resp = _api(me).get("/api/invitations/")
    assert resp.status_code == 200
    ids = {row["id"] for row in resp.data}
    assert ids == {str(mine_t.id), str(mine_org.id)}

    by_id = {row["id"]: row for row in resp.data}
    t_row = by_id[str(mine_t.id)]
    assert t_row["tournament_id"] == str(tournament.id)
    assert t_row["tournament_name"] == "Spring Cup"
    assert t_row["organization_name"] == org.name
    assert t_row["invited_by_email"] == inviter.email
    assert t_row["role"] == MembershipRole.MATCH_SCORER
    assert t_row["status"] == InviteStatus.PENDING

    org_row = by_id[str(mine_org.id)]
    assert org_row["tournament_id"] is None
    assert org_row["tournament_name"] is None


def test_my_invitations_email_match_is_case_insensitive():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    inv = AdminInvitationFactory(organization=org, email="ME@Example.TEST")
    # AdminInvitation.save() lowercases email; the lookup is iexact anyway.
    resp = _api(me).get("/api/invitations/")
    assert resp.status_code == 200
    assert {row["id"] for row in resp.data} == {str(inv.id)}


def test_expired_excluded_from_list():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    AdminInvitationFactory(
        organization=org,
        email="me@example.test",
        expires_at=timezone.now() - dt.timedelta(days=1),
    )
    live = AdminInvitationFactory(
        organization=org,
        email="me@example.test",
        expires_at=timezone.now() + dt.timedelta(days=3),
    )
    resp = _api(me).get("/api/invitations/")
    assert resp.status_code == 200
    assert {row["id"] for row in resp.data} == {str(live.id)}


def test_accepted_and_declined_excluded_from_list():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    AdminInvitationFactory(
        organization=org, email="me@example.test", status=InviteStatus.ACCEPTED
    )
    AdminInvitationFactory(
        organization=org, email="me@example.test", status=InviteStatus.DECLINED
    )
    pending = AdminInvitationFactory(organization=org, email="me@example.test")
    resp = _api(me).get("/api/invitations/")
    assert {row["id"] for row in resp.data} == {str(pending.id)}


def test_my_invitations_requires_auth():
    resp = APIClient().get("/api/invitations/")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# POST /api/invitations/{uuid}:accept/
# ---------------------------------------------------------------------------


def test_accept_by_id_creates_tournament_membership():
    org = OrganizationFactory()
    inviter = UserFactory()
    me = UserFactory(email="me@example.test")
    tournament = _tournament(org)
    inv = AdminInvitationFactory(
        organization=org,
        tournament=tournament,
        email="me@example.test",
        invited_by=inviter,
        role=MembershipRole.MATCH_SCORER,
    )

    # Before: tournament not accessible.
    assert tournament.id not in set(
        accessible_tournaments(me).values_list("id", flat=True)
    )

    resp = _api(me).post(f"/api/invitations/{inv.id}:accept/")
    assert resp.status_code == 200
    assert resp.data["status"] == "accepted"
    assert resp.data["tournament_id"] == str(tournament.id)
    assert resp.data["role"] == MembershipRole.MATCH_SCORER

    tm = TournamentMembership.objects.get(user=me, tournament=tournament)
    assert tm.status == TournamentMembershipStatus.ACTIVE
    assert str(tm.id) == resp.data["membership_id"]

    inv.refresh_from_db()
    assert inv.status == InviteStatus.ACCEPTED
    assert inv.accepted_by_user_id == me.id

    # Now accessible.
    assert tournament.id in set(
        accessible_tournaments(me).values_list("id", flat=True)
    )

    # No org-wide membership leaked (isolation): tournament invite must NOT
    # create an OrganizationMembership.
    assert not OrganizationMembership.objects.filter(
        user=me, organization=org
    ).exists()


def test_accept_by_id_org_invite_creates_org_membership():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    inv = AdminInvitationFactory(
        organization=org, email="me@example.test", role=MembershipRole.CO_ORGANIZER
    )
    resp = _api(me).post(f"/api/invitations/{inv.id}:accept/")
    assert resp.status_code == 200
    assert resp.data["status"] == "accepted"
    assert "tournament_id" not in resp.data
    om = OrganizationMembership.objects.get(user=me, organization=org)
    assert om.is_active
    assert str(om.id) == resp.data["membership_id"]


def test_accept_by_id_is_idempotent_second_accept_does_not_duplicate():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    tournament = _tournament(org)
    inv = AdminInvitationFactory(
        organization=org, tournament=tournament, email="me@example.test"
    )
    first = _api(me).post(f"/api/invitations/{inv.id}:accept/")
    assert first.status_code == 200

    # Already accepted → 400 (idempotent-ish: no error-500, no dup membership).
    second = _api(me).post(f"/api/invitations/{inv.id}:accept/")
    assert second.status_code == 400
    assert (
        TournamentMembership.objects.filter(
            user=me, tournament=tournament
        ).count()
        == 1
    )


def test_cannot_accept_invite_for_other_email():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    tournament = _tournament(org)
    inv = AdminInvitationFactory(
        organization=org, tournament=tournament, email="someone-else@example.test"
    )
    resp = _api(me).post(f"/api/invitations/{inv.id}:accept/")
    assert resp.status_code == 403
    # No membership created.
    assert not TournamentMembership.objects.filter(user=me).exists()
    inv.refresh_from_db()
    assert inv.status == InviteStatus.PENDING


def test_accept_by_id_unknown_invitation_is_404():
    import uuid as _uuid

    me = UserFactory(email="me@example.test")
    resp = _api(me).post(f"/api/invitations/{_uuid.uuid4()}:accept/")
    assert resp.status_code == 404


def test_accept_by_id_expired_returns_400():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    inv = AdminInvitationFactory(
        organization=org,
        email="me@example.test",
        expires_at=timezone.now() - dt.timedelta(days=1),
    )
    resp = _api(me).post(f"/api/invitations/{inv.id}:accept/")
    assert resp.status_code == 400
    # No membership created for an expired invite.
    assert not OrganizationMembership.objects.filter(user=me, organization=org).exists()


def test_service_accept_by_id_expired_flips_status_to_expired():
    """The status materialization mirrors the token path (tested directly so
    it is independent of the request-level ATOMIC_REQUESTS transaction)."""
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    inv = AdminInvitationFactory(
        organization=org,
        email="me@example.test",
        expires_at=timezone.now() - dt.timedelta(days=1),
    )
    with pytest.raises(ValidationError):
        invitation_svc.accept_invitation_by_id(
            invitation_id=inv.id, accepting_user=me, request=None
        )
    inv.refresh_from_db()
    assert inv.status == InviteStatus.EXPIRED


# ---------------------------------------------------------------------------
# POST /api/invitations/{uuid}:decline/
# ---------------------------------------------------------------------------


def test_decline_sets_status_and_blocks_accept():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    tournament = _tournament(org)
    inv = AdminInvitationFactory(
        organization=org, tournament=tournament, email="me@example.test"
    )

    decl = _api(me).post(f"/api/invitations/{inv.id}:decline/")
    assert decl.status_code == 200
    assert decl.data["status"] == "declined"
    inv.refresh_from_db()
    assert inv.status == InviteStatus.DECLINED

    # Declined → cannot accept.
    acc = _api(me).post(f"/api/invitations/{inv.id}:accept/")
    assert acc.status_code == 400
    assert not TournamentMembership.objects.filter(user=me).exists()


def test_cannot_decline_invite_for_other_email():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    inv = AdminInvitationFactory(
        organization=org, email="someone-else@example.test"
    )
    resp = _api(me).post(f"/api/invitations/{inv.id}:decline/")
    assert resp.status_code == 403
    inv.refresh_from_db()
    assert inv.status == InviteStatus.PENDING


def test_decline_unknown_invitation_is_404():
    import uuid as _uuid

    me = UserFactory(email="me@example.test")
    resp = _api(me).post(f"/api/invitations/{_uuid.uuid4()}:decline/")
    assert resp.status_code == 404


def test_decline_requires_auth():
    org = OrganizationFactory()
    inv = AdminInvitationFactory(organization=org, email="me@example.test")
    resp = APIClient().post(f"/api/invitations/{inv.id}:decline/")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Service-layer guards (direct calls)
# ---------------------------------------------------------------------------


def test_service_accept_by_id_email_mismatch_raises_permission_denied():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    inv = AdminInvitationFactory(organization=org, email="nope@example.test")
    with pytest.raises(PermissionDenied):
        invitation_svc.accept_invitation_by_id(
            invitation_id=inv.id, accepting_user=me, request=None
        )


def test_service_decline_only_pending():
    org = OrganizationFactory()
    me = UserFactory(email="me@example.test")
    inv = AdminInvitationFactory(
        organization=org, email="me@example.test", status=InviteStatus.ACCEPTED
    )
    with pytest.raises(ValidationError):
        invitation_svc.decline_invitation(
            invitation_id=inv.id, declining_user=me, request=None
        )
