"""POST /api/tournaments/{id}/invitations/{invitation_id}/resend/.

Before this there was no way to re-send an invitation — only revoke it — so an
invite that aged out or landed in spam was a dead end. Resend mints a FRESH
token (the stale one dies), re-stamps the expiry, and is rate-limited so it
cannot be used to hammer someone's inbox.
"""
from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.organizations.models import AdminInvitation, InviteStatus
from apps.organizations.services.invitation import (
    create_invitation,
    get_invitation_by_token,
    revoke_invitation,
)
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> User:
    user = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _client(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(t, inv) -> str:
    return f"/api/tournaments/{t.id}/invitations/{inv.id}/resend/"


@pytest.fixture
def scene():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    inv, token = create_invitation(
        org=t.organization,
        tournament=t,
        email="ref@test.local",
        role="referee",
        invited_by=admin,
    )
    mail.outbox.clear()
    return admin, t, inv, token


def test_resend_mints_a_new_token_and_extends_expiry(settings, scene):
    settings.INVITE_RESEND_COOLDOWN_SECONDS = 0
    admin, t, inv, old_token = scene
    old_hash = inv.token_hash
    # Pretend it is nearly expired, as a real "they never got it" invite is.
    AdminInvitation.objects.filter(pk=inv.pk).update(
        expires_at=timezone.now() + dt.timedelta(hours=1)
    )
    old_expiry = AdminInvitation.objects.get(pk=inv.pk).expires_at

    resp = _client(admin).post(_url(t, inv), {}, format="json")

    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["id"] == str(inv.id)
    assert body["email"] == "ref@test.local"
    assert body["status"] == InviteStatus.PENDING
    assert body["email_sent"] is True
    assert "token" not in resp.content.decode()

    inv.refresh_from_db()
    assert inv.token_hash != old_hash  # fresh token
    assert inv.expires_at > old_expiry + dt.timedelta(days=5)  # re-stamped TTL
    assert get_invitation_by_token(old_token) is None  # the stale token is dead
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["ref@test.local"]


def test_resend_is_rate_limited(settings, scene):
    settings.INVITE_RESEND_COOLDOWN_SECONDS = 900
    admin, t, inv, _token = scene
    before = inv.token_hash

    resp = _client(admin).post(_url(t, inv), {}, format="json")

    assert resp.status_code == 429, resp.content
    assert resp.json()["detail"] == "resend_too_soon"
    assert 0 < resp.json()["retry_after_seconds"] <= 900
    inv.refresh_from_db()
    assert inv.token_hash == before  # nothing rotated
    assert mail.outbox == []  # and nobody was mailed


def test_second_resend_inside_the_window_is_refused(settings, scene):
    admin, t, inv, _token = scene
    settings.INVITE_RESEND_COOLDOWN_SECONDS = 0
    first = _client(admin).post(_url(t, inv), {}, format="json")
    assert first.status_code == 200, first.content

    settings.INVITE_RESEND_COOLDOWN_SECONDS = 900
    second = _client(admin).post(_url(t, inv), {}, format="json")

    assert second.status_code == 429
    assert len(mail.outbox) == 1  # only the first one went out


def test_resend_refuses_a_non_pending_invitation(settings, scene):
    settings.INVITE_RESEND_COOLDOWN_SECONDS = 0
    admin, t, inv, _token = scene
    revoke_invitation(invitation=inv, revoked_by=admin, reason="left the crew")

    resp = _client(admin).post(_url(t, inv), {}, format="json")

    assert resp.status_code == 400, resp.content
    assert resp.json()["detail"] == "invitation_not_pending"
    assert mail.outbox == []


def test_resend_is_audited(settings, scene):
    from apps.audit.models import AuditEvent

    settings.INVITE_RESEND_COOLDOWN_SECONDS = 0
    admin, t, inv, _token = scene

    _client(admin).post(_url(t, inv), {}, format="json")

    audit = AuditEvent.objects.get(event_type="member_invite_resent")
    assert audit.target_id == inv.id
    assert audit.organization_id == t.organization_id
    assert audit.actor_user_id == admin.id


# ---------------------------------------------------------------------------
# Isolation (invariant 2)
# ---------------------------------------------------------------------------


def test_resend_is_manager_gated(settings, scene):
    """403 for a member who can see the tournament but doesn't manage it;
    404 is reserved for a tournament that doesn't resolve for the user."""
    settings.INVITE_RESEND_COOLDOWN_SECONDS = 0
    _admin, t, inv, _token = scene
    scorer = _verified("scorer@test.local")
    TournamentMembership.objects.create(
        user=scorer,
        tournament=t,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    before = inv.token_hash

    resp = _client(scorer).post(_url(t, inv), {}, format="json")

    assert resp.status_code == 403
    inv.refresh_from_db()
    assert inv.token_hash == before
    assert mail.outbox == []


def test_manager_of_another_org_cannot_resend(settings, scene):
    settings.INVITE_RESEND_COOLDOWN_SECONDS = 0
    _admin, t, inv, _token = scene
    other = _verified("other-admin@test.local")
    create_tournament(user=other, name="Kohima Cup")

    resp = _client(other).post(_url(t, inv), {}, format="json")

    assert resp.status_code == 404
    assert mail.outbox == []


def test_invitation_from_another_tournament_is_not_resendable_here(settings, scene):
    settings.INVITE_RESEND_COOLDOWN_SECONDS = 0
    admin, t, _inv, _token = scene
    other_t = create_tournament(user=admin, name="Kohima Cup")
    foreign, _ = create_invitation(
        org=other_t.organization,
        tournament=other_t,
        email="elsewhere@test.local",
        role="referee",
        invited_by=admin,
    )
    mail.outbox.clear()

    resp = _client(admin).post(_url(t, foreign), {}, format="json")

    assert resp.status_code == 404
    assert mail.outbox == []
