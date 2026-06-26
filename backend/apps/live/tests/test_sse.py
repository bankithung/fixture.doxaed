"""Control room, increment 3 — public tournament SSE stream
(`GET /api/public/tournaments/{slug}/{id}/stream/`, spec 2026-06-12 §2.c).
AllowAny by design: frames carry only UUIDs + a tick kind (zero PII); the
(slug, UUID) pair must resolve and the tournament status must be public —
identical gating to the public schedule. One-way only (invariant #11)."""
from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import get_user_model
from django.test import RequestFactory
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(status: str = TournamentStatus.SCHEDULED):
    admin = _verified(f"sse-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Stream Cup")
    t.status = status
    t.save(update_fields=["status"])
    return admin, t


def _stream_response(t, slug: str | None = None):
    from apps.live.sse import tournament_stream

    rf = RequestFactory()
    s = slug or t.slug
    request = rf.get(f"/api/public/tournaments/{s}/{t.id}/stream/")

    async def call():
        return await tournament_stream(request, s, t.id)

    return async_to_sync(call)()


@pytest.mark.parametrize(
    "status",
    [
        TournamentStatus.REGISTRATION_OPEN,
        TournamentStatus.SCHEDULED,
        TournamentStatus.LIVE,
        TournamentStatus.COMPLETED,
    ],
)
def test_stream_open_in_public_statuses(status):
    _admin, t = _setup(status=status)
    r = _stream_response(t)
    assert r.status_code == 200
    assert r["Content-Type"].startswith("text/event-stream")
    assert r["Cache-Control"] == "no-cache"
    assert r["X-Accel-Buffering"] == "no"
    # The stream generator was never iterated — nothing to clean up.


@pytest.mark.parametrize(
    "status",
    [
        TournamentStatus.DRAFT,
        TournamentStatus.PUBLISHED,
        TournamentStatus.ARCHIVED,
    ],
)
def test_stream_hidden_in_private_statuses(status):
    _admin, t = _setup(status=status)
    assert _stream_response(t).status_code == 404


def test_wrong_slug_is_404():
    _admin, t = _setup()
    assert _stream_response(t, slug="some-other-slug").status_code == 404


def test_stream_is_wired_at_the_public_url():
    """Route smoke test through the full stack (AllowAny, no auth)."""
    _admin, t = _setup(status=TournamentStatus.DRAFT)  # private → 404 fast
    r = APIClient().get(f"/api/public/tournaments/{t.slug}/{t.id}/stream/")
    assert r.status_code == 404


def test_stream_relays_tournament_ticks():
    _admin, t = _setup()
    r = _stream_response(t)
    assert r.status_code == 200
    frames = aiter(r.streaming_content)

    async def flow():
        # First frame is the connected comment — consuming it guarantees the
        # generator has subscribed to the group before we publish.
        first = await asyncio.wait_for(anext(frames), timeout=2)
        assert b": connected" in first

        layer = get_channel_layer()
        await layer.group_send(
            f"tournament_{t.id}",
            {
                "type": "tournament.tick",
                "data": {
                    "tournament_id": str(t.id),
                    "match_id": None,
                    "kind": "score",
                },
            },
        )
        frame = await asyncio.wait_for(anext(frames), timeout=2)
        assert frame.startswith(b"event: tick\n")
        payload = json.loads(frame.split(b"data: ", 1)[1].split(b"\n", 1)[0])
        assert payload == {
            "tournament_id": str(t.id), "match_id": None, "kind": "score",
        }
        await frames.aclose()

    async_to_sync(flow)()


def test_stream_releases_db_connection_after_lookup(monkeypatch):
    """The long-lived stream must hand its Postgres connection back after the
    lookup — otherwise one slot is pinned per concurrent viewer until
    ``max_connections`` is exhausted (the login-500 incident). We assert the
    release path runs; the body itself only reads from the channel layer."""
    from apps.live import sse

    calls = {"n": 0}
    monkeypatch.setattr(
        sse, "_close_db_connection",
        lambda: calls.__setitem__("n", calls["n"] + 1),
    )
    _admin, t = _setup()
    r = _stream_response(t)
    assert r.status_code == 200
    assert calls["n"] == 1  # released exactly once, before streaming begins


def test_stream_emits_keepalive_heartbeats(monkeypatch):
    from apps.live import sse

    monkeypatch.setattr(sse, "KEEPALIVE_SECONDS", 0.05)
    _admin, t = _setup()
    r = _stream_response(t)
    frames = aiter(r.streaming_content)

    async def flow():
        first = await asyncio.wait_for(anext(frames), timeout=2)
        assert b": connected" in first
        beat = await asyncio.wait_for(anext(frames), timeout=2)
        assert b": keep-alive" in beat
        await frames.aclose()

    async_to_sync(flow)()
