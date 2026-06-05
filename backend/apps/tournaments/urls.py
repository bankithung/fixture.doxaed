from __future__ import annotations

from django.urls import path

from apps.tournaments.views import TournamentListCreateView

urlpatterns = [
    path("", TournamentListCreateView.as_view(), name="tournament-list-create"),
]
