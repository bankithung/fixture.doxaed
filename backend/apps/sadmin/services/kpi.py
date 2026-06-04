"""KPI snapshot rollup (v1Users.md §1.7, Appendix B.7).

``compute_kpi_snapshot()`` is idempotent on ``snapshot_date`` (upsert).
The dashboard reads the latest row directly; nightly ``manage.py
snapshot_kpi`` keeps it fresh.

Counts are computed on a best-effort basis: each model lookup is
guarded so missing apps (e.g. organizations agent not yet shipped)
don't break the snapshot. Phase 1A KPI surface is intentionally
small; we'll grow it in Phase 1B as Tournaments/Matches land.
"""
from __future__ import annotations

import datetime as _dt
import logging
from typing import Any

from django.utils import timezone

from apps.sadmin.models import Feedback, FeedbackStatus, KPISnapshot

logger = logging.getLogger(__name__)


def _safe_count(qs) -> int:
    try:
        return int(qs.count())
    except Exception:
        logger.exception("KPI count failed")
        return 0


def compute_kpi_snapshot(date: _dt.date | None = None) -> KPISnapshot:
    """Compute (and upsert) today's KPI snapshot. Idempotent for date.

    Delegates the actual counting to ``compute_metrics_live`` so the
    nightly cron and the on-render dashboard share one source of truth.
    """
    snap_date = date or timezone.now().date()
    metrics = compute_metrics_live()
    # ``snapshot_date`` is the row's PK-equivalent column; don't store it
    # twice inside the JSON metrics blob.
    metrics.pop("snapshot_date", None)

    snapshot, _created = KPISnapshot.objects.update_or_create(
        snapshot_date=snap_date,
        defaults={"metrics": metrics},
    )
    return snapshot


def latest_snapshot() -> KPISnapshot | None:
    return KPISnapshot.objects.order_by("-snapshot_date").first()


def compute_metrics_live() -> dict[str, Any]:
    """Compute the KPI dict without persisting a KPISnapshot row.

    The dashboard view uses this to render the cards on every request
    so the SA always sees current numbers — the persisted ``KPISnapshot``
    is for time-series / history, not for the live "right now" view.

    DEFECT-Q (audit): pre-fix, the dashboard read whatever stale row
    ``latest_snapshot()`` happened to find (e.g. an early seed when
    only the SA existed and no Org was active), reporting ``Total
    users: 1`` / ``Active orgs: 0`` to the platform owner indefinitely.
    Recomputing live is the cheapest fix; counts are O(rows) and the
    sadmin dashboard is a low-traffic surface.
    """
    snap_date = timezone.now().date()
    metrics: dict[str, Any] = {}

    # --- Users -----------------------------------------------------------
    try:
        from apps.accounts.models import User

        seven_days_ago = timezone.now() - _dt.timedelta(days=7)
        metrics["total_users"] = _safe_count(User.objects.filter(deleted_at__isnull=True))
        metrics["active_users_7d"] = _safe_count(
            User.objects.filter(deleted_at__isnull=True, last_login__gte=seven_days_ago)
        )
        metrics["suspended_users"] = _safe_count(
            User.objects.filter(is_active=False, deleted_at__isnull=True)
        )
    except Exception:
        logger.exception("KPI live: User counts failed")
        metrics.setdefault("total_users", 0)
        metrics.setdefault("active_users_7d", 0)
        metrics.setdefault("suspended_users", 0)

    # --- Orgs ------------------------------------------------------------
    try:
        from apps.organizations.models import Organization, OrgStatus

        metrics["total_orgs"] = _safe_count(
            Organization.objects.filter(deleted_at__isnull=True)
        )
        metrics["orgs_pending_review"] = _safe_count(
            Organization.objects.filter(
                status=OrgStatus.PENDING_REVIEW, deleted_at__isnull=True
            )
        )
        metrics["orgs_active"] = _safe_count(
            Organization.objects.filter(
                status=OrgStatus.ACTIVE, deleted_at__isnull=True
            )
        )
        metrics["orgs_suspended"] = _safe_count(
            Organization.objects.filter(
                status=OrgStatus.SUSPENDED, deleted_at__isnull=True
            )
        )
    except Exception:
        logger.exception("KPI live: Organization counts failed")
        metrics.setdefault("total_orgs", 0)
        metrics.setdefault("orgs_pending_review", 0)
        metrics.setdefault("orgs_active", 0)
        metrics.setdefault("orgs_suspended", 0)

    # --- Feedback --------------------------------------------------------
    try:
        seven_days_ago = timezone.now() - _dt.timedelta(days=7)
        metrics["feedback_open"] = _safe_count(
            Feedback.objects.filter(
                status__in=[FeedbackStatus.PENDING, FeedbackStatus.TRIAGED]
            )
        )
        metrics["feedback_resolved_7d"] = _safe_count(
            Feedback.objects.filter(
                status=FeedbackStatus.RESOLVED, resolved_at__gte=seven_days_ago
            )
        )
    except Exception:
        logger.exception("KPI live: Feedback counts failed")
        metrics.setdefault("feedback_open", 0)
        metrics.setdefault("feedback_resolved_7d", 0)

    # --- Tournaments (deferred — Phase 1B) -------------------------------
    metrics.setdefault("tournaments_in_progress", 0)
    metrics.setdefault("snapshot_date", snap_date.isoformat())
    return metrics
