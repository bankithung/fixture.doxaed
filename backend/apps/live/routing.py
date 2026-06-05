from __future__ import annotations

from django.urls import path

from apps.live.consumers import MatchConsumer

websocket_urlpatterns = [
    path("ws/match/<uuid:match_id>/", MatchConsumer.as_asgi()),
]
