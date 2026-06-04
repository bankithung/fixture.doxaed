"""AuditEvent model — append-only at DB level.

Every state-changing verb in v1Users.md emits one of these via
apps.audit.services.emit_audit() (B.4 service-layer pattern).

The audit agent owns the Postgres role-deny migration that physically
prevents UPDATE/DELETE on this table at the database role level
(invariant 5: append-only audit at DB level).
"""
from __future__ import annotations

import uuid
from typing import Any

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class ActorRole(models.TextChoices):
    """Locked taxonomy from v1Users.md B.5."""

    SUPER_ADMIN = "super_admin", _("Super-admin")
    ADMIN = "admin", _("Admin")
    CO_ORGANIZER = "co_organizer", _("Co-organizer")
    GAME_COORDINATOR = "game_coordinator", _("Game coordinator")
    MATCH_SCORER = "match_scorer", _("Match scorer")
    REFEREE = "referee", _("Referee")
    TEAM_MANAGER = "team_manager", _("Team manager")
    SYSTEM = "system", _("System (auto-transition)")


class AuditEvent(models.Model):
    """Append-only event log.

    DB role enforcement (v1Users.md invariant 5) is added by a
    separate migration the audit agent writes. UPDATE/DELETE on this
    table are denied at the Postgres role layer, not just app layer.

    Every row carries actor identity, role snapshot, target, and a
    before/after JSONB plus optional reason. Idempotency is via the
    `idempotency_key` UUID supplied by the service-layer caller.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    idempotency_key = models.UUIDField(unique=True, null=True, blank=True)

    # Actor — see B.5 taxonomy
    actor_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,  # preserved as deleted_user_handle below
        related_name="+",
    )
    actor_role = models.CharField(max_length=32, choices=ActorRole.choices)
    deleted_user_handle = models.CharField(max_length=64, blank=True)
    impersonating_user_id = models.UUIDField(null=True, blank=True)

    # Scope (any of these may be null depending on event)
    organization_id = models.UUIDField(null=True, blank=True, db_index=True)
    tournament_id = models.UUIDField(null=True, blank=True, db_index=True)
    match_id = models.UUIDField(null=True, blank=True, db_index=True)

    # Target
    event_type = models.CharField(max_length=64, db_index=True)
    target_type = models.CharField(max_length=64, db_index=True)
    target_id = models.UUIDField(db_index=True)

    payload_before = models.JSONField(null=True, blank=True)
    payload_after = models.JSONField(null=True, blank=True)
    reason = models.TextField(blank=True)

    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=255, blank=True)

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "audit_event"
        indexes = [
            models.Index(
                fields=["organization_id", "-created_at"],
                name="audit_org_created_idx",
            ),
            models.Index(
                fields=["target_type", "target_id", "-created_at"],
                name="audit_target_created_idx",
            ),
            models.Index(
                fields=["actor_user", "-created_at"],
                name="audit_actor_created_idx",
            ),
        ]
        # NOTE: ordering NOT set — created_at + UUID v7 PK gives natural order.

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.event_type} {self.target_type}:{self.target_id}"


def serialize_payload(d: dict[str, Any] | None) -> dict[str, Any] | None:
    """Stub for payload serialization. Real impl belongs to the audit agent.
    UUIDs and datetimes need normalization. Placeholder for now.
    """
    return d
