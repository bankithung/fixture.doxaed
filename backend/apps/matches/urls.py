from __future__ import annotations

from django.urls import path

from apps.matches.views import RecordScoreView

# Mounted at /api/matches/
urlpatterns = [
    path("<uuid:match_id>/score/", RecordScoreView.as_view(), name="match-score"),
]
