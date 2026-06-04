"""DRF serializers for the permissions endpoints."""
from __future__ import annotations

from rest_framework import serializers

from apps.permissions.models import GrantState, MembershipModuleGrant, Module


class ModuleSerializer(serializers.ModelSerializer):
    """Serializer for the module catalog (read-only, public-ish)."""

    class Meta:
        model = Module
        fields = ["id", "code", "name", "description", "category", "default_for_roles"]
        read_only_fields = fields


class GrantRowSerializer(serializers.ModelSerializer):
    """A single MembershipModuleGrant row, with module code denormalized."""

    module_code = serializers.CharField(source="module.code", read_only=True)

    class Meta:
        model = MembershipModuleGrant
        fields = [
            "id",
            "module_code",
            "state",
            "reason",
            "granted_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class GrantInputSerializer(serializers.Serializer):
    """Single (module, state) pair used inside the bulk grants PUT body."""

    module = serializers.CharField(max_length=64)
    state = serializers.ChoiceField(choices=GrantState.choices)

    def validate_state(self, value: str) -> str:
        valid = {choice for choice, _ in GrantState.choices}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid state: {value!r}")
        return value


class BulkGrantsSerializer(serializers.Serializer):
    """PUT body for /grants/ — replace all grants atomically."""

    grants = GrantInputSerializer(many=True)
    reason = serializers.CharField(min_length=20, max_length=2000)


class EffectiveModulesSerializer(serializers.Serializer):
    """Response shape for GET /me/modules/."""

    modules = serializers.ListField(child=serializers.CharField())


# ---------------------------------------------------------------------------
# Matrix endpoint (B.16)
# ---------------------------------------------------------------------------


class MatrixModuleSerializer(serializers.Serializer):
    """One module row in the matrix `modules` array."""

    key = serializers.CharField()
    scope = serializers.CharField()
    label = serializers.CharField()
    description = serializers.CharField(allow_blank=True)


class MatrixMemberSerializer(serializers.Serializer):
    """One member row in the matrix `members` array."""

    user_id = serializers.CharField()
    user_email = serializers.CharField(allow_blank=True)
    user_full_name = serializers.CharField(allow_blank=True)
    roles = serializers.ListField(child=serializers.CharField())
    cells = serializers.DictField(child=serializers.CharField())
    role_defaults = serializers.DictField(child=serializers.BooleanField())


class MatrixResponseSerializer(serializers.Serializer):
    """Top-level response shape for the matrix endpoint."""

    modules = MatrixModuleSerializer(many=True)
    members = MatrixMemberSerializer(many=True)


class BulkGrantsCellsSerializer(serializers.Serializer):
    """Alternative PUT body shape used by the SPA module-override matrix.

    Frontend sends `{cells: {module_code: "grant"|"deny"|"default"}, reason, event_id}`.
    The view translates this into the `grants=[{module, state}, ...]` shape
    expected by the existing service layer.
    """

    cells = serializers.DictField(
        child=serializers.ChoiceField(choices=GrantState.choices)
    )
    reason = serializers.CharField(min_length=20, max_length=2000)
    # event_id is accepted for idempotency but currently ignored at the
    # service layer (Phase 1A — bulk-grant idempotency lands in Phase 1B
    # with the global event_id table).
    event_id = serializers.UUIDField(required=False)
