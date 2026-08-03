"""Backfill ``Match.court`` from the denormalised ``Match.venue`` string.

Court used to have no row: ``Match.venue`` held the synthesised display name
(``"MP Hall · T2"``) that ``scheduler.court_venue_name`` builds out of
``Venue.count``. Promoting court to a first-class entity means every already
scheduled match needs its FK filled in, WITHOUT touching the string (~40
readers still key off it).

For each non-deleted match with a non-empty ``venue`` and no ``court``:

* resolve the physical base venue with the scheduler's own
  ``court_base_of`` (never re-parse the ``" · T<n>"`` suffix here),
* derive the 1-based court index from that suffix (no suffix → 1),
* get-or-create the ``Court`` under that venue and point the match at it.

Matches whose base venue has NO ``Venue`` row in their organization are
SKIPPED and reported — venue rows are never invented (a scheduling config may
legitimately name a venue the workspace never registered).

Idempotent: a second run finds every match already linked and changes
nothing. ``--dry-run`` reports the same numbers and writes nothing;
``--tournament <uuid>`` scopes the sweep.
"""
from __future__ import annotations

import contextlib
import uuid as _uuid
from collections import Counter
from contextlib import AbstractContextManager
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import transaction

from apps.fixtures.models import Court, Venue
from apps.fixtures.services.courts import court_index_of
from apps.fixtures.services.scheduler import court_base_of

#: How many distinct unresolved venue names to name in the report before the
#: tail collapses into a count (a broken config can produce hundreds).
_MAX_REPORTED_SKIPS = 20


class Command(BaseCommand):
    help = (
        "Link every scheduled Match to a Court row derived from its venue "
        "string (idempotent; supports --tournament and --dry-run)."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--tournament",
            dest="tournament",
            default=None,
            help="Only backfill matches of this tournament UUID.",
        )
        parser.add_argument(
            "--dry-run",
            dest="dry_run",
            action="store_true",
            help="Report what would change without writing anything.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        from apps.matches.models import Match

        dry_run: bool = bool(options.get("dry_run"))
        raw_tournament = options.get("tournament")
        tournament_id = None
        if raw_tournament:
            try:
                tournament_id = _uuid.UUID(str(raw_tournament))
            except ValueError as exc:
                raise CommandError("invalid --tournament uuid") from exc

        qs = (
            Match.objects.filter(deleted_at__isnull=True, court__isnull=True)
            .exclude(venue="")
            .select_related("organization")
            .order_by("organization_id", "venue", "match_no")
        )
        if tournament_id is not None:
            qs = qs.filter(tournament_id=tournament_id)

        # Per-organization lookups, loaded once each (the sweep is ordered by
        # organization so this stays a handful of queries even at scale).
        venues_by_org: dict[Any, dict[str, Venue]] = {}
        courts_by_org: dict[Any, dict[tuple[Any, str], Court]] = {}

        created = 0
        linked = 0
        skipped = 0
        skip_reasons: Counter[str] = Counter()
        planned: set[tuple[Any, str]] = set()

        def venues_of(org_id: Any) -> dict[str, Venue]:
            if org_id not in venues_by_org:
                venues_by_org[org_id] = {
                    v.name: v
                    for v in Venue.objects.filter(
                        organization_id=org_id, deleted_at__isnull=True
                    )
                }
            return venues_by_org[org_id]

        def courts_of(org_id: Any) -> dict[tuple[Any, str], Court]:
            if org_id not in courts_by_org:
                courts_by_org[org_id] = {
                    (c.venue.id, c.name): c
                    for c in Court.objects.filter(
                        organization_id=org_id, deleted_at__isnull=True
                    ).select_related("venue")
                }
            return courts_by_org[org_id]

        # No transaction on the dry run, so a stray write would be VISIBLE
        # here rather than silently rolled back.
        ctx: AbstractContextManager[Any] = (
            contextlib.nullcontext() if dry_run else transaction.atomic()
        )
        with ctx:
            for match in qs.iterator(chunk_size=500):
                org = match.organization
                org_id = org.id
                venues = venues_of(org_id)
                base = court_base_of(match.venue, list(venues))
                venue = venues.get(base)
                if venue is None:
                    skipped += 1
                    skip_reasons[match.venue] += 1
                    continue

                key = (venue.id, match.venue)
                courts = courts_of(org_id)
                court = courts.get(key)
                if court is None:
                    if dry_run:
                        if key not in planned:
                            planned.add(key)
                            created += 1
                    else:
                        court = Court.objects.create(
                            organization=org,
                            venue=venue,
                            name=match.venue,
                            index=court_index_of(match.venue, base),
                        )
                        courts[key] = court
                        created += 1
                if not dry_run and court is not None:
                    match.court = court
                    match.save(update_fields=["court", "updated_at"])
                linked += 1

        prefix = "[dry-run] " if dry_run else ""
        self.stdout.write(
            f"{prefix}courts created: {created}; matches linked: {linked}; "
            f"matches skipped: {skipped}"
        )
        if skip_reasons:
            self.stdout.write(f"{prefix}skipped (no Venue row for the base venue):")
            for name, count in skip_reasons.most_common(_MAX_REPORTED_SKIPS):
                self.stdout.write(f"{prefix}  {name!r}: {count} match(es)")
            rest = len(skip_reasons) - _MAX_REPORTED_SKIPS
            if rest > 0:
                self.stdout.write(f"{prefix}  ... and {rest} more venue name(s)")
