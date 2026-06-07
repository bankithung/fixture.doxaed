"""TDD — Increment 11: tournament member directory + member management + audit.

- GET  /api/tournaments/{id}/members/                 — roster (any member)
- PATCH /api/tournaments/{id}/members/{membership_id}/ — change role / revoke (manager-only)
- GET  /api/tournaments/{id}/audit/                    — tournament-scoped audit (manager-only)

Invariant 2 (multi-tenancy isolation): an outsider gets 404 with no existence
leak. Manager-gating on the PATCH + audit surfaces. Last-admin guard. Audit rows
are scoped to the single tournament (events from other tournaments are excluded).
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.services import emit_audit
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _add_member(tournament, user, role=TournamentMembershipRole.REFEREE):
    return TournamentMembership.objects.create(
        user=user,
        tournament=tournament,
        role=role,
        status=TournamentMembershipStatus.ACTIVE,
        assigned_by=tournament.created_by,
    )


# ---------------------------------------------------------------------------
# Members list
# ---------------------------------------------------------------------------


def test_list_members():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    resp = _client(admin).get(f"/api/tournaments/{t.id}/members/")
    assert resp.status_code == 200, resp.content
    rows = resp.json()
    by_email = {r["email"]: r for r in rows}
    assert by_email["admin@test.local"]["role"] == "admin"
    assert by_email["ref@test.local"]["role"] == "referee"
    # roster shape
    sample = by_email["ref@test.local"]
    for key in ("id", "user_id", "email", "role", "status", "assigned_at"):
        assert key in sample


def test_list_members_visible_to_any_member():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    # a non-manager member (referee) may still view the roster
    resp = _client(ref).get(f"/api/tournaments/{t.id}/members/")
    assert resp.status_code == 200, resp.content
    assert {r["email"] for r in resp.json()} == {"admin@test.local", "ref@test.local"}


def test_revoked_members_excluded_from_list():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    gone = _verified("gone@test.local")
    m = _add_member(t, gone, role=TournamentMembershipRole.REFEREE)
    m.status = TournamentMembershipStatus.REVOKED
    m.revoked_at = timezone.now()
    m.save(update_fields=["status", "revoked_at"])

    resp = _client(admin).get(f"/api/tournaments/{t.id}/members/")
    assert resp.status_code == 200
    assert "gone@test.local" not in {r["email"] for r in resp.json()}


def test_outsider_cannot_list_members():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    outsider = _verified("outsider@test.local")

    resp = _client(outsider).get(f"/api/tournaments/{t.id}/members/")
    assert resp.status_code == 404  # no existence leak


# ---------------------------------------------------------------------------
# Member PATCH (role / status)
# ---------------------------------------------------------------------------


def test_manager_can_change_role():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    m = _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    resp = _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{m.id}/",
        {"role": "game_coordinator"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    m.refresh_from_db()
    assert m.role == TournamentMembershipRole.GAME_COORDINATOR
    assert resp.json()["role"] == "game_coordinator"


def test_manager_can_revoke():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    m = _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    resp = _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{m.id}/",
        {"status": "revoked"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    m.refresh_from_db()
    assert m.status == TournamentMembershipStatus.REVOKED
    assert m.revoked_at is not None

    # excluded from the roster after revoke
    listing = _client(admin).get(f"/api/tournaments/{t.id}/members/")
    assert "ref@test.local" not in {r["email"] for r in listing.json()}


def test_patch_rejects_invalid_role():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    m = _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    resp = _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{m.id}/",
        {"role": "bogus_role"},
        format="json",
    )
    assert resp.status_code == 400


def test_patch_rejects_invalid_status():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    m = _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    resp = _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{m.id}/",
        {"status": "deleted"},
        format="json",
    )
    assert resp.status_code == 400


def test_cannot_remove_last_admin():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    admin_m = TournamentMembership.objects.get(
        tournament=t, user=admin, role=TournamentMembershipRole.ADMIN
    )

    # revoke the only admin -> 400 last_admin
    revoke = _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{admin_m.id}/",
        {"status": "revoked"},
        format="json",
    )
    assert revoke.status_code == 400
    assert revoke.json().get("detail") == "last_admin"

    # demote the only admin -> 400 last_admin
    demote = _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{admin_m.id}/",
        {"role": "co_organizer"},
        format="json",
    )
    assert demote.status_code == 400
    assert demote.json().get("detail") == "last_admin"

    admin_m.refresh_from_db()
    assert admin_m.status == TournamentMembershipStatus.ACTIVE
    assert admin_m.role == TournamentMembershipRole.ADMIN


def test_can_demote_admin_when_another_admin_exists():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    second = _verified("second@test.local")
    _add_member(t, second, role=TournamentMembershipRole.ADMIN)
    admin_m = TournamentMembership.objects.get(
        tournament=t, user=admin, role=TournamentMembershipRole.ADMIN
    )

    resp = _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{admin_m.id}/",
        {"role": "co_organizer"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    admin_m.refresh_from_db()
    assert admin_m.role == TournamentMembershipRole.CO_ORGANIZER


def test_non_manager_cannot_patch_member():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    m = _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    # a referee (member, not a manager) cannot mutate memberships
    resp = _client(ref).patch(
        f"/api/tournaments/{t.id}/members/{m.id}/",
        {"role": "game_coordinator"},
        format="json",
    )
    assert resp.status_code == 403
    m.refresh_from_db()
    assert m.role == TournamentMembershipRole.REFEREE


def test_outsider_cannot_patch_member():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    m = _add_member(t, ref, role=TournamentMembershipRole.REFEREE)
    outsider = _verified("outsider@test.local")

    resp = _client(outsider).patch(
        f"/api/tournaments/{t.id}/members/{m.id}/",
        {"role": "game_coordinator"},
        format="json",
    )
    assert resp.status_code == 404  # no existence leak


def test_patch_emits_audit():
    from apps.audit.models import AuditEvent

    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    m = _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{m.id}/",
        {"role": "game_coordinator"},
        format="json",
    )
    ev = AuditEvent.objects.filter(
        event_type="tournament_member_updated", target_id=m.id
    ).first()
    assert ev is not None
    assert ev.tournament_id == t.id
    assert ev.organization_id == t.organization_id
    assert ev.target_type == "tournament_membership"


# ---------------------------------------------------------------------------
# Tournament-scoped audit
# ---------------------------------------------------------------------------


def test_audit_manager_only():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Kohima Cup")
    ref = _verified("ref@test.local")
    m = _add_member(t, ref, role=TournamentMembershipRole.REFEREE)

    # a separate tournament whose audit events must NOT appear here
    other_admin = _verified("other@test.local")
    other_t = create_tournament(user=other_admin, name="Mokokchung Cup")
    emit_audit(
        actor_user=other_admin,
        actor_role="admin",
        event_type="tournament_member_updated",
        target_type="tournament_membership",
        target_id=other_t.id,
        tournament_id=other_t.id,
        organization_id=other_t.organization_id,
    )

    # generate one in-scope event
    _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{m.id}/",
        {"role": "game_coordinator"},
        format="json",
    )

    # manager: 200 with only this tournament's events
    resp = _client(admin).get(f"/api/tournaments/{t.id}/audit/")
    assert resp.status_code == 200, resp.content
    results = resp.json()["results"]
    assert len(results) >= 1
    # events from the other tournament are NOT included
    for ev in results:
        assert ev["target_id"] != str(other_t.id)
    assert any(ev["event_type"] == "tournament_member_updated" for ev in results)

    # non-manager member: 403 (audit is sensitive)
    assert _client(ref).get(f"/api/tournaments/{t.id}/audit/").status_code == 403

    # outsider: 404 (no existence leak)
    outsider = _verified("outsider@test.local")
    assert _client(outsider).get(f"/api/tournaments/{t.id}/audit/").status_code == 404
