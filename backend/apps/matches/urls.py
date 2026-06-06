from __future__ import annotations

from django.urls import path

from apps.matches.views import (
    AssignScorerView,
    MatchEventsExportView,
    RecordMatchEventView,
    RecordScoreView,
    TransitionMatchView,
)

# Mounted at /api/matches/
urlpatterns = [
    path("<uuid:match_id>/score/", RecordScoreView.as_view(), name="match-score"),
    path("<uuid:match_id>/scorer/", AssignScorerView.as_view(), name="match-assign-scorer"),
    path("<uuid:match_id>/events/", RecordMatchEventView.as_view(), name="match-events"),
    path(
        "<uuid:match_id>/events/export/",
        MatchEventsExportView.as_view(),
        name="match-events-export",
    ),
    path(
        "<uuid:match_id>/transition/",
        TransitionMatchView.as_view(),
        name="match-transition",
    ),
]
