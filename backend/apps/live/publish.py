"""Tournament-wide live tick fan-out (control room spec 2026-06-12 §2.c).

ONE narrow publish path: after a mutation commits (invariant #4 — publish
post-commit only; callers wrap in ``transaction.on_commit``), a thin "tick"
— ids + a kind, no payload data — fans out to the channel-layer group
``tournament_<id>``. Clients (the control room, the public schedule page via
the SSE stream in ``apps.live.sse``) refetch on tick, the same contract the
``match_<id>`` WS room already uses. Best-effort: delivery failure never
affects the committed write.

Deviation from v1Live §2 [MED]: we fan out via the channel layer (InMemory in
dev, channels_redis in prod), not a second raw Redis pub/sub client — one
publish path for WS + SSE. Topic naming follows the shipped ``match_<id>``
convention.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

#: Tick kinds (spec §2.c): what changed, so clients can invalidate narrowly.
TICK_KINDS = ("state", "score", "event", "schedule", "called")


def tournament_group(tournament_id) -> str:
    return f"tournament_{tournament_id}"


def publish_tournament_tick(tournament_id, match_id, kind: str) -> None:
    """Best-effort post-commit fan-out of a thin tick (ids only) to the
    ``tournament_<id>`` group. ``match_id=None`` means a batch change (e.g. a
    cascade that moved more than 10 matches) — clients refetch the whole day."""
    try:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer

        layer = get_channel_layer()
        if layer is not None:
            async_to_sync(layer.group_send)(
                tournament_group(tournament_id),
                {
                    "type": "tournament.tick",
                    "data": {
                        "tournament_id": str(tournament_id),
                        "match_id": str(match_id) if match_id else None,
                        "kind": kind,
                    },
                },
            )
    except Exception:  # pragma: no cover - delivery is best-effort
        logger.exception("publish_tournament_tick fan-out failed")
