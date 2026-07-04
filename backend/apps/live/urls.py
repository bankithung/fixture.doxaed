from __future__ import annotations

from django.urls import path

# Mounted at /api/live/
from apps.live.cards import MatchCardView, TournamentCardView
from apps.live.meta import MatchMetaView, TournamentMetaView
from apps.live.views import LiveMatchSnapshotView

urlpatterns = [
    path("match/<uuid:match_id>/", LiveMatchSnapshotView.as_view(), name="live-match-snapshot"),
    # P6 reach: the 1200x630 share/OG image a forwarded match link unfurls to.
    path("match-card/<uuid:match_id>.png", MatchCardView.as_view(), name="live-match-card"),
    path(
        "tournament-card/<uuid:tournament_id>.png",
        TournamentCardView.as_view(),
        name="tournament-card",
    ),
    # Bot-facing OG meta for /m/:id (nginx routes preview crawlers here).
    path("match-meta/<uuid:match_id>/", MatchMetaView.as_view(), name="live-match-meta"),
    path(
        "tournament-meta/<slug:slug>/<uuid:tournament_id>/",
        TournamentMetaView.as_view(),
        name="live-tournament-meta",
    ),
]
