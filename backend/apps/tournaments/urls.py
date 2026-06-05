from __future__ import annotations

from django.urls import path

from apps.disputes.views import TournamentDisputeView
from apps.fixtures.views import GenerateFixturesView
from apps.matches.views import TournamentMatchListView, TournamentStandingsView
from apps.teams.views import RegistrationLinkCreateView, TournamentTeamsListView
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
    path(
        "<uuid:tournament_id>/registration-link/",
        RegistrationLinkCreateView.as_view(),
        name="tournament-registration-link",
    ),
    path(
        "<uuid:tournament_id>/teams/",
        TournamentTeamsListView.as_view(),
        name="tournament-teams",
    ),
    path(
        "<uuid:tournament_id>/matches/",
        TournamentMatchListView.as_view(),
        name="tournament-matches",
    ),
    path(
        "<uuid:tournament_id>/standings/",
        TournamentStandingsView.as_view(),
        name="tournament-standings",
    ),
    path(
        "<uuid:tournament_id>/generate-fixtures/",
        GenerateFixturesView.as_view(),
        name="tournament-generate-fixtures",
    ),
    path(
        "<uuid:tournament_id>/disputes/",
        TournamentDisputeView.as_view(),
        name="tournament-disputes",
    ),
]
