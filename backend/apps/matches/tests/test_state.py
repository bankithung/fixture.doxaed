"""TDD — Match state machine (invariant #6): guarded, audited transitions."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.matches.models import Match, MatchStatus
from apps.matches.services.state import can_transition, transition_match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _match():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    return admin, Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b
    )


def test_legal_transitions():
    admin, m = _match()
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.LIVE
    assert m.current_period == "first_half"

    transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED


def test_illegal_transition_raises():
    admin, m = _match()
    with pytest.raises(ValidationError):
        transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)  # scheduled->completed


def test_no_transition_out_of_terminal():
    admin, m = _match()
    transition_match(match=m, to_status=MatchStatus.WALKOVER, by=admin)  # scheduled->walkover OK
    with pytest.raises(ValidationError):
        transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)  # walkover is terminal


def test_can_transition_table():
    assert can_transition(MatchStatus.SCHEDULED, MatchStatus.LIVE)
    assert not can_transition(MatchStatus.SCHEDULED, MatchStatus.COMPLETED)
    assert not can_transition(MatchStatus.COMPLETED, MatchStatus.LIVE)
