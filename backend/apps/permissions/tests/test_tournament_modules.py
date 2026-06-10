"""Tournament-scoped module RBAC (spec 2026-06-10 P5): the catalog finally
reaches tournament surfaces — role defaults resolve from TournamentMembership,
per-member TournamentModuleGrant overrides apply, verbs widen additively, and
the stage payload carries the caller's effective set."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.permissions.services.resolver import effective_tournament_modules
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _member(t, email, role):
    u = _verified(email)
    TournamentMembership.objects.create(
        user=u, tournament=t, role=role,
        status=TournamentMembershipStatus.ACTIVE,
    )
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def cup(loaded_modules):
    admin = _verified("admin@perm.test")
    t = create_tournament(user=admin, name="Perm Cup")
    return admin, t


def test_tournament_only_invitee_resolves_role_default_modules(cup):
    _admin, t = cup
    coord = _member(t, "coord@perm.test", TournamentMembershipRole.GAME_COORDINATOR)
    mods = effective_tournament_modules(coord, t)
    assert "tournament.bracket_editor" in mods
    assert "tournament.schedule_editor" in mods
    assert "forms" in mods
    assert "org.settings" not in mods  # org modules don't leak in

    scorer = _member(t, "scorer@perm.test", TournamentMembershipRole.MATCH_SCORER)
    smods = effective_tournament_modules(scorer, t)
    assert "match.scoring_console" in smods
    assert "tournament.bracket_editor" not in smods


def test_org_admin_gets_full_catalog(cup):
    admin, t = cup
    mods = effective_tournament_modules(admin, t)
    assert "tournament.bracket_editor" in mods and "org.settings" in mods


def test_grants_override_defaults_and_invalidate_cache(cup):
    from apps.permissions.services.grants import set_tournament_grant

    admin, t = cup
    tm = _member(t, "tm@perm.test", TournamentMembershipRole.TEAM_MANAGER)
    assert "tournament.schedule_editor" not in effective_tournament_modules(tm, t)
    set_tournament_grant(
        user=tm, tournament=t, module="tournament.schedule_editor",
        state="grant", granted_by=admin,
        reason="Covers scheduling for the U15 leaf this season.",
    )
    assert "tournament.schedule_editor" in effective_tournament_modules(tm, t)
    set_tournament_grant(
        user=tm, tournament=t, module="tournament.team_registration",
        state="deny", granted_by=admin,
        reason="Registration handled centrally for this event.",
    )
    assert "tournament.team_registration" not in effective_tournament_modules(tm, t)


def test_verb_widening_game_coordinator_can_generate_team_manager_cannot(cup):
    from apps.teams.services.registration import register_school

    _admin, t = cup
    register_school(tournament=t, school_name="A", teams=[{"name": "A", "players": []}])
    register_school(tournament=t, school_name="B", teams=[{"name": "B", "players": []}])
    coord = _member(t, "coord2@perm.test", TournamentMembershipRole.GAME_COORDINATOR)
    tm = _member(t, "tm2@perm.test", TournamentMembershipRole.TEAM_MANAGER)

    # team_manager: no bracket_editor → 403 (binary gate used to 403 BOTH)
    assert _client(tm).post(
        f"/api/tournaments/{t.id}/generate-fixtures/", {"format": "round_robin"},
        format="json",
    ).status_code == 403
    # game_coordinator: catalog default → allowed
    r = _client(coord).post(
        f"/api/tournaments/{t.id}/generate-fixtures/", {"format": "round_robin"},
        format="json",
    )
    assert r.status_code == 201, r.content


def test_matrix_and_grant_endpoints(cup):
    admin, t = cup
    scorer = _member(t, "scorer2@perm.test", TournamentMembershipRole.MATCH_SCORER)

    # matrix is manager-only
    assert _client(scorer).get(
        f"/api/tournaments/{t.id}/permissions/"
    ).status_code == 403
    matrix = _client(admin).get(f"/api/tournaments/{t.id}/permissions/").json()
    assert any(m["code"] == "tournament.bracket_editor" for m in matrix["modules"])
    row = next(m for m in matrix["members"] if m["email"] == "scorer2@perm.test")
    assert row["roles"] == ["match_scorer"]
    assert "match.scoring_console" in row["effective"]

    # short reason rejected
    assert _client(admin).put(
        f"/api/tournaments/{t.id}/permissions/grants/",
        {"user_id": str(scorer.id), "module_code": "forms",
         "state": "grant", "reason": "short"},
        format="json",
    ).status_code == 400
    # valid grant takes effect immediately
    r = _client(admin).put(
        f"/api/tournaments/{t.id}/permissions/grants/",
        {"user_id": str(scorer.id), "module_code": "forms",
         "state": "grant",
         "reason": "Scorer also maintains the registration form."},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert "forms" in r.json()["effective"]


def test_stage_payload_carries_effective_modules(cup):
    _admin, t = cup
    coord = _member(t, "coord3@perm.test", TournamentMembershipRole.GAME_COORDINATOR)
    payload = _client(coord).get(f"/api/tournaments/{t.id}/stage/").json()
    assert "tournament.bracket_editor" in payload["modules"]
    assert payload["can_manage"] is False


def test_member_patch_duplicate_role_returns_400(cup):
    admin, t = cup
    user = _verified("dup@perm.test")
    TournamentMembership.objects.create(
        user=user, tournament=t, role=TournamentMembershipRole.REFEREE,
        status=TournamentMembershipStatus.ACTIVE,
    )
    second = TournamentMembership.objects.create(
        user=user, tournament=t, role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    r = _client(admin).patch(
        f"/api/tournaments/{t.id}/members/{second.id}/",
        {"role": "referee"}, format="json",
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "duplicate_role"
