"""Guest Lens photo pipeline: public upload (re-encode, quota), teacher
self-delete, and manager moderation (approve / hide-to-quarantine / award).

Every stored byte went through Pillow (spec D5): ``exif_transpose`` applies the
camera orientation then the re-encode strips EXIF/GPS (child safety) and kills
any fake-image payload; originals are never stored or served. Hiding a photo
physically moves the files OUT of MEDIA_ROOT into ``BASE_DIR/media_quarantine``
(spec D7) so nginx naturally 404s them; approving from hidden moves them back.
"""
from __future__ import annotations

import io
import os
import uuid as _uuid
from pathlib import Path

from django.conf import settings as django_settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound
from rest_framework.exceptions import ValidationError as DRFValidationError

from apps.audit.services import emit_audit
from apps.lens.models import LensPhoto

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ACCEPTED_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_SIDE = 2560
THUMB_SIDE = 480
# Decompression-bomb guard (spec D5 security checklist). A low-entropy image can
# declare an enormous pixel count that still compresses under the 10MB byte gate
# yet decodes to hundreds of MB of bitmap. Reject on the declared dimensions
# BEFORE ``img.load()`` allocates the raster.
MAX_IMAGE_PIXELS = 40_000_000  # ~8000 x 5000, far above any phone camera


# --- upload -----------------------------------------------------------------

def _reencode(uploaded_file):
    """Decode + re-encode to clean JPEG bytes. Returns
    ``(image_bytes, thumb_bytes, width, height)`` or raises ``invalid_image``."""
    from PIL import Image, ImageOps

    try:
        img = Image.open(uploaded_file)
        if img.size[0] * img.size[1] > MAX_IMAGE_PIXELS:
            raise DRFValidationError({"detail": "invalid_image"})
        img.load()
    except DRFValidationError:
        raise
    except Exception:
        raise DRFValidationError({"detail": "invalid_image"}) from None
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")

    main = img.copy()
    main.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    main.save(buf, "JPEG", quality=85)

    thumb = img.copy()
    thumb.thumbnail((THUMB_SIDE, THUMB_SIDE))
    tbuf = io.BytesIO()
    thumb.save(tbuf, "JPEG", quality=80)
    return buf.getvalue(), tbuf.getvalue(), main.width, main.height


def add_photo(*, pass_, file, caption="", category="", event_id=None):
    """Public upload through a pass. Quota is a live COUNT of the institution's
    rows (any status) under ``select_for_update`` on the pass row (spec D10);
    a category with a ``category_limits`` entry gets the same live-count check
    scoped to that category."""
    if event_id:
        # Scope the replay lookup to THIS pass (invariant 2): event_id is
        # globally unique, so an unscoped match could return another tenant's
        # photo row (its url/thumb_url) to this pass.
        prior = LensPhoto.objects.filter(
            event_id=event_id,
            campaign=pass_.campaign,
            institution=pass_.institution,
        ).first()
        if prior is not None:
            return prior

    campaign = pass_.campaign
    if not campaign.is_open:
        raise DRFValidationError({"detail": "campaign_closed"})
    if file is None:
        raise DRFValidationError({"detail": "no_file"})
    if file.size > MAX_UPLOAD_BYTES:
        raise DRFValidationError({"detail": "file_too_large"})
    content_type = (getattr(file, "content_type", "") or "").lower()
    if content_type not in ACCEPTED_TYPES:
        raise DRFValidationError({"detail": "unsupported_type"})
    category = (category or "").strip()[:100]
    if category and category not in (campaign.award_categories or []):
        raise DRFValidationError({"detail": "unknown_category"})

    image_bytes, thumb_bytes, width, height = _reencode(file)

    from apps.lens.models import LensPass

    with transaction.atomic():
        LensPass.objects.select_for_update().get(pk=pass_.pk)
        used = LensPhoto.objects.filter(
            campaign=campaign, institution=pass_.institution
        ).count()
        if used >= campaign.max_photos_per_institution:
            raise DRFValidationError({"detail": "quota_exceeded"})
        cat_limit = (campaign.category_limits or {}).get(category)
        if category and cat_limit is not None:
            used_in_category = LensPhoto.objects.filter(
                campaign=campaign, institution=pass_.institution,
                category=category,
            ).count()
            if used_in_category >= cat_limit:
                raise DRFValidationError({"detail": "category_quota_exceeded"})
        photo = LensPhoto(
            organization=campaign.organization,
            campaign=campaign,
            institution=pass_.institution,
            access_pass=pass_,
            original_name=(getattr(file, "name", "") or "photo.jpg")[:255],
            content_type="image/jpeg",
            size=len(image_bytes),
            width=width,
            height=height,
            caption=(caption or "").strip()[:200],
            category=category,
            event_id=event_id,
        )
        photo.image.save("photo.jpg", ContentFile(image_bytes), save=False)
        photo.thumb.save("thumb.jpg", ContentFile(thumb_bytes), save=False)
        photo.save()
    return photo


def remove_own_photo(*, pass_, upload_ref):
    """Teacher deletes their own PENDING photo (frees quota). Approved or
    hidden photos are locked (the host owns moderated content)."""
    photo = LensPhoto.objects.filter(
        campaign=pass_.campaign,
        institution=pass_.institution,
        upload_ref=upload_ref,
    ).first()
    if photo is None:
        raise NotFound("photo_not_found")
    if photo.status != "pending":
        raise DRFValidationError({"detail": "photo_locked"})
    photo.image.delete(save=False)
    photo.thumb.delete(save=False)
    photo.delete()


# --- quarantine (spec D7) -----------------------------------------------------

def _quarantine_root() -> Path:
    override = getattr(django_settings, "LENS_QUARANTINE_ROOT", None)
    if override:
        return Path(override)
    return Path(django_settings.BASE_DIR) / "media_quarantine"


def _move(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(src, dst)


def _move_to_quarantine(photo: LensPhoto) -> None:
    media = Path(django_settings.MEDIA_ROOT)
    quarantine = _quarantine_root()
    for name in (photo.image.name, photo.thumb.name):
        if name:
            _move(media / name, quarantine / name)


def _restore_from_quarantine(photo: LensPhoto) -> None:
    media = Path(django_settings.MEDIA_ROOT)
    quarantine = _quarantine_root()
    for name in (photo.image.name, photo.thumb.name):
        if name:
            _move(quarantine / name, media / name)


# --- moderation (manager) -----------------------------------------------------

def _replayed(event_type: str, event_id) -> bool:
    if not event_id:
        return False
    from apps.audit.models import AuditEvent

    return AuditEvent.objects.filter(
        idempotency_key=event_id, event_type=event_type
    ).exists()


def approve_photo(*, photo, by, event_id=None, request=None):
    """Approve (also un-hides: files move back from quarantine)."""
    if _replayed("lens_photo_approved", event_id):
        return photo
    with transaction.atomic():
        before = {"status": photo.status}
        if photo.hidden_at is not None:
            _restore_from_quarantine(photo)
        photo.hidden_at = None
        photo.hidden_reason = ""
        photo.hidden_by = None
        if photo.approved_at is None:
            photo.approved_at = timezone.now()
        photo.approved_by = by
        photo.save(
            update_fields=[
                "hidden_at", "hidden_reason", "hidden_by",
                "approved_at", "approved_by",
            ]
        )
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_photo_approved",
            target_type="lens_photo",
            target_id=photo.id,
            payload_before=before,
            payload_after={"status": photo.status},
            organization_id=photo.organization_id,
            tournament_id=photo.campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return photo


def hide_photo(*, photo, by, reason="", event_id=None, request=None):
    """Hide: real takedown at the file layer (move into quarantine)."""
    if _replayed("lens_photo_hidden", event_id):
        return photo
    with transaction.atomic():
        before = {"status": photo.status}
        if photo.hidden_at is None:
            _move_to_quarantine(photo)
            photo.hidden_at = timezone.now()
        photo.hidden_by = by
        photo.hidden_reason = (reason or "").strip()[:200]
        photo.save(update_fields=["hidden_at", "hidden_by", "hidden_reason"])
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_photo_hidden",
            target_type="lens_photo",
            target_id=photo.id,
            payload_before=before,
            payload_after={"status": photo.status, "reason": photo.hidden_reason},
            organization_id=photo.organization_id,
            tournament_id=photo.campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return photo


def award_photo(*, photo, by, category, event_id=None, request=None):
    """Assign a winner-per-category award (spec D11): giving category X to this
    photo clears X from any other holder. Empty category clears this photo's
    award. Only approved photos can win."""
    if _replayed("lens_photo_award_assigned", event_id):
        return photo
    category = (category or "").strip()
    campaign = photo.campaign
    if category:
        if category not in (campaign.award_categories or []):
            raise DRFValidationError({"detail": "unknown_category"})
        if photo.status != "approved":
            raise DRFValidationError({"detail": "not_approved"})
    with transaction.atomic():
        before = {"award_category": photo.award_category}
        if category:
            # Winner-per-category (spec D11): take the prize from any prior
            # holder — and audit that takedown too ("(audited)"), so a photo
            # never loses its award without an AuditEvent trail. No
            # idempotency_key here: the whole verb short-circuits on replay via
            # the ``_replayed`` guard above, and emit_audit dedups on the key
            # alone, so reusing event_id would swallow the assign row below.
            prior_holders = list(
                LensPhoto.objects.filter(
                    campaign=campaign, award_category=category
                ).exclude(pk=photo.pk)
            )
            for holder in prior_holders:
                emit_audit(
                    actor_user=by,
                    actor_role="admin",
                    event_type="lens_photo_award_cleared",
                    target_type="lens_photo",
                    target_id=holder.id,
                    payload_before={"award_category": category},
                    payload_after={"award_category": ""},
                    organization_id=holder.organization_id,
                    tournament_id=campaign.tournament_id,
                    request=request,
                )
            if prior_holders:
                LensPhoto.objects.filter(
                    campaign=campaign, award_category=category
                ).exclude(pk=photo.pk).update(award_category="")
        photo.award_category = category
        photo.save(update_fields=["award_category"])
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_photo_award_assigned",
            target_type="lens_photo",
            target_id=photo.id,
            payload_before=before,
            payload_after={"award_category": category},
            organization_id=photo.organization_id,
            tournament_id=campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return photo


def as_uuid(value):
    try:
        return _uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None
