"""Increment E — postponed/abandoned lifecycle (PRD §5.5, draft v4).

ABANDONED → SCHEDULED is a guarded replay transition: the abandoned result
is void — scores/pens/sets/period are cleared so the replay starts fresh,
the original events stay in the immutable log (invariant #4), and an audit
reason is REQUIRED. Advancement never fires from `abandoned` (it is not a
terminal-with-result state)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.matches.models import (
    Match,
    MatchEvent,
    MatchEventType,
    MatchStatus,
)
from apps.matches.services.state import can_transition, transition_match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "replay@test.local"):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _abandoned_match():
    """A live match with a recorded goal + running score, then abandoned."""
    admin = _verified()
    t = create_tournament(user=admin, name="Replay Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b
    )
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    from apps.matches.services.events import record_match_event

    record_match_event(
        match=m, event_type=MatchEventType.GOAL, team=a, by=admin, minute=12
    )
    m.refresh_from_db()
    assert (m.home_score, m.away_score) == (1, 0)
    m.home_pens, m.away_pens = 4, 3
    m.set_scores = [[11, 8]]
    m.save(update_fields=["home_pens", "away_pens", "set_scores"])
    transition_match(
        match=m, to_status=MatchStatus.ABANDONED, by=admin,
        reason="floodlight failure",
    )
    m.refresh_from_db()
    return admin, m


def test_transition_table_allows_replay_only():
    assert can_transition(MatchStatus.ABANDONED, MatchStatus.SCHEDULED)
    assert not can_transition(MatchStatus.ABANDONED, MatchStatus.LIVE)
    assert not can_transition(MatchStatus.ABANDONED, MatchStatus.COMPLETED)


def test_replay_clears_result_and_keeps_the_event_log():
    admin, m = _abandoned_match()
    events_before = MatchEvent.objects.filter(match=m).count()
    assert events_before > 0

    transition_match(
        match=m, to_status=MatchStatus.SCHEDULED, by=admin,
        reason="replay ordered by committee",
    )
    m.refresh_from_db()
    assert m.status == MatchStatus.SCHEDULED
    assert m.home_score is None and m.away_score is None
    assert m.home_pens is None and m.away_pens is None
    assert m.set_scores == []
    assert m.current_period == ""
    # the original events stay in the immutable log (invariant #4)
    assert MatchEvent.objects.filter(match=m).count() == events_before
    ev = AuditEvent.objects.filter(
        event_type="match_status_changed", target_id=m.id
    ).order_by("-created_at").first()
    assert ev.payload_before["status"] == MatchStatus.ABANDONED
    assert ev.payload_after["status"] == MatchStatus.SCHEDULED
    assert ev.reason == "replay ordered by committee"


@pytest.mark.parametrize("reason", ["", "   "])
def test_replay_requires_a_reason(reason):
    admin, m = _abandoned_match()
    with pytest.raises(ValidationError):
        transition_match(
            match=m, to_status=MatchStatus.SCHEDULED, by=admin, reason=reason
        )
    m.refresh_from_db()
    assert m.status == MatchStatus.ABANDONED  # nothing half-applied
    assert (m.home_score, m.away_score) == (1, 0)


def test_replayed_match_runs_a_full_fresh_cycle():
    admin, m = _abandoned_match()
    transition_match(
        match=m, to_status=MatchStatus.SCHEDULED, by=admin, reason="replay"
    )
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    m.refresh_from_db()
    assert m.current_period == "first_half"  # fresh period, not the old one
    m.home_score, m.away_score = 2, 1
    m.save(update_fields=["home_score", "away_score"])
    transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)
    m.refresh_from_db()
    assert m.status == MatchStatus.COMPLETED
    assert m.winner_id == m.home_team_id


def test_advancement_never_fires_for_abandoned(
    django_capture_on_commit_callbacks, monkeypatch,
):
    calls: list = []
    monkeypatch.setattr(
        "apps.matches.services.state._fire_advancement",
        lambda mid: calls.append(mid),
    )
    admin = _verified("replay-adv@test.local")
    t = create_tournament(user=admin, name="Replay Adv Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b
    )
    with django_capture_on_commit_callbacks(execute=True):
        transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
        transition_match(
            match=m, to_status=MatchStatus.ABANDONED, by=admin, reason="storm"
        )
    assert calls == []  # abandoning is not a result
    with django_capture_on_commit_callbacks(execute=True):
        transition_match(
            match=m, to_status=MatchStatus.SCHEDULED, by=admin, reason="replay"
        )
    assert calls == []  # neither is voiding it for a replay
    # contrast: a real result DOES ripple
    with django_capture_on_commit_callbacks(execute=True):
        transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
        m.home_score, m.away_score = 1, 0
        m.save(update_fields=["home_score", "away_score"])
        transition_match(match=m, to_status=MatchStatus.COMPLETED, by=admin)
    assert calls == [m.id]


def test_replay_via_transition_api():
    admin, m = _abandoned_match()
    from rest_framework.test import APIClient

    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.post(
        f"/api/matches/{m.id}/transition/",
        {"to_status": "scheduled"},  # no reason → rejected
        format="json",
    )
    assert r.status_code == 400
    r2 = c.post(
        f"/api/matches/{m.id}/transition/",
        {"to_status": "scheduled", "reason": "replay ordered"},
        format="json",
    )
    assert r2.status_code == 200, r2.content
    body = r2.json()
    assert body["status"] == "scheduled"
    assert body["home_score"] is None and body["away_score"] is None
