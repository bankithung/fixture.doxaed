"""Public streaming routes — mounted under ``/api/public/`` by ``fixture.urls``.

These two URLs are the platform's own, stable, printable "Watch live" links.
They belong here rather than pointing at YouTube because a channel-level
``/live`` URL cannot address a court (see ``apps.streaming.views``).

    /api/public/tournaments/<slug>/<uuid>/court/<court_id>/live/
    /api/public/matches/<match_id>/watch/
"""
from __future__ import annotations

from django.urls import path

from apps.streaming.views import (
    PublicCourtLiveRedirectView,
    PublicMatchWatchRedirectView,
)

urlpatterns = [
    path(
        "tournaments/<slug:slug>/<uuid:tournament_id>/court/<uuid:court_id>/live/",
        PublicCourtLiveRedirectView.as_view(),
        name="public-court-live",
    ),
    path(
        "matches/<uuid:match_id>/watch/",
        PublicMatchWatchRedirectView.as_view(),
        name="public-match-watch",
    ),
]
