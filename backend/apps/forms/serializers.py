from __future__ import annotations

from typing import Any

from rest_framework import serializers

from apps.forms.models import Form
from apps.forms.services.schema import SchemaError, validate_schema


class FormSchemaField(serializers.JSONField):
    """A JSON field that runs ``validate_schema`` on any non-empty schema so an
    invalid form definition is rejected at the API boundary (400, not 500)."""

    def to_internal_value(self, data: Any) -> Any:
        data = super().to_internal_value(data)
        try:
            if isinstance(data, dict) and data.get("sections"):
                validate_schema(data)
        except SchemaError as e:
            raise serializers.ValidationError(str(e)) from e
        return data


class FormSerializer(serializers.ModelSerializer):
    schema = FormSchemaField(required=False)

    class Meta:
        model = Form
        fields = [
            "id", "slug", "title", "description", "purpose", "schema", "status",
            "opens_at", "closes_at", "version", "max_responses", "response_count",
            "confirmation_message", "settings", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "slug", "status", "version", "response_count",
                            "created_at", "updated_at"]


class FormCreateSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200)
    purpose = serializers.ChoiceField(
        choices=["organization_registration", "team_registration", "generic"],
        default="organization_registration",
    )
    schema = FormSchemaField(required=False)
