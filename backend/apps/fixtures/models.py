"""Scheduling resources (spec 2026-06-10 P3)."""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q, UniqueConstraint

from apps.accounts.models import uuid7


class Venue(models.Model):
    """A physical facility (ground / hall / court block) owned by the
    workspace and shared across its tournaments. ``venue_type`` matches the
    sport profiles' venue requirement ("ground", "indoor_court", ...);
    ``windows`` is a list of {"from": "09:00", "to": "18:00"} availability
    windows (empty = inherits the run's daily window). Matches keep storing
    the venue NAME (CharField) for back-compat — the scheduler resolves rich
    records by name at run time."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="venues",
    )
    name = models.CharField(max_length=120)
    venue_type = models.CharField(max_length=40, blank=True)
    windows = models.JSONField(default=list, blank=True)
    # Courts/tables/pitches at this venue (fixture-engine redesign §2.3): the
    # scheduler expands count=4 into 4 parallel sub-venues ("MP Hall · T1"…).
    count = models.PositiveSmallIntegerField(default=1)
    # Whole-day off-days for THIS venue only (increment S): a list of ISO
    # dates ("2026-08-03") excluded from the slot grid and treated as a hard
    # ``venue_unavailable`` violation by the repair-verb validation. Distinct
    # from tournament blackout_dates (all venues) and ``windows`` (daily
    # hours): "the ground is booked for a wedding on the 3rd".
    unavailable_dates = models.JSONField(default=list, blank=True)
    # Sports allowed on this venue (owner ask 2026-06-25): empty list = any
    # sport. When set (e.g. ["table_tennis"]) the scheduler only lands matches
    # of those sports here — so "2 courts per sport" becomes enforced, not just
    # convention: a TT match never sits on a Sepak Takraw court even when both
    # share the "indoor_court" type. Stored as a list of sport keys.
    sports = models.JSONField(default=list, blank=True)
    # Daily recurring BREAKS for THIS venue (owner ask 2026-06-27): a list of
    # {"from": "HH:MM", "to": "HH:MM"} windows subtracted from the venue's grid
    # every day, so no match is scheduled here during lunch/prayer. Distinct
    # from `windows` (daily open hours) and from the tournament-wide daily break
    # (a recurring_blackout_window constraint at scope "all").
    breaks = models.JSONField(default=list, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="venues_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "fixtures_venue"
        constraints = [
            UniqueConstraint(
                fields=["organization", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_venue_name_per_org",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return self.name


class Court(models.Model):
    """ONE playing surface at a :class:`Venue` — the thing a match is actually
    played on ("MP Hall · T2"), promoted to a first-class row so per-court
    facts (stream URL, overlay key, a court-wide scorer assignment) have
    somewhere to hang.

    ``name`` MUST be exactly what
    ``apps.fixtures.services.scheduler.court_venue_name`` produces, because
    ``Match.venue`` keeps storing that same string as a denormalised display
    value (~40 readers key off it) — ``Match.court`` is the new FK and
    ``Match.venue`` is kept in sync with ``court.name``. A ``count=1`` venue
    has ONE court whose name is the venue's own name (no ``" · T1"`` suffix),
    matching what ``expand_venues`` emits.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="courts",
    )
    venue = models.ForeignKey(
        Venue, on_delete=models.CASCADE, related_name="courts",
    )
    name = models.CharField(max_length=120)
    # 1-based T-number within the venue ("Hall · T3" -> 3). A single-court
    # venue is index 1 even though its name carries no suffix.
    index = models.PositiveSmallIntegerField(default=1)
    # Competitions reserved to THIS court (spec 2026-08-16 §D7): a list of
    # leaf-key PREFIXES, matched segment-aligned by
    # ``apps.tournaments.services.sports.leaf_allowed_by`` —
    # "table_tennis" (whole sport) / "table_tennis.u14" (both genders) /
    # "table_tennis.u14.boys" (one competition). Empty = takes anything.
    #
    # It lives here rather than on Venue because the whole point is two courts
    # in ONE hall running different categories; ``Venue.sports`` stays as the
    # coarser filter above it and a match must satisfy both.
    competitions = models.JSONField(default=list, blank=True)
    # Is that reservation a LOCK or a preference (owner 2026-08-17)?
    #
    # True (the original behaviour, and still the default): nothing else may
    # ever use this court. Right for a court taped out for one sport.
    #
    # False: its own competitions still get first claim — the scheduler scores
    # them onto it ahead of anyone else — but when they have nothing left to
    # play, a waiting match may use it instead of leaving it empty. That is the
    # case the owner hit: the girls table finishing at 13:00 and standing idle
    # for two hours while boys matches spilled to the next day.
    exclusive = models.BooleanField(default=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "fixtures_court"
        constraints = [
            UniqueConstraint(
                fields=["venue", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_court_name_per_venue",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return self.name


class FixtureSnapshot(models.Model):
    """A frozen copy of a tournament's whole fixture at one moment.

    The fixture is regenerated, rescheduled and hand-repaired over a
    tournament's life, and until now each pass overwrote the last with nothing
    kept: an organiser who liked yesterday's draw had no way back to it, and no
    way to show a school what changed. A snapshot is the answer — every match
    as it stood, restorable, and cheap enough to take on every generation.

    ``payload`` is the list of serialised matches (see services/snapshots.py);
    it carries each match's own id, so restoring puts the SAME rows back and
    every winner_of/loser_of pointer between them still resolves.
    """

    class Kind(models.TextChoices):
        GENERATED = "generated", "Fixture generated"
        SCHEDULED = "scheduled", "Schedule run"
        MANUAL = "manual", "Saved by hand"
        RESTORED = "restored", "Restored from an earlier fixture"

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="fixture_snapshots",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="fixture_snapshots",
    )
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.MANUAL)
    # What the organiser will recognise it by ("after the sepak re-group").
    label = models.CharField(max_length=120, blank=True)
    match_count = models.PositiveIntegerField(default=0)
    # Denormalised so the list page needs no payload read: competitions, days
    # and how many matches already have a result.
    summary = models.JSONField(default=dict, blank=True)
    payload = models.JSONField(default=list, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="fixture_snapshots",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "fixtures_fixturesnapshot"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["tournament", "-created_at"], name="fixsnap_trn_created_idx",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - admin convenience
        return f"{self.tournament_id} · {self.created_at:%Y-%m-%d %H:%M} · {self.match_count}"
