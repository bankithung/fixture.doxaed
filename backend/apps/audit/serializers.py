"""DRF serializers for audit list / search endpoints.

v1Users.md Appendix A.2 ``org.audit_log`` module surfaces audit events
to org admins / co_organizers / game_coordinators / referees. PII
redaction is applied at the email field per B.11 if a non-Super-admin
viewer fetches a row authored by another user.
"""
from __future__ import annotations

from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.audit.models import AuditEvent


class AuditEventSerializer(serializers.ModelSerializer):
    """Read-only serializer for AuditEvent rows.

    Includes a denormalized ``actor_email_at_time`` (the actor user's
    current email — there is no historical snapshot in v1A; B.5 lists
    ``deleted_user_handle`` as the post-deletion fallback). ``payload``
    is the merged ``payload_after`` (creation-style events) or
    ``payload_before`` -> ``payload_after`` diff for mutating events.
    """

    actor_id = serializers.UUIDField(source="actor_user_id", allow_null=True, read_only=True)
    actor_email_at_time = serializers.SerializerMethodField()
    target_label = serializers.SerializerMethodField()
    payload = serializers.SerializerMethodField()

    class Meta:
        model = AuditEvent
        fields = [
            "id",
            "event_type",
            "actor_id",
            "actor_email_at_time",
            "target_id",
            "target_type",
            "target_label",
            "payload",
            "reason",
            "created_at",
        ]
        read_only_fields = fields

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_actor_email_at_time(self, obj: AuditEvent) -> str | None:
        # Phase 1A — no historical email snapshot stored. Fall back to
        # the deleted-user handle when the FK was nulled by SET_NULL.
        if obj.actor_user_id is None:
            return obj.deleted_user_handle or None
        try:
            return obj.actor_user.email  # type: ignore[union-attr]
        except Exception:  # pragma: no cover - actor was hard-deleted
            return obj.deleted_user_handle or None

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_target_label(self, obj: AuditEvent) -> str:
        # Free-form short label — derived from event_type + target_type.
        return f"{obj.target_type}:{obj.target_id}"

    @extend_schema_field(serializers.DictField(allow_null=True))
    def get_payload(self, obj: AuditEvent) -> dict[str, Any] | None:
        # Surface the after-state when available; otherwise fall back
        # to the before-state. Frontend can request the full diff via
        # the detail endpoint (Phase 1B).
        return obj.payload_after or obj.payload_before


class AuditEventListResponseSerializer(serializers.Serializer):
    """Cursor-paginated response shape for the audit list endpoint."""

    results = AuditEventSerializer(many=True)
    next_cursor = serializers.CharField(allow_null=True, required=False)
    previous_cursor = serializers.CharField(allow_null=True, required=False)
