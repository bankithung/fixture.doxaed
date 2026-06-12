"""Control room, increment 3 — tournament-wide tick fan-out (spec 2026-06-12
§2.c). Every live mutation publishes a thin post-commit tick (ids only) to
the `tournament_<id>` channel-layer group: events ("event"), transitions
("state" — the gap: they used to publish NOTHING), score/sets/shootout
("score"), repair verbs + lock ("schedule", batched past 10 moves), and the
call endpoint ("called"). The match room (`match_<id>`) keeps working."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchEventType, MatchStatus
from apps.teams.services.registration import register_school
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


def _setup(stage: str = ""):
    admin = _verified(f"tick-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Tick Cup")
    teams = register_school(
        tournament=t, school_name="S",
        teams=[{"name": n, "players": []} for n in ("A", "B", "C", "D")],
    )
    tz = ZoneInfo(t.time_zone)
    m = Match.objects.create(
        organization=t.organization, tournament=t,
        home_team=teams[0], away_team=teams[1],
        stage=stage, scheduled_at=datetime(2026, 8, 1, 9, 0, tzinfo=tz),
        venue="G", match_no=1,
    )
    return admin, t, m, teams


def _subscribe(group: str):
    layer = get_channel_layer()
    channel = async_to_sync(layer.new_channel)()
    async_to_sync(layer.group_add)(group, channel)
    return layer, channel


def _drain(layer, channel) -> list[dict]:
    msgs: list[dict] = []

    async def pull():
        while True:
            try:
                msgs.append(
                    await asyncio.wait_for(layer.receive(channel), timeout=0.2)
                )
            except TimeoutError:
                return

    async_to_sync(pull)()
    return msgs


def _ticks(layer, channel) -> list[dict]:
    return [
        m["data"] for m in _drain(layer, channel) if m["type"] == "tournament.tick"
    ]


def test_record_event_dual_fans_out(django_capture_on_commit_callbacks):
    from apps.matches.services.events import record_match_event

    admin, t, m, _teams = _setup()
    m.status = MatchStatus.LIVE
    m.save(update_fields=["status"])
    layer, trn_chan = _subscribe(f"tournament_{t.id}")
    _, match_chan = _subscribe(f"match_{m.id}")

    with django_capture_on_commit_callbacks(execute=True):
        record_match_event(
            match=m, event_type=MatchEventType.GOAL, team=m.home_team, by=admin
        )

    ticks = _ticks(layer, trn_chan)
    assert ticks == [
        {"tournament_id": str(t.id), "match_id": str(m.id), "kind": "event"}
    ]
    room = _drain(layer, match_chan)  # the match WS room keeps its message
    assert [msg["type"] for msg in room] == ["match.event"]


def test_transition_publishes_state_tick(django_capture_on_commit_callbacks):
    from apps.matches.services.state import transition_match

    admin, t, m, _teams = _setup()
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    assert _ticks(layer, chan) == [
        {"tournament_id": str(t.id), "match_id": str(m.id), "kind": "state"}
    ]


def test_record_score_publishes_score_tick(django_capture_on_commit_callbacks):
    from apps.matches.services.scoring import record_score

    admin, t, m, _teams = _setup()
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        record_score(match=m, home_score=2, away_score=1, by=admin)
    assert _ticks(layer, chan) == [
        {"tournament_id": str(t.id), "match_id": str(m.id), "kind": "score"}
    ]


def test_set_result_publishes_score_tick(django_capture_on_commit_callbacks):
    from apps.matches.services.set_scoring import record_set_result, rules_for_match

    admin, t, m, _teams = _setup()
    m.sport = "table_tennis"
    m.save(update_fields=["sport"])
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        record_set_result(
            match=m, set_scores=[[11, 5], [11, 7]],
            rules=rules_for_match(m), by=admin,
        )
    assert _ticks(layer, chan) == [
        {"tournament_id": str(t.id), "match_id": str(m.id), "kind": "score"}
    ]


def test_shootout_publishes_score_tick(django_capture_on_commit_callbacks):
    admin, t, m, _teams = _setup(stage="knockout")
    m.status = MatchStatus.LIVE
    m.home_score = m.away_score = 1
    m.save(update_fields=["status", "home_score", "away_score"])
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        r = _client(admin).post(
            f"/api/matches/{m.id}/shootout/",
            {"home_pens": 4, "away_pens": 3},
            format="json",
        )
    assert r.status_code == 200, r.content
    assert _ticks(layer, chan) == [
        {"tournament_id": str(t.id), "match_id": str(m.id), "kind": "score"}
    ]


def test_lock_and_call_publish_ticks(django_capture_on_commit_callbacks):
    admin, t, m, _teams = _setup()
    layer, chan = _subscribe(f"tournament_{t.id}")
    c = _client(admin)
    with django_capture_on_commit_callbacks(execute=True):
        assert c.post(f"/api/matches/{m.id}/lock/", {}, format="json").status_code == 200
    with django_capture_on_commit_callbacks(execute=True):
        assert c.post(f"/api/matches/{m.id}/call/", {}, format="json").status_code == 200
    kinds = [tk["kind"] for tk in _ticks(layer, chan)]
    assert kinds == ["schedule", "called"]


def test_repair_verbs_publish_schedule_ticks(django_capture_on_commit_callbacks):
    from apps.fixtures.services.repair import reschedule_match, swap_slots

    admin, t, m, teams = _setup()
    tz = ZoneInfo(t.time_zone)
    m2 = Match.objects.create(
        organization=t.organization, tournament=t,
        home_team=teams[2], away_team=teams[3],
        scheduled_at=datetime(2026, 8, 1, 12, 0, tzinfo=tz), venue="G",
        match_no=2,
    )
    layer, chan = _subscribe(f"tournament_{t.id}")

    with django_capture_on_commit_callbacks(execute=True):
        reschedule_match(
            match=m, by=admin,
            scheduled_at=datetime(2026, 8, 2, 9, 0, tzinfo=tz),
        )
    assert _ticks(layer, chan) == [
        {"tournament_id": str(t.id), "match_id": str(m.id), "kind": "schedule"}
    ]

    with django_capture_on_commit_callbacks(execute=True):
        swap_slots(tournament=t, match_a=m.id, match_b=m2.id, by=admin)
    swap_ticks = _ticks(layer, chan)
    assert {tk["match_id"] for tk in swap_ticks} == {str(m.id), str(m2.id)}
    assert all(tk["kind"] == "schedule" for tk in swap_ticks)


def test_delay_cascade_ticks_every_moved_match(django_capture_on_commit_callbacks):
    from apps.fixtures.services.repair import delay_match

    admin, t, m, teams = _setup()
    tz = ZoneInfo(t.time_zone)
    m2 = Match.objects.create(
        organization=t.organization, tournament=t,
        home_team=teams[2], away_team=teams[3],
        scheduled_at=datetime(2026, 8, 1, 10, 45, 0, tzinfo=tz), venue="G",
        match_no=2,
    )
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        moved, _violations = delay_match(match=m, by=admin, minutes=120)
    moved_ids = {e["match_id"] for e in moved}
    assert {str(m.id), str(m2.id)} <= moved_ids
    ticks = _ticks(layer, chan)
    assert {tk["match_id"] for tk in ticks} == moved_ids
    assert all(tk["kind"] == "schedule" for tk in ticks)


def test_batch_cap_collapses_to_one_null_tick(django_capture_on_commit_callbacks):
    """A cascade past 10 moves collapses to ONE batch tick (match_id=None) —
    clients refetch the whole day instead of 11+ refetches."""
    from django.db import transaction

    from apps.fixtures.services.repair import _publish_schedule_ticks

    _admin, t, _m, _teams = _setup()
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        with transaction.atomic():
            _publish_schedule_ticks(t.id, [uuid.uuid4() for _ in range(11)])
    assert _ticks(layer, chan) == [
        {"tournament_id": str(t.id), "match_id": None, "kind": "schedule"}
    ]
