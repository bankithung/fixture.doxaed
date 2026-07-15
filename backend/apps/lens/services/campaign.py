"""Guest Lens campaign lifecycle: open (gated on generated fixtures), settings
updates, close and reopen. Every mutation is atomic + audited via
``emit_audit`` (idempotency_key = the client's event_id, invariant 3)."""
from __future__ import annotations

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError as DRFValidationError

from apps.audit.services import emit_audit
from apps.lens.models import LensCampaign

# The settings a manager may set at open time or patch later.
SETTING_FIELDS = (
    "title",
    "tagline",
    "instructions",
    "consent_note",
    "max_photos_per_institution",
    "award_categories",
    "category_limits",
)


def _clean_settings(changes: dict) -> dict:
    out: dict = {}
    for key in SETTING_FIELDS:
        if key not in changes:
            continue
        value = changes[key]
        if key == "max_photos_per_institution":
            if isinstance(value, bool) or not isinstance(value, (int, str)):
                raise DRFValidationError({"detail": "invalid_max_photos"})
            try:
                value = int(value)
            except ValueError:
                raise DRFValidationError(
                    {"detail": "invalid_max_photos"}
                ) from None
            if not 1 <= value <= 500:
                raise DRFValidationError({"detail": "invalid_max_photos"})
        elif key == "award_categories":
            if not isinstance(value, list) or not all(
                isinstance(c, str) and c.strip() for c in value
            ):
                raise DRFValidationError({"detail": "invalid_award_categories"})
            value = [c.strip()[:100] for c in value]
        elif key == "category_limits":
            if not isinstance(value, dict):
                raise DRFValidationError({"detail": "invalid_category_limits"})
            cleaned: dict[str, int] = {}
            for cat, limit in value.items():
                if not isinstance(cat, str) or not cat.strip():
                    raise DRFValidationError({"detail": "invalid_category_limits"})
                if isinstance(limit, bool) or not isinstance(limit, (int, str)):
                    raise DRFValidationError({"detail": "invalid_category_limits"})
                try:
                    limit = int(limit)
                except ValueError:
                    raise DRFValidationError(
                        {"detail": "invalid_category_limits"}
                    ) from None
                if not 1 <= limit <= 500:
                    raise DRFValidationError({"detail": "invalid_category_limits"})
                cleaned[cat.strip()[:100]] = limit
            value = cleaned
        else:
            if not isinstance(value, str):
                raise DRFValidationError({"detail": f"invalid_{key}"})
            if key in ("title", "tagline"):
                value = value.strip()[:120]
        out[key] = value
    return out


def _prune_limits(fields: dict, campaign: LensCampaign | None) -> None:
    """Keep ``category_limits`` keyed only by categories that exist. Renaming
    or removing a category drops its limit instead of leaving an orphan key."""
    categories = fields.get(
        "award_categories",
        list(campaign.award_categories or []) if campaign else None,
    )
    if categories is None:
        from apps.lens.models import default_award_categories

        categories = default_award_categories()
    limits = fields.get(
        "category_limits",
        dict(campaign.category_limits or {}) if campaign else {},
    )
    pruned = {cat: n for cat, n in limits.items() if cat in categories}
    if "category_limits" in fields or (
        campaign is not None and pruned != (campaign.category_limits or {})
    ):
        fields["category_limits"] = pruned


def _snapshot(campaign: LensCampaign) -> dict:
    return {
        "title": campaign.title,
        "tagline": campaign.tagline,
        "max_photos_per_institution": campaign.max_photos_per_institution,
        "award_categories": campaign.award_categories,
        "category_limits": campaign.category_limits,
        "opened_at": campaign.opened_at.isoformat() if campaign.opened_at else None,
        "closed_at": campaign.closed_at.isoformat() if campaign.closed_at else None,
    }


def create_campaign(*, tournament, by, settings=None, event_id=None, request=None):
    """Create a NEW Guest Lens campaign (multi-campaign — a tournament may run
    several). Gate: fixtures must exist (spec D4). Idempotent on event_id
    (returns ``(prior, False)``); otherwise ``(campaign, True)``."""
    from apps.fixtures.services.draw_config import leaf_has_matches

    if event_id:
        # Scope the replay lookup to THIS tournament (invariant 2): event_id is
        # globally unique, so an unscoped match could return another tenant's
        # campaign. A true cross-tournament duplicate still fails the unique
        # event_id DB constraint on create below.
        prior = LensCampaign.objects.filter(
            event_id=event_id, tournament=tournament
        ).first()
        if prior is not None:
            return prior, False

    if not leaf_has_matches(tournament, None):
        raise DRFValidationError({"detail": "fixtures_not_generated"})

    fields = _clean_settings(settings or {})
    _prune_limits(fields, None)
    with transaction.atomic():
        campaign = LensCampaign.objects.create(
            organization=tournament.organization,
            tournament=tournament,
            opened_at=timezone.now(),
            created_by=by,
            event_id=event_id,
            **fields,
        )
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_campaign_opened",
            target_type="lens_campaign",
            target_id=campaign.id,
            payload_after=_snapshot(campaign),
            organization_id=tournament.organization_id,
            tournament_id=tournament.id,
            idempotency_key=event_id,
            request=request,
        )
    return campaign, True


def open_campaign(*, tournament, by, settings=None, event_id=None, request=None):
    """Legacy single-campaign entry point: return the tournament's existing
    campaign, or create its first one. Multi-campaign callers use
    :func:`create_campaign`, which always creates."""
    existing = (
        LensCampaign.objects.filter(tournament=tournament)
        .order_by("created_at")
        .first()
    )
    if existing is not None:
        return existing, False
    return create_campaign(
        tournament=tournament, by=by, settings=settings,
        event_id=event_id, request=request,
    )


def update_settings(*, campaign, by, changes, event_id=None, request=None):
    """PATCH any subset of the campaign settings (audited)."""
    fields = _clean_settings(changes or {})
    _prune_limits(fields, campaign)
    with transaction.atomic():
        before = _snapshot(campaign)
        for key, value in fields.items():
            setattr(campaign, key, value)
        if fields:
            campaign.save(update_fields=list(fields.keys()))
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_campaign_updated",
            target_type="lens_campaign",
            target_id=campaign.id,
            payload_before=before,
            payload_after=_snapshot(campaign),
            organization_id=campaign.organization_id,
            tournament_id=campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return campaign


def close_campaign(*, campaign, by, event_id=None, request=None):
    with transaction.atomic():
        before = _snapshot(campaign)
        if campaign.closed_at is None:
            campaign.closed_at = timezone.now()
            campaign.save(update_fields=["closed_at"])
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_campaign_closed",
            target_type="lens_campaign",
            target_id=campaign.id,
            payload_before=before,
            payload_after=_snapshot(campaign),
            organization_id=campaign.organization_id,
            tournament_id=campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return campaign


def reopen_campaign(*, campaign, by, event_id=None, request=None):
    with transaction.atomic():
        before = _snapshot(campaign)
        updates = []
        if campaign.closed_at is not None:
            campaign.closed_at = None
            updates.append("closed_at")
        if campaign.opened_at is None:
            campaign.opened_at = timezone.now()
            updates.append("opened_at")
        if updates:
            campaign.save(update_fields=updates)
        emit_audit(
            actor_user=by,
            actor_role="admin",
            event_type="lens_campaign_reopened",
            target_type="lens_campaign",
            target_id=campaign.id,
            payload_before=before,
            payload_after=_snapshot(campaign),
            organization_id=campaign.organization_id,
            tournament_id=campaign.tournament_id,
            idempotency_key=event_id,
            request=request,
        )
    return campaign
