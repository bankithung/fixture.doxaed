"""DRF serializers for the organizations app."""
from __future__ import annotations

from zoneinfo import available_timezones

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from apps.organizations.models import (
    AdminInvitation,
    InviteStatus,
    MembershipRole,
    Organization,
    OrganizationMembership,
)
from apps.organizations.services.slug import validate_slug as svc_validate_slug


_TZ_NAMES = available_timezones()


# ---------------------------------------------------------------------------
# Organization
# ---------------------------------------------------------------------------


class OrganizationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Organization
        fields = [
            "id",
            "slug",
            "name",
            "status",
            "time_zone",
            "created_at",
            "archived_at",
            "suspended_at",
            "suspended_reason",
        ]
        read_only_fields = [
            "id",
            "status",
            "created_at",
            "archived_at",
            "suspended_at",
            "suspended_reason",
        ]


class OrganizationCreateSerializer(serializers.Serializer):
    slug = serializers.CharField(max_length=63)
    name = serializers.CharField(max_length=200)
    time_zone = serializers.CharField(max_length=64, default="Asia/Kolkata")

    def validate_slug(self, value: str) -> str:
        try:
            return svc_validate_slug(value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages))

    def validate_time_zone(self, value: str) -> str:
        if value not in _TZ_NAMES:
            raise serializers.ValidationError(f"Unknown IANA time zone '{value}'.")
        return value


class OrganizationUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False)
    time_zone = serializers.CharField(max_length=64, required=False)

    def validate_time_zone(self, value: str) -> str:
        if value not in _TZ_NAMES:
            raise serializers.ValidationError(f"Unknown IANA time zone '{value}'.")
        return value


class ChangeSlugSerializer(serializers.Serializer):
    new_slug = serializers.CharField(max_length=63)


class SuspendSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=500)


class ArchiveSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=500)


class TransferOwnershipSerializer(serializers.Serializer):
    """Accepts either ``new_owner_user_id`` (canonical) or ``to_user_id``
    (frontend alias). At least one must be present.
    """

    new_owner_user_id = serializers.UUIDField(required=False)
    to_user_id = serializers.UUIDField(required=False)
    reason = serializers.CharField(max_length=500, required=False, allow_blank=True)
    event_id = serializers.UUIDField(required=False)
    conflict_acknowledged = serializers.BooleanField(required=False)

    def validate(self, attrs):
        new_id = attrs.get("new_owner_user_id") or attrs.get("to_user_id")
        if not new_id:
            raise serializers.ValidationError(
                "Either 'new_owner_user_id' or 'to_user_id' is required."
            )
        attrs["new_owner_user_id"] = new_id
        return attrs


# ---------------------------------------------------------------------------
# Aggregated member-detail (slug routes)
# ---------------------------------------------------------------------------


class OrgMemberDetailSerializer(serializers.Serializer):
    """Shape returned by ``GET /api/orgs/{slug}/members/``.

    Pre-aggregated by the view: one entry per user with roles[] (distinct
    role strings from all that user's active membership rows in this
    org), the earliest joined_at, and OR(is_org_owner) across rows.
    """

    id = serializers.UUIDField()
    user_id = serializers.UUIDField()
    email = serializers.EmailField()
    full_name = serializers.CharField(allow_blank=True)
    roles = serializers.ListField(child=serializers.CharField())
    is_org_owner = serializers.BooleanField()
    joined_at = serializers.DateTimeField()
    is_active = serializers.BooleanField()


# ---------------------------------------------------------------------------
# Membership
# ---------------------------------------------------------------------------


class OrganizationMembershipSerializer(serializers.ModelSerializer):
    class Meta:
        model = OrganizationMembership
        fields = [
            "id",
            "user",
            "organization",
            "role",
            "is_org_owner",
            "is_active",
            "created_at",
            "removed_at",
        ]
        read_only_fields = fields


# ---------------------------------------------------------------------------
# AdminInvitation
# ---------------------------------------------------------------------------


class AdminInvitationSerializer(serializers.ModelSerializer):
    """Read-side serializer. Surfaces effective_status (computed) which
    flips pending→expired when expires_at is in the past, even if the
    DB row hasn't been swept yet (we don't run a cron — read-time
    materialization).
    """

    effective_status = serializers.CharField(read_only=True)

    class Meta:
        model = AdminInvitation
        fields = [
            "id",
            "organization",
            "email",
            "role",
            "status",
            "effective_status",
            "expires_at",
            "accepted_at",
            "revoked_at",
            "created_at",
            "invited_by",
        ]
        read_only_fields = fields


class AdminInvitationCreateSerializer(serializers.Serializer):
    """Body shape accepted by both the UUID-routed and slug-routed
    invitation-create endpoints.

    Either ``role`` (single string, legacy) or ``roles`` (list, sent by
    the SPA) may be given. ``event_id`` is the optional idempotency key
    (UUID).
    """

    email = serializers.EmailField()
    role = serializers.ChoiceField(
        choices=MembershipRole.choices, required=False
    )
    roles = serializers.ListField(
        child=serializers.ChoiceField(choices=MembershipRole.choices),
        required=False,
        allow_empty=False,
    )
    event_id = serializers.UUIDField(required=False)

    def validate(self, attrs):
        if "role" not in attrs and "roles" not in attrs:
            attrs["role"] = MembershipRole.CO_ORGANIZER
        return attrs


class AcceptInvitationSerializer(serializers.Serializer):
    token = serializers.CharField(max_length=128)


class RevokeInvitationSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=500, required=False, allow_blank=True)
