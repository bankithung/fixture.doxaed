"""The public schedule payload's streaming fields.

``GET /api/public/tournaments/{slug}/{id}/schedule/`` gains, per match,
``watch_url`` + ``court_id``, and a top-level ``courts`` list so the display
page and the spectator grid can render per-court state.

**This endpoint is refetched by every spectator**, so the query count is pinned
here on purpose: link resolution must cost a bounded number of queries, never
one per match. If a later change makes it O(n) this test is the thing that
fails.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from django.core.cache import cache

from apps.matches.models import MatchStatus
from apps.streaming.models import BroadcastLifecycle
from apps.streaming.services.links import local_day
from apps.streaming.tests.support import (
    OTHER_VIDEO_ID,
    SHORT_URL,
    VIDEO_ID,
    WATCH_URL,
    api,
    make_broadcast,
    make_match,
    make_stream,
    make_tournament,
    tz_of,
)

pytestmark = pytest.mark.django_db

#: Tournament lookup, matches, courts, court streams, court broadcasts, the
#: manual scoped links — plus the savepoint pair ATOMIC_REQUESTS opens inside
#: the test's own transaction. The NUMBER matters less than the fact that it
#: does not move with the match count (see
#: ``test_query_count_does_not_grow_with_the_match_count``).
#:
#: Went 7 → 8 when the scoped stream links landed (2026-08-04): all three manual
#: scopes — match, court+day, category — are preloaded in ONE ORed query, so the
#: whole precedence rule costs one more query for the payload and none per row.
SCHEDULE_QUERIES = 8


def _schedule(t):
    return api().get(f"/api/public/tournaments/{t.slug}/{t.id}/schedule/")


@pytest.fixture(autouse=True)
def _reset_throttle():
    cache.clear()
    yield
    cache.clear()


def test_each_match_row_carries_court_id_and_watch_url():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    # The broadcast day comes from the MATCH, never from ``local_day()``: a row
    # resolves against the day of its own ``started_at``/``scheduled_at``, so a
    # broadcast filed under "today" plus a match pinned to a fixed date only line
    # up on that one calendar day — the test passed on 2026-08-03 and asserted
    # ``watch_url is None`` against ``WATCH_URL`` on every other.
    kickoff = datetime(2026, 8, 3, 9, 0, tzinfo=tz)
    make_broadcast(courts[0], local_day(kickoff, tz), video_id=VIDEO_ID)
    make_stream(courts[1], watch_url=SHORT_URL)
    m0 = make_match(t, courts[0], match_no=1, scheduled_at=kickoff)
    m1 = make_match(
        t, courts[1], match_no=2, scheduled_at=kickoff + timedelta(hours=1)
    )

    body = _schedule(t).json()
    rows = {r["id"]: r for r in body["matches"]}
    assert rows[str(m0.id)]["court_id"] == str(courts[0].id)
    assert rows[str(m0.id)]["watch_url"] == WATCH_URL
    assert rows[str(m1.id)]["court_id"] == str(courts[1].id)
    assert rows[str(m1.id)]["watch_url"] == SHORT_URL


def test_a_match_with_no_court_has_null_fields_not_a_missing_key():
    _admin, t, _courts = make_tournament()
    m = make_match(t, None)
    row = next(r for r in _schedule(t).json()["matches"] if r["id"] == str(m.id))
    assert row["court_id"] is None
    assert row["watch_url"] is None


def test_a_court_with_no_stream_gives_a_null_watch_url():
    _admin, t, courts = make_tournament()
    m = make_match(t, courts[0])
    row = next(r for r in _schedule(t).json()["matches"] if r["id"] == str(m.id))
    assert row["court_id"] == str(courts[0].id)
    assert row["watch_url"] is None


def test_a_finished_match_row_carries_the_vod_deep_link():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 12, 0, tzinfo=tz)
    make_broadcast(
        courts[0],
        local_day(started, tz),
        actual_start_utc=started - timedelta(hours=3),
        lifecycle=BroadcastLifecycle.COMPLETE,
    )
    m = make_match(
        t,
        courts[0],
        status=MatchStatus.COMPLETED,
        scheduled_at=started,
        started_at=started,
    )
    row = next(r for r in _schedule(t).json()["matches"] if r["id"] == str(m.id))
    assert row["watch_url"] == f"{WATCH_URL}&t={3 * 3600 - 15}"


def test_the_envelope_carries_a_courts_list():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    make_broadcast(courts[0], local_day(tz=tz), video_id=VIDEO_ID)
    make_stream(courts[1], watch_url=SHORT_URL, enabled=False)
    make_match(t, courts[0], match_no=1)
    make_match(t, courts[1], match_no=2)

    body = _schedule(t).json()
    rows = {c["name"]: c for c in body["courts"]}
    assert set(rows) == {"Hall · T1", "Hall · T2"}
    assert rows["Hall · T1"] == {
        "id": str(courts[0].id),
        "name": "Hall · T1",
        "watch_url": WATCH_URL,
        "is_streaming": True,
    }
    # A pasted link the organiser has not switched on: clickable, not on air.
    assert rows["Hall · T2"]["watch_url"] == SHORT_URL
    assert rows["Hall · T2"]["is_streaming"] is False


def test_the_courts_list_only_covers_courts_this_tournament_plays_on():
    _admin, t, courts = make_tournament(
        court_names=("Hall · T1", "Hall · T2", "Hall · T3")
    )
    make_match(t, courts[0])
    names = [c["name"] for c in _schedule(t).json()["courts"]]
    assert names == ["Hall · T1"]


def test_the_courts_list_is_empty_when_nothing_is_pinned_to_a_court():
    _admin, t, _courts = make_tournament()
    make_match(t, None)
    assert _schedule(t).json()["courts"] == []


def test_a_second_days_broadcast_does_not_bleed_into_day_one_rows():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    day1 = datetime(2026, 8, 1, 10, 0, tzinfo=tz)
    make_broadcast(
        courts[0],
        local_day(day1, tz),
        video_id=OTHER_VIDEO_ID,
        actual_start_utc=day1 - timedelta(minutes=10),
        lifecycle=BroadcastLifecycle.COMPLETE,
    )
    # Day TWO's broadcast, counted off day one rather than off ``local_day()``:
    # filed under "today" it would land on the same (court, day) key as day one's
    # own row whenever the suite runs on 2026-08-01, and being the newer row it
    # would win — the exact bleed this test exists to catch.
    make_broadcast(
        courts[0], local_day(day1 + timedelta(days=1), tz), video_id=VIDEO_ID
    )
    m = make_match(
        t,
        courts[0],
        status=MatchStatus.COMPLETED,
        scheduled_at=day1,
        started_at=day1,
    )
    row = next(r for r in _schedule(t).json()["matches"] if r["id"] == str(m.id))
    assert row["watch_url"] == (
        f"https://www.youtube.com/watch?v={OTHER_VIDEO_ID}&t={600 - 15}"
    )


# ------------------------------------------------------------- performance
def _populate(t, courts, n: int):
    tz = tz_of(t)
    # Same rule as above: the broadcasts belong to the day the matches are
    # played on, so the resolver takes the broadcast branch every day of the
    # year and not just on 2026-08-03 (under "today" it fell through to the
    # pasted stream URL, quietly measuring a cheaper path than production's).
    first = datetime(2026, 8, 3, 8, 0, tzinfo=tz)
    for c in courts:
        make_stream(c, watch_url=WATCH_URL)
        make_broadcast(c, local_day(first, tz), video_id=VIDEO_ID)
    for i in range(n):
        make_match(
            t,
            courts[i % len(courts)],
            match_no=i + 1,
            scheduled_at=first + timedelta(minutes=i),
        )


def test_schedule_query_count_is_pinned(django_assert_num_queries):
    _admin, t, courts = make_tournament()
    _populate(t, courts, 6)
    with django_assert_num_queries(SCHEDULE_QUERIES):
        assert _schedule(t).status_code == 200


def test_query_count_does_not_grow_with_the_match_count(django_assert_num_queries):
    """The real guard: doubling the matches must not add a single query."""
    _admin, t, courts = make_tournament()
    _populate(t, courts, 24)
    with django_assert_num_queries(SCHEDULE_QUERIES):
        body = _schedule(t).json()
    assert len(body["matches"]) == 24


def test_query_count_does_not_grow_with_the_court_count(django_assert_num_queries):
    _admin, t, courts = make_tournament(
        court_names=("Hall · T1", "Hall · T2", "Hall · T3", "Hall · T4")
    )
    _populate(t, courts, 12)
    with django_assert_num_queries(SCHEDULE_QUERIES):
        body = _schedule(t).json()
    assert len(body["courts"]) == 4
