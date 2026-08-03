"""The public "Watch live" redirects.

    GET /api/public/tournaments/<slug>/<uuid>/court/<court_id>/live/
    GET /api/public/matches/<match_id>/watch/

**These links are the product.** A YouTube channel-level ``/live`` URL cannot be
printed next to Court 2: with several courts live on one channel it resolves to
an arbitrary broadcast (six requests, five different video ids). So the printed
/ QR-able link belongs to the platform and 302s to whatever the court is
actually showing at click time — which is also why every response here must be
``Cache-Control: no-store``.

Gating is the same block ``PublicTournamentScheduleView`` uses: the (slug, UUID)
pair must resolve, the tournament must not be soft-deleted, and its status must
be one of the four public ones.
"""
from __future__ import annotations

import uuid
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
from apps.tournaments.models import TournamentStatus

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _reset_anon_throttle():
    """AnonRateThrottle keys off the caller IP in a process-wide LocMemCache,
    so a run full of public GETs would otherwise start 429-ing."""
    cache.clear()
    yield
    cache.clear()


def _court_url(t, court) -> str:
    return f"/api/public/tournaments/{t.slug}/{t.id}/court/{court.id}/live/"


def _match_url(m) -> str:
    return f"/api/public/matches/{m.id}/watch/"


# ------------------------------------------------------------- court redirect
def test_live_court_redirects_to_its_own_video():
    _admin, t, courts = make_tournament()
    make_broadcast(courts[0], local_day(tz=tz_of(t)), video_id=VIDEO_ID)
    make_broadcast(courts[1], local_day(tz=tz_of(t)), video_id=OTHER_VIDEO_ID)

    r = api().get(_court_url(t, courts[0]))
    assert r.status_code == 302, r.content
    assert r["Location"] == WATCH_URL
    assert r["Cache-Control"] == "no-store"

    # The whole point: court 2 goes somewhere else, which a channel-level
    # /live link could never guarantee.
    r2 = api().get(_court_url(t, courts[1]))
    assert r2["Location"] == f"https://www.youtube.com/watch?v={OTHER_VIDEO_ID}"


def test_court_redirect_falls_back_to_the_pasted_url():
    _admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=SHORT_URL)
    r = api().get(_court_url(t, courts[0]))
    assert r.status_code == 302
    assert r["Location"] == SHORT_URL


def test_court_with_no_stream_is_404_json_not_a_dead_redirect():
    _admin, t, courts = make_tournament()
    r = api().get(_court_url(t, courts[0]))
    assert r.status_code == 404
    assert r["Content-Type"].startswith("application/json")
    assert r.json()["detail"] == "stream_not_available"
    assert r["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    "status",
    [
        TournamentStatus.DRAFT,
        TournamentStatus.PUBLISHED,
        TournamentStatus.ARCHIVED,
    ],
)
def test_non_public_tournament_status_is_404(status):
    _admin, t, courts = make_tournament(status=status)
    make_broadcast(courts[0], local_day(tz=tz_of(t)))
    r = api().get(_court_url(t, courts[0]))
    assert r.status_code == 404
    assert r.json()["detail"] == "tournament_not_found"


@pytest.mark.parametrize(
    "status",
    [
        TournamentStatus.REGISTRATION_OPEN,
        TournamentStatus.SCHEDULED,
        TournamentStatus.LIVE,
        TournamentStatus.COMPLETED,
    ],
)
def test_every_public_status_resolves(status):
    _admin, t, courts = make_tournament(status=status)
    make_broadcast(courts[0], local_day(tz=tz_of(t)))
    assert api().get(_court_url(t, courts[0])).status_code == 302


def test_wrong_slug_is_404():
    _admin, t, courts = make_tournament()
    make_broadcast(courts[0], local_day(tz=tz_of(t)))
    url = f"/api/public/tournaments/some-other-slug/{t.id}/court/{courts[0].id}/live/"
    assert api().get(url).status_code == 404


def test_unknown_court_is_404():
    _admin, t, _courts = make_tournament()
    url = f"/api/public/tournaments/{t.slug}/{t.id}/court/{uuid.uuid4()}/live/"
    assert api().get(url).status_code == 404


def test_another_orgs_court_cannot_be_reached_through_this_tournament():
    """Invariant 2, on a public route: org B's court id smuggled into org A's
    public URL resolves to nothing, and leaks no existence."""
    _admin_a, t_a, _courts_a = make_tournament(name="Cup A")
    _admin_b, t_b, courts_b = make_tournament(name="Cup B")
    make_broadcast(courts_b[0], local_day(tz=tz_of(t_b)))
    url = f"/api/public/tournaments/{t_a.slug}/{t_a.id}/court/{courts_b[0].id}/live/"
    r = api().get(url)
    assert r.status_code == 404
    assert r.json()["detail"] == "court_not_found"


def test_a_soft_deleted_court_is_404():
    _admin, t, courts = make_tournament()
    make_broadcast(courts[0], local_day(tz=tz_of(t)))
    courts[0].deleted_at = datetime.now(tz_of(t))
    courts[0].save(update_fields=["deleted_at"])
    assert api().get(_court_url(t, courts[0])).status_code == 404


# ------------------------------------------------------------- match redirect
def test_live_match_redirects_to_the_courts_live_url():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    make_broadcast(
        courts[0], local_day(started, tz), actual_start_utc=started - timedelta(hours=1)
    )
    m = make_match(
        t, courts[0], status=MatchStatus.LIVE, scheduled_at=started, started_at=started
    )
    r = api().get(_match_url(m))
    assert r.status_code == 302
    assert r["Location"] == WATCH_URL
    assert r["Cache-Control"] == "no-store"


def test_finished_match_redirects_into_the_archive_at_the_right_second():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    started = datetime(2026, 8, 3, 14, 20, tzinfo=tz)
    make_broadcast(
        courts[0],
        local_day(started, tz),
        actual_start_utc=started - timedelta(hours=5, minutes=30),
        lifecycle=BroadcastLifecycle.COMPLETE,
    )
    m = make_match(
        t,
        courts[0],
        status=MatchStatus.COMPLETED,
        scheduled_at=started,
        started_at=started,
    )
    r = api().get(_match_url(m))
    assert r.status_code == 302
    # 5h30m into the archive, minus planning.py's 15s lead-in.
    assert r["Location"] == f"{WATCH_URL}&t={5 * 3600 + 30 * 60 - 15}"


def test_match_without_a_stream_is_404_json():
    _admin, t, courts = make_tournament()
    m = make_match(t, courts[0])
    r = api().get(_match_url(m))
    assert r.status_code == 404
    assert r.json()["detail"] == "stream_not_available"
    assert r["Cache-Control"] == "no-store"


def test_match_without_a_court_is_404_json():
    _admin, t, _courts = make_tournament()
    m = make_match(t, None)
    assert api().get(_match_url(m)).status_code == 404


def test_match_in_a_non_public_tournament_is_404():
    _admin, t, courts = make_tournament(status=TournamentStatus.DRAFT)
    make_broadcast(courts[0], local_day(tz=tz_of(t)))
    m = make_match(t, courts[0])
    r = api().get(_match_url(m))
    assert r.status_code == 404
    assert r.json()["detail"] == "match_not_found"


def test_unknown_match_is_404():
    assert api().get(f"/api/public/matches/{uuid.uuid4()}/watch/").status_code == 404


def test_a_soft_deleted_match_is_404():
    _admin, t, courts = make_tournament()
    make_broadcast(courts[0], local_day(tz=tz_of(t)))
    m = make_match(t, courts[0])
    m.deleted_at = datetime.now(tz_of(t))
    m.save(update_fields=["deleted_at"])
    assert api().get(_match_url(m)).status_code == 404
