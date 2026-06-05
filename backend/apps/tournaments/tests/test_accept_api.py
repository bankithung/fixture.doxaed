"""TDD — POST /api/invitations:accept/ AllowAny + inline account (design §5.4).

A logged-out, brand-new invitee accepts with a password and gets an account +
the tournament membership in one call. An existing active account is asked to
log in. The email is taken ONLY from the signed invite — never the request body
(account-takeover guard).
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.organizations.services.invitation import create_invitation
from apps.tournaments.models import TournamentMembership, TournamentMembershipStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

ACCEPT_URL = "/api/invitations:accept/"


def _verified(email: str) -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _invite(admin, tournament, email, role="referee"):
    _inv, token = create_invitation(
        org=tournament.organization, email=email, role=role, invited_by=admin, tournament=tournament
    )
    return token


def test_logged_out_new_email_accepts_with_password_creates_account():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    token = _invite(admin, t, "newref@test.local")

    resp = APIClient().post(
        ACCEPT_URL,
        {"token": token, "password": "BrandNewPass99!", "name": "New Ref"},
        format="json",
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["tournament_id"] == str(t.id)
    user = User.objects.get(email="newref@test.local")
    assert user.is_active and user.email_verified_at is not None
    assert TournamentMembership.objects.filter(
        user=user, tournament=t, status=TournamentMembershipStatus.ACTIVE
    ).exists()


def test_logged_out_existing_active_email_gets_login_required():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    _verified("existing@test.local")
    token = _invite(admin, t, "existing@test.local")

    resp = APIClient().post(ACCEPT_URL, {"token": token}, format="json")

    assert resp.status_code == 401
    assert resp.json().get("detail") == "login_required"


def test_email_taken_from_invite_not_body():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    token = _invite(admin, t, "victim@test.local")

    resp = APIClient().post(
        ACCEPT_URL,
        {"token": token, "password": "BrandNewPass99!", "email": "attacker@test.local"},
        format="json",
    )

    assert resp.status_code == 200
    assert User.objects.filter(email="victim@test.local").exists()
    assert not User.objects.filter(email="attacker@test.local").exists()
