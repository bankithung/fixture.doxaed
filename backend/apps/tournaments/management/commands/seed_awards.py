"""Turn a tournament's medal tally on, with a sensible starting setup.

    manage.py seed_awards <tournament-id> [<tournament-id> ...]
        [--gold 5 --silver 3 --bronze 2] [--label "U-14 Boys=..."] [--dry-run]

The ladder and the category groups are the host's to author in Settings, so
this writes nothing they cannot change afterwards: it seeds the ladder the
owner asked for (5/3/2) and one champion group per age band and gender read off
the tournament's OWN category tree, plus an Overall.

Idempotent — re-running replaces the seeded config with the same values, so a
tournament that has since been hand-edited should not be re-seeded.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.tournaments.models import Tournament
from apps.tournaments.services.awards import (
    effective_awards,
    merge_awards,
    suggest_groups,
)


class Command(BaseCommand):
    help = "Enable the medal tally on a tournament with a starting setup."

    def add_arguments(self, parser):
        parser.add_argument("tournament_ids", nargs="+")
        parser.add_argument("--gold", type=int, default=5)
        parser.add_argument("--silver", type=int, default=3)
        parser.add_argument("--bronze", type=int, default=2)
        parser.add_argument(
            "--label", action="append", default=[],
            help='Rename a seeded group: --label "Open Category Boys=Open Boys"',
        )
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        renames = {}
        for pair in opts["label"]:
            if "=" not in pair:
                raise CommandError(f"--label needs old=new, got {pair!r}")
            old, new = pair.split("=", 1)
            renames[old.strip()] = new.strip()

        for tid in opts["tournament_ids"]:
            t = Tournament.objects.filter(id=tid, deleted_at__isnull=True).first()
            if t is None:
                raise CommandError(f"no tournament {tid}")

            groups = [
                {**g, "label": renames.get(g["label"], g["label"])}
                for g in suggest_groups(t.sports)
            ]
            awards = merge_awards(
                {
                    "enabled": True,
                    "ladder": [
                        {"place": 1, "points": opts["gold"], "label": "Gold"},
                        {"place": 2, "points": opts["silver"], "label": "Silver"},
                        {"place": 3, "points": opts["bronze"], "label": "Bronze"},
                    ],
                    "groups": groups,
                },
                base=effective_awards(t),
            )
            self.stdout.write(f"{t.name[:60]} ({t.slug})")
            for g in awards["groups"]:
                self.stdout.write(
                    f"   {g['label']:<24} {', '.join(g['include']) or 'every competition'}"
                )
            if opts["dry_run"]:
                self.stdout.write(self.style.WARNING("   dry run, nothing written"))
                continue
            t.awards = awards
            t.save(update_fields=["awards"])
            self.stdout.write(self.style.SUCCESS("   saved"))
