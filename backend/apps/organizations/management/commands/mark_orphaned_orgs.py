"""Manage command: mark active orgs with no active admin as orphaned.

Run periodically (cron / systemd timer) — there's no Celery in 1A.
Idempotent: re-runs on already-orphaned orgs are no-ops.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.organizations.services.lifecycle import detect_orphaned


class Command(BaseCommand):
    help = "Mark active organizations with no active admin as 'orphaned'."

    def handle(self, *args, **options):
        flipped = detect_orphaned()
        self.stdout.write(self.style.SUCCESS(f"Orgs marked orphaned: {flipped}"))
