"""Notifications — per-user in-app notifications (the bell). Delivery to the
SPA is via SSE on `user:<uuid>:notifications` (apps.live); these rows are the
durable record (PRD §8). Idempotent on event_id (invariant #3)."""
from __future__ import annotations

from django.conf import settings
from django.db import models

from apps.accounts.models import uuid7


class Notification(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="notifications",
    )
    kind = models.CharField(max_length=64)  # e.g. "team_registered", "match_scored"
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True)
    url = models.CharField(max_length=300, blank=True)
    read_at = models.DateTimeField(null=True, blank=True, db_index=True)
    event_id = models.UUIDField(unique=True, null=True, blank=True)  # idempotency #3
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "notifications_notification"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "read_at"], name="notif_user_read_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.kind} -> {self.user_id}"


class NotificationPreference(models.Model):
    """Per-user delivery preferences (Phase 1B). `prefs` maps a notification
    kind to its channel switches ({"match_assignment": {"in_app": true,
    "email": false}, ...}); kinds absent from the map fall back to the
    catalog defaults in services/prefs.py, so newly-added kinds work without
    a data migration. `digest` opts into the daily unread-summary email."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_preference",
    )
    prefs = models.JSONField(default=dict, blank=True)
    digest = models.BooleanField(default=False)
    digest_sent_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notifications_preference"

    def __str__(self) -> str:  # pragma: no cover
        return f"prefs -> {self.user_id}"
