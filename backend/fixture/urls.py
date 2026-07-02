"""Project root URL config.

Phase 1A surfaces:
  - /api/...           DRF API for the React SPA
  - /sadmin/...        Custom Super-admin console (Django+Tailwind+HTMX)
  - /api/schema/       OpenAPI schema (drf-spectacular)
  - /api/docs/         Swagger UI in dev

Each app owns its own urls.py and is included here once. App agents fill those in.
v1Users.md Appendix B.3 commits to AIP-136 colon-action verb URLs.

Default Django Admin at /admin/ is INTENTIONALLY DISABLED in v1.0 per
v1Users.md §1.5 — Super-admin uses the custom console at /sadmin/.
"""
from __future__ import annotations

from django.conf import settings
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from apps.matches.public_views import (
    PublicInstitutionRecordView,
    PublicTeamRecordView,
    PublicTournamentDirectoryView,
)
from apps.badges.views import (
    BadgeCardView,
    PublicTournamentBadgesView,
    TournamentBadgesView,
)
from apps.fixtures.views import (
    PublicTournamentScheduleView,
    PublicTournamentStandingsView,
)
from apps.live.sse import tournament_stream
from apps.organizations.views import (  # noqa: E402
    InvitationAcceptByIdView,
    InvitationAcceptView,
    InvitationDeclineView,
    MyInvitationsView,
)
from apps.sadmin.views import FeedbackSubmitView  # noqa: E402
from apps.teams.views import PublicTeamCalendarView

api_v1 = [
    path("accounts/", include("apps.accounts.urls")),
    path("orgs/", include("apps.organizations.urls")),
    # Top-level invitation accept endpoint (AIP-136 colon verb at root).
    path(
        "invitations:accept/",
        InvitationAcceptView.as_view(),
        name="invitations-accept",
    ),
    # In-app invitations inbox (logged-in invitee). The bare `invitations/`
    # list + the `<uuid>:accept/`/`<uuid>:decline/` colon verbs are distinct
    # from the token-based `invitations:accept/` above (that has no UUID
    # segment), so there is no route collision.
    path(
        "invitations/",
        MyInvitationsView.as_view(),
        name="my-invitations",
    ),
    path(
        "invitations/<uuid:invitation_id>:accept/",
        InvitationAcceptByIdView.as_view(),
        name="invitation-accept-by-id",
    ),
    path(
        "invitations/<uuid:invitation_id>:decline/",
        InvitationDeclineView.as_view(),
        name="invitation-decline",
    ),
    path("permissions/", include("apps.permissions.urls")),
    path("audit/", include("apps.audit.urls")),
    # Phase 1B-prep: sports catalog (read-only metadata).
    path("sports/", include("apps.sports.urls")),
    # Phase 1B: tournaments (self-serve create + list).
    path("tournaments/", include("apps.tournaments.urls")),
    # AI setup assistant (Gemini) — tournament-scoped chat that fills the form.
    path("tournaments/<uuid:tournament_id>/assistant/", include("apps.assistant.urls")),
    # Phase 1B: public school self-registration via shareable link.
    path("register/", include("apps.teams.urls")),
    # Phase 1B: data-driven registration form builder.
    path("forms/", include("apps.forms.urls")),
    # Phase 1B: match scoring endpoints.
    path("matches/", include("apps.matches.urls")),
    # Phase 1B: in-app notifications (the bell).
    path("notifications/", include("apps.notifications.urls")),
    # Phase 1B: dispute resolution endpoints.
    path("disputes/", include("apps.disputes.urls")),
    # Phase 1B: public live viewer snapshot (one-way; SSE upgrade later).
    path("live/", include("apps.live.urls")),
    # Trust layer (increment H): public schedule + per-team iCal feed.
    path(
        "tournaments/<uuid:tournament_id>/badges/",
        TournamentBadgesView.as_view(),
        name="tournament-badges",
    ),
    path(
        "public/tournaments/<slug:slug>/<uuid:tournament_id>/badges/",
        PublicTournamentBadgesView.as_view(),
        name="public-tournament-badges",
    ),
    path(
        "public/badges/<uuid:award_id>/card.png",
        BadgeCardView.as_view(),
        name="public-badge-card",
    ),
    path(
        "public/tournaments/",
        PublicTournamentDirectoryView.as_view(),
        name="public-tournament-directory",
    ),
    path(
        "public/tournaments/<slug:slug>/<uuid:tournament_id>/teams/<uuid:team_id>/",
        PublicTeamRecordView.as_view(),
        name="public-team-record",
    ),
    path(
        "public/tournaments/<slug:slug>/<uuid:tournament_id>/institutions/<uuid:inst_id>/record/",
        PublicInstitutionRecordView.as_view(),
        name="public-institution-record",
    ),
    path(
        "public/tournaments/<slug:slug>/<uuid:tournament_id>/schedule/",
        PublicTournamentScheduleView.as_view(),
        name="public-tournament-schedule",
    ),
    # Control room (spec 2026-06-12 §2.d): public read-only standings.
    path(
        "public/tournaments/<slug:slug>/<uuid:tournament_id>/standings/",
        PublicTournamentStandingsView.as_view(),
        name="public-tournament-standings",
    ),
    # Control room (spec 2026-06-12 §2.c): public one-way SSE tick stream —
    # UUIDs only, zero PII; same slug+status gating as the public schedule.
    path(
        "public/tournaments/<slug:slug>/<uuid:tournament_id>/stream/",
        tournament_stream,
        name="public-tournament-stream",
    ),
    path(
        "public/teams/<uuid:team_id>/calendar.ics",
        PublicTeamCalendarView.as_view(),
        name="public-team-calendar",
    ),
    # Public feedback submit endpoint backing the SPA's feedback widget
    # (v1Users.md A.2 personal.feedback_widget). Throttled to 10/hr/user.
    path(
        "feedback/submit/",
        FeedbackSubmitView.as_view(),
        name="feedback-submit",
    ),
]

urlpatterns = [
    path("api/", include(api_v1)),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("sadmin/", include("apps.sadmin.urls")),
]

if settings.DEBUG:
    from django.conf.urls.static import static

    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
