"""Registration form engine — data-driven (FET-style) forms.

`Form.schema` (JSONB) is the form definition; `FormResponse.answers` (JSONB)
the submission. Mirrors the Tournament.rules/constraints JSONB pattern. All
models are org-scoped (invariant #2) with UUID v7 PKs (invariant #1).
"""
from __future__ import annotations

from django.conf import settings as django_settings
from django.db import models
from django.db.models import Q, UniqueConstraint

from apps.accounts.models import uuid7
from apps.forms.constants import FormPurpose, FormStatus, ResponseStatus


class Form(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="forms"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="forms"
    )
    slug = models.CharField(max_length=63)
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    purpose = models.CharField(
        max_length=32, choices=FormPurpose.choices, default=FormPurpose.GENERIC
    )
    # The TournamentStage this form is bound to (e.g. "org_registration",
    # "team_registration"), so advancing/reopening a stage can auto-close/re-open
    # it. Empty = not stage-bound (generic form; never auto-closed). See
    # spec 2026-06-08 §2.3. `purpose` governs entity mapping; `stage` governs the
    # setup-workflow lifecycle.
    stage = models.CharField(max_length=24, blank=True, db_index=True)
    schema = models.JSONField(default=dict, blank=True)
    status = models.CharField(
        max_length=12, choices=FormStatus.choices, default=FormStatus.DRAFT, db_index=True
    )
    opens_at = models.DateTimeField(null=True, blank=True)
    closes_at = models.DateTimeField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)
    max_responses = models.PositiveIntegerField(null=True, blank=True)
    response_count = models.PositiveIntegerField(default=0)
    confirmation_message = models.TextField(blank=True)
    settings = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="forms_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "forms_form"
        constraints = [
            UniqueConstraint(
                fields=["tournament", "slug"],
                condition=Q(deleted_at__isnull=True),
                name="unique_form_slug_per_tournament",
            ),
        ]
        indexes = [models.Index(fields=["tournament", "status"], name="form_trn_status_idx")]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.title} ({self.slug})"


class FormShareLink(models.Model):
    """Public access token for a form (generalizes teams.RegistrationLink)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="form_share_links"
    )
    form = models.ForeignKey(Form, on_delete=models.CASCADE, related_name="share_links")
    token_hash = models.CharField(max_length=128, db_index=True)
    label = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    max_submissions = models.PositiveIntegerField(null=True, blank=True)
    submission_count = models.PositiveIntegerField(default=0)
    bound_entity = models.JSONField(default=dict, blank=True)
    prefill = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="form_share_links_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "forms_share_link"

    def __str__(self) -> str:  # pragma: no cover
        return f"FormShareLink({self.form_id})"


class FormResponse(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    form = models.ForeignKey(Form, on_delete=models.CASCADE, related_name="responses")
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="form_responses"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="form_responses"
    )
    answers = models.JSONField(default=dict, blank=True)
    form_version = models.PositiveIntegerField(default=1)
    respondent_email = models.CharField(max_length=254, blank=True, db_index=True)
    respondent_phone = models.CharField(max_length=32, blank=True, db_index=True)
    respondent_name = models.CharField(max_length=200, blank=True)
    title = models.CharField(max_length=200, blank=True, db_index=True)
    status = models.CharField(
        max_length=12, choices=ResponseStatus.choices,
        default=ResponseStatus.SUBMITTED, db_index=True,
    )
    event_id = models.UUIDField(null=True, blank=True)
    submitted_via = models.ForeignKey(
        FormShareLink, null=True, blank=True, on_delete=models.SET_NULL, related_name="responses"
    )
    mapped_entities = models.JSONField(default=dict, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "forms_response"
        constraints = [
            UniqueConstraint(
                fields=["form", "event_id"],
                condition=Q(event_id__isnull=False),
                name="unique_form_response_event_id",
            ),
        ]
        indexes = [
            models.Index(fields=["form", "status"], name="resp_form_status_idx"),
            models.Index(fields=["form", "created_at"], name="resp_form_created_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"FormResponse({self.form_id})"


class FormFileUpload(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="form_uploads"
    )
    form = models.ForeignKey(Form, on_delete=models.CASCADE, related_name="uploads")
    response = models.ForeignKey(
        FormResponse, null=True, blank=True, on_delete=models.SET_NULL, related_name="files"
    )
    field_key = models.CharField(max_length=80)
    upload_ref = models.UUIDField(default=uuid7, db_index=True, editable=False)
    file = models.FileField(upload_to="form_uploads/%Y/%m/")
    original_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=127)
    size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "forms_file_upload"

    def __str__(self) -> str:  # pragma: no cover
        return self.original_name
