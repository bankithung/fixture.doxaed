"""Slug validation, mutation, and history.

Reserved-list enforcement happens at THIS layer (not just at the form
serializer). Any caller — including a Super-admin colon-verb — passes
through `validate_slug()` before the value lands in the DB.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpRequest

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.organizations.constants import RESERVED_SLUGS, SLUG_REGEX
from apps.organizations.models import (
    Organization,
    SlugRedirect,
)


def validate_slug(value: str, *, exclude_org: Organization | None = None) -> str:
    """Validate a slug at the service layer.

    Rules (locked):
      1. Lowercase a-z0-9, hyphen-separated, no leading/trailing hyphen.
      2. Length 1-63 (DNS label limit).
      3. Not in RESERVED_SLUGS.
      4. Unique across `Organization.slug` AND `SlugRedirect.old_slug`.
    """
    if not isinstance(value, str):
        raise ValidationError("Slug must be a string.")
    raw = value.strip()
    if not raw:
        raise ValidationError("Slug must be non-empty.")
    # Reject any input that isn't already lowercase / DNS-safe — don't
    # silently lowercase, because 'UPPERCASE' is an invalid slug per the
    # locked rule and tests rely on that contract.
    value = raw
    if not SLUG_REGEX.match(value):
        raise ValidationError(
            "Slug must be lowercase alphanumeric, may contain hyphens, "
            "1-63 chars, no leading or trailing hyphen."
        )
    if value in RESERVED_SLUGS:
        raise ValidationError(f"Slug '{value}' is reserved.")

    org_qs = Organization.objects.filter(slug=value)
    if exclude_org is not None:
        org_qs = org_qs.exclude(pk=exclude_org.pk)
    if org_qs.exists():
        raise ValidationError(f"Slug '{value}' is already taken.")

    if SlugRedirect.objects.filter(old_slug=value).exists():
        raise ValidationError(
            f"Slug '{value}' was previously used by another organization."
        )
    return value


def change_slug(
    *,
    org: Organization,
    new_slug: str,
    changed_by,
    request: HttpRequest | None = None,
) -> Organization:
    """Atomically:
      - Validate new_slug (reserved, regex, unique across slug+redirect).
      - Write a SlugRedirect row for the old slug.
      - Update Organization.slug to new_slug.
      - Audit `org_slug_changed`.
    """
    new_slug = validate_slug(new_slug, exclude_org=org)
    if new_slug == org.slug:
        return org  # no-op

    with transaction.atomic():
        old_slug = org.slug
        # Idempotent guard: if a SlugRedirect already maps old_slug to
        # this org (e.g., this slug was previously cycled), skip.
        SlugRedirect.objects.get_or_create(
            old_slug=old_slug, defaults={"organization": org}
        )
        org.slug = new_slug
        org.save(update_fields=["slug"])

        emit_audit(
            actor_user=changed_by,
            actor_role=ActorRole.ADMIN,
            event_type="org_settings_changed",
            target_type="organization",
            target_id=org.id,
            payload_before={"slug": old_slug},
            payload_after={"slug": new_slug},
            reason="slug change",
            organization_id=org.id,
            request=request,
        )
    return org


def resolve_slug(value: str) -> tuple[Organization | None, Organization | None]:
    """Resolve a slug to (canonical_org, redirect_target).

    Returns:
      - (org, None) if `value` is the current slug of an Organization.
      - (None, target_org) if `value` matches a SlugRedirect.old_slug.
      - (None, None) if neither.
    """
    value = (value or "").strip().lower()
    if not value:
        return (None, None)

    org = Organization.objects.filter(slug=value, deleted_at__isnull=True).first()
    if org is not None:
        return (org, None)

    redirect = (
        SlugRedirect.objects.select_related("organization")
        .filter(old_slug=value)
        .first()
    )
    if redirect is not None and not redirect.organization.is_deleted:
        return (None, redirect.organization)

    return (None, None)
