"""Every Google error reason maps to the typed exception the caller branches on."""
from __future__ import annotations

from typing import Any

import pytest

from apps.streaming.services.errors import (
    ChannelNotEligibleError,
    ConcurrencyLimitError,
    CredentialsExpiredError,
    EncoderOfflineError,
    QuotaError,
    TransitionStateError,
    YouTubeAPIError,
    YouTubeError,
    error_from_payload,
    extract_message,
    extract_reason,
)
from apps.streaming.services.youtube import YouTubeLiveClient

from .conftest import FakeTransport


def _payload(reason: str, code: int = 403, message: str = "nope") -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "errors": [{"domain": "youtube.liveBroadcast", "reason": reason}],
        }
    }


@pytest.mark.parametrize(
    ("reason", "expected", "retryable"),
    [
        ("concurrentBroadcastsExceedLimit", ConcurrencyLimitError, False),
        ("errorStreamInactive", EncoderOfflineError, True),
        ("invalidTransition", TransitionStateError, False),
        ("redundantTransition", TransitionStateError, False),
        ("liveStreamingNotEnabled", ChannelNotEligibleError, False),
        ("livePermissionBlocked", ChannelNotEligibleError, False),
        ("userRequestsExceedRateLimit", QuotaError, True),
        ("quotaExceeded", QuotaError, True),
        ("invalid_grant", CredentialsExpiredError, False),
    ],
)
def test_each_reason_maps_to_its_typed_exception(
    reason: str, expected: type[YouTubeError], retryable: bool
) -> None:
    error = error_from_payload(_payload(reason), status_code=403)
    assert type(error) is expected
    assert error.reason == reason
    assert error.status_code == 403
    assert error.retryable is retryable
    assert isinstance(error, YouTubeError)


def test_unknown_reason_falls_back_and_carries_the_raw_reason() -> None:
    error = error_from_payload(_payload("someBrandNewReason"), status_code=400)
    assert type(error) is YouTubeAPIError
    assert error.reason == "someBrandNewReason"
    assert error.payload["error"]["code"] == 403


def test_missing_reason_still_produces_a_typed_error() -> None:
    payload = {"error": {"code": 500, "message": "backend error"}}
    error = error_from_payload(payload, status_code=500)
    assert type(error) is YouTubeAPIError
    assert error.reason is None
    assert "backend error" in str(error)


def test_oauth_flat_error_shape_is_understood() -> None:
    payload = {"error": "invalid_grant", "error_description": "Token has been expired or revoked."}
    error = error_from_payload(payload, status_code=400, context="OAuth token refresh failed")
    assert type(error) is CredentialsExpiredError
    assert error.reason == "invalid_grant"
    assert "OAuth token refresh failed" in str(error)
    assert "expired or revoked" in str(error)


def test_newer_details_shape_is_understood() -> None:
    payload = {"error": {"code": 403, "details": [{"reason": "quotaExceeded"}]}}
    assert type(error_from_payload(payload)) is QuotaError


def test_undecodable_body_degrades_to_a_generic_error() -> None:
    error = error_from_payload("<html>502 Bad Gateway</html>", status_code=502)
    assert type(error) is YouTubeAPIError
    assert error.reason is None
    assert error.payload == {"raw": "<html>502 Bad Gateway</html>"}


def test_str_includes_reason_and_status_for_logs() -> None:
    error = error_from_payload(_payload("errorStreamInactive"), status_code=403)
    rendered = str(error)
    assert "reason=errorStreamInactive" in rendered
    assert "http=403" in rendered


def test_extract_helpers_are_null_safe() -> None:
    assert extract_reason(None) is None
    assert extract_reason({"error": {}}) is None
    assert extract_reason({"error": {"errors": ["junk"]}}) is None
    assert extract_message(None) == ""
    assert extract_message({"error": {"errors": [{"message": "inner"}]}}) == "inner"


def test_context_prefix_names_the_failing_call() -> None:
    error = error_from_payload(_payload("errorStreamInactive"), context="POST liveBroadcasts")
    assert str(error).startswith("POST liveBroadcasts: nope")


def test_client_surfaces_the_typed_exception_end_to_end(
    client: YouTubeLiveClient, transport: FakeTransport
) -> None:
    """The reason -> type mapping is wired into the request path, not just the helper."""
    transport.queue_error(403, "errorStreamInactive", "The live stream is not active.")
    with pytest.raises(EncoderOfflineError) as exc:
        client.list_broadcasts(["VID1"])
    assert exc.value.retryable is True
    assert exc.value.status_code == 403
