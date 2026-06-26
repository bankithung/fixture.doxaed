from __future__ import annotations

from django.urls import path

from apps.matches.views import (
    AssignOfficialsView,
    AssignScorerView,
    ConfirmLineupView,
    MatchCallView,
    MatchDelayView,
    MatchEventsExportView,
    MatchIncidentView,
    MatchLineupView,
    MatchLockView,
    MatchScheduleView,
    RecordMatchEventView,
    RecordScoreView,
    RecordShootoutView,
    TransitionMatchView,
)

# Mounted at /api/matches/
urlpatterns = [
    path("<uuid:match_id>/score/", RecordScoreView.as_view(), name="match-score"),
    path(
        "<uuid:match_id>/shootout/",
        RecordShootoutView.as_view(),
        name="match-shootout",
    ),
    path("<uuid:match_id>/scorer/", AssignScorerView.as_view(), name="match-assign-scorer"),
    path(
        "<uuid:match_id>/officials/",
        AssignOfficialsView.as_view(),
        name="match-officials",
    ),
    path(
        "<uuid:match_id>/schedule/",
        MatchScheduleView.as_view(),
        name="match-schedule",
    ),
    path(
        "<uuid:match_id>/lock/",
        MatchLockView.as_view(),
        name="match-lock",
    ),
    path(
        "<uuid:match_id>/call/",
        MatchCallView.as_view(),
        name="match-call",
    ),
    path(
        "<uuid:match_id>/delay/",
        MatchDelayView.as_view(),
        name="match-delay",
    ),
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
    path(
        "<uuid:match_id>/lineups/confirm/",
        ConfirmLineupView.as_view(),
        name="match-lineup-confirm",
    ),
    path("<uuid:match_id>/lineups/", MatchLineupView.as_view(), name="match-lineups"),
    path(
        "<uuid:match_id>/incidents/",
        MatchIncidentView.as_view(),
        name="match-incidents",
    ),
]
