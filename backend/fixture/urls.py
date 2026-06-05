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

from apps.organizations.views import InvitationAcceptView  # noqa: E402
from apps.sadmin.views import FeedbackSubmitView  # noqa: E402

api_v1 = [
    path("accounts/", include("apps.accounts.urls")),
    path("orgs/", include("apps.organizations.urls")),
    # Top-level invitation accept endpoint (AIP-136 colon verb at root).
    path(
        "invitations:accept/",
        InvitationAcceptView.as_view(),
        name="invitations-accept",
    ),
    path("permissions/", include("apps.permissions.urls")),
    path("audit/", include("apps.audit.urls")),
    # Phase 1B-prep: sports catalog (read-only metadata).
    path("sports/", include("apps.sports.urls")),
    # Phase 1B: tournaments (self-serve create + list).
    path("tournaments/", include("apps.tournaments.urls")),
    # Phase 1B: public school self-registration via shareable link.
    path("register/", include("apps.teams.urls")),
    # Phase 1B: match scoring endpoints.
    path("matches/", include("apps.matches.urls")),
    # Phase 1B: in-app notifications (the bell).
    path("notifications/", include("apps.notifications.urls")),
    # Phase 1B: dispute resolution endpoints.
    path("disputes/", include("apps.disputes.urls")),
    # Phase 1B: public live viewer snapshot (one-way; SSE upgrade later).
    path("live/", include("apps.live.urls")),
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
