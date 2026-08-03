"""The default httpx-backed transport. Still offline: httpx.MockTransport, no sockets."""
from __future__ import annotations

import json as jsonlib
from collections.abc import Callable
from datetime import UTC, datetime

import httpx
import pytest

from apps.streaming.services.credentials import StaticCredentials
from apps.streaming.services.errors import TransportError
from apps.streaming.services.transport import HttpResponse, HttpTransport, HttpxTransport
from apps.streaming.services.youtube import YouTubeLiveClient

Handler = Callable[[httpx.Request], httpx.Response]


def _mock_client(handler: Handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_httpx_transport_satisfies_the_protocol() -> None:
    transport = HttpxTransport(client=_mock_client(lambda request: httpx.Response(200)))
    assert isinstance(transport, HttpTransport)


def test_httpx_transport_forwards_params_json_and_headers() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = request.content.decode()
        return httpx.Response(200, json={"id": "STREAM1"}, headers={"X-Test": "1"})

    transport = HttpxTransport(client=_mock_client(handler))
    response = transport.request(
        "POST",
        "https://youtube.test/v3/liveStreams",
        params={"part": "snippet"},
        json={"snippet": {"title": "Court 1"}},
        headers={"Authorization": "Bearer tok"},
    )

    assert seen["method"] == "POST"
    assert seen["url"] == "https://youtube.test/v3/liveStreams?part=snippet"
    assert seen["auth"] == "Bearer tok"
    assert jsonlib.loads(str(seen["body"])) == {"snippet": {"title": "Court 1"}}
    assert response.status_code == 200
    assert response.ok is True
    assert response.json() == {"id": "STREAM1"}
    # Header lookup must be case-insensitive for callers -> we lower-case keys.
    assert response.headers["x-test"] == "1"


def test_httpx_transport_form_encodes_data() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.content.decode()
        seen["content_type"] = request.headers.get("content-type", "")
        return httpx.Response(200, json={"access_token": "a"})

    HttpxTransport(client=_mock_client(handler)).request(
        "POST",
        "https://oauth2.googleapis.test/token",
        data={"grant_type": "refresh_token"},
    )

    assert seen["body"] == "grant_type=refresh_token"
    assert "application/x-www-form-urlencoded" in seen["content_type"]


def test_httpx_transport_returns_4xx_rather_than_raising() -> None:
    """The error taxonomy needs the body; the transport must not raise on 4xx."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"code": 403}})

    response = HttpxTransport(client=_mock_client(handler)).request("GET", "https://x.test/")
    assert response.status_code == 403
    assert response.ok is False


def test_network_failure_becomes_a_retryable_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out")

    transport = HttpxTransport(client=_mock_client(handler))
    with pytest.raises(TransportError) as exc:
        transport.request("GET", "https://x.test/")
    assert exc.value.retryable is True
    assert "GET https://x.test/" in str(exc.value)


def test_the_client_runs_end_to_end_over_the_real_httpx_adapter() -> None:
    """Client -> HttpxTransport -> httpx, with only the socket replaced."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["part"] == "snippet,contentDetails,status"
        return httpx.Response(200, json={"id": "VIDEO1", "status": {"lifeCycleStatus": "ready"}})

    api = YouTubeLiveClient(
        credentials=StaticCredentials("tok"),
        transport=HttpxTransport(client=_mock_client(handler)),
        base_url="https://youtube.test/v3",
    )
    broadcast = api.create_broadcast("Court 1", "", datetime(2026, 8, 3, 3, 30, tzinfo=UTC))
    assert broadcast.id == "VIDEO1"
    assert broadcast.lifecycle_status == "ready"


def test_http_response_json_degrades_on_a_non_json_body() -> None:
    assert HttpResponse(502, "<html>Bad Gateway</html>").json() is None
    assert HttpResponse(204, "").json() is None
    assert HttpResponse(200, '{"a": 1}').json() == {"a": 1}
