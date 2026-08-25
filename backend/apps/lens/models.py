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
    "Scan the event QR code, pick your school and enter the code the host "
    "gave you. Capture the event from your school's point of view and upload "
    "your best shots from your own phone. The host reviews every photo "
    "before it joins the shared album."
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
    # ONE card for the whole event (owner 2026-08-13). Everyone scans the same
    # QR; the school proves who it is with its own code on the page behind it,
    # so the host prints one poster instead of 35 cards. sha256 at rest like
    # the pass tokens it replaces; plaintext returned once from the mint call.
    share_token_hash = models.CharField(max_length=128, blank=True, db_index=True)
    # The same token, Fernet-encrypted under the deployment secret (owner
    # 2026-08-25): lets the manager re-view and re-print the SAME card after
    # any refresh, instead of one-time-only. The hash above stays the
    # verification path; this ciphertext is readable only through the
    # manager-gated endpoint.
    share_token_encrypted = models.TextField(blank=True, default="")
    share_minted_at = models.DateTimeField(null=True, blank=True)
    max_photos_per_institution = models.PositiveIntegerField(default=36)
    award_categories = models.JSONField(default=default_award_categories, blank=True)
    # Optional per-institution cap for each category: {category_name: int}.
    # A category absent from the dict has no cap of its own (only the overall
    # max_photos_per_institution applies). For a STORY category (see
    # ``story_categories``) the same number counts ENTRIES (stories), not
    # photos — one story of four photos under a limit of 1 uses 1.
    category_limits = models.JSONField(default=dict, blank=True)
    # Photo-story entries ("Beyond the Court", spec request 2026-08-21): the
    # award categories in this list accept ONE grouped entry per school — N
    # photographs uploaded as one titled, ordered unit and judged together —
    # instead of N individual photos. A category not listed behaves exactly
    # as before. Must be a subset of ``award_categories``.
    story_categories = models.JSONField(default=list, blank=True)
    # How many photographs one story entry holds (the competition's "four
    # photographs arranged in the intended order").
    story_photos_per_entry = models.PositiveSmallIntegerField(default=4)
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
    """One school's standing in the album — one row per (campaign,
    institution), enforced in the service layer (mint skips, rotate replaces
    in place).

    It used to BE a QR card: a long token in a per-school URL. Since the
    campaign carries a single shared card, the credential here is the school's
    own short ``code``, typed on the join page behind that card. The code is
    only 8 characters, so unlike the old token it is stored under a slow
    salted password hash (Argon2id), never sha256.
    """

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
    # Retired with the per-school cards; kept so old rows migrate without a
    # data step and nothing re-mints a URL nobody hands out any more.
    token_hash = models.CharField(max_length=128, db_index=True, blank=True)
    code_hash = models.CharField(max_length=256, blank=True)
    code_set_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    last_minted_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "lens_pass"

    def __str__(self) -> str:  # pragma: no cover - repr aid
        return f"LensPass({self.institution_id})"


class LensStory(models.Model):
    """One photo-story ENTRY: a school's titled, ordered set of photographs
    judged together as a single unit (never as separate photos). The member
    :class:`LensPhoto` rows carry the bytes and their ``position``; this row
    carries the title, the moderation state and any award.

    One story per (campaign, institution, category) — the competition rule is
    "each school may submit ONE photo story" — enforced here in SQL so a race
    between two tabs cannot mint two entries.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="lens_stories",
    )
    campaign = models.ForeignKey(
        LensCampaign, on_delete=models.CASCADE, related_name="stories"
    )
    institution = models.ForeignKey(
        "teams.Institution", on_delete=models.CASCADE, related_name="lens_stories"
    )
    access_pass = models.ForeignKey(
        LensPass, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="stories",
    )
    # The story category this entry competes in; always one of the campaign's
    # ``story_categories``.
    category = models.CharField(max_length=100)
    title = models.CharField(max_length=120, blank=True)
    # Optional free-text description of the entry ("optional description").
    # The TITLE is the mandatory part of a submission; this never is.
    description = models.TextField(blank=True, default="")
    approved_at = models.DateTimeField(null=True, blank=True)
    hidden_at = models.DateTimeField(null=True, blank=True)
    hidden_reason = models.CharField(max_length=200, blank=True)
    award_category = models.CharField(max_length=100, blank=True)
    approved_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="lens_stories_approved",
    )
    hidden_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="lens_stories_hidden",
    )
    event_id = models.UUIDField(unique=True, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "lens_story"
        constraints = [
            models.UniqueConstraint(
                fields=["campaign", "institution", "category"],
                name="uniq_lens_story_per_school_category",
            )]
        indexes = [
            models.Index(
                fields=["campaign", "institution"], name="lens_story_camp_inst_idx"
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr aid
        return f"LensStory({self.category}, {self.institution_id})"

    @property
    def status(self) -> str:
        if self.hidden_at is not None:
            return "hidden"
        if self.approved_at is not None:
            return "approved"
        return "pending"


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
    # Photo-story membership (nullable = an ordinary individual photo). A
    # story photo belongs to exactly one LensStory; SET_NULL keeps the album's
    # moderated content alive if a story row were ever removed directly.
    story = models.ForeignKey(
        "lens.LensStory", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="photos",
    )
    # 1-based order within the story — "arranged in the intended order". 0 =
    # unordered (an ordinary photo, or a legacy row).
    position = models.PositiveSmallIntegerField(default=0)
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
