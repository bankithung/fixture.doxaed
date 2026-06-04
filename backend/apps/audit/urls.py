"""audit app URL config.

Mounted by ``fixture/urls.py`` at ``/api/audit/``. The org-scoped audit
list lives at ``/api/audit/orgs/<slug>/`` — placed inside the audit app
(rather than ``apps/organizations/urls.py``) because:

* The audit module is the canonical owner of the AuditEvent surface
  (see CLAUDE.md invariant 5 — append-only audit at the DB level).
* ``apps/organizations/urls.py`` is owned by another agent in this
  parallel-execution batch; keeping the route here avoids stomping on
  their file.
* The mount point ``/api/audit/orgs/<slug>/`` mirrors the AIP-136
  resource-collection shape used by the rest of the API.
"""
from __future__ import annotations

from django.urls import path

from apps.audit.views import OrgAuditListView

app_name = "audit"

urlpatterns = [
    # Org-scoped audit feed, gated by HasModule("org.audit_log").
    path(
        "orgs/<slug:slug>/",
        OrgAuditListView.as_view(),
        name="org-audit-list",
    ),
]
