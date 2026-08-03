"""OAuth 2 credentials for the YouTube Live daemon (refresh-token flow).

The daemon is a headless server process acting as ONE channel owner. It holds a
long-lived refresh token obtained once, interactively, by a human, and trades it
for short-lived access tokens (~1 hour) against
``https://oauth2.googleapis.com/token``.

OPERATIONAL TRAPS — read this before the first tournament
=========================================================

1. **The consent screen MUST be "In Production", not "Testing".**
   While the Google Cloud OAuth consent screen sits in *Testing*, every refresh
   token Google issues **expires after 7 days**, no exceptions and no warning.
   The daemon then dies with ``invalid_grant`` — and because a tournament is
   longer than a sprint, it will happen *mid-event*, on a Saturday, with every
   court dark. Publish the consent screen (Google Cloud Console -> APIs &
   Services -> OAuth consent screen -> **Publish app**). A single-user internal
   app still needs this; "it works in dev" is exactly the symptom of the trap.

2. **Refresh tokens die after ~6 months unused.** An off-season gap longer than
   six months silently invalidates the token. Re-consent before the season, or
   keep a scheduled warm-up call.

3. **There is a cap of ~100 refresh tokens per (OAuth client, Google account).**
   Issuing the 101st **silently invalidates the oldest** — no error at issue
   time, just a dead daemon later. So do NOT re-run the consent flow casually,
   and do not let a dev laptop and production share one client id while both
   keep re-authorising.

4. **Scope**: ``https://www.googleapis.com/auth/youtube.force-ssl`` alone covers
   everything this package does — liveStreams/liveBroadcasts insert, bind,
   transition, list, and videos list/update. Do not request more.

Configuration
-------------
``client_id`` / ``client_secret`` / ``refresh_token`` are read from Django
settings, which must read them from the environment with **no defaults** (the
``fixture/settings/prod.py`` pattern). Add to ``base.py``/``prod.py``::

    YOUTUBE_OAUTH_CLIENT_ID = env("YOUTUBE_OAUTH_CLIENT_ID", default="")
    YOUTUBE_OAUTH_CLIENT_SECRET = env("YOUTUBE_OAUTH_CLIENT_SECRET", default="")
    YOUTUBE_OAUTH_REFRESH_TOKEN = env("YOUTUBE_OAUTH_REFRESH_TOKEN", default="")

(Empty defaults so a box without streaming configured still boots;
:meth:`RefreshTokenCredentials.from_settings` raises ``ImproperlyConfigured``
the moment something actually tries to stream.) **No secret ever lands in
code, in the repo, or in a log line.**
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any, Final, Protocol

from django.core.exceptions import ImproperlyConfigured

from .errors import YouTubeAPIError, error_from_payload
from .transport import HttpTransport

logger = logging.getLogger(__name__)

#: The single scope that covers every call in this package.
YOUTUBE_SCOPE: Final = "https://www.googleapis.com/auth/youtube.force-ssl"

#: Google's OAuth 2 token endpoint (form-encoded POST, not JSON).
GOOGLE_OAUTH_ENDPOINT: Final = "https://oauth2.googleapis.com/token"

#: Refresh this many seconds *before* the stated expiry, so a token can never
#: die in flight between our check and Google receiving the request.
EXPIRY_SKEW_SECONDS: Final = 60.0

#: Google's documented default access-token lifetime, used when the token
#: response omits ``expires_in``.
DEFAULT_EXPIRES_IN: Final = 3600.0


class CredentialsProvider(Protocol):
    """What :class:`~apps.streaming.services.youtube.YouTubeLiveClient` needs.

    One method: hand me a bearer token. ``force_refresh=True`` is used by the
    client after a 401 to discard a cached token that the server rejected.
    """

    def access_token(self, *, force_refresh: bool = False) -> str: ...


class StaticCredentials:
    """A fixed bearer token. For tests and short-lived scripts only."""

    __slots__ = ("_token",)

    def __init__(self, token: str) -> None:
        self._token = token

    def access_token(self, *, force_refresh: bool = False) -> str:
        return self._token


class RefreshTokenCredentials:
    """Exchanges a stored refresh token for access tokens, with an in-memory cache.

    Thread-safe: the daemon polls several courts concurrently, and without the
    lock a token expiry would fan out into N simultaneous refresh calls (which
    is both wasteful and a good way to trip the token endpoint's rate limit).

    Expiry is tracked on a **monotonic** clock, so an NTP step or a container
    resume cannot make a live token look valid for another hour.
    """

    __slots__ = (
        "_client_id",
        "_client_secret",
        "_clock",
        "_expires_at",
        "_lock",
        "_refresh_token",
        "_timeout",
        "_token",
        "_transport",
    )

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        transport: HttpTransport,
        clock: Callable[[], float] = time.monotonic,
        timeout: float = 15.0,
    ) -> None:
        if not client_id or not client_secret or not refresh_token:
            raise ImproperlyConfigured(
                "YouTube OAuth is not configured: client_id, client_secret and "
                "refresh_token are all required."
            )
        self._client_id = client_id
        self._client_secret = client_secret
        self._refresh_token = refresh_token
        self._transport = transport
        self._clock = clock
        self._timeout = timeout
        self._token: str | None = None
        self._expires_at: float = 0.0
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ build
    @classmethod
    def from_settings(cls, *, transport: HttpTransport, **kwargs: Any) -> RefreshTokenCredentials:
        """Build from Django settings (which read env — see the module docstring).

        Raises ``ImproperlyConfigured`` when any of the three values is missing,
        naming the setting but **never echoing the value**.
        """
        from django.conf import settings

        names = (
            "YOUTUBE_OAUTH_CLIENT_ID",
            "YOUTUBE_OAUTH_CLIENT_SECRET",
            "YOUTUBE_OAUTH_REFRESH_TOKEN",
        )
        values: list[str] = []
        missing: list[str] = []
        for name in names:
            value = str(getattr(settings, name, "") or "").strip()
            if not value:
                missing.append(name)
            values.append(value)
        if missing:
            raise ImproperlyConfigured(
                "YouTube streaming is not configured; missing settings: "
                + ", ".join(missing)
                + ". Set them from the environment (no defaults, no secrets in code)."
            )
        return cls(
            client_id=values[0],
            client_secret=values[1],
            refresh_token=values[2],
            transport=transport,
            **kwargs,
        )

    # ------------------------------------------------------------------ tokens
    def access_token(self, *, force_refresh: bool = False) -> str:
        """A valid bearer token, refreshing only when needed.

        Cached until ``EXPIRY_SKEW_SECONDS`` before the stated expiry.
        ``force_refresh`` discards the cache (used after a 401).
        """
        with self._lock:
            if not force_refresh and self._token is not None and not self._expired():
                return self._token
            return self._refresh_locked()

    def invalidate(self) -> None:
        """Drop the cached access token (the refresh token is untouched)."""
        with self._lock:
            self._token = None
            self._expires_at = 0.0

    @property
    def expires_in(self) -> float:
        """Seconds until the cached token is considered stale (0 when none)."""
        if self._token is None:
            return 0.0
        return max(0.0, self._expires_at - EXPIRY_SKEW_SECONDS - self._clock())

    # ----------------------------------------------------------------- private
    def _expired(self) -> bool:
        return self._clock() >= self._expires_at - EXPIRY_SKEW_SECONDS

    def _refresh_locked(self) -> str:
        """Perform the refresh. Caller must hold ``self._lock``."""
        response = self._transport.request(
            "POST",
            GOOGLE_OAUTH_ENDPOINT,
            data={
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "refresh_token": self._refresh_token,
                "grant_type": "refresh_token",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=self._timeout,
        )
        payload = response.json()

        if not response.ok:
            # invalid_grant lands here and maps to CredentialsExpiredError:
            # the refresh token is dead (see the module docstring's three traps).
            self._token = None
            self._expires_at = 0.0
            error = error_from_payload(
                payload,
                status_code=response.status_code,
                context="OAuth token refresh failed",
            )
            logger.error("YouTube OAuth refresh failed: %s", error)
            raise error

        if not isinstance(payload, dict):
            raise YouTubeAPIError(
                "OAuth token refresh returned a non-JSON body",
                status_code=response.status_code,
            )

        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise YouTubeAPIError(
                "OAuth token refresh returned no access_token",
                status_code=response.status_code,
                payload=payload,
            )

        expires_in = _coerce_seconds(payload.get("expires_in"), DEFAULT_EXPIRES_IN)
        granted = payload.get("scope")
        if isinstance(granted, str) and granted and YOUTUBE_SCOPE not in granted.split():
            # Not fatal here — the API call will fail with its own reason — but
            # this is the single most useful line in the log when it does.
            logger.warning(
                "YouTube access token granted scopes %r, which do not include %s",
                granted,
                YOUTUBE_SCOPE,
            )

        self._token = token
        self._expires_at = self._clock() + expires_in
        return token


def _coerce_seconds(value: Any, default: float) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return default
    return seconds if seconds > 0 else default
