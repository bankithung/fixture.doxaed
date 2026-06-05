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


class Team(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="teams"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="teams"
    )
    slug = models.CharField(max_length=80)
    name = models.CharField(max_length=200)
    short_name = models.CharField(max_length=40, blank=True)
    school = models.CharField(max_length=200, blank=True)
    region = models.CharField(max_length=120, blank=True)
    pool = models.CharField(max_length=80, blank=True)  # group/category
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
            UniqueConstraint(
                fields=["tournament", "person"],
                condition=Q(deleted_at__isnull=True),
                name="unique_person_per_tournament",
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
