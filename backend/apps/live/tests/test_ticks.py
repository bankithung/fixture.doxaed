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


# ------------------------------------------- stream links (production 2026-08-05)
#: The fixed instant the streaming fixtures play at. Every day below is derived
#: from it, never from "today": a link filed under ``local_day()`` plus a match
#: on a fixed date agree on one calendar day of the year, and this is the fourth
#: time that has been said out loud in this codebase.
STREAM_KICKOFF = datetime(2026, 8, 3, 11, 0)


def _stream_setup():
    """A tournament with courts and one match, built with the STREAMING suite's
    fixtures — the ticks below are published by the streaming manager API, so
    the setup has to be the one that API expects (a venue, real courts, a match
    pinned to one). Returns ``(admin, tournament, courts, match, day)``."""
    from apps.streaming.services.links import local_day
    from apps.streaming.tests.support import make_match, make_tournament, tz_of

    admin, t, courts = make_tournament()
    kickoff = STREAM_KICKOFF.replace(tzinfo=tz_of(t))
    m = make_match(t, courts[0], scheduled_at=kickoff)
    return admin, t, courts, m, local_day(kickoff, tz_of(t))


def _links_url(t) -> str:
    return f"/api/tournaments/{t.id}/stream-links/"


def _paste(client, t, court, day, url=None, **extra):
    from apps.streaming.tests.support import COURT_DAY_LINK_URL

    return client.post(
        _links_url(t),
        {
            "scope": "court_day",
            "court_id": str(court.id),
            "day": day.isoformat(),
            "watch_url": url or COURT_DAY_LINK_URL,
            **extra,
        },
        format="json",
    )


def test_pasting_a_stream_link_publishes_a_stream_tick(
    django_capture_on_commit_callbacks,
):
    """THE 2026-08-05 gap. Public pages stop polling while their SSE stream is
    connected (``refetchInterval: connected ? false : 60_000``) and refetch only
    on a tick; stream-link writes published none, so an organiser's paste never
    reached a single already-open page and the feature read as broken."""
    from apps.live.publish import TICK_KINDS

    admin, t, courts, _m, day = _stream_setup()
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        r = _paste(_client(admin), t, courts[0], day)
    assert r.status_code == 201, r.content
    # match_id=None is publish.py's "batch change": a court-day link flips the
    # button on every match on that court that day, so clients refetch the day.
    assert _ticks(layer, chan) == [
        {"tournament_id": str(t.id), "match_id": None, "kind": "stream"}
    ]
    assert "stream" in TICK_KINDS


def test_editing_and_clearing_a_stream_link_publish_stream_ticks(
    django_capture_on_commit_callbacks,
):
    """A wrong URL corrected, or a link switched off, is as urgent as the paste:
    until the tick lands, spectators are on the wrong video."""
    admin, t, courts, _m, day = _stream_setup()
    c = _client(admin)
    with django_capture_on_commit_callbacks(execute=True):
        r = _paste(c, t, courts[0], day)
    link_id = r.json()["id"]
    layer, chan = _subscribe(f"tournament_{t.id}")

    with django_capture_on_commit_callbacks(execute=True):
        patched = c.patch(
            f"{_links_url(t)}{link_id}/", {"enabled": False}, format="json"
        )
    assert patched.status_code == 200, patched.content
    with django_capture_on_commit_callbacks(execute=True):
        deleted = c.delete(f"{_links_url(t)}{link_id}/")
    assert deleted.status_code == 204
    assert [tk["kind"] for tk in _ticks(layer, chan)] == ["stream", "stream"]


def test_a_match_scoped_link_ticks_its_own_match(
    django_capture_on_commit_callbacks,
):
    """Only the match scope can name a match — the other two are day-wide."""
    from apps.streaming.tests.support import MATCH_LINK_URL

    admin, t, _courts, m, _day = _stream_setup()
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        r = _client(admin).post(
            _links_url(t),
            {"scope": "match", "match_id": str(m.id), "watch_url": MATCH_LINK_URL},
            format="json",
        )
    assert r.status_code == 201, r.content
    assert _ticks(layer, chan) == [
        {"tournament_id": str(t.id), "match_id": str(m.id), "kind": "stream"}
    ]


def test_a_replayed_paste_does_not_publish_a_second_tick(
    django_capture_on_commit_callbacks,
):
    """Invariant 3: a retry from a flaky phone wrote nothing the second time, so
    it has nothing to announce."""
    admin, t, courts, _m, day = _stream_setup()
    c = _client(admin)
    event_id = str(uuid.uuid4())
    with django_capture_on_commit_callbacks(execute=True):
        first = _paste(c, t, courts[0], day, event_id=event_id)
    assert first.status_code == 201, first.content
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        replay = _paste(c, t, courts[0], day, event_id=event_id)
    assert replay.status_code == 200, replay.content
    assert _ticks(layer, chan) == []


def test_the_court_stream_default_endpoints_tick_too(
    django_capture_on_commit_callbacks,
):
    """The standing per-court link (precedence level 5) has exactly the same
    problem: it is in the public payload, so writing it has to tick."""
    from apps.streaming.tests.support import COURT_STREAM_URL

    admin, t, courts, _m, _day = _stream_setup()
    c = _client(admin)
    url = f"/api/tournaments/{t.id}/court-streams/"
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        created = c.post(
            url,
            {"court_id": str(courts[0].id), "watch_url": COURT_STREAM_URL},
            format="json",
        )
    assert created.status_code == 201, created.content
    with django_capture_on_commit_callbacks(execute=True):
        # Unbinding takes the button AWAY — the same bug pointing the other way.
        assert c.delete(f"{url}{courts[0].id}/").status_code == 204
    ticks = _ticks(layer, chan)
    assert [tk["kind"] for tk in ticks] == ["stream", "stream"]
    assert {tk["match_id"] for tk in ticks} == {None}


def test_an_idempotent_court_stream_delete_says_nothing(
    django_capture_on_commit_callbacks,
):
    admin, t, courts, _m, _day = _stream_setup()
    layer, chan = _subscribe(f"tournament_{t.id}")
    with django_capture_on_commit_callbacks(execute=True):
        r = _client(admin).delete(
            f"/api/tournaments/{t.id}/court-streams/{courts[0].id}/"
        )
    assert r.status_code == 204
    assert _ticks(layer, chan) == []  # nothing changed; nobody to tell


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
