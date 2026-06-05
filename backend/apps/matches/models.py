"""Match domain — the unit that gets scored (PRD §5.5, v1Matches.md MVP).

A Match is org-scoped (invariant #2), status is a state machine (invariant #6),
and carries typed home/away dependency pointers (invariant #9) so knockout
advancement can resolve later. For round-robin the teams are concrete.
"""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class MatchStatus(models.TextChoices):
    SCHEDULED = "scheduled", _("Scheduled")
    LIVE = "live", _("Live")
    COMPLETED = "completed", _("Completed")
    CANCELLED = "cancelled", _("Cancelled")


class Match(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="matches"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="matches"
    )
    stage = models.CharField(max_length=40, blank=True)  # e.g. "group", "knockout"
    group_label = models.CharField(max_length=80, blank=True)  # e.g. "Group A"
    round_no = models.PositiveSmallIntegerField(default=1)
    match_no = models.PositiveIntegerField(default=0)  # order within tournament

    home_team = models.ForeignKey(
        "teams.Team", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="home_matches",
    )
    away_team = models.ForeignKey(
        "teams.Team", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="away_matches",
    )
    # invariant #9 — typed dependency pointers (winner_of/loser_of/group_position/team/tbd)
    home_source = models.JSONField(default=dict, blank=True)
    away_source = models.JSONField(default=dict, blank=True)

    status = models.CharField(
        max_length=16, choices=MatchStatus.choices, default=MatchStatus.SCHEDULED,
        db_index=True,
    )
    home_score = models.PositiveSmallIntegerField(null=True, blank=True)
    away_score = models.PositiveSmallIntegerField(null=True, blank=True)

    scheduled_at = models.DateTimeField(null=True, blank=True)
    venue = models.CharField(max_length=120, blank=True)
    scorer = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="matches_scoring",
    )

    inputs_hash = models.CharField(max_length=64, blank=True)  # #10
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "matches_match"
        indexes = [
            models.Index(fields=["tournament", "status"], name="match_trn_status_idx"),
            models.Index(fields=["tournament", "group_label"], name="match_trn_group_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.home_team_id} vs {self.away_team_id} ({self.status})"

    @property
    def winner_id(self):
        if self.status != MatchStatus.COMPLETED or self.home_score is None:
            return None
        if self.home_score > self.away_score:
            return self.home_team_id
        if self.away_score > self.home_score:
            return self.away_team_id
        return None  # draw
