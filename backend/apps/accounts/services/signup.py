"""Public self-signup service (v1Users.md §2.3 Path B).

Path A (invite) is handled by the organizations app's invitation accept
flow — those users are joining an existing tenant. Path B is the
"someone discovered the platform on their own" flow: they are creating
a brand-new tenant and themselves as its (pending) Admin owner.

This module owns the multi-row creation:

  1. ``User`` (is_active=False, awaiting email verification).
  2. ``Organization`` (status=pending_review, slug derived).
  3. ``OrganizationMembership`` (role=admin, is_org_owner=True,
     is_active=False — pending until SA approves the org).
  4. ``EmailVerificationToken`` for the user.
  5. Audit emission tying all four together.

All five rows live in one ``transaction.atomic()`` block — if any
step fails, the whole signup unwinds.

Idempotency
-----------
Callers may pass a client-generated ``event_id`` (UUID). The audit
table's ``idempotency_key`` is the storage of record: a re-submit
with the same ``event_id`` short-circuits and returns whatever was
created the first time (per architectural invariant 3).

Slug derivation
---------------
If the caller supplies ``org_name``, slugify it. Otherwise use the
email local-part. The result is then made unique against
``Organization.slug`` and ``SlugRedirect.old_slug`` and validated
against ``RESERVED_SLUGS``. If contention is unresolvable inside 25
attempts a ValueError surfaces.
"""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone

from apps.accounts.models import EmailVerificationToken, User
from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.organizations.constants import RESERVED_SLUGS, SLUG_REGEX
from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
    OrgStatus,
    SlugRedirect,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class SignupResult:
    """Container returned by ``perform_signup``."""

    user: User
    organization: Organization | None
    membership: OrganizationMembership | None
    verification_token_plaintext: str | None
    created: bool  # False on idempotency-replay or duplicate-email
    duplicate_email: bool  # True when the email was already taken (B.11 enum-safe)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


_SLUG_SCRUB = re.compile(r"[^a-z0-9-]+")
_HYPHEN_RUN = re.compile(r"-+")


def _slugify_for_org(raw: str) -> str:
    """Lowercase, strip non-DNS chars, collapse hyphens, trim ends.

    Returns "" if the result is empty after scrubbing. Length-capped at
    63 (DNS label limit). Caller is responsible for de-duplication and
    reserved-list rejection (we do that in ``_pick_unique_slug``).
    """
    candidate = (raw or "").strip().lower()
    candidate = _SLUG_SCRUB.sub("-", candidate)
    candidate = _HYPHEN_RUN.sub("-", candidate)
    candidate = candidate.strip("-")
    return candidate[:63]


def _slug_taken(slug: str) -> bool:
    """True if the slug is already an Org slug or a SlugRedirect.old_slug."""
    if Organization.objects.filter(slug=slug).exists():
        return True
    if SlugRedirect.objects.filter(old_slug=slug).exists():
        return True
    return False


def _pick_unique_slug(seed: str) -> str:
    """Find a free slug starting from ``seed``.

    Strategy:
      1. If ``seed`` is already valid + free + non-reserved, take it.
      2. Otherwise append ``-2``, ``-3``, ... up to 25 tries.
      3. If still not free, append a 6-char random suffix.

    Raises ValueError if everything collides (cosmically unlucky, but
    not silently swallowed — caller can surface as 500).
    """
    base = seed or ""
    if not base or not SLUG_REGEX.match(base) or base in RESERVED_SLUGS or _slug_taken(base):
        # Need to mutate base; ensure base itself is at least valid-shaped.
        if not base or not SLUG_REGEX.match(base):
            base = "org"
        for n in range(2, 27):
            candidate = f"{base}-{n}"[:63]
            if (
                SLUG_REGEX.match(candidate)
                and candidate not in RESERVED_SLUGS
                and not _slug_taken(candidate)
            ):
                return candidate
        # Last resort — random suffix.
        for _ in range(5):
            suffix = secrets.token_hex(3)  # 6 chars
            candidate = f"{base}-{suffix}"[:63]
            if (
                SLUG_REGEX.match(candidate)
                and candidate not in RESERVED_SLUGS
                and not _slug_taken(candidate)
            ):
                return candidate
        raise ValueError("Could not allocate a unique org slug after retries.")
    return base


def _derive_slug(*, org_name: str | None, email: str) -> str:
    """Pick the slug seed — ``org_name`` if given, else email local-part."""
    if org_name and org_name.strip():
        seed = _slugify_for_org(org_name)
        if seed:
            return _pick_unique_slug(seed)
    local_part = email.split("@", 1)[0] if "@" in email else email
    seed = _slugify_for_org(local_part) or "org"
    return _pick_unique_slug(seed)


def _replay_from_idempotency(event_id: uuid.UUID) -> SignupResult | None:
    """If we've already processed this ``event_id``, return the prior result.

    The audit row written by ``perform_signup`` carries the
    ``idempotency_key`` and points to the User via ``target_id``; we use
    that to rebuild the prior return shape. The Org / membership are
    looked up via the audit row's payload.
    """
    audit_row = AuditEvent.objects.filter(
        idempotency_key=event_id, event_type="user_signup"
    ).first()
    if audit_row is None:
        return None

    user = User.objects.filter(pk=audit_row.target_id).first()
    if user is None:
        # Audit exists but user was hard-deleted — refuse to replay
        # (caller will treat as fresh attempt; new event_id required).
        return None

    org = None
    membership = None
    payload = audit_row.payload_after or {}
    org_id = payload.get("organization_id")
    if org_id:
        org = Organization.objects.filter(pk=org_id).first()
    membership_id = payload.get("membership_id")
    if membership_id:
        membership = OrganizationMembership.objects.filter(pk=membership_id).first()

    return SignupResult(
        user=user,
        organization=org,
        membership=membership,
        verification_token_plaintext=None,  # plaintext token not retained
        created=False,
        duplicate_email=False,
    )


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


def perform_signup(
    *,
    email: str,
    password: str,
    name: str = "",
    org_name: str = "",
    event_id: uuid.UUID | None = None,
    request: HttpRequest | None = None,
) -> SignupResult:
    """Run the v1Users.md §2.3 Path B signup flow atomically.

    Returns a ``SignupResult`` describing what was (or wasn't) created.

    The ``duplicate_email=True`` path returns no Org/Membership — by
    design, since the existing email already belongs to another tenant
    and we do not silently mint a second one. Callers should still
    return an enumeration-safe 201 response per B.11.
    """
    email = (email or "").strip().lower()
    org_name = (org_name or "").strip()
    name = (name or "").strip()

    # -- Idempotency replay short-circuit --------------------------------
    if event_id is not None:
        replay = _replay_from_idempotency(event_id)
        if replay is not None:
            return replay

    # -- Duplicate email guard (enumeration-safe per B.11) ---------------
    if User.objects.filter(email=email).exists():
        return SignupResult(
            user=User.objects.get(email=email),
            organization=None,
            membership=None,
            verification_token_plaintext=None,
            created=False,
            duplicate_email=True,
        )

    ttl_hours = getattr(settings, "EMAIL_VERIFICATION_TTL_HOURS", 48)

    with transaction.atomic():
        # 1. User --------------------------------------------------------
        user = User.objects.create_user(
            email=email,
            password=password,
            name=name,
            is_active=False,
        )

        # 2. Organization (status=pending_review) ------------------------
        slug = _derive_slug(org_name=org_name, email=email)
        display_name = (
            org_name
            or (name.strip() or email.split("@", 1)[0]) + "'s Organization"
        ).strip()[:200]
        try:
            org = Organization.objects.create(
                slug=slug,
                name=display_name,
                status=OrgStatus.PENDING_REVIEW,
                time_zone=getattr(settings, "DEFAULT_ORG_TIMEZONE", "Asia/Kolkata"),
                created_by=user,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Path B signup: org create failed")
            raise ValidationError("Unable to provision organization for signup.") from exc

        # 3. Pending Admin OrganizationMembership ------------------------
        membership = OrganizationMembership.objects.create(
            user=user,
            organization=org,
            role=MembershipRole.ADMIN,
            is_org_owner=True,
            is_active=False,  # pending until SA approves the org
            created_by=user,
        )

        # 4. Email verification token -----------------------------------
        plaintext = secrets.token_urlsafe(48)
        EmailVerificationToken.objects.create(
            user=user,
            token_hash=_hash_token(plaintext),
            expires_at=timezone.now() + timedelta(hours=ttl_hours),
        )

        # 5. Audit (idempotent on event_id) -----------------------------
        # Event type stays ``user_signup`` for compatibility with the
        # existing audit assertions; the richer Path B payload (org,
        # membership, path marker) goes in ``payload_after``.
        emit_audit(
            actor_user=user,
            actor_role=ActorRole.SYSTEM,
            event_type="user_signup",
            target_type="user",
            target_id=user.id,
            payload_after={
                "organization_id": str(org.id),
                "organization_slug": org.slug,
                "membership_id": str(membership.id),
                "path": "B",
            },
            organization_id=org.id,
            idempotency_key=event_id,
            request=request,
        )

    return SignupResult(
        user=user,
        organization=org,
        membership=membership,
        verification_token_plaintext=plaintext,
        created=True,
        duplicate_email=False,
    )
