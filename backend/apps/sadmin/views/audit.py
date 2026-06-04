"""Audit log search view (basic — defers rich filtering to audit app)."""
from __future__ import annotations

import uuid

from django.core.paginator import Paginator
from django.http import HttpRequest, HttpResponse
from django.views.decorators.http import require_GET

from apps.audit.models import AuditEvent
from apps.sadmin.decorators import superadmin_required
from apps.sadmin.views._helpers import render_sadmin


@superadmin_required
@require_GET
def audit_search(request: HttpRequest) -> HttpResponse:
    qs = AuditEvent.objects.select_related("actor_user").order_by("-created_at")

    event_type = (request.GET.get("event_type") or "").strip()
    actor = (request.GET.get("actor") or "").strip()
    org_raw = (request.GET.get("org") or "").strip()

    if event_type:
        qs = qs.filter(event_type__icontains=event_type)
    if actor:
        qs = qs.filter(actor_user__email__icontains=actor)
    if org_raw:
        try:
            qs = qs.filter(organization_id=uuid.UUID(org_raw))
        except (ValueError, TypeError):
            pass

    paginator = Paginator(qs, 50)
    page_obj = paginator.get_page(request.GET.get("page") or 1)
    return render_sadmin(
        request,
        "sadmin/audit/search.html",
        {
            "page_obj": page_obj,
            "event_type": event_type,
            "actor": actor,
            "org_id": org_raw,
        },
    )
