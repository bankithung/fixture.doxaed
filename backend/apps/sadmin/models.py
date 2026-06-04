"""Super-admin observability models (v1Users.md §1.7).

Three tables back the Super-admin console:

* ``Feedback`` — user-submitted bug/feature/complaint rows. Surfaced
  only in the Super-admin console; PII redaction applied per B.11.
* ``UsageEvent`` — append-only telemetry firehose (analytics + KPI).
* ``KPISnapshot`` — daily rolled-up metrics for the dashboard
  (Appendix B.7 — ``manage.py snapshot_kpi`` upserts today's row).

All three use UUID v7 PKs from ``apps.accounts.models.uuid7`` (B.1).
"""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


# ---------------------------------------------------------------------------
# Feedback (v1Users.md §1.7)
# ---------------------------------------------------------------------------


class FeedbackCategory(models.TextChoices):
    BUG = "bug", _("Bug")
    FEATURE_REQUEST = "feature_request", _("Feature request")
    COMPLAINT = "complaint", _("Complaint")
    PRAISE = "praise", _("Praise")
    OTHER = "other", _("Other")


class FeedbackStatus(models.TextChoices):
    PENDING = "pending", _("Pending")
    TRIAGED = "triaged", _("Triaged")
    RESOLVED = "resolved", _("Resolved")
    WONTFIX = "wontfix", _("Won't fix")


class Feedback(models.Model):
    """User-submitted feedback. Visible only to Super-admin (§1.7)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    # Nullable so anonymous viewers (§1.12, §9.6) can submit, AND so the
    # row survives soft-deletion of the submitter (SET_NULL).
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="feedback_submissions",
    )

    category = models.CharField(
        max_length=24,
        choices=FeedbackCategory.choices,
        default=FeedbackCategory.OTHER,
    )
    subject = models.CharField(max_length=200)
    body = models.TextField()

    status = models.CharField(
        max_length=16,
        choices=FeedbackStatus.choices,
        default=FeedbackStatus.PENDING,
    )

    triaged_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="feedback_triaged",
    )
    triaged_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    # Super-admin only; never exposed to the original submitter.
    internal_notes = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "sadmin_feedback"
        indexes = [
            models.Index(
                fields=["status", "created_at"],
                name="sadmin_fb_status_created_idx",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"Feedback({self.category}, {self.status}): {self.subject[:30]}"


# ---------------------------------------------------------------------------
# UsageEvent (v1Users.md §1.7)
# ---------------------------------------------------------------------------


class UsageEvent(models.Model):
    """Append-only telemetry firehose. Cheap fire-and-forget writes."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="usage_events",
    )
    organization_id = models.UUIDField(null=True, blank=True, db_index=True)

    event_type = models.CharField(max_length=64)
    payload = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "sadmin_usage_event"
        indexes = [
            models.Index(
                fields=["event_type", "created_at"],
                name="sadmin_ue_evt_created_idx",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"UsageEvent({self.event_type})"


# ---------------------------------------------------------------------------
# KPISnapshot (v1Users.md §1.7, Appendix B.7)
# ---------------------------------------------------------------------------


class KPISnapshot(models.Model):
    """Daily rolled-up KPI metrics. Idempotent per snapshot_date."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    snapshot_date = models.DateField(unique=True)
    metrics = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "sadmin_kpi_snapshot"
        ordering = ["-snapshot_date"]

    def __str__(self) -> str:  # pragma: no cover
        return f"KPISnapshot({self.snapshot_date})"
