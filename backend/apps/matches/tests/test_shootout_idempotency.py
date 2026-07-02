"""C18 — shootout replay with the same event_id must be a no-op (invariant 3)."""
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
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _setup():
    call_command("load_modules")
    admin = User.objects.create_user(
        email=f"so-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Shootout Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    tz = ZoneInfo(t.time_zone)
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        stage="knockout", status=MatchStatus.LIVE, home_score=1, away_score=1,
        scheduled_at=datetime(2026, 8, 1, 9, 0, tzinfo=tz), venue="G", match_no=1,
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    return c, m


def test_shootout_replay_same_event_id_does_not_rewrite():
    c, m = _setup()
    eid = str(uuid.uuid4())

    r1 = c.post(
        f"/api/matches/{m.id}/shootout/",
        {"home_pens": 4, "away_pens": 3, "event_id": eid},
        format="json",
    )
    assert r1.status_code == 200
    m.refresh_from_db()
    assert (m.home_pens, m.away_pens) == (4, 3)

    # Replay with DIFFERENT pens: must return the recorded state untouched,
    # not overwrite it, and must not add a second audit row.
    r2 = c.post(
        f"/api/matches/{m.id}/shootout/",
        {"home_pens": 1, "away_pens": 0, "event_id": eid},
        format="json",
    )
    assert r2.status_code == 200
    m.refresh_from_db()
    assert (m.home_pens, m.away_pens) == (4, 3)
    assert r2.data["home_pens"] == 4 and r2.data["away_pens"] == 3
    assert (
        AuditEvent.objects.filter(
            idempotency_key=eid, event_type="match_shootout_recorded"
        ).count()
        == 1
    )


def test_shootout_new_event_id_still_records():
    c, m = _setup()
    r1 = c.post(
        f"/api/matches/{m.id}/shootout/",
        {"home_pens": 4, "away_pens": 3, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r1.status_code == 200
    r2 = c.post(
        f"/api/matches/{m.id}/shootout/",
        {"home_pens": 5, "away_pens": 4, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r2.status_code == 200
    m.refresh_from_db()
    assert (m.home_pens, m.away_pens) == (5, 4)
