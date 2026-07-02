"""Backfill starts_at/ends_at/season from each tournament's scheduled matches
(the dates existed only inside draw_config calendars and match rows before).
Reversible as a no-op: the fields simply stay populated."""
from django.db import migrations


def backfill(apps, schema_editor):
    Tournament = apps.get_model("tournaments", "Tournament")
    Match = apps.get_model("matches", "Match")
    for t in Tournament.objects.all():
        qs = Match.objects.filter(
            tournament_id=t.id, deleted_at__isnull=True,
            scheduled_at__isnull=False,
        ).order_by("scheduled_at")
        first = qs.first()
        last = qs.last()
        if first is None:
            continue
        t.starts_at = first.scheduled_at.date()
        t.ends_at = last.scheduled_at.date()
        t.season = str(first.scheduled_at.year)
        t.save(update_fields=["starts_at", "ends_at", "season"])


class Migration(migrations.Migration):
    dependencies = [
        ("tournaments", "0008_tournament_ends_at_tournament_season_and_more"),
        ("matches", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
