"""Per-court streaming bindings — the rows that turn a :class:`Court` into a
thing a spectator can watch.

Three models, and the split between them is the whole design:

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
* :class:`StreamLink` is the **hand-pasted override** at whichever scope the
  organiser actually works at — one match, one court for one day, or one
  competition category. The two models above are what the *automation* owns;
  this one is what a human owns, and it is deliberately the thing that wins
  (precedence rule in ``apps.streaming.services.links``). Whatever a human
  pasted this morning beats whatever the YouTube API opened for them, because
  the human is the one looking at the encoder.

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
from django.db.models import CheckConstraint, Q, UniqueConstraint
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


class StreamLinkScope(models.TextChoices):
    """Which thing a :class:`StreamLink` is pinned to.

    Ordered here the way the resolver consults them — most specific first — so
    the discriminator itself documents the precedence (see
    ``apps.streaming.services.links``).
    """

    MATCH = "match", _("Match")
    COURT_DAY = "court_day", _("Court, for one day")
    CATEGORY = "category", _("Sport category")


class StreamLink(models.Model):
    """ONE hand-pasted watch URL, pinned to a match, a court-day or a category.

    The organiser told us how they actually work: *"per court and per day there
    will be one live stream link used throughout the day; it can be updated,
    it's just a link. There can also be one per sport category, or even per
    match."* So the scope is not a design choice we get to make for them — all
    three exist, all three are optional, and the most specific one that is set
    wins. That is why this is ONE table with a discriminator rather than three
    tables: the resolver walks a single ordered list, and a fourth scope later
    (per venue, per day-of-tournament) is a choices entry, not a migration of
    three more lookups into every call site.

    Nullable targets are the price of the discriminator, so the shapes are
    pinned at the DATABASE level rather than trusted to the views:

    * ``match`` scope carries only ``match``;
    * ``court_day`` scope carries ``court`` + ``day`` — ``day`` is the LOCAL
      tournament day, exactly like :attr:`CourtBroadcast.day`, never a UTC date
      (a 23:30 IST match would otherwise be filed under tomorrow);
    * ``category`` scope carries ``tournament`` + ``leaf_key`` — the
      competition leaf (``football.u15.girls``) that ``Match.leaf_key`` points
      at. Leaf keys are only unique *within* a tournament, hence the pair.

    ``enabled`` is an off switch that actually switches off: a disabled row is
    skipped by the resolver and the next level down applies. Note this is NOT
    the same meaning as :attr:`CourtStream.enabled` (which gates "is this court
    on air", not "does this URL resolve") — an override whose toggle did not
    make the override stop overriding would be useless, since the only other
    way back to the automation would be deleting the row.

    Invariants: UUID v7 PK (1), ``organization`` on every row (2), ``event_id``
    for idempotent writes (3), soft delete via ``deleted_at``.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="stream_links",
    )
    scope = models.CharField(
        max_length=16, choices=StreamLinkScope.choices, db_index=True,
    )
    # --- the three mutually exclusive targets (see the CheckConstraint) ---
    match = models.ForeignKey(
        "matches.Match", null=True, blank=True, on_delete=models.CASCADE,
        related_name="stream_links",
    )
    court = models.ForeignKey(
        "fixtures.Court", null=True, blank=True, on_delete=models.CASCADE,
        related_name="stream_links",
    )
    day = models.DateField(null=True, blank=True)
    tournament = models.ForeignKey(
        "tournaments.Tournament", null=True, blank=True,
        on_delete=models.CASCADE, related_name="stream_links",
    )
    # Same width as ``Match.leaf_key`` — this column is compared against it.
    leaf_key = models.CharField(max_length=160, blank=True, default="")
    # Same width as CourtStream.watch_url: YouTube share URLs carry tracking
    # query strings and blow past the URLField default of 200.
    watch_url = models.URLField(max_length=500, blank=True)
    # Defaults TRUE, unlike CourtStream.enabled: a link is pasted in order to be
    # used, and pasting one is the act of switching it on.
    enabled = models.BooleanField(default=True)
    event_id = models.UUIDField(unique=True, null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "streaming_stream_link"
        constraints = [
            # One live link per scope target, mirroring how CourtBroadcast
            # constrains (court, day): the resolver picks ONE row per level, so
            # two active rows for the same target would make the answer depend
            # on insertion order. Soft-deleted rows are excluded so a target can
            # be re-bound after a DELETE (the row is kept for the audit trail).
            UniqueConstraint(
                fields=["match"],
                condition=Q(scope="match", deleted_at__isnull=True),
                name="unique_stream_link_per_match",
            ),
            UniqueConstraint(
                fields=["court", "day"],
                condition=Q(scope="court_day", deleted_at__isnull=True),
                name="unique_stream_link_per_court_day",
            ),
            UniqueConstraint(
                fields=["tournament", "leaf_key"],
                condition=Q(scope="category", deleted_at__isnull=True),
                name="unique_stream_link_per_category",
            ),
            # A discriminated union is only safe if the database enforces the
            # discrimination: without this, a `court_day` row with a NULL day
            # would sit in the table forever, never matching any lookup and
            # never showing up as an error either.
            CheckConstraint(
                condition=(
                    Q(
                        scope="match",
                        match__isnull=False,
                        court__isnull=True,
                        day__isnull=True,
                        leaf_key="",
                    )
                    | Q(
                        scope="court_day",
                        match__isnull=True,
                        court__isnull=False,
                        day__isnull=False,
                        leaf_key="",
                    )
                    | Q(
                        scope="category",
                        match__isnull=True,
                        court__isnull=True,
                        day__isnull=True,
                        tournament__isnull=False,
                    )
                    & ~Q(leaf_key="")
                ),
                name="stream_link_scope_target_matches_scope",
            ),
        ]
        indexes = [
            # The two lookups the resolver makes per payload.
            models.Index(
                fields=["court", "day"], name="stream_link_court_day_idx"
            ),
            models.Index(
                fields=["tournament", "leaf_key"], name="stream_link_leaf_idx"
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr aid
        return f"StreamLink({self.scope} {self.target_key})"

    @property
    def target_key(self) -> str:
        """A human/log-safe identifier for what this row is pinned to."""
        if self.scope == StreamLinkScope.MATCH:
            return str(self.match_id)
        if self.scope == StreamLinkScope.COURT_DAY:
            return f"{self.court_id} {self.day}"
        return f"{self.tournament_id} {self.leaf_key}"

    @property
    def resolves(self) -> bool:
        """Whether this row is one the resolver may hand to a spectator: an
        empty URL is a cleared binding, and a disabled one is switched off —
        both fall through to the next level rather than yielding ``None``."""
        return bool(self.enabled and self.watch_url)
