"""Dashboard views — KPI overview + recent feedback / usage."""
from __future__ import annotations

from django.http import HttpRequest, HttpResponse
from django.views.decorators.http import require_GET

from apps.sadmin.decorators import superadmin_required
from apps.sadmin.models import Feedback, UsageEvent
from apps.sadmin.services.kpi import compute_metrics_live, latest_snapshot
from apps.sadmin.views._helpers import render_sadmin


def _dashboard_metrics() -> dict:
    """Return live KPI metrics for the dashboard render.

    DEFECT-Q fix: previously read the latest persisted ``KPISnapshot``
    row, which was always stale (the nightly cron isn't wired in dev,
    and on a fresh seed the row reflected an early state with only
    the SA / no active orgs). The dashboard now computes live each
    request — counts are O(rows) on a low-traffic surface and the
    answer is always current.
    """
    return compute_metrics_live()


@superadmin_required
@require_GET
def dashboard(request: HttpRequest) -> HttpResponse:
    return render_sadmin(
        request,
        "sadmin/dashboard.html",
        {
            "snapshot": latest_snapshot(),
            "metrics": _dashboard_metrics(),
            "recent_feedback": Feedback.objects.order_by("-created_at")[:5],
            "recent_usage": UsageEvent.objects.order_by("-created_at")[:5],
        },
    )


@superadmin_required
@require_GET
def dashboard_kpis(request: HttpRequest) -> HttpResponse:
    """HTMX-refresh partial — auto-refreshed by the dashboard every 30s."""
    return render_sadmin(
        request,
        "sadmin/_kpi_cards.html",
        {
            "metrics": _dashboard_metrics(),
            "snapshot": latest_snapshot(),
        },
    )
