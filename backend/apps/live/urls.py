from __future__ import annotations

from django.urls import path

from apps.live.views import LiveMatchSnapshotView

# Mounted at /api/live/
from apps.live.cards import MatchCardView

urlpatterns = [
    path("match/<uuid:match_id>/", LiveMatchSnapshotView.as_view(), name="live-match-snapshot"),
    # P6 reach: the 1200x630 share/OG image a forwarded match link unfurls to.
    path("match-card/<uuid:match_id>.png", MatchCardView.as_view(), name="live-match-card"),
]
