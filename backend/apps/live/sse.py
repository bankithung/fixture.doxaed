"""Public tournament SSE stream — the one-way half of the live transport
(invariant #11; control room spec 2026-06-12 §2.c).

``GET /api/public/tournaments/{slug}/{id}/stream/`` is AllowAny by design:
frames carry only UUIDs + a tick kind (zero PII; member-only data flows
through the authed aggregate refetch). Gating is identical to
``PublicTournamentScheduleView`` — the (slug, UUID) pair must resolve
(invariant 1) and the tournament status must be public-facing. The view
subscribes a fresh channel to the ``tournament_<id>`` channel-layer group
(see ``apps.live.publish`` for the deviation from v1Live's raw Redis
pub/sub) and relays ``tournament.tick`` messages as ``event: tick`` frames,
emitting keep-alive comments while idle. Strictly one-way; the WS surface is
untouched. Deploy note: nginx must not buffer this path
(``proxy_buffering off`` / ``X-Accel-Buffering: no`` + a long read timeout —
already the case for ``/api/`` in deploy/nginx-fixture.conf).
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from asgiref.sync import sync_to_async
from django.db import connection, transaction
from django.http import HttpResponseNotFound, StreamingHttpResponse

#: Idle window between ': keep-alive' comments (proxies drop silent streams).
KEEPALIVE_SECONDS = 25.0


def _close_db_connection() -> None:
    """Release the request's Postgres connection.

    The streaming body below reads only from the channel layer (Redis) — it
    never touches Postgres again. Because a Server-Sent-Events request never
    "finishes" until the client disconnects (minutes/hours), the connection
    the lookup opened would otherwise sit idle for the stream's whole lifetime,
    pinning one Postgres slot per concurrent viewer until ``max_connections``
    is exhausted and *every* request 500s. Django reopens lazily if needed.
    Guarded on ``in_atomic_block`` so it is a no-op under the test transaction
    (and would never close a connection mid-transaction in any case).
    """
    if not connection.in_atomic_block:
        connection.close()


# A long-lived stream must not hold a request transaction open (and Django
# refuses ATOMIC_REQUESTS around async views outright). Read-only anyway.
@transaction.non_atomic_requests
async def tournament_stream(request, slug, tournament_id):
    from apps.tournaments.models import Tournament, TournamentStatus

    public_statuses = (
        TournamentStatus.REGISTRATION_OPEN,
        TournamentStatus.SCHEDULED,
        TournamentStatus.LIVE,
        TournamentStatus.COMPLETED,
    )
    t = await Tournament.objects.filter(
        id=tournament_id,
        slug=slug,
        deleted_at__isnull=True,
        status__in=public_statuses,
    ).afirst()
    # Hand the Postgres connection back to the pool before we start streaming.
    await sync_to_async(_close_db_connection)()
    if t is None:
        return HttpResponseNotFound("tournament_not_found")

    response = StreamingHttpResponse(
        _frames(str(t.id)), content_type="text/event-stream"
    )
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"  # nginx: do not buffer this stream
    return response


async def _frames(tournament_id: str) -> AsyncIterator[str]:
    from channels.layers import get_channel_layer

    from apps.live.publish import tournament_group

    layer = get_channel_layer()
    if layer is None:  # pragma: no cover - layer is always configured
        return
    group = tournament_group(tournament_id)
    channel = await layer.new_channel()
    await layer.group_add(group, channel)
    try:
        yield ": connected\n\n"
        while True:
            try:
                message = await asyncio.wait_for(
                    layer.receive(channel), timeout=KEEPALIVE_SECONDS
                )
            except TimeoutError:
                yield ": keep-alive\n\n"
                continue
            if message.get("type") == "tournament.tick":
                data = json.dumps(message.get("data") or {})
                yield f"event: tick\ndata: {data}\n\n"
    finally:
        await layer.group_discard(group, channel)
