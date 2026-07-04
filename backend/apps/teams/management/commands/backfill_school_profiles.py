"""Backfill the S5 identity spine (P4): link every tournament-scoped
Institution to a canonical SchoolProfile, resolved by normalized name +
region. Idempotent — safe to re-run; near-duplicates merge later through
the admin merge console (merged_into)."""
from __future__ import annotations

import re

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.teams.models import Institution, SchoolProfile


def _norm(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().casefold())


class Command(BaseCommand):
    help = "Link Institutions to canonical SchoolProfiles (idempotent)."

    def handle(self, *args, **options):
        linked = created = 0
        with transaction.atomic():
            for inst in Institution.objects.filter(
                school_profile__isnull=True, deleted_at__isnull=True
            ).order_by("created_at"):
                key = _norm(inst.name)
                if not key:
                    continue
                profile = (
                    SchoolProfile.objects.filter(
                        normalized_name=key, region=inst.region or "",
                        merged_into__isnull=True,
                    ).first()
                    # Same name, blank-region row also matches (regions are
                    # inconsistently filled in registrations).
                    or SchoolProfile.objects.filter(
                        normalized_name=key, merged_into__isnull=True,
                    ).first()
                )
                if profile is None:
                    profile = SchoolProfile.objects.create(
                        name=inst.name,
                        normalized_name=key,
                        region=inst.region or "",
                        kind=inst.kind,
                    )
                    created += 1
                inst.school_profile = profile
                inst.save(update_fields=["school_profile"])
                linked += 1
        self.stdout.write(
            f"linked {linked} institutions ({created} new profiles)"
        )
