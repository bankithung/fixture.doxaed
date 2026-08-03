"""Injectable HTTP transport for the YouTube client.

Deliberately tiny: one :class:`HttpTransport` protocol and one concrete
``httpx`` implementation. Everything above this layer (the API client, the
credentials provider) takes a transport as a constructor argument, so tests
substitute a recorder/replayer and **never touch the network**.

Why hand-rolled REST instead of ``google-api-python-client``:
``google-api-python-client`` / ``google-auth`` are not in
``backend/requirements.txt`` or ``backend/pyproject.toml``, and adding a
dependency was out of scope. ``httpx`` is already installed and already used
for exactly this purpose in ``apps/assistant/gemini.py``, so we speak the plain
Data API v3 REST endpoints. The YouTube surface we need is nine calls and a
token exchange — the SDK buys little and costs a discovery round-trip.
"""
from __future__ import annotations

import json as jsonlib
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from .errors import TransportError

if TYPE_CHECKING:  # pragma: no cover - typing only
    import httpx


class HttpResponse:
    """A transport-agnostic response.

    Only what this package needs: status, decoded text, headers. Kept as a
    plain class (not a dataclass) so tests can construct it positionally with
    two arguments and ignore headers.
    """

    __slots__ = ("headers", "status_code", "text")

    def __init__(
        self,
        status_code: int,
        text: str = "",
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self.text = text
        self.headers: Mapping[str, str] = headers or {}

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> Any:
        """Decoded JSON body, or ``None`` when the body is empty/undecodable.

        Google returns JSON for every endpoint we call, including errors — but
        a proxy or a 502 HTML page must not crash the error path, so decoding
        failures degrade to ``None`` instead of raising.
        """
        if not self.text.strip():
            return None
        try:
            return jsonlib.loads(self.text)
        except ValueError:
            return None

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"HttpResponse(status_code={self.status_code}, text={self.text[:120]!r})"


@runtime_checkable
class HttpTransport(Protocol):
    """The one method the YouTube layer needs from an HTTP client.

    ``json`` sends a JSON body; ``data`` sends form-encoded fields (the OAuth
    token endpoint requires ``application/x-www-form-urlencoded``). Exactly one
    of them should be supplied.

    Implementations MUST raise :class:`~apps.streaming.services.errors.TransportError`
    when no response is obtained (DNS/TCP/TLS/timeout) and MUST NOT raise for
    4xx/5xx — those are returned so the error taxonomy can classify the body.
    """

    def request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        json: Any | None = None,
        data: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> HttpResponse: ...


class HttpxTransport:
    """Default :class:`HttpTransport`, backed by ``httpx``.

    Constructs its own ``httpx.Client`` (connection pooling matters — the
    daemon makes a handful of calls per court per minute) unless one is passed
    in. Import of ``httpx`` is deferred to construction so that importing this
    module never hard-fails in an environment without it.
    """

    __slots__ = ("_client", "_owns_client", "_timeout")

    def __init__(self, *, timeout: float = 30.0, client: httpx.Client | None = None) -> None:
        self._timeout = timeout
        self._owns_client = client is None
        if client is None:
            try:
                import httpx as _httpx
            except ModuleNotFoundError as exc:  # pragma: no cover - env guard
                raise TransportError(
                    "httpx is required for HttpxTransport; install it or inject "
                    "your own HttpTransport implementation"
                ) from exc
            client = _httpx.Client(timeout=timeout)
        self._client = client

    def request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        json: Any | None = None,
        data: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> HttpResponse:
        import httpx as _httpx

        try:
            response = self._client.request(
                method,
                url,
                params=dict(params) if params else None,
                json=json,
                data=dict(data) if data else None,
                headers=dict(headers) if headers else None,
                timeout=timeout if timeout is not None else self._timeout,
            )
        except _httpx.HTTPError as exc:
            raise TransportError(f"{method} {url} failed: {exc}") from exc
        return HttpResponse(
            response.status_code,
            response.text,
            {k.lower(): v for k, v in response.headers.items()},
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> HttpxTransport:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
