"""Disputes — lifecycle for protests/appeals (PRD §; v1Disputes.md MVP).

Org-scoped (invariant #2), explicit state machine (invariant #6), audited
transitions, idempotent raise (invariant #3). The cross-result cascade engine
(re-advancement on an upheld score dispute) is a follow-up.
"""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class DisputeStatus(models.TextChoices):
    OPEN = "open", _("Open")
    UNDER_REVIEW = "under_review", _("Under review")
    RESOLVED = "resolved", _("Resolved (upheld)")
    REJECTED = "rejected", _("Rejected")
    WITHDRAWN = "withdrawn", _("Withdrawn")


class Dispute(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="disputes"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="disputes"
    )
    match = models.ForeignKey(
        "matches.Match", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="disputes",
    )
    raised_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="disputes_raised",
    )
    kind = models.CharField(max_length=64)  # e.g. "score", "eligibility", "conduct"
    description = models.TextField()
    status = models.CharField(
        max_length=16, choices=DisputeStatus.choices, default=DisputeStatus.OPEN,
        db_index=True,
    )
    resolution = models.TextField(blank=True)
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="disputes_reviewed",
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    event_id = models.UUIDField(unique=True, null=True, blank=True)  # idempotency #3
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "disputes_dispute"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["tournament", "status"], name="dispute_trn_status_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"Dispute({self.kind}, {self.status})"
