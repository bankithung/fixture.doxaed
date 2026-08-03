"""Per-court streaming bindings — the rows that turn a :class:`Court` into a
thing a spectator can watch.

Two models, and the split between them is the whole design:

* :class:`CourtStream` is **permanent** and one-per-court. It holds the
  organiser's binding for that surface — in phase 1 a hand-pasted YouTube watch
  URL, in phase 3 the reusable ``liveStreams`` id + its ingestion key. It never
  changes from day to day, so the encoder pointed at a court is configured once.
* :class:`CourtBroadcast` is **per court per DAY** — never per match. YouTube
  bills a broadcast as one continuous video; opening one per match would
  produce dozens of 20-minute videos with no continuity and would blow through
  the daily broadcast quota. One broadcast per court per day means one archive
  per court, and a match is a ``&t=`` deep-link into it (see
  ``apps.streaming.services.links``).

``yt_stream_key`` is a **credential** — the RTMP ingestion secret. Anyone
holding it can push video onto the organiser's channel. It is write-only: it is
never included in a serializer, an API response, ``__str__`` or ``__repr__``,
and ``apps/streaming/tests/test_manager_api.py`` asserts that it never appears
in any response body.

Invariants: UUID v7 PKs (1), an ``organization`` FK on every row (2), soft
delete via ``deleted_at``, and a client ``event_id`` for idempotent writes (3).
"""
from __future__ import annotations

from django.db import models
from django.db.models import Q, UniqueConstraint
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class BroadcastLifecycle(models.TextChoices):
    """YouTube's ``liveBroadcasts.status.lifeCycleStatus``, narrowed to the
    states we act on (invariant 6 — a state machine, not booleans)."""

    CREATED = "created", _("Created")
    READY = "ready", _("Ready")
    LIVE = "live", _("Live")
    COMPLETE = "complete", _("Complete")
    ERRORED = "errored", _("Errored")


#: Lifecycle values that mean "this court is on air right now".
LIVE_LIFECYCLES = (BroadcastLifecycle.LIVE,)


class CourtStream(models.Model):
    """The permanent stream binding for ONE court.

    Phase 1 (this increment) uses ``watch_url`` only: the organiser streams from
    whatever they already use (phone, OBS, a school's channel) and pastes the
    resulting YouTube watch URL here. Phases 2/3 fill ``yt_stream_id`` /
    ``yt_stream_key`` from the API client in ``apps.streaming.services.youtube``
    and the pasted URL becomes the fallback.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    court = models.OneToOneField(
        "fixtures.Court", on_delete=models.CASCADE, related_name="stream",
    )
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="court_streams",
    )
    # PHASE 1: the organiser pastes a YouTube watch URL by hand. Deliberately
    # long-ish — YouTube share URLs carry tracking query strings.
    watch_url = models.URLField(max_length=500, blank=True)
    # PHASE 3: the reusable liveStreams resource bound to this court.
    yt_stream_id = models.CharField(max_length=64, blank=True)
    # PHASE 3: the RTMP ingestion key. WRITE-ONLY — never serialised, never
    # logged, never in __str__/__repr__. See the module docstring.
    yt_stream_key = models.CharField(max_length=128, blank=True)
    enabled = models.BooleanField(default=False)
    # Invariant 3: client-supplied idempotency token for the mutation that last
    # wrote this row; a replay of the same token returns the row (200, not 201).
    event_id = models.UUIDField(unique=True, null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "streaming_court_stream"

    def __str__(self) -> str:  # pragma: no cover - repr aid
        # NEVER interpolate yt_stream_key here: Django's default __repr__ is
        # "<CourtStream: {__str__}>", so a key leaked into __str__ would land in
        # every traceback, log line and error report.
        return f"CourtStream({self.court_id})"

    @property
    def has_stream_key(self) -> bool:
        """Whether an ingestion key is configured — the only thing about
        ``yt_stream_key`` that may cross an API boundary."""
        return bool(self.yt_stream_key)


class CourtBroadcast(models.Model):
    """ONE YouTube broadcast per court per day.

    ``yt_video_id`` is both the broadcast id and the video id (YouTube uses one
    identifier for both), so the watch URL is derived from it directly.
    ``actual_start_utc`` is when the broadcast actually went live — the origin
    of the archive clock, and therefore the base every match's ``&t=`` offset is
    measured from (``services.planning.vod_offset_seconds``).
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    court = models.ForeignKey(
        "fixtures.Court", on_delete=models.CASCADE, related_name="broadcasts",
    )
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="court_broadcasts",
    )
    # Local tournament day, not a UTC date: a 19:00 IST match belongs to that
    # evening's broadcast, which UTC would push onto the previous day.
    day = models.DateField()
    yt_video_id = models.CharField(max_length=64, blank=True)
    actual_start_utc = models.DateTimeField(null=True, blank=True)
    lifecycle = models.CharField(
        max_length=16, choices=BroadcastLifecycle.choices,
        default=BroadcastLifecycle.CREATED,
    )
    event_id = models.UUIDField(unique=True, null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "streaming_court_broadcast"
        constraints = [
            UniqueConstraint(
                fields=["court", "day"],
                condition=Q(deleted_at__isnull=True),
                name="unique_broadcast_per_court_day",
            ),
        ]
        indexes = [
            models.Index(fields=["court", "day"], name="broadcast_court_day_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr aid
        return f"CourtBroadcast({self.court_id} {self.day})"

    @property
    def is_live(self) -> bool:
        return self.lifecycle in LIVE_LIFECYCLES
