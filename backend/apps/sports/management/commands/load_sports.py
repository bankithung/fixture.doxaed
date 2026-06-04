"""Load (or upsert) the sports catalog from sports.json.

Idempotent: re-running updates name/category/description/etc on existing
rows by ``code``; never deletes. Mirrors ``load_modules``.

Usage:
    python manage.py load_sports
"""
from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.sports.models import Sport, SportCategory, SportStatus

FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent.parent / "fixtures" / "sports.json"
)


class Command(BaseCommand):
    help = "Load (upsert) the sports catalog from sports.json (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--path",
            default=str(FIXTURE_PATH),
            help="Override path to sports.json fixture file.",
        )

    def handle(self, *args, **options):
        path = Path(options["path"])
        if not path.exists():
            self.stderr.write(self.style.ERROR(f"Fixture not found: {path}"))
            return

        data = json.loads(path.read_text(encoding="utf-8"))

        if not isinstance(data, list):
            self.stderr.write(self.style.ERROR("sports.json must be a JSON array."))
            return

        valid_categories = {c.value for c in SportCategory}
        valid_statuses = {s.value for s in SportStatus}

        created_count = 0
        updated_count = 0

        with transaction.atomic():
            for entry in data:
                code = entry["code"]
                category = entry.get("category", SportCategory.OTHER.value)
                if category not in valid_categories:
                    self.stderr.write(
                        self.style.WARNING(
                            f"Sport {code}: unknown category {category!r}; "
                            f"falling back to 'other'."
                        )
                    )
                    category = SportCategory.OTHER.value

                status = entry.get("status", SportStatus.PLANNED.value)
                if status not in valid_statuses:
                    self.stderr.write(
                        self.style.WARNING(
                            f"Sport {code}: unknown status {status!r}; "
                            f"falling back to 'planned'."
                        )
                    )
                    status = SportStatus.PLANNED.value

                defaults = {
                    "name": entry.get("name", code),
                    "category": category,
                    "status": status,
                    "description": entry.get("description", ""),
                    "indigenous_to": entry.get("indigenous_to", ""),
                    "is_team_sport": bool(entry.get("is_team_sport", False)),
                    "is_individual_sport": bool(
                        entry.get("is_individual_sport", False)
                    ),
                    "icon": entry.get("icon", ""),
                    "display_order": int(entry.get("display_order", 1000)),
                    "python_module_path": entry.get("python_module_path", ""),
                }
                _obj, created = Sport.objects.update_or_create(
                    code=code, defaults=defaults
                )
                if created:
                    created_count += 1
                else:
                    updated_count += 1

        total = Sport.objects.count()
        self.stdout.write(
            self.style.SUCCESS(
                f"Sports — created: {created_count}, "
                f"updated: {updated_count}, total in DB: {total}."
            )
        )
