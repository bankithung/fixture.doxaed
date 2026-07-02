"""P7a — the undo path: POST events/ with event_type=void + voids_seq."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus
from apps.matches.services.events import record_match_event
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _setup():
    admin = User.objects.create_user(
        email=f"vd-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Void Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MatchStatus.LIVE,
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    return admin, a, m, c


def test_void_reverses_a_goal_and_is_idempotent():
    admin, a, m, c = _setup()
    g = record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, by=admin)
    m.refresh_from_db()
    assert m.home_score == 1

    eid = str(uuid.uuid4())
    r = c.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "void", "voids_seq": g.sequence_no, "event_id": eid},
        format="json",
    )
    assert r.status_code == 201, r.content
    m.refresh_from_db()
    assert m.home_score == 0

    # Replay: same event_id is a no-op (one VOID row).
    r2 = c.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "void", "voids_seq": g.sequence_no, "event_id": eid},
        format="json",
    )
    assert r2.status_code == 201
    assert MatchEvent.objects.filter(
        match=m, event_type=MatchEventType.VOID
    ).count() == 1


def test_void_guards():
    admin, a, m, c = _setup()
    g = record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, by=admin)

    r = c.post(f"/api/matches/{m.id}/events/", {"event_type": "void"}, format="json")
    assert r.status_code == 400 and r.json()["detail"] == "voids_seq_required"

    r = c.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "void", "voids_seq": 99},
        format="json",
    )
    assert r.status_code == 400 and r.json()["detail"] == "event_not_found"

    c.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "void", "voids_seq": g.sequence_no},
        format="json",
    )
    r = c.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "void", "voids_seq": g.sequence_no},
        format="json",
    )
    assert r.status_code == 400 and r.json()["detail"] == "already_voided"

    void_row = MatchEvent.objects.get(match=m, event_type=MatchEventType.VOID)
    r = c.post(
        f"/api/matches/{m.id}/events/",
        {"event_type": "void", "voids_seq": void_row.sequence_no},
        format="json",
    )
    assert r.status_code == 400 and r.json()["detail"] == "cannot_void_a_void"
