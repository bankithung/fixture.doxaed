"""Teams domain — Person ↔ Player split (invariant #8), Team, Player.

MVP of v1Teams.md: the sport-agnostic core needed to register schools' teams +
players and feed the fixture generator. Person is platform-scoped (no org FK)
so career stats roll up across tournaments; Team/Player are org-scoped
(invariant #2). DOB is stored coarsely as `dob_year` here; full Fernet-encrypted
DOB (v1Teams §7.3) is a follow-up.
"""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q, UniqueConstraint
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class TeamStatus(models.TextChoices):
    DRAFT = "draft", _("Draft")
    PENDING_APPROVAL = "pending_approval", _("Pending approval")
    REGISTERED = "registered", _("Registered")
    REJECTED = "rejected", _("Rejected")
    WITHDRAWN = "withdrawn", _("Withdrawn")
    DISQUALIFIED = "disqualified", _("Disqualified")


class Person(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    full_name = models.CharField(max_length=200)
    display_name = models.CharField(max_length=120, blank=True)
    dob_year = models.PositiveSmallIntegerField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="persons_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_person"
        indexes = [models.Index(fields=["full_name"], name="person_full_name_idx")]

    def __str__(self) -> str:  # pragma: no cover
        return self.full_name


class InstitutionKind(models.TextChoices):
    SCHOOL = "school", _("School")
    COLLEGE = "college", _("College")
    UNIVERSITY = "university", _("University")
    CLUB = "club", _("Club")
    ACADEMY = "academy", _("Academy")
    OTHER = "other", _("Other")


class InstitutionStatus(models.TextChoices):
    DRAFT = "draft", _("Draft")
    INVITED = "invited", _("Invited")
    REGISTERED = "registered", _("Registered")
    WITHDRAWN = "withdrawn", _("Withdrawn")
    REJECTED = "rejected", _("Rejected")


class Institution(models.Model):
    """A participant entity (school / college / club) that owns many Teams —
    the new level in Organization → Tournament → Institution → Team → Player
    (spec 2026-06-08 §1). Org + tournament scoped like Team/Player. Promotes the
    old free-text ``Team.school`` into a first-class row so Stage-2 team
    registration can attach teams to a chosen institution.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="institutions",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="institutions",
    )
    slug = models.CharField(max_length=80)
    name = models.CharField(max_length=200)
    short_name = models.CharField(max_length=40, blank=True)
    kind = models.CharField(
        max_length=16, choices=InstitutionKind.choices, default=InstitutionKind.SCHOOL,
    )
    region = models.CharField(max_length=120, blank=True)
    contact_name = models.CharField(max_length=200, blank=True)
    contact_email = models.EmailField(blank=True)
    contact_phone = models.CharField(max_length=32, blank=True)
    status = models.CharField(
        max_length=16, choices=InstitutionStatus.choices,
        default=InstitutionStatus.REGISTERED, db_index=True,
    )
    # Free-form labels the constraint engine keys off (e.g. {"campus": "north"}),
    # FET-style (mirrors Tournament.rules/constraints "everything is data").
    attributes = models.JSONField(default=dict, blank=True)
    # Optional pointer to the Stage-1 form response that created this row (bare
    # UUID, no FK — avoids a teams→forms cycle; mirrors audit scope columns).
    source_response_id = models.UUIDField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="institutions_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_institution"
        constraints = [
            UniqueConstraint(
                fields=["tournament", "slug"],
                name="unique_institution_slug_per_tournament",
            ),
            UniqueConstraint(
                fields=["tournament", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_institution_name_per_tournament",
            ),
        ]
        indexes = [
            models.Index(fields=["tournament", "status"], name="inst_trn_status_idx"),
            models.Index(fields=["organization"], name="inst_org_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return self.name


class Team(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="teams"
    )
    institution = models.ForeignKey(
        Institution, null=True, blank=True, on_delete=models.PROTECT,
        related_name="teams",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="teams"
    )
    slug = models.CharField(max_length=80)
    name = models.CharField(max_length=200)
    short_name = models.CharField(max_length=40, blank=True)
    school = models.CharField(max_length=200, blank=True)
    region = models.CharField(max_length=120, blank=True)
    pool = models.CharField(max_length=80, blank=True)  # display label (group/category)
    # Structural competition binding (spec 2026-06-10 §3): the sport key and
    # the category-leaf key ("football.u15.girls.5v5") this team registered
    # into. `pool` stays as the human-readable label; these are the machine
    # references fixtures/scoring scope by. Blank = uncategorized.
    sport = models.CharField(max_length=40, blank=True)
    leaf_key = models.CharField(max_length=160, blank=True, db_index=True)
    seed = models.PositiveSmallIntegerField(null=True, blank=True)
    status = models.CharField(
        max_length=24, choices=TeamStatus.choices, default=TeamStatus.REGISTERED,
        db_index=True,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="teams_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_team"
        constraints = [
            UniqueConstraint(
                fields=["tournament", "slug"], name="unique_team_slug_per_tournament"
            ),
            UniqueConstraint(
                fields=["tournament", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_team_name_per_tournament",
            ),
        ]
        indexes = [
            models.Index(fields=["tournament", "status"], name="team_trn_status_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.name} ({self.school})" if self.school else self.name


class Player(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="players"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="players"
    )
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="players")
    person = models.ForeignKey(Person, on_delete=models.PROTECT, related_name="players")
    jersey_no = models.PositiveSmallIntegerField(null=True, blank=True)
    position = models.CharField(max_length=16, blank=True)
    captain = models.BooleanField(default=False)
    is_goalkeeper = models.BooleanField(default=False)
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="players_added",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_player"
        constraints = [
            UniqueConstraint(
                fields=["team", "jersey_no"],
                condition=Q(deleted_at__isnull=True, jersey_no__isnull=False),
                name="unique_jersey_per_team",
            ),
            # W2-D: one entry per TEAM (not per tournament) — a student may
            # legitimately play U15 football AND badminton singles. The
            # scheduler treats teams sharing a person as linked (their
            # matches never overlap); same-leaf double-entry is blocked in
            # register_school.
            UniqueConstraint(
                fields=["team", "person"],
                condition=Q(deleted_at__isnull=True),
                name="unique_person_per_team",
            ),
            UniqueConstraint(
                fields=["team"],
                condition=Q(captain=True, deleted_at__isnull=True),
                name="unique_captain_per_team",
            ),
        ]
        indexes = [
            models.Index(fields=["team"], name="player_team_idx"),
            models.Index(fields=["person"], name="player_person_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"#{self.jersey_no} {self.person_id}"


class RegistrationLink(models.Model):
    """A shareable token an organizer hands out so schools self-register their
    teams + players (no account needed). Plaintext token is shown once; only the
    sha256 hash is stored (same pattern as invitations)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="registration_links",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="registration_links",
    )
    token_hash = models.CharField(max_length=128, db_index=True)
    label = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    max_submissions = models.PositiveIntegerField(null=True, blank=True)
    submission_count = models.PositiveIntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="registration_links_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_registration_link"

    def __str__(self) -> str:  # pragma: no cover
        return f"RegistrationLink({self.tournament_id})"
