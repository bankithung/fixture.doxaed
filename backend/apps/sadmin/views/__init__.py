"""View module exports for url wiring."""
from apps.sadmin.views.audit import audit_search
from apps.sadmin.views.auth import sadmin_login, sadmin_logout
from apps.sadmin.views.dashboard import dashboard, dashboard_kpis
from apps.sadmin.views.feedback import (
    FeedbackSubmitView,
    feedback_list,
    feedback_triage,
)
from apps.sadmin.views.orgs import org_verb, orgs_detail, orgs_list
from apps.sadmin.views.superadmin import (
    archive_feedback_api,
    bulk_email_api,
    system_health_api,
)
from apps.sadmin.views.users import (
    impersonate_stop,
    user_verb,
    users_detail,
    users_list,
)

__all__ = [
    "FeedbackSubmitView",
    "archive_feedback_api",
    "audit_search",
    "bulk_email_api",
    "dashboard",
    "dashboard_kpis",
    "feedback_list",
    "feedback_triage",
    "impersonate_stop",
    "org_verb",
    "orgs_detail",
    "orgs_list",
    "sadmin_login",
    "sadmin_logout",
    "system_health_api",
    "user_verb",
    "users_detail",
    "users_list",
]
