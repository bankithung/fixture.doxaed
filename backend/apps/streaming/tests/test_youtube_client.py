"""YouTubeLiveClient: URL, ``part``, and request-body assertions. All HTTP mocked.

The two settings most likely to be silently wrong — and most expensive when they
are — get their own explicit identity assertions:
``enableAutoStop is False`` and ``enableAutoStart is True``.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest

from apps.streaming.services.credentials import StaticCredentials
from apps.streaming.services.errors import (
    ConcurrencyLimitError,
    CredentialsExpiredError,
    TransitionStateError,
    YouTubeAPIError,
)
from apps.streaming.services.transport import HttpResponse
from apps.streaming.services.youtube import (
    API_BASE,
    YouTubeLiveClient,
    parse_rfc3339,
)

from .conftest import FakeTransport

pytestmark = pytest.mark.filterwarnings("error::RuntimeWarning")


# ------------------------------------------------------------------ fixtures
def _stream_resource(stream_id: str = "STREAM1") -> dict[str, Any]:
    return {
        "id": stream_id,
        "snippet": {"title": "Court 1"},
        "cdn": {
            "ingestionType": "rtmp",
            "ingestionInfo": {
                "streamName": "abcd-efgh-ijkl-mnop",
                "ingestionAddress": "rtmp://a.rtmp.youtube.com/live2",
                "backupIngestionAddress": "rtmp://b.rtmp.youtube.com/live2?backup=1",
                "rtmpsIngestionAddress": "rtmps://a.rtmps.youtube.com/live2",
                "rtmpsBackupIngestionAddress": "rtmps://b.rtmps.youtube.com/live2?backup=1",
            },
        },
        "contentDetails": {"isReusable": True},
    }


def _broadcast_resource(
    broadcast_id: str = "VIDEO1", status: str = "ready"
) -> dict[str, Any]:
    return {
        "id": broadcast_id,
        "snippet": {
            "title": "Court 1 - Day 1",
            "description": "desc",
            "scheduledStartTime": "2026-08-03T03:30:00Z",
            "actualStartTime": "2026-08-03T03:32:11Z",
            "liveChatId": "CHAT1",
        },
        "status": {"lifeCycleStatus": status, "privacyStatus": "public"},
        "contentDetails": {"boundStreamId": "STREAM1"},
    }


def _video_resource(video_id: str = "VIDEO1") -> dict[str, Any]:
    return {
        "id": video_id,
        "snippet": {
            "title": "Court 1 - Day 1",
            "description": "old description",
            "categoryId": "17",
        },
        "liveStreamingDetails": {
            "actualStartTime": "2026-08-03T03:32:11Z",
            "actualEndTime": "2026-08-03T13:05:00Z",
        },
    }


# --------------------------------------------------------------- create_stream
def test_create_stream_builds_the_right_url_part_and_body(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(_stream_resource())

    stream = client.create_stream("Court 1")

    req = transport.only
    assert req.method == "POST"
    assert req.url == f"{API_BASE}/liveStreams"
    assert req.part == "snippet,cdn,contentDetails"
    assert req.json == {
        "snippet": {"title": "Court 1"},
        "cdn": {
            "ingestionType": "rtmp",
            "resolution": "variable",
            "frameRate": "variable",
        },
        "contentDetails": {"isReusable": True},
    }
    # Created once per court, forever -> the stream must be reusable.
    assert req.json["contentDetails"]["isReusable"] is True

    assert stream.id == "STREAM1"
    assert stream.stream_key == "abcd-efgh-ijkl-mnop"
    assert stream.ingestion_address == "rtmp://a.rtmp.youtube.com/live2"
    assert stream.backup_ingestion_address == "rtmp://b.rtmp.youtube.com/live2?backup=1"
    assert stream.rtmps_ingestion_address == "rtmps://a.rtmps.youtube.com/live2"
    assert stream.is_reusable is True


def test_stream_repr_never_leaks_the_stream_key(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(_stream_resource())
    stream = client.create_stream("Court 1")
    assert "abcd-efgh-ijkl-mnop" not in repr(stream)
    assert stream.rtmp_url() == "rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop"


def test_authorization_header_carries_the_bearer_token(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(_stream_resource())
    client.create_stream("Court 1")
    assert transport.only.headers["Authorization"] == "Bearer test-access-token"


# ------------------------------------------------------------ create_broadcast
def test_create_broadcast_sets_every_required_field(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(_broadcast_resource())
    start = datetime(2026, 8, 3, 3, 30, tzinfo=UTC)

    broadcast = client.create_broadcast("Court 1 - Day 1", "desc", start)

    req = transport.only
    assert req.method == "POST"
    assert req.url == f"{API_BASE}/liveBroadcasts"
    assert req.part == "snippet,contentDetails,status"

    body = req.json
    assert body["snippet"] == {
        "title": "Court 1 - Day 1",
        "description": "desc",
        "scheduledStartTime": "2026-08-03T03:30:00Z",
    }
    assert body["status"] == {"privacyStatus": "public", "selfDeclaredMadeForKids": False}
    assert body["contentDetails"] == {
        "enableAutoStart": True,
        "enableAutoStop": False,
        "recordFromStart": True,
        "enableDvr": True,
        "enableEmbed": True,
        "latencyPreference": "low",
        "monitorStream": {"enableMonitorStream": False},
    }

    # The returned broadcast id IS the YouTube video id.
    assert broadcast.id == "VIDEO1"
    assert broadcast.video_id == "VIDEO1"
    assert broadcast.watch_url == "https://www.youtube.com/watch?v=VIDEO1"
    assert broadcast.embed_url == "https://www.youtube.com/embed/VIDEO1"
    assert broadcast.bound_stream_id == "STREAM1"
    assert broadcast.live_chat_id == "CHAT1"


def test_create_broadcast_autostop_is_false_and_autostart_is_true(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    """The single most expensive pair of booleans in the integration.

    Autostop fires ~1 minute after ingest stops, so a Wi-Fi blip would end a
    court's whole day and there is no un-completing a broadcast. Identity
    assertions (``is False`` / ``is True``) so a truthy 0/1 cannot pass.
    """
    transport.queue_json(_broadcast_resource())
    client.create_broadcast("Court 2", "", datetime(2026, 8, 3, 4, 0, tzinfo=UTC))

    content = transport.only.json["contentDetails"]
    assert content["enableAutoStop"] is False
    assert content["enableAutoStart"] is True
    assert content["monitorStream"]["enableMonitorStream"] is False
    assert transport.only.json["status"]["selfDeclaredMadeForKids"] is False


def test_create_broadcast_rejects_a_naive_datetime(client: YouTubeLiveClient) -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        client.create_broadcast("Court 1", "", datetime(2026, 8, 3, 3, 30))


def test_create_broadcast_converts_a_non_utc_datetime_to_utc(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(_broadcast_resource())
    ist = datetime(2026, 8, 3, 9, 0, tzinfo=UTC) + timedelta(0)
    kolkata = ist.astimezone(_fixed_offset(hours=5, minutes=30))

    client.create_broadcast("Court 1", "", kolkata)

    assert transport.only.json["snippet"]["scheduledStartTime"] == "2026-08-03T09:00:00Z"


def _fixed_offset(*, hours: int, minutes: int) -> timezone:
    return timezone(timedelta(hours=hours, minutes=minutes))


# ------------------------------------------------------------------------ bind
def test_bind_uses_query_params_and_no_body(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(_broadcast_resource())

    client.bind("VIDEO1", "STREAM1")

    req = transport.only
    assert req.method == "POST"
    assert req.url == f"{API_BASE}/liveBroadcasts/bind"
    assert req.part == "id,contentDetails"
    assert req.params["id"] == "VIDEO1"
    assert req.params["streamId"] == "STREAM1"
    assert req.json is None


def test_bind_with_blank_stream_id_omits_streamid_to_unbind(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(_broadcast_resource())
    client.bind("VIDEO1", "")
    assert "streamId" not in transport.only.params


# ------------------------------------------------------------------ transition
@pytest.mark.parametrize("status", ["testing", "live", "complete"])
def test_transition_sends_broadcast_status(
    client: YouTubeLiveClient, transport: FakeTransport, status: str
) -> None:
    transport.queue_json(_broadcast_resource(status=status))

    client.transition("VIDEO1", status)  # type: ignore[arg-type]

    req = transport.only
    assert req.method == "POST"
    assert req.url == f"{API_BASE}/liveBroadcasts/transition"
    assert req.params["broadcastStatus"] == status
    assert req.params["id"] == "VIDEO1"
    assert req.part == "id,snippet,status"


def test_transition_rejects_an_unknown_status_without_calling_the_api(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    with pytest.raises(ValueError, match="invalid broadcastStatus"):
        client.transition("VIDEO1", "ready")  # type: ignore[arg-type]
    assert transport.requests == []


def test_redundant_transition_raises_transition_state_error(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_error(403, "redundantTransition")
    with pytest.raises(TransitionStateError) as exc:
        client.transition("VIDEO1", "live")
    assert exc.value.reason == "redundantTransition"
    assert exc.value.retryable is False


# -------------------------------------------------------------------- batching
def test_list_broadcasts_batches_six_ids_into_one_request(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    """Six courts must cost ONE request (~1 quota unit), not six."""
    ids = [f"VID{n}" for n in range(1, 7)]
    transport.queue_json({"items": [_broadcast_resource(i) for i in ids]})

    result = client.list_broadcasts(ids)

    assert len(transport.requests) == 1, "batching regressed: one request per id"
    req = transport.only
    assert req.method == "GET"
    assert req.url == f"{API_BASE}/liveBroadcasts"
    assert req.part == "id,status,snippet"
    assert req.params["id"] == "VID1,VID2,VID3,VID4,VID5,VID6"
    assert req.ids == ids
    # maxResults must not accompany an id filter.
    assert "maxResults" not in req.params
    assert [b.id for b in result] == ids


def test_list_broadcasts_dedupes_and_drops_blanks(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json({"items": []})
    client.list_broadcasts(["A", "B", "A", "", "C"])
    assert transport.only.params["id"] == "A,B,C"


def test_list_broadcasts_chunks_beyond_fifty_ids(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    ids = [f"V{n:03d}" for n in range(120)]
    transport.queue_json({"items": []})

    client.list_broadcasts(ids)

    assert len(transport.requests) == 3  # 50 + 50 + 20
    assert len(transport.requests[0].ids) == 50
    assert len(transport.requests[2].ids) == 20


def test_list_broadcasts_with_no_ids_makes_no_request(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    assert client.list_broadcasts([]) == []
    assert transport.requests == []


def test_get_stream_details_batches_and_parses(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    ids = [f"VID{n}" for n in range(1, 7)]
    transport.queue_json({"items": [_video_resource(i) for i in ids]})

    details = client.get_stream_details(ids)

    assert len(transport.requests) == 1
    req = transport.only
    assert req.url == f"{API_BASE}/videos"
    assert req.part == "snippet,liveStreamingDetails"
    assert req.params["id"] == ",".join(ids)

    first = details[0]
    assert first.video_id == "VID1"
    assert first.title == "Court 1 - Day 1"
    assert first.category_id == "17"
    assert first.actual_start_time == datetime(2026, 8, 3, 3, 32, 11, tzinfo=UTC)
    assert first.actual_end_time == datetime(2026, 8, 3, 13, 5, 0, tzinfo=UTC)


def test_list_broadcasts_tolerates_missing_ids_in_the_response(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json({"items": [_broadcast_resource("VID1")]})
    result = client.list_broadcasts(["VID1", "GONE"])
    assert [b.id for b in result] == ["VID1"]


# ------------------------------------------------------------ list_active_mine
def test_list_active_mine_filters_active_all_types_and_mine(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json({"items": [_broadcast_resource("VID1", status="live")]})

    client.list_active_mine()

    params = transport.only.params
    assert params["broadcastStatus"] == "active"
    assert params["mine"] == "true"
    # 'all' so a persistent "Stream now" broadcast is counted too.
    assert params["broadcastType"] == "all"
    assert params["part"] == "id,status,snippet"


def test_list_active_mine_follows_pagination(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(
        {"items": [_broadcast_resource("VID1")], "nextPageToken": "PAGE2"}
    ).queue_json({"items": [_broadcast_resource("VID2")]})

    result = client.list_active_mine()

    assert [b.id for b in result] == ["VID1", "VID2"]
    assert transport.requests[1].params["pageToken"] == "PAGE2"


# -------------------------------------------------------------- check_headroom
def test_check_headroom_returns_remaining_slots(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json({"items": [_broadcast_resource(f"V{n}") for n in range(4)]})
    assert client.check_headroom() == 10 - 1 - 4  # max 10, reserve 1, 4 active


def test_check_headroom_refuses_at_the_limit(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    """9 active with max=10/reserve=1 -> refuse BEFORE YouTube does."""
    transport.queue_json({"items": [_broadcast_resource(f"V{n}") for n in range(9)]})
    with pytest.raises(ConcurrencyLimitError) as exc:
        client.check_headroom()
    assert exc.value.retryable is False
    assert "9 active" in str(exc.value)


def test_check_headroom_allows_the_slot_just_below_the_limit(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json({"items": [_broadcast_resource(f"V{n}") for n in range(8)]})
    assert client.check_headroom() == 1


def test_check_headroom_honours_a_custom_reserve(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json({"items": [_broadcast_resource(f"V{n}") for n in range(8)]})
    with pytest.raises(ConcurrencyLimitError):
        client.check_headroom(max_concurrent=10, reserve=2)


# ----------------------------------------------------------- update_description
def test_update_description_is_a_full_snippet_replacement(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queue_json(_video_resource())

    client.update_description("VIDEO1", "00:00 Warm-up\n5:00 Match 1", "Court 1 - Day 1", "17")

    req = transport.only
    assert req.method == "PUT"
    assert req.url == f"{API_BASE}/videos"
    assert req.part == "snippet"
    # title and categoryId MUST be re-sent or YouTube wipes them.
    assert req.json == {
        "id": "VIDEO1",
        "snippet": {
            "title": "Court 1 - Day 1",
            "description": "00:00 Warm-up\n5:00 Match 1",
            "categoryId": "17",
        },
    }


@pytest.mark.parametrize(
    ("title", "category_id", "match"),
    [("", "17", "blank title"), ("Court 1", "", "blank categoryId")],
)
def test_update_description_refuses_to_wipe_title_or_category(
    client: YouTubeLiveClient,
    transport: FakeTransport,
    title: str,
    category_id: str,
    match: str,
) -> None:
    with pytest.raises(ValueError, match=match):
        client.update_description("VIDEO1", "desc", title, category_id)
    assert transport.requests == []


# ------------------------------------------------------------------ auth retry
class _CountingCredentials:
    def __init__(self) -> None:
        self.calls: list[bool] = []

    def access_token(self, *, force_refresh: bool = False) -> str:
        self.calls.append(force_refresh)
        return "token-2" if force_refresh else "token-1"


def test_a_401_triggers_exactly_one_forced_refresh_and_a_replay() -> None:
    creds = _CountingCredentials()
    transport = FakeTransport()
    transport.queued.append(HttpResponse(401, '{"error": {"code": 401}}'))
    transport.queue_json(_stream_resource())
    api = YouTubeLiveClient(credentials=creds, transport=transport)

    stream = api.create_stream("Court 1")

    assert stream.id == "STREAM1"
    assert creds.calls == [False, True]
    assert len(transport.requests) == 2
    assert transport.requests[0].headers["Authorization"] == "Bearer token-1"
    assert transport.requests[1].headers["Authorization"] == "Bearer token-2"


def test_a_second_401_is_raised_rather_than_looping() -> None:
    creds = _CountingCredentials()
    transport = FakeTransport(
        [HttpResponse(401, '{"error": {"errors": [{"reason": "authError"}]}}')]
    )
    api = YouTubeLiveClient(credentials=creds, transport=transport)

    with pytest.raises(CredentialsExpiredError):
        api.create_stream("Court 1")
    assert len(transport.requests) == 2


# --------------------------------------------------------------- misc parsing
def test_non_object_json_body_raises_youtube_api_error(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queued.append(HttpResponse(200, "[1, 2, 3]"))
    with pytest.raises(YouTubeAPIError, match="expected a JSON object"):
        client.create_stream("Court 1")


def test_empty_body_on_success_yields_empty_dataclass(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    transport.queued.append(HttpResponse(204, ""))
    stream = client.create_stream("Court 1")
    assert stream.id == ""


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2026-08-03T03:32:11Z", datetime(2026, 8, 3, 3, 32, 11, tzinfo=UTC)),
        ("2026-08-03T03:32:11.500Z", datetime(2026, 8, 3, 3, 32, 11, 500000, tzinfo=UTC)),
        ("2026-08-03T09:02:11+05:30", datetime(2026, 8, 3, 3, 32, 11, tzinfo=UTC)),
        ("", None),
        ("not a date", None),
        (None, None),
    ],
)
def test_parse_rfc3339(raw: object, expected: datetime | None) -> None:
    assert parse_rfc3339(raw) == expected


def test_base_url_is_injectable_for_a_test_double(transport: FakeTransport) -> None:
    api = YouTubeLiveClient(
        credentials=StaticCredentials("t"),
        transport=transport,
        base_url="https://youtube.test/v3/",
    )
    transport.queue_json(_stream_resource())
    api.create_stream("Court 1")
    assert transport.only.url == "https://youtube.test/v3/liveStreams"
