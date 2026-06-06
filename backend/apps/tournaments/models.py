"""Tournament + TournamentMembership (design-selfserve-flow.md §3.1).

Locked invariants implemented here:
  - UUID v7 PKs (invariant 1).
  - Tournament is org-scoped via `organization` FK (invariant 2).
  - `status` is a state-machine enum, not a boolean (invariant 6); PRD §5.2 is
    canonical, this is the v1 subset.
  - `inputs_hash` / `last_manual_edit_at` present from day 1 so generators can
    fill them (invariant 10).
  - Tournament-admin identity lives HERE (TournamentMembership.role=admin), which
    is what lets us drop `single_org_per_admin_user` on OrganizationMembership.
    Widening to the 6-role set is decision #91 (see v1Users.md).
"""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q, UniqueConstraint
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class TournamentStatus(models.TextChoices):
    """Tournament lifecycle (PRD §5.2 canonical; v1 subset)."""

    DRAFT = "draft", _("Draft")
    PUBLISHED = "published", _("Published")
    REGISTRATION_OPEN = "registration_open", _("Registration open")
    SCHEDULED = "scheduled", _("Scheduled")
    LIVE = "live", _("Live")
    COMPLETED = "completed", _("Completed")
    ARCHIVED = "archived", _("Archived")


class TournamentMembershipRole(models.TextChoices):
    """Tournament-scoped roles (decision #91 widens v1Users §4.7 to 6 roles)."""

    ADMIN = "admin", _("Admin")
    CO_ORGANIZER = "co_organizer", _("Co-organizer")
    GAME_COORDINATOR = "game_coordinator", _("Game coordinator")
    MATCH_SCORER = "match_scorer", _("Match scorer")
    REFEREE = "referee", _("Referee")
    TEAM_MANAGER = "team_manager", _("Team manager")


class TournamentMembershipStatus(models.TextChoices):
    ACTIVE = "active", _("Active")
    SUSPENDED = "suspended", _("Suspended")
    REVOKED = "revoked", _("Revoked")


class Tournament(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="tournaments",
    )
    sport = models.ForeignKey(
        "sports.Sport",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="tournaments",
    )
    slug = models.CharField(max_length=63)
    name = models.CharField(max_length=200)
    status = models.CharField(
        max_length=24,
        choices=TournamentStatus.choices,
        default=TournamentStatus.DRAFT,
        db_index=True,
    )
    time_zone = models.CharField(max_length=64, default="Asia/Kolkata")
    # invariant 10 — auto-generate + manual-edit conflict tracking (filled by Phase 1B generators).
    inputs_hash = models.CharField(max_length=64, blank=True)
    last_manual_edit_at = models.DateTimeField(null=True, blank=True)
    # Data-driven rules + scheduling constraints (FET-style). See
    # docs/superpowers/specs/2026-06-06-tournament-rules-constraints-design.md.
    # `rules` is editable in draft/published, frozen at registration_open (invariant 7).
    rules = models.JSONField(default=dict, blank=True)
    constraints = models.JSONField(default=list, blank=True)
    rules_frozen_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="tournaments_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        db_table = "tournaments_tournament"
        constraints = [
            UniqueConstraint(
                fields=["organization", "slug"],
                condition=Q(deleted_at__isnull=True),
                name="unique_tournament_slug_per_org",
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "status"], name="trn_org_status_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.name} ({self.slug})"

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None


class TournamentMembership(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="tournament_memberships",
    )
    tournament = models.ForeignKey(
        Tournament, on_delete=models.CASCADE, related_name="memberships"
    )
    role = models.CharField(max_length=24, choices=TournamentMembershipRole.choices)
    status = models.CharField(
        max_length=16,
        choices=TournamentMembershipStatus.choices,
        default=TournamentMembershipStatus.ACTIVE,
    )
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="tournament_assignments_made",
    )
    assigned_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "tournaments_membership"
        constraints = [
            UniqueConstraint(
                fields=["user", "tournament", "role"],
                condition=Q(status="active"),
                name="unique_active_tournament_role",
            ),
        ]
        indexes = [
            models.Index(
                fields=["tournament", "role", "status"], name="trnmem_t_role_status_idx"
            ),
            models.Index(fields=["user", "status"], name="trnmem_user_status_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.user_id} as {self.role} in {self.tournament_id}"
