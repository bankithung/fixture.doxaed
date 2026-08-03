"""Typed error taxonomy for the YouTube Live integration.

Google answers a dozen operationally different situations with the same one or
two HTTP statuses (almost everything is 400 or 403). The only machine-readable
thing that says what actually went wrong — and therefore what the daemon should
*do* — is the ``reason`` string buried in the error payload::

    {"error": {"code": 403, "message": "...",
               "errors": [{"domain": "youtube.liveBroadcast",
                           "reason": "errorStreamInactive",
                           "message": "..."}]}}

So we map reason -> exception class, and every class documents the response.
Callers should branch on the type, never on the HTTP status and never on a
substring of the message.

Recovery contract (this is the whole point of the module):

===========================  ==========================================
Exception                    What the caller must do
===========================  ==========================================
``ConcurrencyLimitError``    Do NOT retry. Alert a human; the channel is
                             at its 10-active-broadcast ceiling.
``EncoderOfflineError``      Retry with backoff and surface
                             "Court N encoder offline" to the operator.
``TransitionStateError``     NEVER blind-retry. Re-``list_broadcasts`` the
                             real lifecycle status and reconcile.
``ChannelNotEligibleError``  Hard stop. Human escalation — live streaming
                             is not enabled/permitted on the channel.
``QuotaError``               Exponential backoff (and shed load; the daily
                             quota resets at midnight Pacific).
``CredentialsExpiredError``  Page a human. The refresh token is dead; no
                             amount of retrying brings it back.
``TransportError``           Network/timeout. Retry with backoff.
``YouTubeAPIError``          Unknown reason (carried verbatim on
                             ``.reason``). Log loudly, do not auto-retry.
===========================  ==========================================
"""
from __future__ import annotations

from typing import Any, Final


class YouTubeError(RuntimeError):
    """Base class for every failure raised by this package.

    Carries the raw Google ``reason`` (when there was one), the HTTP status and
    the decoded payload so logs keep the evidence even for reasons we do not
    model yet.
    """

    #: Whether a plain retry (with backoff) is a sane response. Subclasses that
    #: represent a *state* problem or a dead credential set this to ``False`` so
    #: a generic retry wrapper cannot make things worse.
    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        reason: str | None = None,
        status_code: int | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.reason = reason
        self.status_code = status_code
        self.payload: dict[str, Any] = payload or {}

    def __str__(self) -> str:
        bits = [self.message]
        if self.reason:
            bits.append(f"reason={self.reason}")
        if self.status_code is not None:
            bits.append(f"http={self.status_code}")
        return " ".join(bits[:1]) + ("" if len(bits) == 1 else " [" + ", ".join(bits[1:]) + "]")


class ConcurrencyLimitError(YouTubeError):
    """The channel already has too many active broadcasts.

    YouTube's documented ceilings are **10 active broadcasts per channel** and
    **3 concurrent broadcasts per stream key**. Retrying does not help — some
    other court has to finish first. Alert, and stop creating.
    """

    retryable = False


class EncoderOfflineError(YouTubeError):
    """The bound stream is not receiving video (``errorStreamInactive``).

    Usually the court's phone/encoder dropped Wi-Fi, or it has not started
    pushing yet. Retry with backoff and surface "Court N encoder offline" so
    somebody physically walks over and looks at it.
    """

    retryable = True


class TransitionStateError(YouTubeError):
    """A lifecycle transition was rejected (``invalidTransition``/``redundantTransition``).

    ``redundantTransition`` means we asked for the state it is already in — a
    race with autostart, or a duplicated command. ``invalidTransition`` means we
    asked for a state that is not reachable from the current one.

    **Never blind-retry.** Re-list the broadcast, read the real
    ``lifeCycleStatus``, and reconcile from that. Retrying a transition against
    a stale mental model is how a court ends up ``complete`` mid-match.
    """

    retryable = False


class ChannelNotEligibleError(YouTubeError):
    """Live streaming is not available on this channel.

    ``liveStreamingNotEnabled``: the channel has never enabled live streaming
    (or is inside the 24h wait after first enabling it).
    ``livePermissionBlocked``: live streaming is blocked, typically a strike or
    a policy restriction.

    Hard stop. No retry, no fallback — a human has to fix it in YouTube Studio.
    """

    retryable = False


class QuotaError(YouTubeError):
    """Rate limit or daily quota exhausted.

    ``userRequestsExceedRateLimit`` is short-term (back off seconds-to-minutes).
    ``quotaExceeded`` is the 10,000-unit daily budget and only resets at
    midnight US/Pacific — back off hard and shed non-essential polling.
    """

    retryable = True


class CredentialsExpiredError(YouTubeError):
    """The OAuth refresh token no longer works (``invalid_grant``).

    Page a human. See :mod:`apps.streaming.services.credentials` for the three
    ways this happens in practice (consent screen left in *Testing*, 6 months
    unused, or the 100-refresh-tokens-per-client cap silently evicting it).
    """

    retryable = False


class TransportError(YouTubeError):
    """The HTTP call never produced a response (DNS, TCP, TLS, timeout)."""

    retryable = True


class YouTubeAPIError(YouTubeError):
    """Fallback for a reason we do not model.

    ``.reason`` carries Google's raw string verbatim (possibly ``None``) and
    ``.payload`` the decoded body, so an unmapped failure is still diagnosable
    from logs without a code change.
    """

    retryable = False


#: reason -> exception. Keys are exactly the strings Google puts in
#: ``error.errors[].reason`` (plus the OAuth token endpoint's flat ``error``).
REASON_MAP: Final[dict[str, type[YouTubeError]]] = {
    # --- specified taxonomy -------------------------------------------------
    "concurrentBroadcastsExceedLimit": ConcurrencyLimitError,
    "errorStreamInactive": EncoderOfflineError,
    "invalidTransition": TransitionStateError,
    "redundantTransition": TransitionStateError,
    "liveStreamingNotEnabled": ChannelNotEligibleError,
    "livePermissionBlocked": ChannelNotEligibleError,
    "userRequestsExceedRateLimit": QuotaError,
    "quotaExceeded": QuotaError,
    "invalid_grant": CredentialsExpiredError,
    # --- extensions (same operational response as their neighbours above) ---
    # These are standard Google API reasons rather than live-streaming ones,
    # but they demand identical handling, so they are mapped here rather than
    # falling through to YouTubeAPIError and getting a "do not retry".
    "rateLimitExceeded": QuotaError,
    "dailyLimitExceeded": QuotaError,
    # A 401 that survives a forced token refresh is a dead credential, not a
    # transient — treat it like invalid_grant so it pages instead of looping.
    "authError": CredentialsExpiredError,
}


def extract_reason(payload: Any) -> str | None:
    """Pull Google's error ``reason`` out of any of the shapes it ships in.

    Handles the Data API v3 shape (``error.errors[].reason``), the newer
    ``error.details[].reason`` shape, and the OAuth 2 token endpoint's flat
    ``{"error": "invalid_grant"}``. Returns ``None`` when nothing usable is
    present (the caller then gets :class:`YouTubeAPIError`).
    """
    if not isinstance(payload, dict):
        return None

    err = payload.get("error")

    # OAuth 2 token endpoint: {"error": "invalid_grant", "error_description": ...}
    if isinstance(err, str):
        return err or None

    if not isinstance(err, dict):
        return None

    for key in ("errors", "details"):
        entries = err.get(key)
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    reason = entry.get("reason")
                    if isinstance(reason, str) and reason:
                        return reason

    reason = err.get("reason")
    return reason if isinstance(reason, str) and reason else None


def extract_message(payload: Any) -> str:
    """Best-effort human message from a Google error payload."""
    if not isinstance(payload, dict):
        return ""

    description = payload.get("error_description")
    if isinstance(description, str) and description:
        return description

    err = payload.get("error")
    if isinstance(err, str):
        return err
    if not isinstance(err, dict):
        return ""

    message = err.get("message")
    if isinstance(message, str) and message:
        return message

    entries = err.get("errors")
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict):
                inner = entry.get("message")
                if isinstance(inner, str) and inner:
                    return inner
    return ""


def error_from_payload(
    payload: Any,
    *,
    status_code: int | None = None,
    context: str = "",
) -> YouTubeError:
    """Build the right typed exception for a decoded Google error body.

    Never raises on a malformed payload — an undecodable body still yields a
    :class:`YouTubeAPIError` carrying whatever we got.
    """
    reason = extract_reason(payload)
    message = extract_message(payload) or "YouTube API request failed"
    if context:
        message = f"{context}: {message}"

    cls = REASON_MAP.get(reason or "", YouTubeAPIError)
    body: dict[str, Any] = payload if isinstance(payload, dict) else {"raw": payload}
    return cls(message, reason=reason, status_code=status_code, payload=body)
