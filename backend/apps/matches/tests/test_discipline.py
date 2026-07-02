"""Phase 2 — derived suspensions (PRD 5.8): cards become consequences."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.matches.models import Match, MatchEventType, MatchStatus
from apps.matches.services.discipline import compute_suspensions, suspended_player_ids
from apps.matches.services.events import record_match_event, void_match_event
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified():
    u = User.objects.create_user(
        email=f"dc-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(n_matches=3):
    admin = _verified()
    t = create_tournament(user=admin, name="Discipline Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[
            {"name": "A", "players": [{"full_name": "Rocky"}]},
            {"name": "B", "players": []},
        ],
    )
    tz = ZoneInfo(t.time_zone)
    base = datetime(2026, 8, 1, 9, 0, tzinfo=tz)
    ms = [
        Match.objects.create(
            organization=t.organization, tournament=t, home_team=a, away_team=b,
            match_no=i + 1, scheduled_at=base + timedelta(days=i),
            status=MatchStatus.LIVE,
        )
        for i in range(n_matches)
    ]
    rocky = a.players.first()
    return admin, t, a, rocky, ms


def test_red_card_bans_next_match_until_served():
    admin, t, _a, rocky, (m1, m2, _m3) = _setup()
    record_match_event(
        match=m1, event_type=MatchEventType.RED_CARD, team=rocky.team,
        player=rocky, by=admin,
    )
    Match.objects.filter(pk=m1.pk).update(status=MatchStatus.COMPLETED)

    rows = compute_suspensions(t)
    assert len(rows) == 1
    row = rows[0]
    assert row["reason"] == "red_card"
    assert row["active"] is True and row["served"] == 0
    assert str(rocky.id) in suspended_player_ids(t)

    # The team's next final match serves the ban.
    Match.objects.filter(pk=m2.pk).update(status=MatchStatus.COMPLETED)
    rows = compute_suspensions(t)
    assert rows[0]["served"] == 1 and rows[0]["active"] is False
    assert str(rocky.id) not in suspended_player_ids(t)


def test_two_yellows_in_one_match_is_a_red():
    admin, t, _a, rocky, (m1, _m2, _m3) = _setup()
    for _ in range(2):
        record_match_event(
            match=m1, event_type=MatchEventType.YELLOW_CARD, team=rocky.team,
            player=rocky, by=admin,
        )
    Match.objects.filter(pk=m1.pk).update(status=MatchStatus.COMPLETED)
    rows = compute_suspensions(t)
    assert rows and rows[0]["reason"] == "second_yellow" and rows[0]["active"]


def test_yellow_accumulation_across_matches_triggers():
    """DEFAULT_RULES: yellow_suspension_threshold=2 accumulated yellows."""
    admin, t, _a, rocky, (m1, m2, _m3) = _setup()
    record_match_event(
        match=m1, event_type=MatchEventType.YELLOW_CARD, team=rocky.team,
        player=rocky, by=admin,
    )
    Match.objects.filter(pk=m1.pk).update(status=MatchStatus.COMPLETED)
    assert compute_suspensions(t) == []  # one yellow: nothing yet

    record_match_event(
        match=m2, event_type=MatchEventType.YELLOW_CARD, team=rocky.team,
        player=rocky, by=admin,
    )
    Match.objects.filter(pk=m2.pk).update(status=MatchStatus.COMPLETED)
    rows = compute_suspensions(t)
    assert rows and rows[0]["reason"] == "yellow_accumulation" and rows[0]["active"]


def test_voided_card_does_not_count():
    admin, t, _a, rocky, (m1, _m2, _m3) = _setup()
    card = record_match_event(
        match=m1, event_type=MatchEventType.RED_CARD, team=rocky.team,
        player=rocky, by=admin,
    )
    void_match_event(match=m1, target_event=card, by=admin)
    Match.objects.filter(pk=m1.pk).update(status=MatchStatus.COMPLETED)
    assert compute_suspensions(t) == []


def test_suspended_player_blocked_from_lineup():
    admin, _t, a, rocky, (m1, m2, _m3) = _setup()
    record_match_event(
        match=m1, event_type=MatchEventType.RED_CARD, team=rocky.team,
        player=rocky, by=admin,
    )
    Match.objects.filter(pk=m1.pk).update(status=MatchStatus.COMPLETED)
    Match.objects.filter(pk=m2.pk).update(status=MatchStatus.SCHEDULED)

    from apps.matches.services.lineups import set_lineup

    with pytest.raises(ValidationError) as exc:
        set_lineup(
            match=m2, team=a,
            entries=[{"player_id": str(rocky.id), "role": "starter"}],
            by=admin,
        )
    assert "player_suspended" in str(exc.value)
