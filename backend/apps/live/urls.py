from __future__ import annotations

from django.urls import path

from apps.live.views import LiveMatchSnapshotView

# Mounted at /api/live/
urlpatterns = [
    path("match/<uuid:match_id>/", LiveMatchSnapshotView.as_view(), name="live-match-snapshot"),
]
