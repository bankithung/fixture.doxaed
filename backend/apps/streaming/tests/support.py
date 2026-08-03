"""Shared setup for the streaming model/view tests.

Kept out of ``conftest.py`` on purpose: that file already defines a ``client``
fixture (the *YouTube* client), which shadows pytest-django's HTTP ``client``.
Tests here build an ``APIClient`` explicitly via :func:`api`.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.models import Venue
from apps.fixtures.services.courts import resolve_court
from apps.matches.models import Match, MatchStatus
from apps.streaming.models import BroadcastLifecycle, CourtBroadcast, CourtStream
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()

#: A real-shaped 11-character YouTube video id (the only length YouTube issues).
VIDEO_ID = "dQw4w9WgXcQ"
OTHER_VIDEO_ID = "9bZkp7q19f0"
WATCH_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
SHORT_URL = f"https://youtu.be/{VIDEO_ID}"
#: The URL an organiser reaches for first, and the one that cannot work.
CHANNEL_LIVE_URL = "https://www.youtube.com/@nagalandschoolscup/live"


def verified(prefix: str = "stream") -> User:
    u = User.objects.create_user(
        email=f"{prefix}-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!",
        is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def api(user=None) -> APIClient:
    c = APIClient()
    if user is not None:
        c.force_authenticate(user=user)
    return c


def make_tournament(
    admin=None,
    *,
    name: str = "Stream Cup",
    status: str = TournamentStatus.LIVE,
    n_teams: int = 8,
    court_names: tuple[str, ...] = ("Hall · T1", "Hall · T2"),
):
    """A public-status tournament with a "Hall" venue and materialised courts.

    Returns ``(admin, tournament, [Court, ...])`` in ``court_names`` order.
    """
    admin = admin or verified()
    t = create_tournament(user=admin, name=name)
    register_school(
        tournament=t,
        school_name="St. Mary School",
        teams=[{"name": f"T{i}", "players": []} for i in range(n_teams)],
    )
    Venue.objects.create(organization=t.organization, name="Hall", count=4)
    courts = [resolve_court(t.organization, n) for n in court_names]
    t.status = status
    t.save(update_fields=["status"])
    return admin, t, courts


def tz_of(t) -> ZoneInfo:
    return ZoneInfo(t.time_zone)


def make_match(
    t,
    court,
    *,
    match_no: int = 1,
    status: str = MatchStatus.SCHEDULED,
    scheduled_at: datetime | None = None,
    started_at: datetime | None = None,
    teams: tuple | None = None,
) -> Match:
    """One match pinned to ``court`` — both the FK and the denormalised
    ``venue`` string, exactly as the four real writers keep them."""
    tz = tz_of(t)
    if teams is None:
        pool = list(Team.objects.filter(tournament=t).order_by("name"))
        offset = (match_no - 1) * 2 % max(1, len(pool) - 1)
        teams = (pool[offset], pool[offset + 1])
    return Match.objects.create(
        organization=t.organization,
        tournament=t,
        round_no=1,
        match_no=match_no,
        home_team=teams[0],
        away_team=teams[1],
        status=status,
        scheduled_at=scheduled_at or datetime(2026, 8, 3, 9, 0, tzinfo=tz),
        started_at=started_at,
        court=court,
        venue=court.name if court else "",
    )


def make_stream(court, *, watch_url: str = WATCH_URL, enabled: bool = True, **kw):
    return CourtStream.objects.create(
        court=court,
        organization_id=court.organization_id,
        watch_url=watch_url,
        enabled=enabled,
        **kw,
    )


def make_broadcast(
    court,
    day,
    *,
    video_id: str = VIDEO_ID,
    actual_start_utc: datetime | None = None,
    lifecycle: str = BroadcastLifecycle.LIVE,
):
    return CourtBroadcast.objects.create(
        court=court,
        organization_id=court.organization_id,
        day=day,
        yt_video_id=video_id,
        actual_start_utc=actual_start_utc,
        lifecycle=lifecycle,
    )
