"""Backfill Institution rows from the legacy ``Team.school`` free-text and link
every team to its institution (spec 2026-06-08 §4.2). Forward-only, re-run-safe
(get_or_create by (tournament, name)). Teams with a blank school fall back to an
institution named after the team so the FK can later be made non-null.

Org-consistency holds by construction: the institution copies the team's
organization_id, which already equals tournament.organization_id.
"""
from __future__ import annotations

import re

from django.db import migrations

_SCRUB = re.compile(r"[^a-z0-9-]+")
_HYPHEN = re.compile(r"-+")


def _slug(raw: str) -> str:
    s = _HYPHEN.sub("-", _SCRUB.sub("-", (raw or "").strip().lower())).strip("-")
    return s[:80] or "institution"


def backfill(apps, schema_editor):
    Team = apps.get_model("teams", "Team")
    Institution = apps.get_model("teams", "Institution")

    # (tournament_id, lower(name)) -> institution_id, within this run.
    cache: dict[tuple, str] = {}
    used_slugs: dict[str, set] = {}

    def unique_slug(tournament_id, name):
        base = _slug(name)
        seen = used_slugs.setdefault(str(tournament_id), set())
        # seed from existing rows to avoid clashes across re-runs
        if not seen:
            seen.update(
                Institution.objects.filter(tournament_id=tournament_id)
                .values_list("slug", flat=True)
            )
        slug, n = base, 2
        while slug in seen:
            slug = f"{base}-{n}"[:80]
            n += 1
        seen.add(slug)
        return slug

    for team in Team.objects.filter(
        deleted_at__isnull=True, institution__isnull=True
    ).iterator():
        name = (team.school or "").strip() or team.name
        name = name[:200]
        key = (team.tournament_id, name.lower())
        inst_id = cache.get(key)
        if inst_id is None:
            inst, _created = Institution.objects.get_or_create(
                tournament_id=team.tournament_id,
                name=name,
                deleted_at__isnull=True,
                defaults={
                    "organization_id": team.organization_id,
                    "slug": unique_slug(team.tournament_id, name),
                    "kind": "school",
                    "region": (team.region or "")[:120],
                    "status": "registered",
                },
            )
            inst_id = inst.id
            cache[key] = inst_id
        team.institution_id = inst_id
        team.school = name  # normalise the mirror to the institution name
        team.save(update_fields=["institution", "school"])


def reverse(apps, schema_editor):
    # Forward-only inference; just unlink (institutions become harmless orphans).
    Team = apps.get_model("teams", "Team")
    Team.objects.update(institution=None)


class Migration(migrations.Migration):

    dependencies = [
        ("teams", "0004_institution_team_institution_and_more"),
    ]

    operations = [
        migrations.RunPython(backfill, reverse),
    ]
