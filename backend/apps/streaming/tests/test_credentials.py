"""Refresh-token flow: caching, near-expiry refresh, and invalid_grant paging."""
from __future__ import annotations

import json as jsonlib
from typing import Any

import pytest
from django.core.exceptions import ImproperlyConfigured
from pytest_django.fixtures import SettingsWrapper

from apps.streaming.services.credentials import (
    EXPIRY_SKEW_SECONDS,
    GOOGLE_OAUTH_ENDPOINT,
    YOUTUBE_SCOPE,
    RefreshTokenCredentials,
)
from apps.streaming.services.errors import CredentialsExpiredError, QuotaError, YouTubeAPIError
from apps.streaming.services.transport import HttpResponse

from .conftest import FakeTransport


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _token_response(token: str, expires_in: int = 3600) -> dict[str, Any]:
    return {
        "access_token": token,
        "expires_in": expires_in,
        "scope": YOUTUBE_SCOPE,
        "token_type": "Bearer",
    }


def _creds(transport: FakeTransport, clock: FakeClock) -> RefreshTokenCredentials:
    return RefreshTokenCredentials(
        client_id="cid",
        client_secret="csecret",
        refresh_token="rtoken",
        transport=transport,
        clock=clock,
    )


def test_refresh_posts_form_encoded_to_the_google_token_endpoint() -> None:
    transport = FakeTransport().queue_json(_token_response("access-1"))
    creds = _creds(transport, FakeClock())

    assert creds.access_token() == "access-1"

    req = transport.only
    assert req.method == "POST"
    assert req.url == GOOGLE_OAUTH_ENDPOINT
    assert req.url == "https://oauth2.googleapis.com/token"
    assert req.data == {
        "client_id": "cid",
        "client_secret": "csecret",
        "refresh_token": "rtoken",
        "grant_type": "refresh_token",
    }
    assert req.headers["Content-Type"] == "application/x-www-form-urlencoded"
    assert req.json is None


def test_the_access_token_is_cached_between_calls() -> None:
    transport = FakeTransport().queue_json(_token_response("access-1"))
    clock = FakeClock()
    creds = _creds(transport, clock)

    tokens = [creds.access_token() for _ in range(5)]

    assert tokens == ["access-1"] * 5
    assert len(transport.requests) == 1, "cache regressed: one refresh per call"


def test_the_cache_survives_until_the_skew_window_then_refreshes() -> None:
    transport = FakeTransport()
    transport.queue_json(_token_response("access-1", expires_in=3600))
    transport.queue_json(_token_response("access-2", expires_in=3600))
    clock = FakeClock()
    creds = _creds(transport, clock)

    assert creds.access_token() == "access-1"

    # One second before the 60s skew window opens: still cached.
    clock.advance(3600 - EXPIRY_SKEW_SECONDS - 1)
    assert creds.access_token() == "access-1"
    assert len(transport.requests) == 1

    # Crossing into the skew window forces a refresh, a full minute before the
    # token would actually expire.
    clock.advance(1)
    assert creds.access_token() == "access-2"
    assert len(transport.requests) == 2


def test_force_refresh_bypasses_a_valid_cache() -> None:
    transport = FakeTransport()
    transport.queue_json(_token_response("access-1"))
    transport.queue_json(_token_response("access-2"))
    creds = _creds(transport, FakeClock())

    assert creds.access_token() == "access-1"
    assert creds.access_token(force_refresh=True) == "access-2"
    assert len(transport.requests) == 2


def test_invalidate_drops_the_cached_token() -> None:
    transport = FakeTransport()
    transport.queue_json(_token_response("access-1"))
    transport.queue_json(_token_response("access-2"))
    creds = _creds(transport, FakeClock())

    assert creds.access_token() == "access-1"
    creds.invalidate()
    assert creds.expires_in == 0.0
    assert creds.access_token() == "access-2"


def test_invalid_grant_raises_credentials_expired_error() -> None:
    """The 7-day 'Testing' consent-screen trap surfaces exactly here."""
    transport = FakeTransport().queue_json(
        {"error": "invalid_grant", "error_description": "Token has been expired or revoked."},
        status_code=400,
    )
    creds = _creds(transport, FakeClock())

    with pytest.raises(CredentialsExpiredError) as exc:
        creds.access_token()

    assert exc.value.reason == "invalid_grant"
    assert exc.value.retryable is False
    assert "OAuth token refresh failed" in str(exc.value)


def test_a_failed_refresh_does_not_leave_a_stale_token_cached() -> None:
    transport = FakeTransport()
    transport.queue_json(_token_response("access-1", expires_in=3600))
    transport.queue_json({"error": "invalid_grant"}, status_code=400)
    clock = FakeClock()
    creds = _creds(transport, clock)

    assert creds.access_token() == "access-1"
    clock.advance(3600)
    with pytest.raises(CredentialsExpiredError):
        creds.access_token()
    assert creds.expires_in == 0.0


def test_a_rate_limited_refresh_is_retryable_not_a_page() -> None:
    transport = FakeTransport().queue_json(
        {"error": {"code": 429, "errors": [{"reason": "rateLimitExceeded"}]}},
        status_code=429,
    )
    creds = _creds(transport, FakeClock())
    with pytest.raises(QuotaError) as exc:
        creds.access_token()
    assert exc.value.retryable is True


def test_a_200_without_an_access_token_is_an_error_not_an_empty_string() -> None:
    transport = FakeTransport().queue_json({"expires_in": 3600})
    creds = _creds(transport, FakeClock())
    with pytest.raises(YouTubeAPIError, match="no access_token"):
        creds.access_token()


def test_a_non_json_200_is_an_error() -> None:
    transport = FakeTransport()
    transport.queued.append(HttpResponse(200, "not json"))
    creds = _creds(transport, FakeClock())
    with pytest.raises(YouTubeAPIError, match="non-JSON"):
        creds.access_token()


def test_a_missing_expires_in_falls_back_to_an_hour() -> None:
    transport = FakeTransport().queue_json({"access_token": "access-1"})
    clock = FakeClock()
    creds = _creds(transport, clock)

    creds.access_token()

    assert creds.expires_in == pytest.approx(3600 - EXPIRY_SKEW_SECONDS)


def test_a_scope_missing_force_ssl_is_logged_but_not_fatal(
    caplog: pytest.LogCaptureFixture,
) -> None:
    transport = FakeTransport().queue_json(
        {"access_token": "access-1", "expires_in": 3600, "scope": "https://example.test/other"}
    )
    creds = _creds(transport, FakeClock())

    with caplog.at_level("WARNING"):
        assert creds.access_token() == "access-1"

    assert any("youtube.force-ssl" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize(
    ("client_id", "client_secret", "refresh_token"),
    [
        ("", "s", "r"),
        ("c", "", "r"),
        ("c", "s", ""),
    ],
)
def test_missing_configuration_is_rejected_at_construction(
    client_id: str, client_secret: str, refresh_token: str
) -> None:
    with pytest.raises(ImproperlyConfigured):
        RefreshTokenCredentials(
            client_id=client_id,
            client_secret=client_secret,
            refresh_token=refresh_token,
            transport=FakeTransport(),
        )


def test_from_settings_names_the_missing_settings(settings: SettingsWrapper) -> None:
    settings.YOUTUBE_OAUTH_CLIENT_ID = "cid"
    settings.YOUTUBE_OAUTH_CLIENT_SECRET = ""
    settings.YOUTUBE_OAUTH_REFRESH_TOKEN = ""

    with pytest.raises(ImproperlyConfigured) as exc:
        RefreshTokenCredentials.from_settings(transport=FakeTransport())

    message = str(exc.value)
    assert "YOUTUBE_OAUTH_CLIENT_SECRET" in message
    assert "YOUTUBE_OAUTH_REFRESH_TOKEN" in message
    assert "YOUTUBE_OAUTH_CLIENT_ID" not in message
    # Never echo a configured secret in the error.
    assert "cid" not in message


def test_from_settings_builds_a_working_provider(settings: SettingsWrapper) -> None:
    settings.YOUTUBE_OAUTH_CLIENT_ID = "cid"
    settings.YOUTUBE_OAUTH_CLIENT_SECRET = "csecret"
    settings.YOUTUBE_OAUTH_REFRESH_TOKEN = "rtoken"
    transport = FakeTransport().queue_json(_token_response("access-1"))

    creds = RefreshTokenCredentials.from_settings(transport=transport, clock=FakeClock())

    assert creds.access_token() == "access-1"
    assert transport.only.data["client_id"] == "cid"


def test_no_secret_is_ever_serialised_into_the_query_string() -> None:
    transport = FakeTransport().queue_json(_token_response("access-1"))
    creds = _creds(transport, FakeClock())
    creds.access_token()

    req = transport.only
    assert req.params == {}
    assert "csecret" not in req.url
    assert "csecret" not in jsonlib.dumps(req.headers)
