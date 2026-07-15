"""Guest Lens ("36 Shots Challenge") — the shared event album captured by the
visiting institutions (spec 2026-07-10).

One :class:`LensCampaign` per tournament; each participating institution gets a
:class:`LensPass` (a QR card credential, sha256-hashed at rest like
``forms.FormShareLink``); teachers upload :class:`LensPhoto` rows through the
no-login pass page. Moderation state is nullable timestamps (invariant 6 in
spirit — never booleans); the derived ``status`` is hidden > approved > pending.
All models are org-scoped (invariant 2) with UUID v7 PKs (invariant 1).
"""
from __future__ import annotations

from django.conf import settings as django_settings
from django.db import models

from apps.accounts.models import uuid7

DEFAULT_TITLE = "Guest Lens"
DEFAULT_TAGLINE = "36 Shots Challenge"
DEFAULT_INSTRUCTIONS = (
    "Scan your school's QR pass to open the upload page. Capture the event "
    "from your school's point of view and upload your best shots from your "
    "own phone. The host reviews every photo before it joins the shared album."
)
DEFAULT_CONSENT_NOTE = (
    "Selected photos may be used by the host for event highlights and social "
    "media. Please upload only appropriate event photos."
)


def default_award_categories() -> list[str]:
    return [
        "Best Team Spirit",
        "Best Sportsmanship Moment",
        "Best Action Shot",
        "Best Fun Fair Moment",
        "Best Visiting School POV",
    ]


def photo_upload_to(instance, filename) -> str:
    return f"lens_photos/{instance.campaign_id}/{instance.upload_ref}.jpg"


def thumb_upload_to(instance, filename) -> str:
    return f"lens_photos/{instance.campaign_id}/{instance.upload_ref}_t.jpg"


class LensCampaign(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="lens_campaigns",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="lens_campaigns",
    )
    title = models.CharField(max_length=120, default=DEFAULT_TITLE)
    tagline = models.CharField(max_length=120, default=DEFAULT_TAGLINE)
    instructions = models.TextField(default=DEFAULT_INSTRUCTIONS, blank=True)
    consent_note = models.TextField(default=DEFAULT_CONSENT_NOTE, blank=True)
    max_photos_per_institution = models.PositiveIntegerField(default=36)
    award_categories = models.JSONField(default=default_award_categories, blank=True)
    # Optional per-institution cap for each category: {category_name: int}.
    # A category absent from the dict has no cap of its own (only the overall
    # max_photos_per_institution applies).
    category_limits = models.JSONField(default=dict, blank=True)
    opened_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="lens_campaigns_created",
    )
    event_id = models.UUIDField(unique=True, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "lens_campaign"
        # A tournament may run several Guest Lens campaigns (e.g. one photo
        # challenge per day / theme). Passes + photos already FK the campaign,
        # so multi-campaign needed only dropping the old one-per-tournament
        # unique constraint (migration 0003).

    def __str__(self) -> str:  # pragma: no cover - repr aid
        return f"LensCampaign({self.tournament_id})"

    @property
    def is_open(self) -> bool:
        return self.opened_at is not None and self.closed_at is None


class LensPass(models.Model):
    """The QR card credential — one active pass per (campaign, institution),
    enforced in the service layer (mint skips, rotate replaces in place)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="lens_passes",
    )
    campaign = models.ForeignKey(
        LensCampaign, on_delete=models.CASCADE, related_name="passes"
    )
    institution = models.ForeignKey(
        "teams.Institution", on_delete=models.CASCADE, related_name="lens_passes"
    )
    token_hash = models.CharField(max_length=128, db_index=True)
    is_active = models.BooleanField(default=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    last_minted_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "lens_pass"

    def __str__(self) -> str:  # pragma: no cover - repr aid
        return f"LensPass({self.institution_id})"


class LensPhoto(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="lens_photos",
    )
    campaign = models.ForeignKey(
        LensCampaign, on_delete=models.CASCADE, related_name="photos"
    )
    institution = models.ForeignKey(
        "teams.Institution", on_delete=models.CASCADE, related_name="lens_photos"
    )
    # Rotation reuses the same pass row, so this FK stays stable; SET_NULL so a
    # deleted pass never cascades away moderated album content.
    access_pass = models.ForeignKey(
        LensPass, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="photos",
    )
    upload_ref = models.UUIDField(default=uuid7, db_index=True, editable=False)
    image = models.FileField(upload_to=photo_upload_to)
    thumb = models.FileField(upload_to=thumb_upload_to)
    original_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100, default="image/jpeg")
    size = models.PositiveIntegerField(default=0)
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    caption = models.CharField(max_length=200, blank=True)
    # The campaign category the uploader filed this photo under ("" = none;
    # photos from before categories became upload buckets stay blank).
    category = models.CharField(max_length=100, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    hidden_at = models.DateTimeField(null=True, blank=True)
    hidden_reason = models.CharField(max_length=200, blank=True)
    award_category = models.CharField(max_length=100, blank=True)
    approved_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="lens_photos_approved",
    )
    hidden_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="lens_photos_hidden",
    )
    event_id = models.UUIDField(unique=True, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "lens_photo"
        indexes = [
            models.Index(fields=["campaign", "institution"], name="lens_photo_camp_inst_idx"),
            models.Index(fields=["campaign", "approved_at"], name="lens_photo_camp_appr_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr aid
        return f"LensPhoto({self.upload_ref})"

    @property
    def status(self) -> str:
        if self.hidden_at is not None:
            return "hidden"
        if self.approved_at is not None:
            return "approved"
        return "pending"
