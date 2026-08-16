"""Court resolution — the seam that keeps ``Match.court`` (the FK) and
``Match.venue`` (the denormalised display string) in sync.

A court's identity is a display name: the physical venue's name, optionally
carrying the ``" · T<n>"`` suffix ``scheduler.court_venue_name`` builds for a
``Venue.count > 1`` facility. That string has always been what ``Match.venue``
stores, and ~40 readers still key off it, so promoting court to a row means
resolving the string to a :class:`~apps.fixtures.models.Court` and writing BOTH
columns at every slot write.

Rules:

* The base :class:`~apps.fixtures.models.Venue` is resolved with the SAME
  helper the scheduler/validator use (``scheduler.court_base_of``) against the
  org's configured venue names, so a stranded court ("Hall · T5" after
  ``count`` dropped to 2) still resolves to its hall.
* No base ``Venue`` row → **no court** (``None``). Venue rows are never
  invented here; the caller keeps the free-text string and leaves the FK null.
  Scheduler configs may legitimately name venues that have no workspace row.
* ``Court`` rows ARE created on demand (they are pure derived identity), so
  the first slot written to "Hall · T3" materialises that court.
"""
from __future__ import annotations

from apps.fixtures.models import Court, Venue
from apps.fixtures.services.scheduler import _COURT_SUFFIX, court_base_of


def court_index_of(name: str, base: str) -> int:
    """The 1-based T-number encoded in a court display ``name`` given its
    resolved ``base`` venue name. A bare base name (``count=1`` venue) is
    court 1."""
    prefix = f"{base}{_COURT_SUFFIX}"
    if name.startswith(prefix):
        tail = name[len(prefix):]
        if tail.isdigit():
            return max(1, int(tail))
    return 1


class CourtResolver:
    """Resolve court display names for ONE organization, memoised.

    Built once per bulk run (the scheduler commits hundreds of slots) so the
    org's venue list and each distinct court are looked up a single time.
    """

    def __init__(self, organization) -> None:
        self.organization = organization
        self._venues: dict[str, Venue] | None = None
        self._cache: dict[str, Court | None] = {}

    @property
    def venues(self) -> dict[str, Venue]:
        if self._venues is None:
            self._venues = {
                v.name: v
                for v in Venue.objects.filter(
                    organization=self.organization, deleted_at__isnull=True
                )
            }
        return self._venues

    def resolve(self, venue_name: str | None) -> Court | None:
        """The Court for display name ``venue_name``, created if the base
        Venue exists and the court row doesn't. ``None`` for a blank name or
        an unknown base venue (the caller keeps the raw string)."""
        name = (venue_name or "").strip()[:120]
        if not name:
            return None
        if name in self._cache:
            return self._cache[name]
        base = court_base_of(name, list(self.venues))
        venue = self.venues.get(base)
        court: Court | None = None
        if venue is not None:
            court = Court.objects.filter(
                venue=venue, name=name, deleted_at__isnull=True
            ).first()
            if court is None:
                court = Court.objects.create(
                    organization=venue.organization,
                    venue=venue,
                    name=name,
                    index=court_index_of(name, base),
                )
        self._cache[name] = court
        return court


def materialise_courts(venue) -> list[Court]:
    """Make the venue's playing surfaces real rows, now, one per ``count``.

    Courts used to appear only when a match first landed on one (``resolve``
    below), which meant an admin could not address "court 2" before the draw —
    and per-court competition reservations (spec 2026-08-16) have to be set
    BEFORE the draw, or they cannot influence it. Idempotent; surplus rows from
    a reduced ``count`` are soft-deleted rather than dropped, because a match
    may still reference one by name.
    """
    from django.utils import timezone as dj_tz

    from apps.fixtures.services.scheduler import court_venue_name

    n = max(1, int(venue.count or 1))
    live = {c.index: c for c in venue.courts.filter(deleted_at__isnull=True)}
    out: list[Court] = []
    for i in range(1, n + 1):
        name = venue.name if n == 1 else court_venue_name(venue.name, i)
        court = live.get(i)
        if court is None:
            court = Court.objects.create(
                organization=venue.organization, venue=venue, name=name, index=i,
            )
        elif court.name != name:
            # A rename of the venue, or a count crossing the 1 -> N boundary,
            # changes every court's display name — and the name IS the identity
            # Match.venue stores.
            court.name = name
            court.save(update_fields=["name", "updated_at"])
        out.append(court)
    surplus = [c for idx, c in live.items() if idx > n]
    for c in surplus:
        c.deleted_at = dj_tz.now()
        c.save(update_fields=["deleted_at", "updated_at"])
    return out


def resolve_court(organization, venue_name: str | None) -> Court | None:
    """One-shot :meth:`CourtResolver.resolve` — for the single-match writers.
    Bulk callers should keep a :class:`CourtResolver` for the whole run."""
    return CourtResolver(organization).resolve(venue_name)
