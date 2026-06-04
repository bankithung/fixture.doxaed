"""Organization list/detail/verb views."""
from __future__ import annotations

import uuid

from django.core.paginator import Paginator
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_GET, require_POST

from apps.sadmin.decorators import superadmin_required
from apps.sadmin.services import superadmin_verbs
from apps.sadmin.views._helpers import render_sadmin, render_verb_result


@superadmin_required
@require_GET
def orgs_list(request: HttpRequest) -> HttpResponse:
    from apps.organizations.models import Organization, OrgStatus

    qs = Organization.objects.filter(deleted_at__isnull=True).order_by("-created_at")
    q = (request.GET.get("q") or "").strip()
    status_filter = (request.GET.get("status") or "").strip()
    if q:
        qs = qs.filter(name__icontains=q) | qs.filter(slug__icontains=q)
    if status_filter and status_filter in OrgStatus.values:
        qs = qs.filter(status=status_filter)

    paginator = Paginator(qs, 25)
    page_obj = paginator.get_page(request.GET.get("page") or 1)
    return render_sadmin(
        request,
        "sadmin/orgs/list.html",
        {
            "page_obj": page_obj,
            "q": q,
            "status_filter": status_filter,
            "statuses": OrgStatus.choices,
        },
    )


@superadmin_required
@require_GET
def orgs_detail(request: HttpRequest, org_id: uuid.UUID) -> HttpResponse:
    from apps.organizations.models import Organization

    org = get_object_or_404(Organization, pk=org_id)
    memberships = org.memberships.select_related("user").filter(is_active=True)
    return render_sadmin(
        request,
        "sadmin/orgs/detail.html",
        {"org": org, "memberships": memberships},
    )


@superadmin_required
@require_POST
def org_verb(request: HttpRequest, org_id: uuid.UUID, verb: str) -> HttpResponse:
    from apps.organizations.models import Organization

    org = get_object_or_404(Organization, pk=org_id)
    reason = (request.POST.get("reason") or "").strip()
    user = request.user

    try:
        if verb == "approve":
            superadmin_verbs.approve_org(org=org, approved_by=user, request=request)
            msg = f"Approved {org.name}."
        elif verb == "reject":
            superadmin_verbs.reject_org(org=org, rejected_by=user, reason=reason, request=request)
            msg = f"Rejected {org.name}."
        elif verb == "suspend":
            superadmin_verbs.suspend_org(org=org, suspended_by=user, reason=reason, request=request)
            msg = f"Suspended {org.name}."
        elif verb == "unsuspend":
            superadmin_verbs.unsuspend_org(org=org, unsuspended_by=user, request=request)
            msg = f"Unsuspended {org.name}."
        else:
            return render_verb_result(request, ok=False, message=f"Unknown verb: {verb}")
    except Exception as exc:
        return render_verb_result(request, ok=False, message=str(exc))

    return render_verb_result(request, ok=True, message=msg)
