"""Test doubles for the streaming layer. NOTHING here touches the network.

``FakeTransport`` records every call and replays canned responses, so each test
asserts on the exact URL, query ``part``, and request body that would have gone
to Google.
"""
from __future__ import annotations

import json as jsonlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import pytest

from apps.streaming.services.credentials import StaticCredentials
from apps.streaming.services.transport import HttpResponse
from apps.streaming.services.youtube import YouTubeLiveClient


@dataclass
class RecordedRequest:
    method: str
    url: str
    params: dict[str, str] = field(default_factory=dict)
    json: Any = None
    data: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    timeout: float | None = None

    @property
    def part(self) -> str:
        return self.params.get("part", "")

    @property
    def ids(self) -> list[str]:
        raw = self.params.get("id", "")
        return raw.split(",") if raw else []


class FakeTransport:
    """An :class:`~apps.streaming.services.transport.HttpTransport` that never leaves the process.

    Responses are consumed in order; when the queue empties the last response is
    repeated (so paging/retry tests do not have to pad the queue).
    """

    def __init__(self, responses: Sequence[HttpResponse] | None = None) -> None:
        self.queued: list[HttpResponse] = list(responses or [])
        self.requests: list[RecordedRequest] = []

    # -- queueing helpers ----------------------------------------------------
    def queue_json(self, payload: Any, status_code: int = 200) -> FakeTransport:
        self.queued.append(HttpResponse(status_code, jsonlib.dumps(payload)))
        return self

    def queue_error(self, status_code: int, reason: str, message: str = "boom") -> FakeTransport:
        return self.queue_json(
            {
                "error": {
                    "code": status_code,
                    "message": message,
                    "errors": [{"domain": "youtube.liveBroadcast", "reason": reason}],
                }
            },
            status_code=status_code,
        )

    # -- the transport protocol ---------------------------------------------
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
        self.requests.append(
            RecordedRequest(
                method=method,
                url=url,
                params=dict(params or {}),
                json=json,
                data=dict(data or {}),
                headers=dict(headers or {}),
                timeout=timeout,
            )
        )
        if not self.queued:
            return HttpResponse(200, "{}")
        if len(self.queued) == 1:
            return self.queued[0]
        return self.queued.pop(0)

    # -- assertions ----------------------------------------------------------
    @property
    def last(self) -> RecordedRequest:
        assert self.requests, "no request was made"
        return self.requests[-1]

    @property
    def only(self) -> RecordedRequest:
        assert len(self.requests) == 1, f"expected exactly 1 request, got {len(self.requests)}"
        return self.requests[0]


@pytest.fixture
def transport() -> FakeTransport:
    return FakeTransport()


@pytest.fixture
def client(transport: FakeTransport) -> YouTubeLiveClient:
    return YouTubeLiveClient(
        credentials=StaticCredentials("test-access-token"),
        transport=transport,
    )
