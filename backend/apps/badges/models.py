"""Badge awards (owner feature 2026-06-29) — achievements derived from played
results, with the EVIDENCE stored on the award (the numbers that make a nice
social post: "conceded 9 points", the set scores, the streak).

Award rows follow the house append-only discipline: a wrong award is revoked
(stamped ``revoked_at``, audited), never deleted; a re-award after revoke is a
new row. ``dedupe_key`` + the partial unique constraint make the reconciler
idempotent (invariant 3 in spirit).
"""
from __future__ import annotations

from django.db import models
from django.db.models import Q
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class BadgeSubject(models.TextChoices):
    TEAM = "team", _("Team")
    PLAYER = "player", _("Player")


class BadgeAward(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="badge_awards",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="badge_awards",
    )
    badge_key = models.CharField(max_length=64)
    # Competition scope: the category leaf + multi-stage index the award was
    # computed in ("" / 0 = whole-tournament or single-stage draws).
    leaf_key = models.CharField(max_length=200, blank=True)
    stage_no = models.IntegerField(default=0)
    group_label = models.CharField(max_length=40, blank=True)
    subject_type = models.CharField(
        max_length=12, choices=BadgeSubject.choices, default=BadgeSubject.TEAM
    )
    team = models.ForeignKey(
        "teams.Team", null=True, blank=True, on_delete=models.CASCADE,
        related_name="badge_awards",
    )
    player = models.ForeignKey(
        "teams.Player", null=True, blank=True, on_delete=models.CASCADE,
        related_name="badge_awards",
    )
    # Match-scope badges reference their match; scope-level awards leave it null.
    match = models.ForeignKey(
        "matches.Match", null=True, blank=True, on_delete=models.CASCADE,
        related_name="badge_awards",
    )
    # The numbers behind the award (set scores, conceded totals, streak match
    # ids) — rendered on share cards and certificates.
    evidence = models.JSONField(default=dict, blank=True)
    awarded_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    # Reconciler identity: badge_key:leaf:stage:group:subject:match-or-scope.
    dedupe_key = models.CharField(max_length=350)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tournament", "dedupe_key"],
                condition=Q(revoked_at__isnull=True),
                name="uniq_active_badge_award",
            )
        ]
        indexes = [
            models.Index(fields=["tournament", "badge_key"]),
            models.Index(fields=["team"]),
            models.Index(fields=["player"]),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr aid
        return f"{self.badge_key} -> {self.team_id or self.player_id}"
