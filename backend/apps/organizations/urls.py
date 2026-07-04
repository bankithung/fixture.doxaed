"""organizations app URL config.

AIP-136 colon-syntax verbs (`:suspend`, `:unsuspend`, …). Django's URL
router accepts the colon literally; the lookup converter `<uuid:uuid>`
captures the UUID prefix and the colon-verb is matched as a literal
suffix.

Mounted at `/api/orgs/` by `fixture.urls`.
"""
from __future__ import annotations

from django.urls import path

from apps.organizations import views

app_name = "organizations"


from apps.teams.views_houses import (
    OrgSeasonsView,
    SeasonGroupsView,
    SeasonHousePointsView,
    SeasonHouseTableView,
    SeasonMeetResultView,
)

urlpatterns = [
    # GET / POST /api/orgs/
    path("", views.OrgListCreateView.as_view(), name="org-list"),
    # GET /api/orgs/{slug_or_uuid}/
    path(
        "<str:slug_or_uuid>/",
        views.OrgDetailView.as_view(),
        name="org-detail",
    ),
    # PATCH path is also "<slug_or_uuid>/" (handled by the same view).
    # Verb routes must be matched BEFORE the catch-all detail route — Django
    # matches in order, so place verbs first in this list.
]


# Re-order: put verb routes BEFORE the bare slug match so colon verbs win.
urlpatterns = [
    path("", views.OrgListCreateView.as_view(), name="org-list"),
    # P4 — institution-operator seasons, houses and the house-points ledger.
    path("<uuid:uuid>/seasons/", OrgSeasonsView.as_view(), name="org-seasons"),
    path(
        "<uuid:uuid>/seasons/<uuid:season_id>/groups/",
        SeasonGroupsView.as_view(),
        name="org-season-groups",
    ),
    path(
        "<uuid:uuid>/seasons/<uuid:season_id>/house-table/",
        SeasonHouseTableView.as_view(),
        name="org-season-house-table",
    ),
    path(
        "<uuid:uuid>/seasons/<uuid:season_id>/house-points/",
        SeasonHousePointsView.as_view(),
        name="org-season-house-points",
    ),
    path(
        "<uuid:uuid>/seasons/<uuid:season_id>/meet-results/",
        SeasonMeetResultView.as_view(),
        name="org-season-meet-results",
    ),
    # Colon-verbs (UUID-only)
    path(
        "<uuid:uuid>:change_slug/",
        views.OrgChangeSlugView.as_view(),
        name="org-change-slug",
    ),
    path(
        "<uuid:uuid>:suspend/",
        views.OrgSuspendView.as_view(),
        name="org-suspend",
    ),
    path(
        "<uuid:uuid>:unsuspend/",
        views.OrgUnsuspendView.as_view(),
        name="org-unsuspend",
    ),
    path(
        "<uuid:uuid>:archive/",
        views.OrgArchiveView.as_view(),
        name="org-archive",
    ),
    path(
        "<uuid:uuid>:transfer_ownership/",
        views.OrgTransferOwnershipView.as_view(),
        name="org-transfer-ownership",
    ),
    # Members nested (UUID, canonical)
    path(
        "<uuid:uuid>/members/",
        views.OrgMembersListView.as_view(),
        name="org-members-list",
    ),
    path(
        "<uuid:uuid>/members/<uuid:membership_id>/",
        views.OrgMemberRemoveView.as_view(),
        name="org-member-remove",
    ),
    # Invitations nested (UUID, canonical)
    path(
        "<uuid:uuid>/invitations/",
        views.OrgInvitationsView.as_view(),
        name="org-invitations",
    ),
    path(
        "<uuid:uuid>/invitations/<uuid:invitation_id>:revoke/",
        views.OrgInvitationRevokeView.as_view(),
        name="org-invitation-revoke",
    ),
    # ------------------------------------------------------------------
    # Slug-routed aliases (frontend SPA shape).
    # MUST come BEFORE the catch-all `<str:slug_or_uuid>/` route below;
    # otherwise that route swallows e.g. "{slug}/members/" as a 404.
    # We use distinct kwarg name `<str:slug>` so the slug-routed views
    # don't collide with the existing UUID dispatchers.
    # ------------------------------------------------------------------
    # /api/orgs/invitations/accept/  (path alias of /api/invitations:accept/)
    path(
        "invitations/accept/",
        views.InvitationAcceptByPathView.as_view(),
        name="org-invitations-accept",
    ),
    # /api/orgs/{slug}/members/
    path(
        "<str:slug>/members/",
        views.OrgMembersBySlugView.as_view(),
        name="org-members-by-slug",
    ),
    # /api/orgs/{slug}/invitations/
    path(
        "<str:slug>/invitations/",
        views.OrgInvitationsBySlugView.as_view(),
        name="org-invitations-by-slug",
    ),
    # /api/orgs/{slug}/invitations/{invitation_id}/  (DELETE = revoke)
    path(
        "<str:slug>/invitations/<uuid:invitation_id>/",
        views.OrgInvitationByIdSlugView.as_view(),
        name="org-invitation-by-id-slug",
    ),
    # /api/orgs/{slug}/ownership/transfer/
    path(
        "<str:slug>/ownership/transfer/",
        views.OwnershipTransferBySlugView.as_view(),
        name="org-ownership-transfer-by-slug",
    ),
    # Detail / update — slug or UUID, comes LAST so colon verbs win.
    path(
        "<str:slug_or_uuid>/",
        views.OrgDetailView.as_view(),
        name="org-detail",
    ),
]
