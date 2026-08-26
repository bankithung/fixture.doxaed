"""Photo-story entries: a school's titled, ordered set of photographs judged
together as ONE entry ("Beyond the Court", spec request 2026-08-21).

The bytes stay on the member :class:`LensPhoto` rows (same re-encode, same
quota plumbing); this module owns the grouping rules:

- A story lives only under a category on ``campaign.story_categories``.
- ONE story per (school, category) — the competition rule "each school may
  submit one photo story" is a SQL unique constraint, not a hope.
- The per-category cap counts STORIES, not photographs: with the default
  limit of 1, four photos make one complete entry, never four half ones.
- Positions are 1-based and gapless — renumbered on every add/remove/move —
  so "arranged in the intended order" survives any edit.

Moderation and awards mirror the photo pipeline exactly (nullable timestamps,
audited winner-per-category), but operate at STORY level: the four frames are
never approved or crowned one by one.
"""
from __future__ import annotations

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound
from rest_framework.exceptions import ValidationError as DRFValidationError

from apps.audit.services import emit_audit
from apps.lens.models import LensPass, LensPhoto, LensStory


def is_story_category(campaign, category: str) -> bool:
    return bool(category) and category in (campaign.story_categories or [])


def _renumber(story: LensStory) -> None:
    """Rewrite positions 1..n by current order. Cheap at N<=12 — write only
    the rows that actually moved."""
    ordered = list(
        story.photos.order_by("position", "created_at")
    )
    for idx, photo in enumerate(ordered, start=1):
        if photo.position != idx:
            photo.position = idx
            photo.save(update_fields=["position"])


def story_for_upload(*, pass_: LensPass, campaign, category: str) -> LensStory:
    """The institution's single story row for this category, created on first
    upload. Enforces the ENTRY cap (``category_limits`` counts stories here)
    inside the caller's lock so two concurrent uploads cannot double it."""
    existing = LensStory.objects.filter(
        campaign=campaign, institution=pass_.institution, category=category,
    ).first()
    if existing is not None:
        return existing
    # Entry cap: same dict as photo categories, different unit.
    entry_limit = (campaign.category_limits or {}).get(category, 1)
    used_entries = LensStory.objects.filter(
        campaign=campaign, institution=pass_.institution,
        category=category,
    ).count()
    if used_entries >= max(int(entry_limit), 1):
        raise DRFValidationError({"detail": "category_quota_exceeded"})
    try:
        return LensStory.objects.create(
            organization=campaign.organization,
            campaign=campaign,
            institution=pass_.institution,
            access_pass=pass_,
            category=category,
            # Publish-on-upload applies to the ENTRY too: a story whose frames
            # are public but whose story row is not would show nowhere.
            approved_at=timezone.now() if campaign.publish_on_upload else None,
        )
    except Exception:
        # Lost a create race against another tab of the same school: the
        # unique constraint means the story exists — use it.
        return LensStory.objects.get(
            campaign=campaign, institution=pass_.institution, category=category,
        )


def check_story_room(*, story: LensStory, campaign) -> None:  # noqa: ANN001
    """The per-entry frame cap: a story holds at most
    ``story_photos_per_entry`` photographs."""
    used_frames = story.photos.count()
    if used_frames >= campaign.story_photos_per_entry:
        raise DRFValidationError({"detail": "story_full"})


def attach_photo(*, pass_: LensPass, photo: LensPhoto, category: str) -> LensPhoto:
    """Bind a freshly uploaded photo into the school's story for this
    category (the row is already quota-checked and saved)."""
    story = story_for_upload(pass_=pass_, campaign=pass_.campaign, category=category)
    check_story_room(story=story, campaign=pass_.campaign)
    photo.story = story
    photo.position = story.photos.count() + 1
    photo.save(update_fields=["story", "position"])
    return photo


def remove_photo_from_story(photo: LensPhoto) -> None:  # type: ignore[unused]
    """Called after a pass deletes one of its story frames: drop the row to
    its story and close the gap. An emptied pending story dies with it — an
    empty titled entry must not linger in the console or the album."""
    story = photo.story
    if story is None:
        return
    _renumber(story)
    if not story.photos.exists() and story.status == "pending":
        story.delete()


def set_title(
    *, pass_: LensPass, story_id: object, title: str,
    description: str | None = None,
) -> LensStory:
    """The school names its entry (title mandatory at submit time) and may
    add an OPTIONAL description. Own-story scoped: a pass can only edit ITS
    school's story (invariant 2 at the credential layer)."""
    story = (
        LensStory.objects.filter(
            id=as_uuid_or_404(story_id),
            campaign=pass_.campaign,
            institution=pass_.institution,
        ).first()
    )
    if story is None:
        raise NotFound("story_not_found")
    if story.status != "pending":
        raise DRFValidationError({"detail": "photo_locked"})
    story.title = (title or "").strip()[:120]
    if description is not None:
        story.description = (description or "").strip()[:1000]
    story.save(update_fields=["title", "description"]
               if description is not None else ["title"])
    return story


def move_photo(*, pass_: LensPass, story_id: object, upload_ref: object,
               position: int) -> LensStory:
    """Reorder: move one of the school's own pending frames to 1-based
    ``position``, closing the gap it left behind. This is how "the four
    photographs are arranged in the intended order" gets authored."""
    story = (
        LensStory.objects.filter(
            id=as_uuid_or_404(story_id),
            campaign=pass_.campaign,
            institution=pass_.institution,
        )
        .first()
    )
    if story is None:
        raise NotFound("story_not_found")
    if story.status != "pending":
        raise DRFValidationError({"detail": "photo_locked"})
    photo = (
        LensPhoto.objects.filter(
            story=story,
            upload_ref=as_uuid_or_404(upload_ref),
        )
        .first()
    )
    if photo is None:
        raise NotFound("photo_not_found")
    ordered = list(story.photos.order_by("position", "created_at"))
    pos = int(position)
    if not 1 <= pos <= len(ordered):
        raise DRFValidationError({"detail": "invalid_position"})
    ordered.remove(photo)
    ordered.insert(pos - 1, photo)
    for idx, ph in enumerate(ordered, start=1):
        if ph.position != idx:
            ph.position = idx
            ph.save(update_fields=["position"])
    return story


def get_managed_story(tournament, story_id: object) -> LensStory:
    s = (
        LensStory.objects.filter(id=as_uuid_or_404(story_id),
                                 campaign__tournament=tournament)
        .select_related("campaign", "institution")
        .first()
    )
    if s is None:
        raise NotFound("story_not_found")
    return s


def approve_story(*, story: LensStory, by, event_id=None, request=None):
    """Approve (also un-hides) the WHOLE entry at once: every frame becomes
    public together, or none of it does. A half-published story would read as
    a broken album."""
    from apps.lens.services.photos import _restore_from_quarantine

    if _replayed("lens_story_approved", event_id):
        return story
    with transaction.atomic():
        now = timezone.now()
        story.approved_at = now
        story.approved_by = by
        story.hidden_at = None
        story.hidden_reason = ""
        story.save(update_fields=[
            "approved_at", "approved_by", "hidden_at", "hidden_reason",
        ])
        for photo in story.photos.all():
            if photo.hidden_at is not None:
                _restore_from_quarantine(photo)
            photo.hidden_at = None
            photo.hidden_reason = ""
            photo.hidden_by = None
            if photo.approved_at is None:
                photo.approved_at = now
            photo.approved_by = by
            photo.save(update_fields=[
                "hidden_at", "hidden_reason", "hidden_by",
                "approved_at", "approved_by",
            ])
        emit_audit(
            actor_user=by, actor_role="admin", event_type="lens_story_approved",
            target_type="lens_story", target_id=story.id,
            payload_before={"status": "pending"}, payload_after={"status": "approved"},
            organization_id=story.organization_id,
            tournament_id=story.campaign.tournament_id,
            idempotency_key=event_id, request=request,
        )
    return story


def hide_story(*, story: LensStory, by, reason="", event_id=None, request=None):
    from apps.lens.services.photos import _move_to_quarantine

    prior_status = story.status
    if _replayed("lens_story_hidden", event_id):
        return story
    with transaction.atomic():
        now = timezone.now()
        story.hidden_at = now
        story.hidden_reason = (reason or "")[:200]
        story.hidden_by = by
        story.save(update_fields=["hidden_at", "hidden_reason", "hidden_by"])
        for photo in story.photos.all():
            if photo.hidden_at is None:
                _move_to_quarantine(photo)
                photo.hidden_at = now
                photo.hidden_reason = story.hidden_reason
                photo.hidden_by = by
                photo.save(update_fields=["hidden_at", "hidden_by", "hidden_reason"])
        emit_audit(
            actor_user=by, actor_role="admin", event_type="lens_story_hidden",
            target_type="lens_story", target_id=story.id,
            payload_before={"status": prior_status},
            payload_after={"reason": story.hidden_reason},
            organization_id=story.organization_id,
            tournament_id=story.campaign.tournament_id,
            idempotency_key=event_id, request=request,
        )
    return story


def award_story(*, story: LensStory, by, category: str, event_id=None, request=None):
    """Winner-per-story-category, exactly the photo rule: giving the prize to
    this entry takes it from any prior holder (cleared auditably), empty
    clears it, only approved entries can win."""
    if _replayed("lens_story_award_assigned", event_id):
        return story
    category = (category or "").strip()
    campaign = story.campaign
    if category:
        if category not in (campaign.award_categories or []):
            raise DRFValidationError({"detail": "unknown_category"})
        if story.status != "approved":
            raise DRFValidationError({"detail": "not_approved"})
    with transaction.atomic():
        before = {"award_category": story.award_category}
        if category:
            prior_holders = list(
                LensStory.objects.filter(
                    campaign=campaign, award_category=category
                ).exclude(pk=story.pk)
            )
            for holder in prior_holders:
                emit_audit(
                    actor_user=by, actor_role="admin",
                    event_type="lens_story_award_cleared",
                    target_type="lens_story", target_id=holder.id,
                    payload_before={"award_category": category},
                    payload_after={"award_category": ""},
                    organization_id=holder.organization_id,
                    tournament_id=campaign.tournament_id,
                    request=request,
                )
            if prior_holders:
                LensStory.objects.filter(
                    campaign=campaign, award_category=category
                ).exclude(pk=story.pk).update(award_category="")
        story.award_category = category
        story.save(update_fields=["award_category"])
        emit_audit(
            actor_user=by, actor_role="admin",
            event_type="lens_story_award_assigned",
            target_type="lens_story", target_id=story.id,
            payload_before=before,
            payload_after={"award_category": category},
            organization_id=story.organization_id,
            tournament_id=campaign.tournament_id,
            idempotency_key=event_id, request=request,
        )
    return story


# --- shared helpers ------------------------------------------------------------

def as_uuid_or_404(value: object):
    from apps.lens.services.photos import as_uuid

    out = as_uuid(value)
    if out is None:
        raise NotFound("invalid_id")
    return out


def _replayed(event_type: str, event_id: object) -> bool:
    from apps.lens.services.photos import _replayed as replayed

    return replayed(event_type, event_id)
