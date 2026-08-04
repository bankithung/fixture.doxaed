"""Resolve the "Watch live" URL that currently applies to a court or a match.

This is the whole reason the platform hands out **its own** links rather than
YouTube's. A channel-level ``/live`` URL cannot address a court: with several
courts live on one channel YouTube resolves it to an arbitrary one of them
(empirically, six requests returned five different video ids). So the printable
/ QR-able link is ours (``…/court/<id>/live/``) and this module is what it
redirects to.

**THE PRECEDENCE RULE** (owner, 2026-08-04: *"per court and per day there will
be one live stream link… there can also be one per sport category, or even per
match — give full flexibility"*, most-specific-wins). Every level is optional
and independently settable; resolving a match walks them in this order and
takes the first that yields a URL:

1. a :class:`~apps.streaming.models.StreamLink` on **that match**;
2. a ``StreamLink`` for that match's **court on that match's day**;
3. the day's :class:`~apps.streaming.models.CourtBroadcast` — the API-managed
   broadcast, whose ``yt_video_id`` is both the live player and, afterwards,
   the archive;
4. a ``StreamLink`` for that match's **sport category** (its ``leaf_key``)
   in that tournament;
5. the court's standing default — :attr:`CourtStream.watch_url` (phase 1: the
   organiser streams from their own tooling and pastes one link per court);
6. ``None`` — the caller answers 404, never a redirect to a dead page.

Levels 1/2/4 are the hand-pasted overrides and 3/5 are what the platform owns.
The ordering is not alphabetical taste: **a link a human pasted for today beats
the automation** (2 over 3), because the human is the one looking at the
encoder and the automation cannot know it opened the wrong broadcast — while
the automation still beats anything *less* specific than the day it belongs to
(3 over 4 and 5), because a per-category or per-court standing link is a
default, not a statement about today.

Resolving a **court** (no match in hand) walks the same list minus the levels
that need one: court-day link → broadcast → CourtStream.

Once a match is finished the link becomes a deep link into that day's archive
(``&t=<offset>``), computed by the existing
:func:`apps.streaming.services.planning.vod_offset_seconds`. That offset is
only ever appended at level 3: it is an offset *into the broadcast's own
recording*, and a hand-pasted URL is not that recording (see
:func:`_apply_offset`).

Everything here is safe on missing data: no court, no stream row, no broadcast,
a null ``started_at`` or a null ``actual_start_utc`` all resolve to ``None`` or
to the plain live URL. **Nothing in here raises** — these functions sit on a
public, unauthenticated read path and inside the schedule payload every
spectator refetches.
"""
from __future__ import annotations

import re
from datetime import date as _date
from datetime import datetime, tzinfo
from typing import Any, Final
from urllib.parse import parse_qs, urlparse

from django.db.models import Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _t

from apps.streaming.models import (
    BroadcastLifecycle,
    CourtBroadcast,
    CourtStream,
    StreamLink,
    StreamLinkScope,
)
from apps.streaming.services.planning import vod_offset_seconds

#: A broadcast/video id renders as this. YouTube uses ONE identifier for the
#: broadcast, the live player and the resulting archive.
WATCH_URL_TEMPLATE: Final = "https://www.youtube.com/watch?v={video_id}"

#: Match statuses whose watch link should point *into* the archive rather than
#: at the live player.
FINISHED_STATUSES: Final = ("completed", "walkover")

_YT_HOSTS: Final = frozenset({
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
})
_YT_SHORT_HOSTS: Final = frozenset({"youtu.be", "www.youtu.be"})
#: 11-char YouTube video ids (the only length YouTube has ever issued).
_VIDEO_ID_RE: Final = re.compile(r"^[A-Za-z0-9_-]{11}$")


# --------------------------------------------------------------------- days
def local_day(when: datetime | None = None, tz: tzinfo | None = None) -> _date:
    """The calendar day ``when`` falls on, in ``tz`` (default: the active TZ).

    Broadcasts are keyed by the LOCAL tournament day, so this must not be
    ``.date()`` on a UTC datetime — a 19:00 Asia/Kolkata match is 13:30 UTC the
    same day, but a 23:30 one is the *next* UTC day and would miss its own
    broadcast.
    """
    moment = when or timezone.now()
    if timezone.is_naive(moment):
        moment = timezone.make_aware(moment, timezone.get_current_timezone())
    return timezone.localtime(moment, tz).date()


# ------------------------------------------------------------------ lookups
def _broadcast_for(court_id: Any, day: _date) -> CourtBroadcast | None:
    if court_id is None:
        return None
    return (
        CourtBroadcast.objects.filter(
            court_id=court_id, day=day, deleted_at__isnull=True
        )
        .order_by("-created_at")
        .first()
    )


def _stream_for(court_id: Any) -> CourtStream | None:
    if court_id is None:
        return None
    return CourtStream.objects.filter(
        court_id=court_id, deleted_at__isnull=True
    ).first()


#: Every manual-link lookup shares this filter. ``enabled=False`` and an empty
#: URL are both "this level is not set" rather than "this level says no": the
#: resolver must fall THROUGH to the next level, so the rows never come back at
#: all. Keep it identical to :attr:`StreamLink.resolves` and to the bulk
#: resolver's preload, or a link will resolve one way in the schedule payload
#: and another way through the redirect view.
_ACTIVE_LINK: Final = {"deleted_at__isnull": True, "enabled": True}


def _active_links():
    return StreamLink.objects.filter(**_ACTIVE_LINK).exclude(watch_url="")


def _link_for_match(match_id: Any) -> StreamLink | None:
    """Level 1 — the link pinned to this one match."""
    if match_id is None:
        return None
    return _active_links().filter(
        scope=StreamLinkScope.MATCH, match_id=match_id
    ).first()


def _link_for_court_day(court_id: Any, day: _date | None) -> StreamLink | None:
    """Level 2 — the link this court is using for THIS day.

    ``day`` is the local tournament day (see :func:`local_day`), the same key
    :class:`CourtBroadcast` is filed under — a UTC date would hand the evening
    session the next day's link.
    """
    if court_id is None or day is None:
        return None
    return _active_links().filter(
        scope=StreamLinkScope.COURT_DAY, court_id=court_id, day=day
    ).first()


def _link_for_category(tournament_id: Any, leaf_key: str) -> StreamLink | None:
    """Level 4 — the link for this match's competition leaf.

    A blank ``leaf_key`` is the legacy whole-tournament draw, not a category, so
    it never matches (the check constraint forbids a blank-leaf category row).
    """
    if tournament_id is None or not leaf_key:
        return None
    return _active_links().filter(
        scope=StreamLinkScope.CATEGORY,
        tournament_id=tournament_id,
        leaf_key=leaf_key,
    ).first()


def url_from_link(link: StreamLink | None) -> str | None:
    """The hand-pasted URL on a scoped link, or ``None``."""
    if link is None or not link.resolves:
        return None
    return link.watch_url


def url_from_broadcast(broadcast: CourtBroadcast | None) -> str | None:
    """``https://www.youtube.com/watch?v=<id>`` for a broadcast, or ``None``
    when there is no broadcast / it has no video id yet (a ``created`` row
    whose YouTube call has not landed)."""
    if broadcast is None or not broadcast.yt_video_id:
        return None
    return WATCH_URL_TEMPLATE.format(video_id=broadcast.yt_video_id)


def url_from_stream(stream: CourtStream | None) -> str | None:
    """The organiser's hand-pasted URL, or ``None``."""
    if stream is None or not stream.watch_url:
        return None
    return stream.watch_url


def _court_id_of(court: Any) -> Any:
    """Accept a Court instance or a bare id, so callers that already hold only
    ``match.court_id`` do not have to re-fetch the row."""
    if court is None:
        return None
    return getattr(court, "pk", court)


# ------------------------------------------------------------- public API
def watch_url_for_court(
    court: Any, when: datetime | None = None, *, tz: tzinfo | None = None
) -> str | None:
    """The watch URL that applies to ``court`` right now (or at ``when``).

    Precedence levels 2 → 3 → 5 of the module rule: the link pasted for this
    court on this day, else the day's broadcast, else the court's standing
    ``CourtStream``. Levels 1 and 4 need a match in hand, so they cannot apply
    here — a court is not a match and has no category.

    ``tz`` selects the timezone the broadcast *day* is computed in and should be
    the tournament's; it defaults to the active timezone (UTC in this
    deployment's settings). Returns ``None`` — never raises — when the court is
    ``None``, has no link, no stream row and no broadcast for the day.
    """
    court_id = _court_id_of(court)
    if court_id is None:
        return None
    day = local_day(when, tz)
    return (
        url_from_link(_link_for_court_day(court_id, day))
        or url_from_broadcast(_broadcast_for(court_id, day))
        or url_from_stream(_stream_for(court_id))
    )


def watch_url_for_match(match: Any, *, tz: tzinfo | None = None) -> str | None:
    """The watch URL for ONE match — the full six-level precedence rule.

    1 match link → 2 court-day link → 3 the day's broadcast → 4 category link →
    5 the court's ``CourtStream`` → 6 ``None``. See the module docstring for why
    that is the order.

    While the match is live (or still to come) level 3 is simply its court's
    live URL. Once it is ``completed``/``walkover`` **and** the day's broadcast
    carries an ``actual_start_utc`` **and** the match carries a ``started_at``,
    a ``&t=<seconds>`` offset is appended so the link opens at the first serve
    instead of at the top of a nine-hour archive.

    The offset is only ever appended to a URL derived from the day's broadcast:
    a hand-pasted URL may be a ``youtu.be/…`` short link (where the separator
    would have to be ``?t=``) or point at something that is not that day's
    archive at all, so deep-linking it would be wrong.

    A match with **no court** is not disqualified: levels 1 and 4 are pinned to
    the match and to its category, so a link still resolves for a fixture that
    has not been given a court yet. Only the court-scoped levels are skipped.

    Returns ``None`` and never raises when nothing is set at any level, or when
    ``started_at`` / ``actual_start_utc`` is null.
    """
    if match is None:
        return None

    # LEVEL 1 — this match's own link, which beats everything including today's
    # broadcast: it is the most specific thing a human can say.
    url = url_from_link(_link_for_match(getattr(match, "pk", None)))
    if url:
        return url

    court_id = getattr(match, "court_id", None)
    if court_id is not None:
        # A finished match links into ITS OWN day's archive, not today's: on day
        # 3 of a tournament, day 1's results must still deep-link into day 1's
        # video — and day 1's court link, not today's.
        when = getattr(match, "started_at", None) or getattr(
            match, "scheduled_at", None
        )
        day = local_day(when, tz)
        # LEVEL 2 — what a human pasted for this court, this day.
        url = url_from_link(_link_for_court_day(court_id, day))
        if url:
            return url
        # LEVEL 3 — the automation's broadcast for the same court and day.
        broadcast = _broadcast_for(court_id, day)
        url = _apply_offset(match, broadcast, url_from_broadcast(broadcast))
        if url:
            return url

    # LEVEL 4 — one link for the whole competition leaf (e.g. every U15 girls
    # football match streams on the same channel feed).
    url = url_from_link(
        _link_for_category(
            getattr(match, "tournament_id", None),
            getattr(match, "leaf_key", "") or "",
        )
    )
    if url:
        return url

    # LEVEL 5 — the court's standing default.
    return url_from_stream(_stream_for(court_id))


def _apply_offset(
    match: Any, broadcast: CourtBroadcast | None, base: str | None
) -> str | None:
    """Append ``&t=<offset>`` when (and only when) the match is finished, the
    base URL came from the broadcast, and both timestamps exist."""
    if base is None or broadcast is None:
        return base
    if getattr(match, "status", None) not in FINISHED_STATUSES:
        return base
    started_at = getattr(match, "started_at", None)
    if started_at is None or broadcast.actual_start_utc is None:
        return base
    try:
        offset = vod_offset_seconds(started_at, broadcast.actual_start_utc)
    except ValueError:
        # Naive datetime somewhere (should be impossible under USE_TZ=True).
        # A live link with no offset beats a 500 on a public page.
        return base
    return f"{base}&t={offset}"


def is_streaming(
    stream: CourtStream | None,
    broadcast: CourtBroadcast | None,
    link: StreamLink | None = None,
) -> bool:
    """Is this court **on air right now**?

    Deliberately narrower than "has a watch_url": a court with a pasted link
    that the organiser has not switched on, or with a broadcast that is only
    ``created``/``ready``, has a URL you *can* open but is not live. The
    spectator grid uses this to light up the courts actually showing sport.

    ``link`` is the court-day link for the day being asked about, and an enabled
    one counts as on air for exactly the same reason ``stream.enabled`` does: an
    organiser who pasted TODAY's URL for this court and left it switched on has
    said the court is streaming today. (A standing ``CourtStream`` says nothing
    about today, which is why it needs its own toggle.) Optional so existing
    two-argument callers keep their meaning.
    """
    if link is not None and link.resolves:
        return True
    if broadcast is not None and broadcast.lifecycle == BroadcastLifecycle.LIVE:
        return True
    return bool(stream is not None and stream.enabled and stream.watch_url)


# ------------------------------------------------------------ bulk resolver
class CourtLinkResolver:
    """Resolve links for MANY courts/matches in a **bounded** number of queries.

    The public schedule is refetched by every spectator, so it must not issue a
    query per match. Build one resolver for the courts a payload touches — three
    queries total (streams, broadcasts, manual links), independent of how many
    matches or days the tournament has — then ask it per match. It answers the
    same six-level precedence rule as the single-row helpers above, from
    preloaded dictionaries; ``test_resolver_matches_the_single_row_helpers``
    exists to keep the two implementations agreeing.

    Broadcasts and links are loaded for **every** day, not just today, because a
    finished match deep-links into its own day's archive.

    Pass ``tournament`` when the payload is a tournament's (the public
    schedule): the match- and category-scoped levels are keyed by tournament, so
    without it the resolver can only answer levels 2/3/5 and every match will
    silently fall through its own link. One extra query buys all three manual
    levels at once — do NOT split it into three.
    """

    def __init__(
        self,
        courts: Any,
        *,
        when: datetime | None = None,
        tz: tzinfo | None = None,
        tournament: Any = None,
        matches: Any = None,
    ) -> None:
        self.tz = tz
        self.today = local_day(when, tz)
        self.courts = {c.id: c for c in courts}
        ids = list(self.courts)
        # Django short-circuits ``__in []`` without touching the database, so an
        # empty court set costs zero queries.
        self._streams: dict[Any, CourtStream] = {
            s.court_id: s
            for s in CourtStream.objects.filter(
                court_id__in=ids, deleted_at__isnull=True
            )
        }
        self._broadcasts: dict[tuple[Any, _date], CourtBroadcast] = {}
        for b in CourtBroadcast.objects.filter(
            court_id__in=ids, deleted_at__isnull=True
        ).order_by("created_at"):
            self._broadcasts[(b.court_id, b.day)] = b
        self._match_links: dict[Any, StreamLink] = {}
        self._court_day_links: dict[tuple[Any, _date], StreamLink] = {}
        self._category_links: dict[tuple[Any, str], StreamLink] = {}
        self._load_links(ids, tournament, matches)

    def _load_links(self, court_ids: list, tournament: Any, matches: Any) -> None:
        """ONE query for all three manual scopes, ORed together.

        Match links are fetched by joining on the tournament rather than by
        ``id__in`` over the payload's matches: a tournament's schedule can carry
        hundreds of rows, and an IN-list that long is both a slower plan and a
        parameter-count risk. ``matches`` is the fallback for callers that hold
        rows but no tournament.
        """
        tournament_id = getattr(tournament, "pk", tournament)
        clauses = Q()
        if court_ids:
            clauses |= Q(scope=StreamLinkScope.COURT_DAY, court_id__in=court_ids)
        if tournament_id is not None:
            clauses |= Q(
                scope=StreamLinkScope.MATCH, match__tournament_id=tournament_id
            )
            clauses |= Q(
                scope=StreamLinkScope.CATEGORY, tournament_id=tournament_id
            )
        elif matches is not None:
            match_ids = [m.pk for m in matches if getattr(m, "pk", None)]
            if match_ids:
                clauses |= Q(scope=StreamLinkScope.MATCH, match_id__in=match_ids)
        # An empty Q() would filter nothing away and select the whole table, so
        # "nothing to look up" has to short-circuit here, not in the database.
        if not clauses:
            return
        for link in _active_links().filter(clauses).order_by("created_at"):
            if link.scope == StreamLinkScope.MATCH:
                self._match_links[link.match_id] = link
            elif link.scope == StreamLinkScope.COURT_DAY:
                self._court_day_links[(link.court_id, link.day)] = link
            else:
                self._category_links[(link.tournament_id, link.leaf_key)] = link

    # -- per court ----------------------------------------------------------
    def broadcast(self, court_id: Any, day: _date | None = None) -> CourtBroadcast | None:
        return self._broadcasts.get((court_id, day or self.today))

    def stream(self, court_id: Any) -> CourtStream | None:
        return self._streams.get(court_id)

    def court_day_link(self, court_id: Any, day: _date | None = None) -> StreamLink | None:
        return self._court_day_links.get((court_id, day or self.today))

    def watch_url(self, court_id: Any, day: _date | None = None) -> str | None:
        """Levels 2 → 3 → 5, exactly as :func:`watch_url_for_court`."""
        if court_id is None:
            return None
        return (
            url_from_link(self.court_day_link(court_id, day))
            or url_from_broadcast(self.broadcast(court_id, day))
            or url_from_stream(self.stream(court_id))
        )

    def is_streaming(self, court_id: Any) -> bool:
        return is_streaming(
            self.stream(court_id),
            self.broadcast(court_id),
            self.court_day_link(court_id),
        )

    # -- per match ----------------------------------------------------------
    def watch_url_for_match(self, match: Any) -> str | None:
        """The full six-level rule, from the preloaded dictionaries."""
        # LEVEL 1 — the match's own link.
        url = url_from_link(self._match_links.get(getattr(match, "pk", None)))
        if url:
            return url

        court_id = getattr(match, "court_id", None)
        if court_id is not None:
            when = getattr(match, "started_at", None) or getattr(
                match, "scheduled_at", None
            )
            day = local_day(when, self.tz)
            # LEVEL 2 — the court's link for THIS match's day…
            url = url_from_link(self.court_day_link(court_id, day))
            if url:
                return url
            # …LEVEL 3 — else that day's broadcast, deep-linked once finished.
            broadcast = self.broadcast(court_id, day)
            url = _apply_offset(match, broadcast, url_from_broadcast(broadcast))
            if url:
                return url

        # LEVEL 4 — the competition leaf's link.
        url = url_from_link(
            self._category_links.get(
                (
                    getattr(match, "tournament_id", None),
                    getattr(match, "leaf_key", "") or "",
                )
            )
        )
        if url:
            return url

        # LEVEL 5 — the court's standing default.
        return url_from_stream(self.stream(court_id))

    # -- payload ------------------------------------------------------------
    def court_payload(self) -> list[dict]:
        """``[{id, name, watch_url, is_streaming}]`` for the resolver's courts,
        ordered by name so the spectator grid is stable between refetches."""
        return [
            {
                "id": str(c.id),
                "name": c.name,
                "watch_url": self.watch_url(c.id),
                "is_streaming": self.is_streaming(c.id),
            }
            for c in sorted(self.courts.values(), key=lambda c: (c.name, str(c.id)))
        ]


# ----------------------------------------------------------- URL validation
class WatchUrlError(ValueError):
    """A pasted URL we refuse, carrying a machine ``code`` and a human
    ``message`` (the API surfaces both)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(code)
        self.code = code
        self.message = message


#: Explains WHY a channel-level /live URL is rejected. This is the single most
#: likely thing an organiser pastes, and it silently sends spectators to the
#: wrong court, so the message has to teach rather than just refuse.
CHANNEL_LIVE_MESSAGE = _t(
    "That is a channel-level “/live” link, which cannot identify a court. "
    "When more than one court is streaming on the same channel, YouTube "
    "resolves that link to whichever broadcast it likes — spectators aiming "
    "for Court 2 land on Court 5. Open the broadcast you want, then paste "
    "its own video link (youtube.com/watch?v=… or youtu.be/…). Each court "
    "needs its own video link; share the printable court link this page "
    "gives you and we will redirect to the right video."
)

NOT_YOUTUBE_MESSAGE = _t(
    "That does not look like a YouTube video link. Paste the URL of the "
    "broadcast itself — youtube.com/watch?v=…, youtu.be/… or "
    "youtube.com/live/…"
)


def is_channel_live_url(raw: str) -> bool:
    """True for ``youtube.com/@handle/live``, ``/channel/UC…/live``,
    ``/c/Name/live``, ``/user/Name/live`` — the URLs that resolve to "whatever
    this channel happens to be streaming".

    NOT to be confused with ``youtube.com/live/<videoId>``, which addresses one
    specific broadcast and is fine.
    """
    parsed = urlparse(_with_scheme(raw))
    if (parsed.hostname or "").lower() not in _YT_HOSTS:
        return False
    parts = [p for p in parsed.path.split("/") if p]
    # /live/<id> is a video link; anything else ENDING in /live is channel-level.
    if parts[:1] == ["live"]:
        return False
    return len(parts) >= 2 and parts[-1].lower() == "live"


def video_id_from_url(raw: str) -> str | None:
    """The 11-char video id inside a YouTube watch/short/live URL, or ``None``
    if the URL does not address one specific video."""
    parsed = urlparse(_with_scheme(raw))
    host = (parsed.hostname or "").lower()
    parts = [p for p in parsed.path.split("/") if p]
    if host in _YT_SHORT_HOSTS:
        return _valid_id(parts[0]) if parts else None
    if host not in _YT_HOSTS:
        return None
    if parts[:1] == ["watch"]:
        values = parse_qs(parsed.query).get("v") or []
        return _valid_id(values[0]) if values else None
    if len(parts) == 2 and parts[0] in ("live", "embed", "shorts", "v"):
        return _valid_id(parts[1])
    return None


def validate_watch_url(raw: Any) -> str:
    """Normalise + validate an organiser-pasted watch URL.

    Returns the cleaned URL (``""`` clears the binding). Raises
    :class:`WatchUrlError` for a channel-level ``/live`` URL — with the
    explanation above — and for anything that is not a YouTube video link.
    """
    url = str(raw or "").strip()
    if not url:
        return ""
    if len(url) > 500:
        raise WatchUrlError("watch_url_too_long", str(NOT_YOUTUBE_MESSAGE))
    url = _with_scheme(url)
    if is_channel_live_url(url):
        raise WatchUrlError("channel_live_url", str(CHANNEL_LIVE_MESSAGE))
    if video_id_from_url(url) is None:
        raise WatchUrlError("not_a_youtube_video_url", str(NOT_YOUTUBE_MESSAGE))
    return url


def _with_scheme(raw: str) -> str:
    url = str(raw or "").strip()
    if url and not urlparse(url).scheme:
        return f"https://{url}"
    return url


def _valid_id(candidate: str) -> str | None:
    return candidate if _VIDEO_ID_RE.match(candidate or "") else None
