"""TDD — dispute lifecycle: raise, resolve/reject (manager), withdraw (raiser), isolation."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _member(t, email: str):
    u = _verified(email)
    TournamentMembership.objects.create(
        user=u, tournament=t, role=TournamentMembershipRole.TEAM_MANAGER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _raise(client, t, kind="score", desc="Wrong score recorded in our match"):
    return client.post(
        f"/api/tournaments/{t.id}/disputes/",
        {"kind": kind, "description": desc},
        format="json",
    )


def test_member_raises_and_manager_resolves():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    member = _member(t, "m@test.local")

    r = _raise(_client(member), t)
    assert r.status_code == 201, r.content
    did = r.json()["id"]

    rr = _client(admin).post(
        f"/api/disputes/{did}/resolve/",
        {"resolution": "Reviewed and corrected the score."},
        format="json",
    )
    assert rr.status_code == 200
    assert rr.json()["status"] == "resolved"


def test_resolve_requires_resolution_note():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    member = _member(t, "m@test.local")
    did = _raise(_client(member), t).json()["id"]

    r = _client(admin).post(
        f"/api/disputes/{did}/resolve/", {"resolution": "no"}, format="json"
    )
    assert r.status_code == 400


def test_manager_sees_all_member_sees_own():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    m1, m2 = _member(t, "m1@test.local"), _member(t, "m2@test.local")
    _raise(_client(m1), t)
    _raise(_client(m2), t)

    assert len(_client(m1).get(f"/api/tournaments/{t.id}/disputes/").json()) == 1
    assert len(_client(admin).get(f"/api/tournaments/{t.id}/disputes/").json()) == 2


def test_outsider_cannot_raise():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    outsider = _verified("out@test.local")
    assert _raise(_client(outsider), t).status_code == 404


def test_raiser_can_withdraw():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Cup")
    member = _member(t, "m@test.local")
    did = _raise(_client(member), t).json()["id"]
    assert _client(member).post(f"/api/disputes/{did}/withdraw/").status_code == 200
