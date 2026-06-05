"""TDD — MatchEvent log (invariant #4): scores derived from events, gapless, idempotent, voidable."""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus
from apps.matches.services.events import record_match_event, void_match_event
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MatchStatus.LIVE,
    )
    return admin, a, b, m


def test_goal_events_derive_score_and_are_gapless():
    admin, a, b, m = _setup()
    e1 = record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, by=admin)
    e2 = record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, by=admin)
    e3 = record_match_event(match=m, event_type=MatchEventType.OWN_GOAL, team=a, by=admin)

    assert [e1.sequence_no, e2.sequence_no, e3.sequence_no] == [1, 2, 3]
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (2, 1)  # own goal by A counts for B


def test_void_reverses_score():
    admin, a, b, m = _setup()
    g = record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, by=admin)
    m.refresh_from_db()
    assert m.home_score == 1

    void_match_event(match=m, target_event=g, by=admin)
    m.refresh_from_db()
    assert m.home_score == 0


def test_event_idempotent_on_event_id():
    admin, a, b, m = _setup()
    eid = uuid.uuid4()
    record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, by=admin, event_id=eid)
    record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, by=admin, event_id=eid)

    assert MatchEvent.objects.filter(match=m, event_type=MatchEventType.GOAL).count() == 1
    m.refresh_from_db()
    assert m.home_score == 1
