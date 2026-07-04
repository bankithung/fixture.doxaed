"""URL-routed wrappers for the unwired Super-admin verbs.

The service-layer functions (``apps.sadmin.services.superadmin_verbs.bulk_email``,
``system_health``, and ``apps.sadmin.services.feedback.archive_feedback``)
already exist and are tested. This module wires them to JSON endpoints
mounted under ``/sadmin/api/`` so the Super-admin console front-end can
invoke them.

Access is gated by ``@superadmin_required`` (Phase 1A surface-hide
invariant — non-SA users get 404, anonymous users get 302 to login).
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from apps.sadmin.decorators import superadmin_required
from apps.sadmin.models import Feedback
from apps.sadmin.services.feedback import archive_feedback as svc_archive_feedback
from apps.sadmin.services.superadmin_verbs import (
    bulk_email as svc_bulk_email,
)
from apps.sadmin.services.superadmin_verbs import (
    system_health as svc_system_health,
)

logger = logging.getLogger(__name__)


def _parse_json_body(request: HttpRequest) -> dict[str, Any]:
    """Parse a JSON request body. Falls back to empty dict on failure."""
    raw = request.body or b"{}"
    try:
        parsed = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


@superadmin_required
@require_POST
@csrf_exempt
def bulk_email_api(request: HttpRequest) -> HttpResponse:
    """POST /sadmin/api/bulk-email/

    Phase 1A: drafts a bulk-email row (writes ``bulk_email_drafted``
    audit). Actual SMTP send is deferred to Phase 1B.
    """
    body = _parse_json_body(request)
    subject = (body.get("subject") or "").strip()
    if not subject:
        return JsonResponse(
            {"detail": "subject is required"}, status=400
        )
    text = (body.get("body") or "").strip()
    target_filter = body.get("target_filter") or {}
    if not isinstance(target_filter, dict):
        return JsonResponse(
            {"detail": "target_filter must be an object"}, status=400
        )

    result = svc_bulk_email(
        target_filter=target_filter,
        subject=subject,
        body=text,
        requested_by=request.user,
        request=request,
    )
    return JsonResponse(
        {
            "recipients": result["recipients"],
            "subject": result["subject"],
            "body": result["body"],
        },
        status=200,
    )


@superadmin_required
@require_GET
def system_health_api(request: HttpRequest) -> HttpResponse:
    """GET /sadmin/api/system-health/

    Reads the DB / Redis / table-count probe. Read-only; no audit row.
    """
    info = svc_system_health()
    return JsonResponse(info, status=200)


@superadmin_required
@require_POST
@csrf_exempt
def archive_feedback_api(
    request: HttpRequest, feedback_id: uuid.UUID
) -> HttpResponse:
    """POST /sadmin/api/feedback/<uuid>:archive/

    Marks a Feedback row as resolved + tagged ``[archived]``. Audited.
    """
    fb = get_object_or_404(Feedback, pk=feedback_id)
    archived = svc_archive_feedback(
        feedback=fb,
        archived_by=request.user,
        request=request,
    )
    return JsonResponse(
        {"id": str(archived.id), "status": archived.status},
        status=200,
    )
