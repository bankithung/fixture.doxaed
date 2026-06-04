"""``manage.py snapshot_kpi`` — daily KPI rollup (v1Users.md Appendix B.7).

Idempotent on snapshot_date: re-runs upsert today's row.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.sadmin.services.kpi import compute_kpi_snapshot


class Command(BaseCommand):
    help = "Compute (or refresh) today's KPISnapshot row."

    def handle(self, *args, **options):
        snap = compute_kpi_snapshot()
        self.stdout.write(
            self.style.SUCCESS(
                f"KPISnapshot {snap.snapshot_date} -> {snap.metrics}"
            )
        )
