"""Feedback list + triage views (HTML) + public submit view (JSON).

The HTML triage views (``feedback_list``, ``feedback_triage``) are
rendered into the Super-admin console under ``/sadmin/feedback/``.

The public submit view (``FeedbackSubmitView``) is a DRF APIView at
``/api/feedback/submit/``; it backs the SPA's feedback widget
(v1Users.md A.2 ``personal.feedback_widget`` — default-on for every
in-org role).
"""
from __future__ import annotations

import logging
import uuid

from django.core.paginator import Paginator
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_GET, require_POST
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from apps.audit.models import AuditEvent
from apps.sadmin.decorators import superadmin_required
from apps.sadmin.models import Feedback, FeedbackCategory, FeedbackStatus
from apps.sadmin.serializers import (
    FeedbackSubmitResponseSerializer,
    FeedbackSubmitSerializer,
)
from apps.sadmin.services.feedback import (
    redact_email,
    submit_feedback,
    triage_feedback,
)
from apps.sadmin.views._helpers import render_sadmin, render_verb_result

logger = logging.getLogger(__name__)


def _decorate(rows, viewer) -> list[Feedback]:
    """Attach a redacted submitter_email per B.11 PII rules."""
    decorated: list[Feedback] = []
    for fb in rows:
        # Super-admin sees full email; redact_email returns it unchanged.
        email = fb.submitted_by.email if fb.submitted_by_id else ""
        fb.submitter_email = redact_email(email, viewer) if email else "[anonymous]"
        decorated.append(fb)
    return decorated


@superadmin_required
@require_GET
def feedback_list(request: HttpRequest) -> HttpResponse:
    qs = Feedback.objects.select_related("submitted_by").order_by("-created_at")
    status_filter = (request.GET.get("status") or "").strip()
    category_filter = (request.GET.get("category") or "").strip()
    if status_filter and status_filter in FeedbackStatus.values:
        qs = qs.filter(status=status_filter)
    if category_filter and category_filter in FeedbackCategory.values:
        qs = qs.filter(category=category_filter)

    paginator = Paginator(qs, 25)
    page_obj = paginator.get_page(request.GET.get("page") or 1)
    page_obj.object_list = _decorate(page_obj.object_list, request.user)
    return render_sadmin(
        request,
        "sadmin/feedback/list.html",
        {
            "page_obj": page_obj,
            "statuses": FeedbackStatus.choices,
            "categories": FeedbackCategory.choices,
            "status_filter": status_filter,
            "category_filter": category_filter,
        },
    )


@superadmin_required
@require_POST
def feedback_triage(request: HttpRequest, feedback_id: uuid.UUID) -> HttpResponse:
    fb = get_object_or_404(Feedback, pk=feedback_id)
    new_status = (request.POST.get("status") or "").strip()
    notes = (request.POST.get("internal_notes") or "").strip()
    try:
        triage_feedback(
            feedback=fb,
            triaged_by=request.user,
            status=new_status,
            internal_notes=notes,
            request=request,
        )
    except ValueError as exc:
        return render_verb_result(request, ok=False, message=str(exc))
    return render_verb_result(
        request, ok=True, message=f"Feedback {fb.subject[:30]} → {new_status}"
    )


# ---------------------------------------------------------------------------
# Public feedback submit (DRF JSON; mounted at /api/feedback/submit/)
# ---------------------------------------------------------------------------


class FeedbackSubmitThrottle(UserRateThrottle):
    """B.11 rate-limit for the feedback widget: 10 / hour / user.

    Uses a dedicated cache scope so it doesn't share counters with the
    default ``user`` throttle bucket (``240/min`` from settings).
    """

    scope = "feedback_submit"
    rate = "10/hour"


class FeedbackSubmitView(APIView):
    """POST /api/feedback/submit/

    Accepts ``{message, page_url?, screenshot_data_uri?, category?,
    subject?, event_id?}``. Writes a ``Feedback`` row (with B.11
    body redaction) and emits a ``feedback_submitted`` audit row.
    Returns ``{id}``.

    Idempotency: when ``event_id`` is supplied and an existing audit
    row carries the same idempotency_key, the prior feedback row is
    returned (200 instead of 201).
    """

    permission_classes = [IsAuthenticated]
    throttle_classes = [FeedbackSubmitThrottle]

    @extend_schema(
        request=FeedbackSubmitSerializer,
        responses={
            201: FeedbackSubmitResponseSerializer,
            200: FeedbackSubmitResponseSerializer,
        },
        description=(
            "Submit feedback from any authenticated user. Body is PII-redacted "
            "at the service layer (B.11). Throttled to 10/hr/user."
        ),
    )
    def post(self, request):
        ser = FeedbackSubmitSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data

        # Compose the body the service layer ingests. We bundle the
        # page_url into the feedback body so the redaction sweep covers
        # it too. Long screenshot data URIs are NOT persisted in v1A
        # (they would bloat the DB row); we just record their presence
        # as a flag.
        message = data["message"]
        page_url = data.get("page_url") or ""
        has_screenshot = bool(data.get("screenshot_data_uri"))

        composed_body_parts = [message.strip()]
        if page_url:
            composed_body_parts.append(f"Page: {page_url}")
        if has_screenshot:
            composed_body_parts.append("[screenshot attached]")
        composed_body = "\n\n".join(p for p in composed_body_parts if p)

        subject = (data.get("subject") or message[:60]).strip() or "Feedback"
        category = data.get("category") or FeedbackCategory.OTHER
        event_id = data.get("event_id")

        # Idempotency: if event_id was previously seen, the service
        # returns the existing Feedback row (we surface 200 instead of
        # 201 to signal the no-op).
        existed_before = False
        if event_id is not None:
            existed_before = Feedback.objects.filter(
                pk__in=AuditEvent.objects.filter(
                    idempotency_key=event_id,
                    event_type="feedback_submitted",
                ).values("target_id")
            ).exists()

        try:
            fb = submit_feedback(
                user=request.user,
                category=category,
                subject=subject,
                body=composed_body,
                request=request,
                event_id=event_id,
            )
        except Exception:
            logger.exception("feedback submit failed")
            return Response(
                {"detail": "Could not record feedback."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return Response(
            {"id": str(fb.id)},
            status=status.HTTP_200_OK if existed_before else status.HTTP_201_CREATED,
        )
