"""Match-domain audit rows must carry tournament_id + match_id (H9).

The audit page filters by tournament/match; rows emitted without those ids
are invisible there, leaving scoring and completion unauditable.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.matches.models import Match, MatchEventType, MatchStatus
from apps.matches.services.events import record_match_event
from apps.matches.services.state import transition_match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _match():
    u = User.objects.create_user(
        email="audit-ids@test.local", password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    t = create_tournament(user=u, name="Audit Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    return u, Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b
    )


def test_transition_audit_carries_tournament_and_match_ids():
    admin, m = _match()
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)

    row = AuditEvent.objects.filter(
        event_type="match_status_changed", target_id=m.id
    ).latest("created_at")
    assert row.tournament_id == m.tournament_id
    assert row.match_id == m.id


def test_event_recorded_audit_carries_tournament_and_match_ids():
    admin, m = _match()
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    record_match_event(
        match=m,
        event_type=MatchEventType.GOAL,
        team=m.home_team,
        by=admin,
        event_id=uuid.uuid4(),
    )

    row = AuditEvent.objects.filter(
        event_type="match_event_recorded", target_id=m.id
    ).latest("created_at")
    assert row.tournament_id == m.tournament_id
    assert row.match_id == m.id
