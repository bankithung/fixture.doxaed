"""``apps.streaming.services.links`` — the resolution logic behind every
"Watch live" link, and the validator that stops an organiser pasting a URL
which cannot address a court.

The two rules worth stating out loud, because both are load-bearing:

* a finished match deep-links into **its own day's** archive, not today's — on
  day 3 of a tournament, day 1's results must still open at the right rally;
* nothing here may raise. These functions run on an unauthenticated public read
  path and inside the schedule payload every spectator refetches, so a missing
  court / stream row / broadcast / timestamp resolves to ``None``, never a 500.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from apps.matches.models import MatchStatus
from apps.streaming.models import BroadcastLifecycle, CourtStream
from apps.streaming.services.links import (
    CourtLinkResolver,
    WatchUrlError,
    is_channel_live_url,
    local_day,
    validate_watch_url,
    video_id_from_url,
    watch_url_for_court,
    watch_url_for_match,
)
from apps.streaming.tests.support import (
    CHANNEL_LIVE_URL,
    OTHER_VIDEO_ID,
    SHORT_URL,
    VIDEO_ID,
    WATCH_URL,
    make_broadcast,
    make_match,
    make_stream,
    make_tournament,
    tz_of,
)

pytestmark = pytest.mark.django_db


# ------------------------------------------------------------ court resolution
def test_todays_broadcast_wins_over_the_pasted_url():
    _admin, t, courts = make_tournament()
    court = courts[0]
    make_stream(court, watch_url=WATCH_URL)
    make_broadcast(court, local_day(tz=tz_of(t)), video_id=OTHER_VIDEO_ID)
    assert watch_url_for_court(court, tz=tz_of(t)) == (
        f"https://www.youtube.com/watch?v={OTHER_VIDEO_ID}"
    )


def test_falls_back_to_the_pasted_url_without_a_broadcast():
    _admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=SHORT_URL)
    assert watch_url_for_court(courts[0], tz=tz_of(t)) == SHORT_URL


def test_a_broadcast_on_another_day_does_not_leak_into_today():
    _admin, t, courts = make_tournament()
    make_broadcast(
        courts[0], local_day(tz=tz_of(t)) - timedelta(days=1), video_id=VIDEO_ID
    )
    assert watch_url_for_court(courts[0], tz=tz_of(t)) is None


def test_a_broadcast_with_no_video_id_yet_is_not_a_link():
    """A ``created`` row whose YouTube call has not landed must not produce
    ``watch?v=`` with an empty id."""
    _admin, t, courts = make_tournament()
    make_broadcast(
        courts[0],
        local_day(tz=tz_of(t)),
        video_id="",
        lifecycle=BroadcastLifecycle.CREATED,
    )
    assert watch_url_for_court(courts[0], tz=tz_of(t)) is None


@pytest.mark.parametrize("court", [None])
def test_watch_url_for_court_is_none_without_a_court(court):
    assert watch_url_for_court(court) is None


def test_watch_url_for_court_is_none_with_no_stream_and_no_broadcast():
    _admin, t, courts = make_tournament()
    assert watch_url_for_court(courts[0], tz=tz_of(t)) is None


def test_a_soft_deleted_stream_stops_resolving():
    _admin, t, courts = make_tournament()
    s = make_stream(courts[0])
    s.deleted_at = datetime.now(UTC)
    s.save(update_fields=["deleted_at"])
    assert watch_url_for_court(courts[0], tz=tz_of(t)) is None


def test_the_broadcast_day_is_the_LOCAL_day():
    """A 23:30 Asia/Kolkata match is 18:00 UTC the same day, but a 05:00 one is
    the previous UTC day — keying broadcasts off a UTC date would hand half the
    evening session the wrong video."""
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    late = datetime(2026, 8, 3, 23, 30, tzinfo=tz)
    assert local_day(late, tz).isoformat() == "2026-08-03"
    assert local_day(late).isoformat() == "2026-08-03"  # 18:00 UTC, same day
    early = datetime(2026, 8, 3, 5, 0, tzinfo=tz)
    assert local_day(early, tz).isoformat() == "2026-08-03"
    assert local_day(early).isoformat() == "2026-08-02"  # 23:30 UTC the day before

    make_broadcast(courts[0], local_day(early, tz), video_id=VIDEO_ID)
    assert watch_url_for_court(courts[0], early, tz=tz) == WATCH_URL


# ------------------------------------------------------------ match resolution
def _finished_match(t, court, *, started_at, actual_start, video_id=VIDEO_ID):
    tz = tz_of(t)
    make_broadcast(
        court,
        local_day(started_at, tz),
        video_id=video_id,
        actual_start_utc=actual_start,
        lifecycle=BroadcastLifecycle.COMPLETE,
    )
    return make_match(
        t,
        court,
        status=MatchStatus.COMPLETED,
        scheduled_at=started_at,
        started_at=started_at,
    )


def test_finished_match_deep_links_with_the_vod_offset():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    m = _finished_match(
        t, courts[0], started_at=started, actual_start=started - timedelta(hours=2)
    )
    # 2h into the archive, minus the 15s lead-in planning.py applies so the link
    # lands just BEFORE the first serve.
    assert watch_url_for_match(m, tz=tz) == f"{WATCH_URL}&t={7200 - 15}"


def test_a_live_match_gets_the_plain_live_url():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    make_broadcast(
        courts[0], local_day(started, tz), actual_start_utc=started - timedelta(hours=1)
    )
    m = make_match(
        t, courts[0], status=MatchStatus.LIVE, scheduled_at=started, started_at=started
    )
    assert watch_url_for_match(m, tz=tz) == WATCH_URL


def test_walkover_also_deep_links():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    m = _finished_match(
        t, courts[0], started_at=started, actual_start=started - timedelta(minutes=30)
    )
    m.status = MatchStatus.WALKOVER
    m.save(update_fields=["status"])
    assert watch_url_for_match(m, tz=tz) == f"{WATCH_URL}&t={1800 - 15}"


def test_no_offset_when_started_at_is_null():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    scheduled = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    make_broadcast(
        courts[0],
        local_day(scheduled, tz),
        actual_start_utc=scheduled - timedelta(hours=1),
        lifecycle=BroadcastLifecycle.COMPLETE,
    )
    m = make_match(
        t,
        courts[0],
        status=MatchStatus.COMPLETED,
        scheduled_at=scheduled,
        started_at=None,
    )
    assert watch_url_for_match(m, tz=tz) == WATCH_URL


def test_no_offset_when_actual_start_utc_is_null():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    make_broadcast(
        courts[0],
        local_day(started, tz),
        actual_start_utc=None,
        lifecycle=BroadcastLifecycle.COMPLETE,
    )
    m = make_match(
        t,
        courts[0],
        status=MatchStatus.COMPLETED,
        scheduled_at=started,
        started_at=started,
    )
    assert watch_url_for_match(m, tz=tz) == WATCH_URL


def test_offset_is_clamped_at_zero_when_the_match_predates_the_broadcast():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    m = _finished_match(
        t, courts[0], started_at=started, actual_start=started + timedelta(minutes=5)
    )
    assert watch_url_for_match(m, tz=tz) == f"{WATCH_URL}&t=0"


def test_offset_is_never_appended_to_a_hand_pasted_url():
    """A pasted link may be a ``youtu.be/…`` short URL (where the separator
    would have to be ``?t=``) or point somewhere that is not that day's archive
    at all — deep-linking it would be wrong."""
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    make_stream(courts[0], watch_url=SHORT_URL)
    m = make_match(
        t,
        courts[0],
        status=MatchStatus.COMPLETED,
        scheduled_at=started,
        started_at=started,
    )
    assert watch_url_for_match(m, tz=tz) == SHORT_URL


def test_finished_match_links_into_ITS_OWN_day_not_today():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    day1 = datetime(2026, 8, 1, 10, 0, tzinfo=tz)
    m = _finished_match(
        t,
        courts[0],
        started_at=day1,
        actual_start=day1 - timedelta(minutes=20),
        video_id=OTHER_VIDEO_ID,
    )
    # A LATER day's broadcast for the same court, counted off day one instead of
    # off ``local_day()``: filed under "today" it shares day one's (court, day)
    # key whenever the suite runs on 2026-08-01, and ``_broadcast_for`` takes the
    # newest row — so on that one date the test would assert the bug it forbids.
    make_broadcast(
        courts[0], local_day(day1 + timedelta(days=2), tz), video_id=VIDEO_ID
    )
    url = watch_url_for_match(m, tz=tz)
    assert url == f"https://www.youtube.com/watch?v={OTHER_VIDEO_ID}&t={1200 - 15}"


# ------------------------------------------------------- never raises, ever
def test_watch_url_for_match_is_none_and_silent_without_a_court():
    _admin, t, _courts = make_tournament()
    m = make_match(t, None, scheduled_at=datetime(2026, 8, 3, 9, 0, tzinfo=tz_of(t)))
    assert watch_url_for_match(m) is None


def test_watch_url_for_match_is_none_without_stream_or_broadcast():
    _admin, t, courts = make_tournament()
    m = make_match(t, courts[0])
    assert watch_url_for_match(m, tz=tz_of(t)) is None


def test_watch_url_for_match_tolerates_a_none_match():
    assert watch_url_for_match(None) is None


def test_watch_url_for_match_survives_a_naive_started_at():
    """``vod_offset_seconds`` refuses naive datetimes (that is how you get an
    offset exactly one timezone wrong). The link path must degrade to the live
    URL rather than 500 a public page."""
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    m = _finished_match(
        t, courts[0], started_at=started, actual_start=started - timedelta(hours=1)
    )
    m.started_at = datetime(2026, 8, 3, 11, 0)  # naive, in-memory only
    assert watch_url_for_match(m, tz=tz) == WATCH_URL


# --------------------------------------------------------------- bulk resolver
def test_resolver_matches_the_single_row_helpers():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    make_stream(courts[0], watch_url=WATCH_URL)
    make_broadcast(courts[1], local_day(tz=tz), video_id=OTHER_VIDEO_ID)
    r = CourtLinkResolver(courts, tz=tz)
    for c in courts:
        assert r.watch_url(c.id) == watch_url_for_court(c, tz=tz)


def test_resolver_is_streaming_needs_more_than_a_url():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    # A pasted link the organiser has NOT switched on: clickable, not on air.
    make_stream(courts[0], watch_url=WATCH_URL, enabled=False)
    make_broadcast(
        courts[1], local_day(tz=tz), lifecycle=BroadcastLifecycle.READY
    )
    r = CourtLinkResolver(courts, tz=tz)
    assert r.watch_url(courts[0].id) == WATCH_URL
    assert r.is_streaming(courts[0].id) is False
    assert r.is_streaming(courts[1].id) is False

    CourtStream.objects.filter(court=courts[0]).update(enabled=True)
    r2 = CourtLinkResolver(courts, tz=tz)
    assert r2.is_streaming(courts[0].id) is True


def test_resolver_costs_three_queries_regardless_of_court_count(
    django_assert_num_queries,
):
    """Streams, broadcasts, manual scoped links — three, whatever the court
    count. The links query covers all three manual scopes at once (it was 2
    before those existed); if it ever splits per scope, this is what fails."""
    _admin, t, courts = make_tournament(
        court_names=("Hall · T1", "Hall · T2", "Hall · T3", "Hall · T4")
    )
    for c in courts:
        make_stream(c)
        make_broadcast(c, local_day(tz=tz_of(t)))
    with django_assert_num_queries(3):
        r = CourtLinkResolver(courts, tz=tz_of(t), tournament=t)
    with django_assert_num_queries(0):
        assert all(r.watch_url(c.id) for c in courts)


def test_resolver_with_no_courts_touches_the_database_not_at_all(
    django_assert_num_queries,
):
    with django_assert_num_queries(0):
        r = CourtLinkResolver([])
    assert r.court_payload() == []


# ------------------------------------------------------------- URL validation
@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/@nagalandschoolscup/live",
        "https://youtube.com/channel/UCabcdefghijklmnopqrstu/live",
        "https://www.youtube.com/c/SomeChannel/live",
        "https://www.youtube.com/user/SomeUser/live",
        "youtube.com/@handle/live",
    ],
)
def test_channel_level_live_urls_are_refused_with_an_explanation(url):
    assert is_channel_live_url(url) is True
    with pytest.raises(WatchUrlError) as e:
        validate_watch_url(url)
    assert e.value.code == "channel_live_url"
    # The message must explain WHY, not just refuse: this is the URL every
    # organiser reaches for first.
    assert "court" in e.value.message.lower()
    assert "channel" in e.value.message.lower()


@pytest.mark.parametrize(
    "url",
    [
        WATCH_URL,
        SHORT_URL,
        f"https://www.youtube.com/live/{VIDEO_ID}",
        f"https://m.youtube.com/watch?v={VIDEO_ID}&feature=share",
        f"youtube.com/watch?v={VIDEO_ID}",
    ],
)
def test_real_video_urls_are_accepted(url):
    cleaned = validate_watch_url(url)
    assert cleaned.startswith("https://")
    assert video_id_from_url(cleaned) == VIDEO_ID
    assert is_channel_live_url(cleaned) is False


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/",
        "https://www.youtube.com/@handle",
        "https://www.youtube.com/watch?v=short",
        "not a url at all",
    ],
)
def test_non_video_urls_are_refused(url):
    with pytest.raises(WatchUrlError) as e:
        validate_watch_url(url)
    assert e.value.code == "not_a_youtube_video_url"


def test_blank_clears_the_binding():
    assert validate_watch_url("") == ""
    assert validate_watch_url(None) == ""
    assert validate_watch_url("   ") == ""


def test_the_live_slash_id_form_is_a_video_not_a_channel():
    url = f"https://www.youtube.com/live/{VIDEO_ID}"
    assert is_channel_live_url(url) is False
    assert validate_watch_url(url) == url


def test_channel_live_url_constant_is_actually_rejected():
    with pytest.raises(WatchUrlError):
        validate_watch_url(CHANNEL_LIVE_URL)
