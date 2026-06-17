from __future__ import annotations

from typing import Any

from rest_framework import serializers

from apps.forms.models import Form, FormResponse
from apps.forms.services.schema import SchemaError, validate_schema
from apps.tournaments.models import TournamentStage


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
    stale = serializers.SerializerMethodField()
    # Live count of submissions that still exist — the stored counter is only
    # ever incremented, so soft-deleted (e.g. deleted-application) responses
    # would otherwise keep inflating it.
    response_count = serializers.SerializerMethodField()

    class Meta:
        model = Form
        fields = (
            "id", "slug", "title", "description", "purpose", "stage", "schema", "status",
            "opens_at", "closes_at", "version", "max_responses", "response_count",
            "confirmation_message", "settings", "stale", "created_at", "updated_at",
        )
        read_only_fields = ("id", "slug", "stage", "status", "version", "response_count",
                            "stale", "created_at", "updated_at")

    def get_response_count(self, obj) -> int:
        return obj.responses.filter(deleted_at__isnull=True).count()

    def get_stale(self, obj) -> bool:
        """True for a GENERATED form whose inputs (the sports/category config)
        changed after generation (invariant 10) — the UI offers a regenerate.
        Hand-built forms are never stale."""
        s = obj.settings or {}
        if not (s.get("generated_from_sports") or s.get("generated_from")):
            return False
        from apps.tournaments.services.sports import sports_inputs_hash

        return s.get("inputs_hash") != sports_inputs_hash(obj.tournament.sports)


class FormCreateSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200)
    purpose = serializers.ChoiceField(
        choices=["organization_registration", "team_registration", "generic"],
        default="organization_registration",
    )
    # Constrain to real lifecycle stages so a form can't be bound to a typo'd
    # stage that the auto-close mechanism would silently never match.
    stage = serializers.ChoiceField(
        choices=TournamentStage.values, required=False, allow_blank=True, default="",
    )
    source_form_id = serializers.UUIDField(required=False)
    schema = FormSchemaField(required=False)


class FormResponseSerializer(serializers.ModelSerializer):
    """Read-only view of a submitted response for the organizer responses list."""

    class Meta:
        model = FormResponse
        fields = (
            "id", "answers", "form_version", "respondent_email", "respondent_phone",
            "respondent_name", "title", "status", "mapped_entities", "created_at",
        )
        read_only_fields = fields


class ContactAdminSerializer(serializers.Serializer):
    """A public visitor's message to the tournament organisers."""

    name = serializers.CharField(max_length=200)
    email = serializers.EmailField()
    message = serializers.CharField(max_length=5000)


class PublicSubmitSerializer(serializers.Serializer):
    """Validates the shape of a public submission payload. Answer-level
    validation (branching-aware) happens in ``submit_response``."""

    answers = serializers.DictField()
    event_id = serializers.UUIDField(required=False)
    upload_refs = serializers.DictField(required=False, default=dict)
    # Per-file document names ({upload_ref: "Aadhaar card"}) so the admin knows
    # what each uploaded document is.
    file_labels = serializers.DictField(
        required=False, default=dict, child=serializers.CharField(allow_blank=True),
    )
    # Team forms: the signed token from /team-access/ proving the submitter
    # holds the institution's emailed access code.
    access_token = serializers.CharField(required=False, allow_blank=True)
