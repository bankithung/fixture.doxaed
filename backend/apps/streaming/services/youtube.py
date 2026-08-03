"""YouTube Data API v3 live-streaming client.

Pure and injectable: it takes plain values (ids, strings, aware datetimes) and
returns plain dataclasses. It imports **no project model**. Both the credentials
provider and the HTTP transport are constructor arguments, so tests substitute
each and never reach the network.

The shape of a court's day
--------------------------
``liveStream``    — created **once per court, forever** (``isReusable: true``).
                    Its ``streamName`` is the RTMP key that gets typed into the
                    court's encoder on day one and never changes.
``liveBroadcast`` — one per session (typically one per court per day, plus a
                    "Session 2" after the 11-hour rollover). Bound to the court's
                    reusable stream. The broadcast's ``id`` **is** the YouTube
                    video id, so the VOD link is known before a ball is served.

Quota
-----
The daily budget is 10,000 units. **Google does not publish per-method costs for
the live-streaming methods** — they are absent from the official cost table, so
the numbers below are *inferred* from the general Data API convention and from
observed consumption, not quoted:

    read  (``list``)                       ~1 unit    [INFERRED]
    write (``insert``/``update``/``bind``/
           ``transition``)                 ~50 units  [INFERRED]

Do not treat those as documented fact; treat them as the planning assumption.
The practical consequence is the reason ``list_broadcasts`` takes MANY ids:
one batched poll costs ~1 unit for every court at once instead of ~1 unit per
court. Across a 12-court day polled every 30s that is roughly a third of the
whole daily budget saved.

Documented hard limits (these ARE published):
    * 10 active broadcasts per channel  -> see :func:`YouTubeLiveClient.check_headroom`
    * 3 concurrent broadcasts per stream key
"""
from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final, Literal

from .credentials import CredentialsProvider
from .errors import ConcurrencyLimitError, YouTubeAPIError, error_from_payload
from .transport import HttpTransport

logger = logging.getLogger(__name__)

API_BASE: Final = "https://www.googleapis.com/youtube/v3"

#: YouTube's published ceiling: 10 simultaneously *active* broadcasts / channel.
MAX_CONCURRENT_BROADCASTS: Final = 10

#: YouTube's published ceiling: 3 simultaneous broadcasts bound to one stream key.
#: We never approach it (one court = one key = one live broadcast), but a
#: forgotten "Session 1" left active during a rollover is exactly how you would.
MAX_BROADCASTS_PER_STREAM_KEY: Final = 3

#: The Data API caps an ``id`` filter at 50 values per request; longer id lists
#: are chunked. Six courts is one request, which is the point.
MAX_IDS_PER_REQUEST: Final = 50

#: Safety valve on ``list_active_mine`` paging (10 active max => 1 page, ever).
_MAX_PAGES: Final = 10

BroadcastStatus = Literal["testing", "live", "complete"]
_VALID_TRANSITIONS: Final[frozenset[str]] = frozenset({"testing", "live", "complete"})


# --------------------------------------------------------------------- models
@dataclass(frozen=True, slots=True)
class Stream:
    """A reusable RTMP ingestion endpoint — one per court, created once, forever.

    ``stream_key`` is ``cdn.ingestionInfo.streamName``: the secret typed into the
    court encoder. Treat it like a password (never log it, never put it in an
    API response a spectator can reach).
    """

    id: str
    stream_key: str
    ingestion_address: str
    backup_ingestion_address: str
    title: str = ""
    rtmps_ingestion_address: str = ""
    rtmps_backup_ingestion_address: str = ""
    is_reusable: bool = True

    def rtmp_url(self) -> str:
        """Full push URL for encoders that want one string instead of two fields."""
        return f"{self.ingestion_address.rstrip('/')}/{self.stream_key}"

    def __repr__(self) -> str:
        # Never let a stream key reach a log line or a traceback.
        return f"Stream(id={self.id!r}, title={self.title!r}, stream_key='***')"


@dataclass(frozen=True, slots=True)
class Broadcast:
    """A single live session.

    ``id`` **is** the YouTube video id — the watch URL is known at creation time,
    before the broadcast has ever gone live.
    """

    id: str
    title: str = ""
    description: str = ""
    lifecycle_status: str = ""
    privacy_status: str = ""
    scheduled_start_utc: datetime | None = None
    actual_start_utc: datetime | None = None
    actual_end_utc: datetime | None = None
    bound_stream_id: str | None = None
    live_chat_id: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @property
    def video_id(self) -> str:
        """Alias for :attr:`id` — the broadcast id and the video id are the same."""
        return self.id

    @property
    def watch_url(self) -> str:
        return f"https://www.youtube.com/watch?v={self.id}"

    @property
    def embed_url(self) -> str:
        return f"https://www.youtube.com/embed/{self.id}"


@dataclass(frozen=True, slots=True)
class VideoDetails:
    """``videos.list`` projection: what the VOD post-processing step needs."""

    video_id: str
    title: str = ""
    description: str = ""
    category_id: str = ""
    actual_start_time: datetime | None = None
    actual_end_time: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)


# --------------------------------------------------------------------- client
class YouTubeLiveClient:
    """Thin, typed wrapper over the nine Data API v3 calls this platform needs.

    :param credentials: anything with ``access_token(*, force_refresh=False)``
        (see :class:`~apps.streaming.services.credentials.RefreshTokenCredentials`).
    :param transport: anything implementing
        :class:`~apps.streaming.services.transport.HttpTransport`.
    """

    __slots__ = ("_base_url", "_credentials", "_timeout", "_transport")

    def __init__(
        self,
        *,
        credentials: CredentialsProvider,
        transport: HttpTransport,
        base_url: str = API_BASE,
        timeout: float = 30.0,
    ) -> None:
        self._credentials = credentials
        self._transport = transport
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    # ------------------------------------------------------------- liveStreams
    def create_stream(self, title: str) -> Stream:
        """``liveStreams.insert`` — create the court's permanent ingestion point.

        Called **once per court, forever**: ``contentDetails.isReusable = true``
        means the same stream key can back a new broadcast every day (and after
        every session rollover), so the encoder configuration never changes.
        Re-running this for a court that already has one leaks stream objects and
        forces a physical re-configuration of the encoder — don't.

        ``cdn.resolution`` / ``cdn.frameRate`` are ``"variable"`` so the phone or
        laptop on the court dictates the format; pinning them makes an encoder
        mismatch fail the ingest instead of just looking worse.
        """
        body: dict[str, Any] = {
            "snippet": {"title": title},
            "cdn": {
                "ingestionType": "rtmp",
                "resolution": "variable",
                "frameRate": "variable",
            },
            "contentDetails": {"isReusable": True},
        }
        payload = self._request(
            "POST",
            "liveStreams",
            params={"part": "snippet,cdn,contentDetails"},
            body=body,
        )
        return _parse_stream(payload)

    def get_streams(self, stream_ids: Sequence[str]) -> list[Stream]:
        """``liveStreams.list`` — batched. Mostly for verifying a saved key still exists."""
        out: list[Stream] = []
        for chunk in _chunks(_dedupe(stream_ids), MAX_IDS_PER_REQUEST):
            payload = self._request(
                "GET",
                "liveStreams",
                params={"part": "id,snippet,cdn,contentDetails,status", "id": ",".join(chunk)},
            )
            out.extend(_parse_stream(item) for item in _items(payload))
        return out

    # ---------------------------------------------------------- liveBroadcasts
    def create_broadcast(
        self,
        title: str,
        description: str,
        scheduled_start_utc: datetime,
    ) -> Broadcast:
        """``liveBroadcasts.insert`` — one session on one court.

        The returned :attr:`Broadcast.id` **is the YouTube video id**, so the
        public link exists before the first serve.

        Settings that are NOT negotiable, and why:

        ``contentDetails.enableAutoStart = True``
            The court's phone starts pushing and the broadcast goes live by
            itself. Nobody at a school tournament is going to press "Go live"
            twelve times.

        ``contentDetails.enableAutoStop = False``   **<-- critical**
            YouTube's autostop fires roughly **one minute after ingest stops**.
            A Wi-Fi blip, a phone that briefly backgrounds the encoder, a
            battery swap between matches — any of those would *permanently end
            that court's broadcast for the whole day*, and there is no
            un-completing a broadcast. We stop broadcasts explicitly via
            :meth:`transition`; we never let YouTube guess.

        ``status.privacyStatus = "public"`` / ``selfDeclaredMadeForKids = False``
            Public so a parent with a link can watch. ``madeForKids`` must be
            declared explicitly or YouTube may block comments/live chat and
            personalised features; school sport is not "made for kids" content
            in COPPA's sense (declare it deliberately, do not leave it unset).

        ``recordFromStart = True`` / ``enableDvr = True``
            The archive is the actual deliverable — the VOD link with a
            per-match timestamp. Without ``recordFromStart`` there is nothing
            to link to afterwards.

        .. warning::
           ``enableDvr``, ``enableEmbed`` and ``latencyPreference`` can only be
           **set while the broadcast is in the ``created`` or ``ready``
           lifecycle state**. Once it is ``testing``/``live`` the API silently
           ignores them (or errors), so they must be right in this insert call —
           there is no later fix-up.

        ``monitorStream.enableMonitorStream = False``
            The monitor stream adds a preview pipeline and forces an explicit
            ``testing -> live`` step; with autostart we want ingest to go
            straight to air.

        :param scheduled_start_utc: an **aware** datetime; converted to UTC and
            sent as RFC 3339. Naive datetimes raise ``ValueError`` rather than
            quietly scheduling in the wrong timezone (invariant 14: UTC storage).
        """
        body: dict[str, Any] = {
            "snippet": {
                "title": title,
                "description": description,
                "scheduledStartTime": _rfc3339(scheduled_start_utc),
            },
            "status": {
                "privacyStatus": "public",
                "selfDeclaredMadeForKids": False,
            },
            "contentDetails": {
                "enableAutoStart": True,
                # See the docstring. This False is load-bearing.
                "enableAutoStop": False,
                "recordFromStart": True,
                "enableDvr": True,
                "enableEmbed": True,
                "latencyPreference": "low",
                "monitorStream": {"enableMonitorStream": False},
            },
        }
        payload = self._request(
            "POST",
            "liveBroadcasts",
            params={"part": "snippet,contentDetails,status"},
            body=body,
        )
        return _parse_broadcast(payload)

    def bind(self, broadcast_id: str, stream_id: str) -> Broadcast:
        """``liveBroadcasts.bind`` — attach a court's reusable stream to a session.

        Parameters go in the query string; there is no request body. Pass
        ``stream_id=""`` to *unbind* (YouTube treats an absent ``streamId`` as
        "detach"), which is what a session rollover does before rebinding the
        same stream to Session 2.
        """
        params = {"part": "id,contentDetails", "id": broadcast_id}
        if stream_id:
            params["streamId"] = stream_id
        payload = self._request("POST", "liveBroadcasts/bind", params=params)
        return _parse_broadcast(payload)

    def transition(self, broadcast_id: str, status: BroadcastStatus) -> Broadcast:
        """``liveBroadcasts.transition`` — drive the lifecycle explicitly.

        ``testing`` -> ``live`` -> ``complete``. With ``enableAutoStart`` the
        ``live`` transition usually happens by itself; we still need ``complete``
        because :meth:`create_broadcast` deliberately disables autostop.

        A rejected transition raises
        :class:`~apps.streaming.services.errors.TransitionStateError` —
        **re-list the broadcast and reconcile, never blind-retry** (see that
        class's docstring).

        ``part=id,snippet,status`` costs the same as ``part=id`` on a write, so
        we ask for enough to return a populated :class:`Broadcast`.
        """
        if status not in _VALID_TRANSITIONS:
            raise ValueError(
                f"invalid broadcastStatus {status!r}; expected one of "
                f"{sorted(_VALID_TRANSITIONS)}"
            )
        payload = self._request(
            "POST",
            "liveBroadcasts/transition",
            params={
                "part": "id,snippet,status",
                "id": broadcast_id,
                "broadcastStatus": status,
            },
        )
        return _parse_broadcast(payload)

    def list_broadcasts(self, ids: Sequence[str]) -> list[Broadcast]:
        """``liveBroadcasts.list`` — poll MANY broadcasts in ONE request.

        The ``id`` filter is comma-separated, so every court on the site is one
        request and (inferred) one quota unit, not one per court. At a 30s poll
        across a 12-court day that is worth roughly a third of the daily budget;
        looping this method per court is the single easiest way to run the
        platform out of quota by mid-afternoon.

        Id lists longer than :data:`MAX_IDS_PER_REQUEST` (50) are chunked.
        ``maxResults`` is deliberately NOT sent: the Data API rejects it
        alongside an ``id`` filter on some resources, and it is meaningless when
        you have named the exact rows you want.

        Ids that do not exist are simply absent from the result — the caller
        must not assume ``len(result) == len(ids)``.
        """
        out: list[Broadcast] = []
        for chunk in _chunks(_dedupe(ids), MAX_IDS_PER_REQUEST):
            payload = self._request(
                "GET",
                "liveBroadcasts",
                params={"part": "id,status,snippet", "id": ",".join(chunk)},
            )
            out.extend(_parse_broadcast(item) for item in _items(payload))
        return out

    def list_active_mine(self) -> list[Broadcast]:
        """``liveBroadcasts.list`` with ``broadcastStatus=active&mine=true``.

        The input to the concurrency guard. ``broadcastType=all`` is important:
        the default (``event``) hides the channel's *persistent* "Stream now"
        broadcast, which still counts against the 10-active ceiling — undercount
        it and :meth:`check_headroom` cheerfully authorises the create that then
        fails with ``concurrentBroadcastsExceedLimit``.
        """
        out: list[Broadcast] = []
        page_token: str | None = None
        for _ in range(_MAX_PAGES):
            params = {
                "part": "id,status,snippet",
                "broadcastStatus": "active",
                "broadcastType": "all",
                "mine": "true",
                "maxResults": "50",
            }
            if page_token:
                params["pageToken"] = page_token
            payload = self._request("GET", "liveBroadcasts", params=params)
            out.extend(_parse_broadcast(item) for item in _items(payload))
            token = payload.get("nextPageToken")
            if not isinstance(token, str) or not token:
                break
            page_token = token
        return out

    def check_headroom(
        self,
        max_concurrent: int = MAX_CONCURRENT_BROADCASTS,
        reserve: int = 1,
    ) -> int:
        """How many more broadcasts may be created right now. Call before creating.

        YouTube allows **10 active broadcasts per channel** (and 3 per stream
        key). Hitting the ceiling does not fail gracefully: the create errors,
        and a court that was about to start simply has no stream. So we keep a
        ``reserve`` (default 1) in hand for an emergency/rollover session and
        refuse before YouTube does.

        :returns: remaining slots, always ``>= 1`` on success.
        :raises ConcurrencyLimitError: when ``active >= max_concurrent - reserve``.
            Do not retry — alert, and wait for a court to finish.
        """
        active = len(self.list_active_mine())
        headroom = max_concurrent - reserve - active
        if headroom <= 0:
            raise ConcurrencyLimitError(
                f"Channel is at its live-broadcast ceiling: {active} active, "
                f"limit {max_concurrent} with {reserve} reserved. "
                "Complete a finished court's broadcast before starting another.",
                reason="concurrentBroadcastsExceedLimit",
            )
        return headroom

    # ------------------------------------------------------------------ videos
    def get_stream_details(self, video_ids: Sequence[str]) -> list[VideoDetails]:
        """``videos.list`` (``part=snippet,liveStreamingDetails``) — batched.

        ``liveStreamingDetails.actualStartTime`` is the anchor for every VOD
        deep-link: a match's offset into the archive is
        ``match_started_at - actual_start_time`` (see
        :func:`apps.streaming.services.planning.vod_offset_seconds`).

        We also return ``title`` and ``category_id`` because
        :meth:`update_description` cannot be called safely without them.
        """
        out: list[VideoDetails] = []
        for chunk in _chunks(_dedupe(video_ids), MAX_IDS_PER_REQUEST):
            payload = self._request(
                "GET",
                "videos",
                params={"part": "snippet,liveStreamingDetails", "id": ",".join(chunk)},
            )
            out.extend(_parse_video(item) for item in _items(payload))
        return out

    def update_description(
        self,
        video_id: str,
        description: str,
        title: str,
        category_id: str,
    ) -> VideoDetails:
        """``videos.update`` (``part=snippet``) — write the chapter list onto the VOD.

        .. danger::
           **This is a FULL REPLACEMENT of the snippet, not a patch.**
           ``videos.update`` overwrites every mutable field in the parts you
           name. Send ``description`` alone and YouTube will **wipe the video's
           title and reset its category** — the archive of an entire day's play
           ends up named "" in the channel. There is no PATCH semantics on this
           endpoint and no undo.

           That is why ``title`` and ``category_id`` are **required positional
           parameters** rather than optional keywords: the signature makes it
           impossible to call this without having read the current values back
           from :meth:`get_stream_details` first. Round-trip them; do not invent
           them.

        :returns: the updated video. Only ``snippet`` was requested, so
            ``actual_start_time``/``actual_end_time`` on the result are ``None``
            — that is the response shape, not a missing timestamp.
        """
        if not title:
            raise ValueError(
                "videos.update replaces the whole snippet; a blank title would "
                "erase the video's name. Read the current title with "
                "get_stream_details() and pass it through."
            )
        if not category_id:
            raise ValueError(
                "videos.update replaces the whole snippet; a blank categoryId "
                "would reset the video's category. Read it with "
                "get_stream_details() and pass it through."
            )
        body: dict[str, Any] = {
            "id": video_id,
            "snippet": {
                "title": title,
                "description": description,
                "categoryId": category_id,
            },
        }
        payload = self._request("PUT", "videos", params={"part": "snippet"}, body=body)
        return _parse_video(payload)

    # ----------------------------------------------------------------- private
    def _request(
        self,
        method: str,
        resource: str,
        *,
        params: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """One authenticated call, with a single forced-refresh retry on 401.

        A 401 means the access token was rejected (expired early, revoked
        session, clock skew). We refresh once and replay; a second 401 is a real
        credentials problem and is raised, so we can never spin on auth.
        """
        url = f"{self._base_url}/{resource}"

        for attempt in range(2):
            token = self._credentials.access_token(force_refresh=attempt > 0)
            response = self._transport.request(
                method,
                url,
                params=params,
                json=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                },
                timeout=self._timeout,
            )
            if response.status_code == 401 and attempt == 0:
                logger.info("YouTube returned 401 for %s %s; refreshing token", method, resource)
                continue

            decoded = response.json()
            if not response.ok:
                raise error_from_payload(
                    decoded,
                    status_code=response.status_code,
                    context=f"{method} {resource}",
                )
            if decoded is None:
                return {}
            if not isinstance(decoded, dict):
                raise YouTubeAPIError(
                    f"{method} {resource}: expected a JSON object, got "
                    f"{type(decoded).__name__}",
                    status_code=response.status_code,
                )
            return decoded

        # Unreachable: the loop either returns or raises on its second pass.
        raise YouTubeAPIError(f"{method} {resource}: exhausted auth retries")


# -------------------------------------------------------------------- parsing
def _items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    items = payload.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _sub(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


def _str(source: dict[str, Any], key: str, default: str = "") -> str:
    value = source.get(key)
    return value if isinstance(value, str) else default


def _parse_stream(item: dict[str, Any]) -> Stream:
    cdn = _sub(item, "cdn")
    ingestion = _sub(cdn, "ingestionInfo")
    content = _sub(item, "contentDetails")
    return Stream(
        id=_str(item, "id"),
        stream_key=_str(ingestion, "streamName"),
        ingestion_address=_str(ingestion, "ingestionAddress"),
        backup_ingestion_address=_str(ingestion, "backupIngestionAddress"),
        title=_str(_sub(item, "snippet"), "title"),
        rtmps_ingestion_address=_str(ingestion, "rtmpsIngestionAddress"),
        rtmps_backup_ingestion_address=_str(ingestion, "rtmpsBackupIngestionAddress"),
        is_reusable=bool(content.get("isReusable", True)),
    )


def _parse_broadcast(item: dict[str, Any]) -> Broadcast:
    snippet = _sub(item, "snippet")
    status = _sub(item, "status")
    content = _sub(item, "contentDetails")
    bound = content.get("boundStreamId")
    chat = snippet.get("liveChatId")
    return Broadcast(
        id=_str(item, "id"),
        title=_str(snippet, "title"),
        description=_str(snippet, "description"),
        lifecycle_status=_str(status, "lifeCycleStatus"),
        privacy_status=_str(status, "privacyStatus"),
        scheduled_start_utc=parse_rfc3339(snippet.get("scheduledStartTime")),
        actual_start_utc=parse_rfc3339(snippet.get("actualStartTime")),
        actual_end_utc=parse_rfc3339(snippet.get("actualEndTime")),
        bound_stream_id=bound if isinstance(bound, str) and bound else None,
        live_chat_id=chat if isinstance(chat, str) and chat else None,
        raw=item,
    )


def _parse_video(item: dict[str, Any]) -> VideoDetails:
    snippet = _sub(item, "snippet")
    live = _sub(item, "liveStreamingDetails")
    return VideoDetails(
        video_id=_str(item, "id"),
        title=_str(snippet, "title"),
        description=_str(snippet, "description"),
        category_id=_str(snippet, "categoryId"),
        actual_start_time=parse_rfc3339(live.get("actualStartTime")),
        actual_end_time=parse_rfc3339(live.get("actualEndTime")),
        raw=item,
    )


# --------------------------------------------------------------------- helpers
def parse_rfc3339(value: Any) -> datetime | None:
    """Parse Google's RFC 3339 timestamps to aware UTC datetimes.

    Returns ``None`` for absent/blank/unparseable values — a missing
    ``actualStartTime`` just means the broadcast has not started yet, which is a
    normal poll result, not an error.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        logger.warning("Unparseable YouTube timestamp %r", text)
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _rfc3339(value: datetime) -> str:
    """Aware datetime -> ``2026-08-03T09:30:00Z``.

    Naive datetimes are rejected: the platform stores UTC (invariant 14), and a
    silently-assumed timezone here would schedule a court's broadcast hours off.
    """
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise ValueError(
            "scheduled_start_utc must be timezone-aware; got a naive datetime "
            f"({value!r}). Use django.utils.timezone.now() or attach UTC."
        )
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _dedupe(values: Iterable[str]) -> list[str]:
    """Order-preserving de-duplication, dropping blanks."""
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def _chunks(values: Sequence[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(values), size):
        yield list(values[start : start + size])
