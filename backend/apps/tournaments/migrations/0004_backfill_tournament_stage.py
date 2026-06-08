"""Backfill ``Tournament.stage`` for existing rows so the setup stepper opens on
the right step (spec 2026-06-08 §2.4). Forward-only, idempotent, read-only on
other apps' data — it only infers the stage from current state:

    has matches            -> "fixtures"  ("ready" if status >= scheduled)
    else REGISTERED teams   -> "team_registration"
    else any forms          -> "org_registration"
    else                    -> "setup"

Reads ``Team(status="registered")`` without changing it (that status is exactly
what the fixture generator selects — a load-bearing invariant).
"""
from __future__ import annotations

from django.db import migrations

# Lifecycle ranks for the "ready vs fixtures" decision (PRD §5.2 order).
_SCHEDULED_OR_LATER = {"scheduled", "live", "completed", "archived"}


def backfill_stage(apps, schema_editor):
    Tournament = apps.get_model("tournaments", "Tournament")
    Match = apps.get_model("matches", "Match")
    Team = apps.get_model("teams", "Team")
    Form = apps.get_model("forms", "Form")

    for t in Tournament.objects.all().iterator():
        if Match.objects.filter(tournament_id=t.id).exists():
            stage = "ready" if t.status in _SCHEDULED_OR_LATER else "fixtures"
        elif Team.objects.filter(
            tournament_id=t.id, status="registered", deleted_at__isnull=True
        ).exists():
            stage = "team_registration"
        elif Form.objects.filter(
            tournament_id=t.id, deleted_at__isnull=True
        ).exists():
            stage = "org_registration"
        else:
            stage = "setup"
        if t.stage != stage:
            t.stage = stage
            t.save(update_fields=["stage"])


def noop_reverse(apps, schema_editor):
    # Forward-only inference; nothing to undo (the column default is "setup").
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("tournaments", "0003_tournament_stage_tournament_stage_meta_and_more"),
        ("matches", "0004_lineup_lineupentry_matchincident_and_more"),
        ("teams", "0003_registrationlink_expires_at_and_more"),
        ("forms", "0002_form_stage"),
    ]

    operations = [
        migrations.RunPython(backfill_stage, noop_reverse),
    ]
