"""URL routes for the Super-admin console (HTML, NOT API).

Mounted by the project at ``/sadmin/`` (see fixture/urls.py).
Every view is wrapped in ``@superadmin_required`` (returns 404 to
non-Super-admin users so the surface's existence is hidden — B.15
network-level allowlist further restricts at IP layer).
"""
from __future__ import annotations

from django.urls import path

from apps.sadmin import views

app_name = "sadmin"

urlpatterns = [
    # Auth (the only public URLs in /sadmin/ — everything else 404s for non-SA)
    path("login/", views.sadmin_login, name="login"),
    path("logout/", views.sadmin_logout, name="logout"),

    # Dashboard
    path("", views.dashboard, name="dashboard"),
    path("kpis/", views.dashboard_kpis, name="dashboard_kpis"),

    # Organizations
    path("orgs/", views.orgs_list, name="orgs_list"),
    path("orgs/<uuid:org_id>/", views.orgs_detail, name="orgs_detail"),
    path(
        "orgs/<uuid:org_id>/<str:verb>/",
        views.org_verb,
        name="org_verb",
    ),

    # Users
    path("users/", views.users_list, name="users_list"),
    path("users/<uuid:user_id>/", views.users_detail, name="users_detail"),
    path(
        "users/<uuid:user_id>/<str:verb>/",
        views.user_verb,
        name="user_verb",
    ),
    path("impersonate/stop/", views.impersonate_stop, name="impersonate_stop"),

    # Feedback inbox
    path("feedback/", views.feedback_list, name="feedback_list"),
    path(
        "feedback/<uuid:feedback_id>/triage/",
        views.feedback_triage,
        name="feedback_triage",
    ),

    # Audit log
    path("audit/", views.audit_search, name="audit_search"),

    # ------------------------------------------------------------------
    # JSON API verbs (mounted under /sadmin/api/ — same auth gate as the
    # HTML console; non-SA users get 404, anonymous get a 302 redirect).
    # These wire previously-unwired services from
    # apps/sadmin/services/superadmin_verbs.py and
    # apps/sadmin/services/feedback.py.
    # ------------------------------------------------------------------
    path(
        "api/bulk-email/",
        views.bulk_email_api,
        name="api_bulk_email",
    ),
    path(
        "api/system-health/",
        views.system_health_api,
        name="api_system_health",
    ),
    path(
        "api/feedback/<uuid:feedback_id>:archive/",
        views.archive_feedback_api,
        name="api_archive_feedback",
    ),
]
