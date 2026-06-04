"""DRF serializers for the public-facing sadmin / feedback API.

The Super-admin HTML console under ``/sadmin/`` does NOT use these —
those views render Django templates. These serializers are for the
JSON endpoints exposed under ``/api/feedback/`` (public feedback
widget) and ``/sadmin/api/`` (Super-admin verbs invoked from the
console).
"""
from __future__ import annotations

from rest_framework import serializers

from apps.sadmin.models import FeedbackCategory


class FeedbackSubmitSerializer(serializers.Serializer):
    """Request body for ``POST /api/feedback/submit/``.

    Frontend wires the feedback widget (v1Users.md A.2
    ``personal.feedback_widget``) to this endpoint. Body is PII-redacted
    at the service layer (B.11) so screenshots / page URLs that may
    contain emails or recovery codes are stripped before INSERT.

    ``event_id`` is an optional client-supplied UUID for idempotency
    (PRD invariant 3). When supplied, re-submitting the same id
    returns the existing row (200 instead of 201).
    """

    message = serializers.CharField(min_length=1, max_length=5000)
    page_url = serializers.CharField(max_length=2048, required=False, allow_blank=True)
    screenshot_data_uri = serializers.CharField(
        max_length=5_000_000,  # ~3.7 MB worth of base64 — generous cap.
        required=False,
        allow_blank=True,
    )
    category = serializers.ChoiceField(
        choices=FeedbackCategory.choices,
        required=False,
        default=FeedbackCategory.OTHER,
    )
    subject = serializers.CharField(max_length=200, required=False, allow_blank=True)
    event_id = serializers.UUIDField(required=False)


class FeedbackSubmitResponseSerializer(serializers.Serializer):
    """Response body for the public submit endpoint."""

    id = serializers.UUIDField()


# ---------------------------------------------------------------------------
# Super-admin verbs (JSON shapes for /sadmin/api/...)
# ---------------------------------------------------------------------------


class BulkEmailRequestSerializer(serializers.Serializer):
    """Request body for ``POST /sadmin/api/bulk-email/``."""

    subject = serializers.CharField(min_length=1, max_length=200)
    body = serializers.CharField(min_length=1, max_length=10000)
    target_filter = serializers.DictField(
        child=serializers.CharField(allow_blank=True),
        required=False,
        default=dict,
    )


class BulkEmailResponseSerializer(serializers.Serializer):
    """Response body for the bulk-email draft endpoint."""

    recipients = serializers.IntegerField()
    subject = serializers.CharField()
    body = serializers.CharField()


class SystemHealthResponseSerializer(serializers.Serializer):
    """Response body for ``GET /sadmin/api/system-health/``."""

    db = serializers.BooleanField()
    redis = serializers.BooleanField(allow_null=True)
    tables = serializers.DictField(child=serializers.IntegerField(allow_null=True))


class FeedbackArchiveResponseSerializer(serializers.Serializer):
    """Response body for ``POST /sadmin/api/feedback/<uuid>:archive/``."""

    id = serializers.UUIDField()
    status = serializers.CharField()
