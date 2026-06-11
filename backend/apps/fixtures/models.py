"""Scheduling resources (spec 2026-06-10 P3)."""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q, UniqueConstraint

from apps.accounts.models import uuid7


class Venue(models.Model):
    """A physical facility (ground / hall / court block) owned by the
    workspace and shared across its tournaments. ``venue_type`` matches the
    sport profiles' venue requirement ("ground", "indoor_court", ...);
    ``windows`` is a list of {"from": "09:00", "to": "18:00"} availability
    windows (empty = inherits the run's daily window). Matches keep storing
    the venue NAME (CharField) for back-compat — the scheduler resolves rich
    records by name at run time."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="venues",
    )
    name = models.CharField(max_length=120)
    venue_type = models.CharField(max_length=40, blank=True)
    windows = models.JSONField(default=list, blank=True)
    # Courts/tables/pitches at this venue (fixture-engine redesign §2.3): the
    # scheduler expands count=4 into 4 parallel sub-venues ("MP Hall · T1"…).
    count = models.PositiveSmallIntegerField(default=1)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="venues_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "fixtures_venue"
        constraints = [
            UniqueConstraint(
                fields=["organization", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_venue_name_per_org",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return self.name
