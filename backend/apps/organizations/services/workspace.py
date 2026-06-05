"""Shared workspace-provision service (design-selfserve-flow.md §3.2).

Creates an ACTIVE personal-workspace Organization + an ACTIVE admin/owner
OrganizationMembership for a user, with NO super-admin approval. This is the
org-as-hidden-workspace primitive that the self-serve tournament-create flow
builds on. Slug helpers live here so both the (rewritten) signup flow and the
tournament-create flow share one implementation.
"""
from __future__ import annotations

import re
import secrets

from django.conf import settings
from django.db import transaction

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.organizations.constants import RESERVED_SLUGS, SLUG_REGEX
from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
    OrgStatus,
    SlugRedirect,
)

_SLUG_SCRUB = re.compile(r"[^a-z0-9-]+")
_HYPHEN_RUN = re.compile(r"-+")


def slugify_for_org(raw: str) -> str:
    """Lowercase, strip non-DNS chars, collapse hyphens, trim, cap at 63."""
    candidate = (raw or "").strip().lower()
    candidate = _SLUG_SCRUB.sub("-", candidate)
    candidate = _HYPHEN_RUN.sub("-", candidate)
    candidate = candidate.strip("-")
    return candidate[:63]


def _slug_taken(slug: str) -> bool:
    return (
        Organization.objects.filter(slug=slug).exists()
        or SlugRedirect.objects.filter(old_slug=slug).exists()
    )


def pick_unique_org_slug(seed: str) -> str:
    """Find a free, valid, non-reserved org slug starting from ``seed``."""
    base = seed or ""
    if not base or not SLUG_REGEX.match(base) or base in RESERVED_SLUGS or _slug_taken(base):
        if not base or not SLUG_REGEX.match(base):
            base = "workspace"
        for n in range(2, 27):
            candidate = f"{base}-{n}"[:63]
            if (
                SLUG_REGEX.match(candidate)
                and candidate not in RESERVED_SLUGS
                and not _slug_taken(candidate)
            ):
                return candidate
        for _ in range(5):
            candidate = f"{base}-{secrets.token_hex(3)}"[:63]
            if (
                SLUG_REGEX.match(candidate)
                and candidate not in RESERVED_SLUGS
                and not _slug_taken(candidate)
            ):
                return candidate
        raise ValueError("Could not allocate a unique workspace slug after retries.")
    return base


def provision_personal_workspace(*, user, name, time_zone=None, request=None) -> Organization:
    """Create an ACTIVE org + ACTIVE admin/owner membership for ``user``.

    No super-admin approval (self-serve). Atomic. Idempotency is the caller's
    concern (e.g. the tournament-create audit ``event_id``).
    """
    slug = pick_unique_org_slug(slugify_for_org(name) or "workspace")
    with transaction.atomic():
        org = Organization.objects.create(
            slug=slug,
            name=(name or "Workspace")[:200],
            status=OrgStatus.ACTIVE,
            time_zone=time_zone or getattr(settings, "DEFAULT_ORG_TIMEZONE", "Asia/Kolkata"),
            created_by=user,
        )
        OrganizationMembership.objects.create(
            user=user,
            organization=org,
            role=MembershipRole.ADMIN,
            is_org_owner=True,
            is_active=True,
            created_by=user,
        )
        emit_audit(
            actor_user=user,
            actor_role=ActorRole.ADMIN,
            event_type="workspace_provisioned",
            target_type="organization",
            target_id=org.id,
            organization_id=org.id,
            payload_after={"slug": org.slug, "status": org.status},
            request=request,
        )
    return org
