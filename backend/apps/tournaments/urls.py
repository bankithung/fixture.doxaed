from __future__ import annotations

from django.urls import path

from apps.tournaments.views import (
    TournamentInvitationCreateView,
    TournamentListCreateView,
)

urlpatterns = [
    path("", TournamentListCreateView.as_view(), name="tournament-list-create"),
    path(
        "<uuid:tournament_id>/invitations/",
        TournamentInvitationCreateView.as_view(),
        name="tournament-invitation-create",
    ),
]
