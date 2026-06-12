"""Control room, increment 1 — "called to venue" annotation
(`POST/DELETE /api/matches/{id}/call/`): schedule_editor-gated, audited,
idempotent. `called_at` is an operational sub-state of `scheduled` (spec
2026-06-12 §2.b, PRD §5.5 note / decision 72), NOT a lifecycle status — and
it auto-clears on the transition to live (owner decision 2026-06-12)."""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _setup():
    admin = _verified(f"call-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Call Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    tz = ZoneInfo(t.time_zone)
    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    for i, m in enumerate(matches):
        m.scheduled_at = datetime(2026, 8, 1 + i, 9, 0, tzinfo=tz)
        m.venue = "G"
        m.save(update_fields=["scheduled_at", "venue"])
    return admin, t, matches


def test_call_then_uncall_roundtrip_with_audit():
    admin, _t, matches = _setup()
    m = matches[0]
    c = _client(admin)

    r = c.post(f"/api/matches/{m.id}/call/", {}, format="json")
    assert r.status_code == 200, r.content
    assert r.json()["match"]["called_at"] is not None
    m.refresh_from_db()
    assert m.called_at is not None
    assert m.status == MatchStatus.SCHEDULED  # the state machine is untouched
    assert AuditEvent.objects.filter(
        event_type="match_called", target_id=m.id
    ).count() == 1

    r2 = c.delete(f"/api/matches/{m.id}/call/")
    assert r2.status_code == 200, r2.content
    assert r2.json()["match"]["called_at"] is None
    m.refresh_from_db()
    assert m.called_at is None
    assert AuditEvent.objects.filter(
        event_type="match_call_cleared", target_id=m.id
    ).count() == 1


def test_call_is_idempotent():
    admin, _t, matches = _setup()
    m = matches[0]
    c = _client(admin)
    assert c.post(f"/api/matches/{m.id}/call/", {}, format="json").status_code == 200
    m.refresh_from_db()
    first = m.called_at
    assert c.post(f"/api/matches/{m.id}/call/", {}, format="json").status_code == 200
    m.refresh_from_db()
    assert m.called_at == first  # no re-stamp
    assert AuditEvent.objects.filter(
        event_type="match_called", target_id=m.id
    ).count() == 1
    # un-calling an un-called match is also a no-op
    assert c.delete(f"/api/matches/{m.id}/call/").status_code == 200
    assert c.delete(f"/api/matches/{m.id}/call/").status_code == 200
    assert AuditEvent.objects.filter(
        event_type="match_call_cleared", target_id=m.id
    ).count() == 1


@pytest.mark.parametrize(
    "status",
    [
        MatchStatus.LIVE,
        MatchStatus.COMPLETED,
        MatchStatus.POSTPONED,
        MatchStatus.CANCELLED,
    ],
)
def test_call_409_unless_scheduled(status):
    admin, _t, matches = _setup()
    m = matches[0]
    m.status = status
    m.save(update_fields=["status"])
    c = _client(admin)
    r = c.post(f"/api/matches/{m.id}/call/", {}, format="json")
    assert r.status_code == 409, r.content
    assert r.json()["detail"] == "match_not_callable"
    assert c.delete(f"/api/matches/{m.id}/call/").status_code == 409
    m.refresh_from_db()
    assert m.called_at is None


def test_called_at_auto_clears_on_transition_to_live():
    admin, _t, matches = _setup()
    m = matches[0]
    c = _client(admin)
    assert c.post(f"/api/matches/{m.id}/call/", {}, format="json").status_code == 200
    r = c.post(
        f"/api/matches/{m.id}/transition/", {"to_status": "live"}, format="json"
    )
    assert r.status_code == 200, r.content
    assert r.json()["called_at"] is None
    m.refresh_from_db()
    assert m.called_at is None
    assert m.status == MatchStatus.LIVE


def test_call_permissions():
    _admin, t, matches = _setup()
    m = matches[0]
    outsider = _verified(f"callout-{uuid.uuid4().hex[:8]}@test.local")
    assert _client(outsider).post(
        f"/api/matches/{m.id}/call/", {}, format="json"
    ).status_code == 404

    # team_manager / match_scorer lack the schedule_editor module → 403.
    for role in (
        TournamentMembershipRole.TEAM_MANAGER,
        TournamentMembershipRole.MATCH_SCORER,
    ):
        member = _verified(f"call-{role}-{uuid.uuid4().hex[:8]}@test.local")
        TournamentMembership.objects.create(
            user=member, tournament=t, role=role,
            status=TournamentMembershipStatus.ACTIVE,
        )
        assert _client(member).post(
            f"/api/matches/{m.id}/call/", {}, format="json"
        ).status_code == 403
        assert _client(member).delete(f"/api/matches/{m.id}/call/").status_code == 403

    # game_coordinator holds schedule_editor by default → allowed.
    call_command("load_modules")  # seed the module catalog (role defaults)
    coord = _verified(f"callgc-{uuid.uuid4().hex[:8]}@test.local")
    TournamentMembership.objects.create(
        user=coord, tournament=t, role=TournamentMembershipRole.GAME_COORDINATOR,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _client(coord).post(
        f"/api/matches/{m.id}/call/", {}, format="json"
    ).status_code == 200
