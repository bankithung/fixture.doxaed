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


class TournamentStage(models.TextChoices):
    """Setup-workflow stages (spec 2026-06-08 §1). Orthogonal to TournamentStatus
    (the PRD §5.2 lifecycle): the lifecycle is draft→…→live→completed; the *stage*
    is the owner's 4-stage setup flow. Coupling is one-way and applied in
    ``services/state.py::transition_tournament``.

    Forward order: SETUP < ORG_REGISTRATION < TEAM_REGISTRATION < MEMBERS <
    FIXTURES < READY. Forward is one step at a time; backward (reopen) may jump to
    any earlier stage. Advancing auto-closes the previous stage's bound form.
    """

    SETUP = "setup", _("Setup")
    ORG_REGISTRATION = "org_registration", _("Institution registration")
    TEAM_REGISTRATION = "team_registration", _("Team registration")
    MEMBERS = "members", _("Members & roles")
    FIXTURES = "fixtures", _("Fixtures")
    READY = "ready", _("Ready")


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
    # Event window + season label (school-data spine, 2026-07-02 master plan):
    # the tournament finally knows WHEN it runs, so lists, public pages, and
    # multi-year school histories can group and sort structurally. Backfilled
    # from match scheduled_at; kept fresh by the scheduler.
    starts_at = models.DateField(null=True, blank=True)
    ends_at = models.DateField(null=True, blank=True)
    season = models.CharField(max_length=16, blank=True)  # e.g. "2026" (legacy label)
    # P2: the org-scoped Season container (academic year) this event belongs
    # to — house points and records roll up per season. The bare `season`
    # string stays for backfill; new events set both.
    season_ref = models.ForeignKey(
        "teams.Season", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="tournaments",
    )
    # Setup-workflow stage (orthogonal to `status`). Driven by
    # services/state.py::transition_tournament. See spec 2026-06-08 §1.
    stage = models.CharField(
        max_length=24,
        choices=TournamentStage.choices,
        default=TournamentStage.SETUP,
        db_index=True,
    )
    # Per-stage bookkeeping (entered/exited/reopened, who, completeness snapshot),
    # keyed by stage value. JSONB (mirrors rules/constraints convention); the
    # audit log holds the full transition history. See spec §3.1.
    stage_meta = models.JSONField(default=dict, blank=True)
    # invariant 10 — auto-generate + manual-edit conflict tracking (filled by Phase 1B generators).
    inputs_hash = models.CharField(max_length=64, blank=True)
    last_manual_edit_at = models.DateTimeField(null=True, blank=True)
    # Data-driven rules + scheduling constraints (FET-style). See
    # docs/superpowers/specs/2026-06-06-tournament-rules-constraints-design.md.
    # `rules` is editable in draft/published, frozen at registration_open (invariant 7).
    rules = models.JSONField(default=dict, blank=True)
    constraints = models.JSONField(default=list, blank=True)
    # Multi-sport: the sports this tournament runs, chosen at SETUP. A list of
    # {key, name, custom, scoring?, scheduling?, nodes: [recursive category
    # tree], categories: [legacy 2-level projection]} — normalized by
    # apps.tournaments.services.sports (spec 2026-06-10 §3). The legacy single
    # `sport` FK above is kept for back-compat.
    sports = models.JSONField(default=list, blank=True)
    # Last-used scheduling wizard payload (dates, windows, venues, rest...) so
    # re-runs prefill instead of retyping. Operational config, deliberately
    # OUTSIDE `rules` (which freezes at registration_open — invariant 7).
    scheduling_config = models.JSONField(default=dict, blank=True)
    # Per-competition draw configuration (fixture-engine redesign spec §2.1):
    # {"<leaf_key>": DrawConfig, "*": DrawConfig} — generation inputs (format,
    # group size, legs, seeding, third place). Deliberately OUTSIDE `rules`:
    # draw config is finalized after registration closes and is governed by
    # invariant 10 (inputs_hash staleness), not the invariant-7 freeze. See
    # apps.fixtures.services.draw_config for the whitelist + layering.
    draw_config = models.JSONField(default=dict, blank=True)
    rules_frozen_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
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
            models.Index(fields=["organization", "stage"], name="trn_org_stage_idx"),
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
