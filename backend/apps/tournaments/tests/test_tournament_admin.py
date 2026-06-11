"""Tournament delete + activate/deactivate (archive) — manager-gated, audited,
isolation-safe."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_admin_can_soft_delete_tournament():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Oops")

    r = _client(admin).delete(f"/api/tournaments/{t.id}/")
    assert r.status_code == 204, r.content
    t.refresh_from_db()
    assert t.deleted_at is not None
    # Gone from the user's list.
    listing = _client(admin).get("/api/tournaments/").json()
    assert all(x["id"] != str(t.id) for x in listing)


def test_delete_blocked_while_live():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Live")
    t.status = TournamentStatus.LIVE
    t.save(update_fields=["status"])

    r = _client(admin).delete(f"/api/tournaments/{t.id}/")
    assert r.status_code == 409
    t.refresh_from_db()
    assert t.deleted_at is None


def test_outsider_cannot_delete():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    outsider = _verified("z@test.local")

    r = _client(outsider).delete(f"/api/tournaments/{t.id}/")
    assert r.status_code == 404  # no existence leak
    t.refresh_from_db()
    assert t.deleted_at is None


def test_deactivate_then_reactivate_restores_status():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    t.status = TournamentStatus.PUBLISHED
    t.save(update_fields=["status"])

    r1 = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"active": False}, format="json"
    )
    assert r1.status_code == 200 and r1.json()["status"] == "archived"
    t.refresh_from_db()
    assert t.status == TournamentStatus.ARCHIVED
    assert t.stage_meta.get("status_before_archive") == "published"

    r2 = _client(admin).patch(
        f"/api/tournaments/{t.id}/", {"active": True}, format="json"
    )
    assert r2.status_code == 200 and r2.json()["status"] == "published"
    t.refresh_from_db()
    assert t.status == TournamentStatus.PUBLISHED


def test_outsider_cannot_archive():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    outsider = _verified("z@test.local")
    r = _client(outsider).patch(
        f"/api/tournaments/{t.id}/", {"active": False}, format="json"
    )
    assert r.status_code == 404


def test_patch_requires_active_boolean():
    admin = _verified("a@test.local")
    t = create_tournament(user=admin, name="Cup")
    r = _client(admin).patch(f"/api/tournaments/{t.id}/", {}, format="json")
    assert r.status_code == 400


def _invited_admin(t, inviter):
    """An ACTIVE tournament-admin who joined via invite (no org membership)."""
    from apps.tournaments.models import (
        TournamentMembership,
        TournamentMembershipRole,
        TournamentMembershipStatus,
    )

    member = _verified("invited@test.local")
    TournamentMembership.objects.create(
        user=member,
        tournament=t,
        role=TournamentMembershipRole.ADMIN,
        status=TournamentMembershipStatus.ACTIVE,
        assigned_by=inviter,
    )
    return member


def test_invited_admin_cannot_delete():
    """Only the ORGANIZER may delete — an invited tournament-admin gets 403
    (they can see the tournament, so 404 would be wrong)."""
    organizer = _verified("a@test.local")
    t = create_tournament(user=organizer, name="Cup")
    member = _invited_admin(t, organizer)

    r = _client(member).delete(f"/api/tournaments/{t.id}/")
    assert r.status_code == 403
    t.refresh_from_db()
    assert t.deleted_at is None


def test_invited_admin_cannot_deactivate():
    organizer = _verified("a@test.local")
    t = create_tournament(user=organizer, name="Cup")
    member = _invited_admin(t, organizer)

    r = _client(member).patch(
        f"/api/tournaments/{t.id}/", {"active": False}, format="json"
    )
    assert r.status_code == 403
    t.refresh_from_db()
    assert t.status != TournamentStatus.ARCHIVED


def test_settings_payload_separates_manage_from_delete():
    """Invited admins manage (can_manage) but never delete (can_delete)."""
    organizer = _verified("a@test.local")
    t = create_tournament(user=organizer, name="Cup")
    member = _invited_admin(t, organizer)

    mine = _client(organizer).get(f"/api/tournaments/{t.id}/settings/").json()
    assert mine["can_manage"] is True and mine["can_delete"] is True

    theirs = _client(member).get(f"/api/tournaments/{t.id}/settings/").json()
    assert theirs["can_manage"] is True and theirs["can_delete"] is False
