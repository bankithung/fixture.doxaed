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
from apps.streaming.models import (
    BroadcastLifecycle,
    CourtBroadcast,
    CourtStream,
    StreamLink,
    StreamLinkScope,
)
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()

#: A real-shaped 11-character YouTube video id (the only length YouTube issues).
VIDEO_ID = "dQw4w9WgXcQ"
OTHER_VIDEO_ID = "9bZkp7q19f0"
WATCH_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
SHORT_URL = f"https://youtu.be/{VIDEO_ID}"
#: The URL an organiser reaches for first, and the one that cannot work.
CHANNEL_LIVE_URL = "https://www.youtube.com/@nagalandschoolscup/live"

#: One distinguishable video per PRECEDENCE LEVEL, so a test that asserts which
#: level won reads as the answer itself rather than as "the second constant".
#: Level 3 (broadcast) uses VIDEO_ID and level 5 (CourtStream) OTHER_VIDEO_ID.
MATCH_LINK_URL = "https://www.youtube.com/watch?v=M1atchLink1"
COURT_DAY_LINK_URL = "https://www.youtube.com/watch?v=C0urtDayLnk"
CATEGORY_LINK_URL = "https://www.youtube.com/watch?v=Categ0ryLnk"
BROADCAST_URL = WATCH_URL
COURT_STREAM_URL = f"https://www.youtube.com/watch?v={OTHER_VIDEO_ID}"

#: Leaf keys minted by ``with_categories`` below (sport key + node key).
FOOTBALL_U15 = "football.u15"
FOOTBALL_U17 = "football.u17"


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


def with_categories(t) -> tuple[str, str]:
    """Give ``t`` a two-leaf category tree and return its leaf keys.

    The category scope is keyed on ``Match.leaf_key`` — the competition leaf
    minted from ``Tournament.sports`` — so a category test needs a tournament
    that actually runs those competitions (the manager API refuses a leaf the
    tournament does not have).
    """
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}, {"name": "U17"}]},
    ])
    t.save(update_fields=["sports"])
    return FOOTBALL_U15, FOOTBALL_U17


def make_match(
    t,
    court,
    *,
    match_no: int = 1,
    status: str = MatchStatus.SCHEDULED,
    scheduled_at: datetime | None = None,
    started_at: datetime | None = None,
    teams: tuple | None = None,
    leaf_key: str = "",
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
        leaf_key=leaf_key,
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


# ------------------------------------------------------ scoped manual links
def make_match_link(match, *, watch_url: str = MATCH_LINK_URL, enabled: bool = True):
    """Precedence level 1."""
    return StreamLink.objects.create(
        scope=StreamLinkScope.MATCH,
        organization_id=match.organization_id,
        match=match,
        watch_url=watch_url,
        enabled=enabled,
    )


def make_court_day_link(
    court, day, *, watch_url: str = COURT_DAY_LINK_URL, enabled: bool = True
):
    """Precedence level 2. ``day`` is a LOCAL tournament day — always derive it
    from the match under test (``local_day(kickoff, tz)``), never from
    ``local_day()``: a link filed under "today" only lines up with a fixed-date
    match on one calendar day of the year."""
    return StreamLink.objects.create(
        scope=StreamLinkScope.COURT_DAY,
        organization_id=court.organization_id,
        court=court,
        day=day,
        watch_url=watch_url,
        enabled=enabled,
    )


def make_category_link(
    t, leaf_key: str, *, watch_url: str = CATEGORY_LINK_URL, enabled: bool = True
):
    """Precedence level 4."""
    return StreamLink.objects.create(
        scope=StreamLinkScope.CATEGORY,
        organization_id=t.organization_id,
        tournament=t,
        leaf_key=leaf_key,
        watch_url=watch_url,
        enabled=enabled,
    )
