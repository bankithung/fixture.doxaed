"""Load (or upsert) the 22-module catalog from modules.json.

Idempotent: re-running updates name/description/category/default_for_roles
on existing rows; never deletes.

Source of truth: `apps/permissions/fixtures/modules.json` (translated
from v1Users.md Appendix A.2 + B.16 = 22 modules total).

Usage:
    python manage.py load_modules
"""
from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.permissions.models import Module

FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent.parent / "fixtures" / "modules.json"
)


class Command(BaseCommand):
    help = "Load (upsert) the module catalog from modules.json (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--path",
            default=str(FIXTURE_PATH),
            help="Override path to modules.json fixture file.",
        )

    def handle(self, *args, **options):
        path = Path(options["path"])
        if not path.exists():
            self.stderr.write(self.style.ERROR(f"Fixture not found: {path}"))
            return

        data = json.loads(path.read_text(encoding="utf-8"))

        if not isinstance(data, list):
            self.stderr.write(self.style.ERROR("modules.json must be a JSON array."))
            return

        created_count = 0
        updated_count = 0

        with transaction.atomic():
            for entry in data:
                code = entry["code"]
                defaults = {
                    "name": entry.get("name", code),
                    "description": entry.get("description", ""),
                    "category": entry.get("category", ""),
                    "default_for_roles": entry.get("default_for_roles", []),
                }
                _obj, created = Module.objects.update_or_create(
                    code=code, defaults=defaults
                )
                if created:
                    created_count += 1
                else:
                    updated_count += 1

        total = Module.objects.count()
        self.stdout.write(
            self.style.SUCCESS(
                f"Modules — created: {created_count}, "
                f"updated: {updated_count}, total in DB: {total}."
            )
        )
