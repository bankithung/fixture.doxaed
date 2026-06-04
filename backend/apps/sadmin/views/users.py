"""User list/detail/verb views + impersonation control."""
from __future__ import annotations

import uuid

from django.core.paginator import Paginator
from django.http import HttpRequest, HttpResponse, HttpResponseRedirect
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.views.decorators.http import require_GET, require_POST

from apps.accounts.models import User
from apps.audit.models import AuditEvent
from apps.sadmin.decorators import superadmin_required
from apps.sadmin.services import superadmin_verbs
from apps.sadmin.views._helpers import render_sadmin, render_verb_result


@superadmin_required
@require_GET
def users_list(request: HttpRequest) -> HttpResponse:
    qs = User.objects.all().order_by("-date_joined")
    q = (request.GET.get("q") or "").strip()
    status_filter = (request.GET.get("status") or "").strip()
    if q:
        qs = qs.filter(email__icontains=q)
    if status_filter == "active":
        qs = qs.filter(is_active=True, deleted_at__isnull=True)
    elif status_filter == "inactive":
        qs = qs.filter(is_active=False, deleted_at__isnull=True)
    elif status_filter == "deleted":
        qs = qs.filter(deleted_at__isnull=False)

    paginator = Paginator(qs, 25)
    page_obj = paginator.get_page(request.GET.get("page") or 1)
    return render_sadmin(
        request,
        "sadmin/users/list.html",
        {"page_obj": page_obj, "q": q, "status_filter": status_filter},
    )


@superadmin_required
@require_GET
def users_detail(request: HttpRequest, user_id: uuid.UUID) -> HttpResponse:
    subject = get_object_or_404(User, pk=user_id)
    memberships = []
    try:
        memberships = list(
            subject.org_memberships.select_related("organization")
            .filter(is_active=True)
        )
    except Exception:
        memberships = []
    audit_events = (
        AuditEvent.objects.filter(target_id=subject.id, target_type="user")
        .order_by("-created_at")[:20]
    )
    return render_sadmin(
        request,
        "sadmin/users/detail.html",
        {
            "subject_user": subject,
            "memberships": memberships,
            "audit_events": audit_events,
        },
    )


@superadmin_required
@require_POST
def user_verb(request: HttpRequest, user_id: uuid.UUID, verb: str) -> HttpResponse:
    subject = get_object_or_404(User, pk=user_id)
    actor = request.user
    reason = (request.POST.get("reason") or "").strip()

    try:
        if verb == "suspend":
            superadmin_verbs.suspend_user(
                user=subject, suspended_by=actor, reason=reason, request=request
            )
            msg = f"Suspended {subject.email}."
        elif verb == "unsuspend":
            superadmin_verbs.unsuspend_user(
                user=subject, unsuspended_by=actor, request=request
            )
            msg = f"Unsuspended {subject.email}."
        elif verb == "force_logout_all":
            n = superadmin_verbs.force_logout_all(
                user=subject, requested_by=actor, reason=reason, request=request
            )
            msg = f"Force-logged-out {subject.email} ({n} sessions deleted)."
        elif verb == "force_password_reset":
            superadmin_verbs.force_password_reset(
                user=subject, requested_by=actor, reason=reason, request=request
            )
            msg = f"Issued password-reset token for {subject.email}."
        elif verb == "unlock_account":
            superadmin_verbs.unlock_account(
                user=subject, requested_by=actor, request=request
            )
            msg = f"Cleared axes lockout for {subject.email}."
        elif verb == "impersonate_start":
            superadmin_verbs.impersonate_start(
                target_user=subject,
                requested_by=actor,
                reason=reason,
                request=request,
            )
            msg = f"Impersonating {subject.email}. Banner is now active."
        else:
            return render_verb_result(request, ok=False, message=f"Unknown verb: {verb}")
    except Exception as exc:
        return render_verb_result(request, ok=False, message=str(exc))

    return render_verb_result(request, ok=True, message=msg)


@superadmin_required
@require_POST
def impersonate_stop(request: HttpRequest) -> HttpResponse:
    superadmin_verbs.impersonate_stop(request=request)
    return HttpResponseRedirect(reverse("sadmin:dashboard"))
