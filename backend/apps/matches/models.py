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
    HALF_TIME = "half_time", _("Half time")
    COMPLETED = "completed", _("Completed")
    CANCELLED = "cancelled", _("Cancelled")
    POSTPONED = "postponed", _("Postponed")
    ABANDONED = "abandoned", _("Abandoned")
    WALKOVER = "walkover", _("Walkover")


class MatchEventType(models.TextChoices):
    GOAL = "goal", _("Goal")
    OWN_GOAL = "own_goal", _("Own goal")
    PENALTY_SCORED = "penalty_scored", _("Penalty scored")
    PENALTY_MISSED = "penalty_missed", _("Penalty missed")
    YELLOW_CARD = "yellow_card", _("Yellow card")
    RED_CARD = "red_card", _("Red card")
    SUBSTITUTION = "substitution", _("Substitution")
    PERIOD_START = "period_start", _("Period start")
    PERIOD_END = "period_end", _("Period end")
    VOID = "void", _("Void (reversal)")


# Event types that count toward the score (for the event-scoring team).
SCORING_EVENT_TYPES = frozenset(
    {MatchEventType.GOAL, MatchEventType.PENALTY_SCORED}
)


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
    current_period = models.CharField(max_length=24, blank=True)  # e.g. "first_half"
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
        if self.status not in (MatchStatus.COMPLETED, MatchStatus.WALKOVER):
            return None
        if self.home_score is None or self.away_score is None:
            return None
        if self.home_score > self.away_score:
            return self.home_team_id
        if self.away_score > self.home_score:
            return self.away_team_id
        return None  # draw

    @property
    def loser_id(self):
        w = self.winner_id
        if w is None:
            return None
        return self.away_team_id if w == self.home_team_id else self.home_team_id


class MatchEvent(models.Model):
    """DB-first event log (invariant #4) — the system of record for what happened
    in a match. Scores are DERIVED from these rows. Append-only in spirit:
    corrections are a VOID event referencing the original, never an UPDATE/DELETE.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="match_events",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="match_events",
    )
    match = models.ForeignKey(Match, on_delete=models.CASCADE, related_name="events")
    # Gapless per-match ordering (assigned under select_for_update on the match).
    sequence_no = models.PositiveIntegerField()
    event_type = models.CharField(max_length=20, choices=MatchEventType.choices)
    team = models.ForeignKey(
        "teams.Team", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="match_events",
    )
    player = models.ForeignKey(
        "teams.Player", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="match_events",
    )
    related_player = models.ForeignKey(
        "teams.Player", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="match_events_related",
    )  # substitution-on / assist
    minute = models.PositiveSmallIntegerField(null=True, blank=True)
    period = models.CharField(max_length=24, blank=True)
    detail = models.JSONField(default=dict, blank=True)
    # When event_type == VOID, points at the event being reversed.
    voids = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="voided_by",
    )
    event_id = models.UUIDField(unique=True, null=True, blank=True)  # idempotency #3
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="match_events_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "matches_match_event"
        ordering = ["match", "sequence_no"]
        constraints = [
            models.UniqueConstraint(
                fields=["match", "sequence_no"], name="unique_event_seq_per_match"
            ),
        ]
        indexes = [
            models.Index(fields=["match", "sequence_no"], name="event_match_seq_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.match_id}#{self.sequence_no} {self.event_type}"
