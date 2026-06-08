from __future__ import annotations

from django.urls import path

from apps.disputes.views import TournamentDisputeView
from apps.fixtures.views import GenerateFixturesView, ScheduleFixturesView
from apps.forms.views import GenerateTeamFormView, TournamentFormsView
from apps.matches.views import TournamentMatchListView, TournamentStandingsView
from apps.teams.views import (
    InstitutionDetailView,
    InstitutionListCreateView,
    RegistrationLinkCreateView,
    TournamentTeamsListView,
)
from apps.tournaments.views import (
    ConstraintTypesView,
    TournamentAuditView,
    TournamentInvitationCreateView,
    TournamentListCreateView,
    TournamentMemberDetailView,
    TournamentMembersView,
    TournamentSettingsView,
    TournamentStagePreviewView,
    TournamentStageView,
)

urlpatterns = [
    path("", TournamentListCreateView.as_view(), name="tournament-list-create"),
    path(
        "constraint-types/",
        ConstraintTypesView.as_view(),
        name="tournament-constraint-types",
    ),
    path(
        "<uuid:tournament_id>/settings/",
        TournamentSettingsView.as_view(),
        name="tournament-settings",
    ),
    path(
        "<uuid:tournament_id>/invitations/",
        TournamentInvitationCreateView.as_view(),
        name="tournament-invitation-create",
    ),
    path(
        "<uuid:tournament_id>/members/",
        TournamentMembersView.as_view(),
        name="tournament-members",
    ),
    path(
        "<uuid:tournament_id>/members/<uuid:membership_id>/",
        TournamentMemberDetailView.as_view(),
        name="tournament-member-detail",
    ),
    path(
        "<uuid:tournament_id>/audit/",
        TournamentAuditView.as_view(),
        name="tournament-audit",
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
        "<uuid:tournament_id>/forms/",
        TournamentFormsView.as_view(),
        name="tournament-forms",
    ),
    path(
        "<uuid:tournament_id>/forms/generate-team/",
        GenerateTeamFormView.as_view(),
        name="tournament-generate-team-form",
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
        "<uuid:tournament_id>/schedule/",
        ScheduleFixturesView.as_view(),
        name="tournament-schedule-fixtures",
    ),
    path(
        "<uuid:tournament_id>/institutions/",
        InstitutionListCreateView.as_view(),
        name="tournament-institutions",
    ),
    path(
        "<uuid:tournament_id>/institutions/<uuid:institution_id>/",
        InstitutionDetailView.as_view(),
        name="tournament-institution-detail",
    ),
    path(
        "<uuid:tournament_id>/disputes/",
        TournamentDisputeView.as_view(),
        name="tournament-disputes",
    ),
    path(
        "<uuid:tournament_id>/stage/",
        TournamentStageView.as_view(),
        name="tournament-stage",
    ),
    path(
        "<uuid:tournament_id>/stage/preview/",
        TournamentStagePreviewView.as_view(),
        name="tournament-stage-preview",
    ),
]
