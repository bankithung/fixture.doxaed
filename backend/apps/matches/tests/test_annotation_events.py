"""P2 — set-sport annotation events (the digital scoresheet vocabulary).

SERVE/ACE/KILL/BLOCK/POINT/LET/TIMEOUT annotate a set-sport match without
ever touching the score of record: set_scores stays the source (resolved
design conflict, master plan Pillar A), so a mis-tagged stat tap can never
corrupt a result. VOID undo works on them like any event.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone

from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus
from apps.matches.services.events import record_match_event
from apps.matches.services.set_scoring import update_set_progress
from apps.matches.services.state import transition_match
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SEPAK = {"type": "sets", "points": 21, "win_by": 2, "cap": 25, "best_of": 3}


def _live_sepak():
    u = User.objects.create_user(
        email="annot@test.local", password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    t = create_tournament(user=u, name="Annot Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": [{"full_name": "Tekong One"}]},
               {"name": "B", "players": []}],
    )
    a, b = list(Team.objects.filter(tournament=t).order_by("name"))
    m = Match.objects.create(
        organization=t.organization, tournament=t, sport="sepak_takraw",
        home_team=a, away_team=b,
    )
    transition_match(match=m, to_status=MatchStatus.LIVE, by=u)
    return u, m, a


def test_annotations_never_touch_the_set_score_mirror():
    admin, m, a = _live_sepak()
    update_set_progress(
        match=m, set_scores=[[5, 3]], rules=SEPAK, by=admin,
        event_id=uuid.uuid4(),
    )
    m.refresh_from_db()
    before = (m.home_score, m.away_score, m.set_scores)

    player = a.players.first()
    for etype in (
        MatchEventType.SERVE, MatchEventType.ACE, MatchEventType.KILL,
        MatchEventType.BLOCK, MatchEventType.TIMEOUT,
    ):
        record_match_event(
            match=m, event_type=etype, team=a, player=player, by=admin,
            event_id=uuid.uuid4(),
        )
    record_match_event(
        match=m, event_type=MatchEventType.POINT, team=a, by=admin,
        detail={"reason": "three_touch", "scoring_side": "home"},
        event_id=uuid.uuid4(),
    )

    m.refresh_from_db()
    assert (m.home_score, m.away_score, m.set_scores) == before
    assert MatchEvent.objects.filter(
        match=m, event_type=MatchEventType.ACE
    ).count() == 1


def test_goal_family_still_rejected_for_set_sports():
    admin, m, a = _live_sepak()
    with pytest.raises(DjangoValidationError):
        record_match_event(
            match=m, event_type=MatchEventType.GOAL, team=a, by=admin,
        )


def test_annotation_events_are_voidable():
    admin, m, a = _live_sepak()
    ev = record_match_event(
        match=m, event_type=MatchEventType.ACE, team=a, by=admin,
        event_id=uuid.uuid4(),
    )
    record_match_event(
        match=m, event_type=MatchEventType.VOID, voids=ev, by=admin,
        event_id=uuid.uuid4(),
    )
    assert MatchEvent.objects.filter(
        match=m, event_type=MatchEventType.VOID, voids=ev
    ).exists()
