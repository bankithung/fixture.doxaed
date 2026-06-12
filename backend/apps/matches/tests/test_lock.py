"""Control-room repair seam, increment B — match slot locks
(`POST/DELETE /api/matches/{id}/lock/`): schedule_editor-gated, audited,
idempotent. A locked match's slot survives scheduler re-runs (see
fixtures/tests/test_repair.py for the engine side)."""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.matches.models import Match
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
    admin = _verified(f"lock-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Lock Cup")
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


def test_lock_then_unlock_roundtrip_with_audit():
    admin, _t, matches = _setup()
    m = matches[0]
    c = _client(admin)

    r = c.post(f"/api/matches/{m.id}/lock/", {}, format="json")
    assert r.status_code == 200, r.content
    assert r.json()["match"]["locked_at"] is not None
    m.refresh_from_db()
    assert m.locked_at is not None
    assert AuditEvent.objects.filter(
        event_type="match_locked", target_id=m.id
    ).count() == 1

    r2 = c.delete(f"/api/matches/{m.id}/lock/")
    assert r2.status_code == 200, r2.content
    assert r2.json()["match"]["locked_at"] is None
    m.refresh_from_db()
    assert m.locked_at is None
    assert AuditEvent.objects.filter(
        event_type="match_unlocked", target_id=m.id
    ).count() == 1


def test_lock_is_idempotent():
    admin, _t, matches = _setup()
    m = matches[0]
    c = _client(admin)
    assert c.post(f"/api/matches/{m.id}/lock/", {}, format="json").status_code == 200
    m.refresh_from_db()
    first = m.locked_at
    assert c.post(f"/api/matches/{m.id}/lock/", {}, format="json").status_code == 200
    m.refresh_from_db()
    assert m.locked_at == first  # no re-stamp
    assert AuditEvent.objects.filter(
        event_type="match_locked", target_id=m.id
    ).count() == 1
    # unlocking an unlocked match is also a no-op
    assert c.delete(f"/api/matches/{m.id}/lock/").status_code == 200
    assert c.delete(f"/api/matches/{m.id}/lock/").status_code == 200
    assert AuditEvent.objects.filter(
        event_type="match_unlocked", target_id=m.id
    ).count() == 1


def test_lock_permissions():
    _admin, t, matches = _setup()
    m = matches[0]
    outsider = _verified("lockout@test.local")
    assert _client(outsider).post(
        f"/api/matches/{m.id}/lock/", {}, format="json"
    ).status_code == 404

    tm = _verified("locktm@test.local")
    TournamentMembership.objects.create(
        user=tm, tournament=t, role=TournamentMembershipRole.TEAM_MANAGER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _client(tm).post(
        f"/api/matches/{m.id}/lock/", {}, format="json"
    ).status_code == 403
    assert _client(tm).delete(f"/api/matches/{m.id}/lock/").status_code == 403
