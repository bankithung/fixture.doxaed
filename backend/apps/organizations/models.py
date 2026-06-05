"""Organization, OrganizationMembership, AdminInvitation, SlugRedirect.

Locked invariants implemented here:
  - UUID v7 PKs everywhere (uuid7 helper from apps.accounts).
  - Multi-tenancy by Organization is the day-one boundary.
  - DEFERRABLE INITIALLY DEFERRED on `one_owner_per_org` so atomic
    ownership-swap inside a single transaction works.
  - single_org_per_admin_user DROPPED (decision #91: org-as-hidden-workspace;
    tournament-admin identity lives on TournamentMembership). one_owner_per_org
    and unique_active_role_per_user_per_org are retained.
  - Multi-role per (user, org) supported because role is part of the
    unique tuple in `unique_active_role_per_user_per_org`.
  - is_org_owner=True implies role=admin (CheckConstraint).
  - Soft-delete via `deleted_at` on Organization; `active_objects`
    manager filters it out.
"""
from __future__ import annotations

import datetime as _dt
from typing import Iterable, Optional

from django.conf import settings
from django.db import models
from django.db.models import Deferrable, Q, UniqueConstraint, CheckConstraint
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class OrgStatus(models.TextChoices):
    """Organization lifecycle (v1Users.md §2.1-§2.3)."""

    PENDING_REVIEW = "pending_review", _("Pending review")
    ACTIVE = "active", _("Active")
    SUSPENDED = "suspended", _("Suspended")
    ARCHIVED = "archived", _("Archived")
    ORPHANED = "orphaned", _("Orphaned")


class MembershipRole(models.TextChoices):
    """In-Org roles. Player goes via Phase 1B."""

    ADMIN = "admin", _("Admin")
    CO_ORGANIZER = "co_organizer", _("Co-organizer")
    GAME_COORDINATOR = "game_coordinator", _("Game coordinator")
    MATCH_SCORER = "match_scorer", _("Match scorer")
    REFEREE = "referee", _("Referee")
    TEAM_MANAGER = "team_manager", _("Team manager")


class InviteStatus(models.TextChoices):
    """AdminInvitation lifecycle (v1Users.md §2.13)."""

    PENDING = "pending", _("Pending")
    ACCEPTED = "accepted", _("Accepted")
    EXPIRED = "expired", _("Expired")
    REVOKED = "revoked", _("Revoked")


# ---------------------------------------------------------------------------
# Managers
# ---------------------------------------------------------------------------


class OrganizationManager(models.Manager):
    """Default manager — returns everything, including soft-deleted rows."""


class ActiveOrganizationManager(models.Manager):
    """Manager that filters out soft-deleted rows."""

    def get_queryset(self):  # type: ignore[override]
        return super().get_queryset().filter(deleted_at__isnull=True)


class OrganizationMembershipManager(models.Manager):
    """Convenience helpers used by the scope-filter pattern (Appendix B.2).

    Avoid bolting onto `User`; expose the user→accessible-org-ids mapping
    here so we don't stomp on the accounts agent's User class.
    """

    def user_org_ids(self, user) -> Iterable:
        """Return iterable of Organization UUIDs the user has any active
        membership in.
        """
        if not getattr(user, "is_authenticated", False):
            return []
        return (
            self.get_queryset()
            .filter(user=user, is_active=True, organization__deleted_at__isnull=True)
            .values_list("organization_id", flat=True)
            .distinct()
        )

    def active_for(self, user, organization):
        return self.get_queryset().filter(
            user=user, organization=organization, is_active=True
        )


# ---------------------------------------------------------------------------
# Organization
# ---------------------------------------------------------------------------


class Organization(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    slug = models.CharField(max_length=63, unique=True)
    name = models.CharField(max_length=200)

    status = models.CharField(
        max_length=24,
        choices=OrgStatus.choices,
        default=OrgStatus.PENDING_REVIEW,
        db_index=True,
    )

    # IANA TZ name; default Asia/Kolkata per project default. Validated
    # against zoneinfo.available_timezones() at the form / service layer.
    time_zone = models.CharField(max_length=64, default="Asia/Kolkata")

    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="orgs_created",
    )

    # Lifecycle marks
    archived_at = models.DateTimeField(null=True, blank=True)
    suspended_at = models.DateTimeField(null=True, blank=True)
    suspended_reason = models.TextField(blank=True)

    # Soft-delete (PRD invariant)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = OrganizationManager()
    active_objects = ActiveOrganizationManager()

    class Meta:
        db_table = "organizations_organization"
        indexes = [
            models.Index(fields=["status"], name="org_status_idx"),
            models.Index(fields=["slug"], name="org_slug_idx"),
            models.Index(fields=["deleted_at"], name="org_deleted_at_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.name} ({self.slug})"

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None


# ---------------------------------------------------------------------------
# OrganizationMembership
# ---------------------------------------------------------------------------


class OrganizationMembership(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="org_memberships",
    )
    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="memberships"
    )
    role = models.CharField(max_length=24, choices=MembershipRole.choices)

    # Only meaningful when role=admin. Enforced by CheckConstraint.
    is_org_owner = models.BooleanField(default=False)

    is_active = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="memberships_created",
    )
    removed_at = models.DateTimeField(null=True, blank=True)

    objects = OrganizationMembershipManager()

    class Meta:
        db_table = "organizations_membership"
        indexes = [
            models.Index(
                fields=["organization", "role", "is_active"],
                name="mem_org_role_active_idx",
            ),
            models.Index(fields=["user", "is_active"], name="mem_user_active_idx"),
        ]
        constraints = [
            # 1. unique active (user, org, role) tuple — multi-role per
            # (user, org) is allowed because role is part of the key.
            UniqueConstraint(
                fields=["user", "organization", "role"],
                condition=Q(is_active=True),
                name="unique_active_role_per_user_per_org",
            ),
            # 2. Exactly one is_org_owner=True per Org (active rows only).
            # NOTE (accounts agent deferral): Django prohibits combining
            # `condition` with `deferrable` — the spec's
            # DEFERRABLE INITIALLY DEFERRED requirement is therefore added
            # by a follow-up RunSQL migration owned by the organizations
            # agent. This declarative constraint stays IMMEDIATE until then.
            UniqueConstraint(
                fields=["organization"],
                condition=Q(is_org_owner=True, is_active=True),
                name="one_owner_per_org",
            ),
            # is_org_owner=True implies role=admin.
            CheckConstraint(
                condition=Q(is_org_owner=False) | Q(role="admin"),
                name="owner_flag_only_on_admin_role",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        owner = " (owner)" if self.is_org_owner else ""
        return f"{self.user_id} as {self.role} in {self.organization_id}{owner}"


# ---------------------------------------------------------------------------
# AdminInvitation
# ---------------------------------------------------------------------------


def _default_invite_expiry() -> _dt.datetime:
    days = getattr(settings, "INVITE_TOKEN_TTL_DAYS", 7)
    return timezone.now() + _dt.timedelta(days=days)


class AdminInvitation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="invitations"
    )
    email = models.EmailField()
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="invitations_sent",
    )
    role = models.CharField(
        max_length=24,
        choices=MembershipRole.choices,
        default=MembershipRole.CO_ORGANIZER,
    )

    # Tournament-scoped invite (decision #91); null = org-level invite.
    tournament = models.ForeignKey(
        "tournaments.Tournament",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="invitations",
    )

    # sha256(token_plaintext) — plaintext is emailed only.
    token_hash = models.CharField(max_length=128, db_index=True)

    status = models.CharField(
        max_length=16,
        choices=InviteStatus.choices,
        default=InviteStatus.PENDING,
    )

    expires_at = models.DateTimeField(default=_default_invite_expiry)

    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_by_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="invitations_accepted",
    )
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_reason = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "organizations_admin_invitation"
        indexes = [
            models.Index(fields=["email", "status"], name="inv_email_status_idx"),
            models.Index(fields=["token_hash"], name="inv_token_hash_idx"),
        ]
        constraints = [
            UniqueConstraint(
                fields=["organization", "tournament", "email"],
                condition=Q(status="pending"),
                name="unique_pending_invite_per_email_per_org_tournament",
            ),
        ]

    def save(self, *args, **kwargs):
        if self.email:
            self.email = self.email.lower()
        super().save(*args, **kwargs)

    def is_expired(self, now: Optional[_dt.datetime] = None) -> bool:
        return (now or timezone.now()) > self.expires_at

    @property
    def effective_status(self) -> str:
        """Pending invites whose expires_at is in the past surface as
        'expired' on read, even if the DB row hasn't been swept yet.
        """
        if self.status == InviteStatus.PENDING and self.is_expired():
            return InviteStatus.EXPIRED
        return self.status

    def __str__(self) -> str:  # pragma: no cover
        return f"Invite {self.email} → {self.organization_id} ({self.status})"


# ---------------------------------------------------------------------------
# SlugRedirect
# ---------------------------------------------------------------------------


class SlugRedirect(models.Model):
    """When an Org's slug changes, write one of these so old links resolve."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    old_slug = models.CharField(max_length=63, unique=True)
    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="slug_redirects"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "organizations_slug_redirect"

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.old_slug} → {self.organization_id}"
