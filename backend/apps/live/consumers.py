"""WebSocket consumers (invariant #11). Delivery only — the system of record is
the MatchEvent log (#4); authoritative writes go through the REST/service layer,
which fans out to these rooms via the post-commit hook (Redis in prod)."""
from __future__ import annotations

from channels.generic.websocket import AsyncJsonWebsocketConsumer


class MatchConsumer(AsyncJsonWebsocketConsumer):
    """Live match room: clients join `match_<id>` and receive event broadcasts."""

    async def connect(self):
        self.match_id = str(self.scope["url_route"]["kwargs"]["match_id"])
        self.group = f"match_{self.match_id}"
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if hasattr(self, "group"):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        # Bidirectional channel; authoritative scoring is via REST. Echo pings.
        if content.get("type") == "ping":
            await self.send_json({"type": "pong"})

    async def match_event(self, event):
        """Handler for channel-layer messages of type 'match.event'."""
        await self.send_json(event["data"])
