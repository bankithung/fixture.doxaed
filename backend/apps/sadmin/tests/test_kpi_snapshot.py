"""KPI snapshot tests."""
from __future__ import annotations

import pytest

from apps.organizations.models import Organization, OrgStatus
from apps.sadmin.models import KPISnapshot
from apps.sadmin.services.kpi import (
    compute_kpi_snapshot,
    compute_metrics_live,
)
from apps.sadmin.tests.factories import FeedbackFactory, UserFactory


@pytest.mark.django_db
def test_compute_kpi_snapshot_creates_row():
    UserFactory.create_batch(3)
    FeedbackFactory.create_batch(2)

    snap = compute_kpi_snapshot()
    assert isinstance(snap, KPISnapshot)
    assert snap.metrics["total_users"] >= 3
    assert snap.metrics["feedback_open"] >= 2
    # All required keys present
    for key in [
        "total_users",
        "active_users_7d",
        "total_orgs",
        "orgs_pending_review",
        "orgs_active",
        "orgs_suspended",
        "feedback_open",
        "feedback_resolved_7d",
    ]:
        assert key in snap.metrics


@pytest.mark.django_db
def test_compute_kpi_snapshot_idempotent():
    snap1 = compute_kpi_snapshot()
    UserFactory()
    snap2 = compute_kpi_snapshot()
    # Same date → same row, but metrics updated.
    assert snap1.snapshot_date == snap2.snapshot_date
    assert snap1.id == snap2.id
    assert KPISnapshot.objects.filter(snapshot_date=snap1.snapshot_date).count() == 1
    assert snap2.metrics["total_users"] >= snap1.metrics["total_users"]


@pytest.mark.django_db
def test_compute_metrics_live_counts_seed_correctly():
    """DEFECT-Q regression: dashboard reported 1 user / 0 orgs vs the
    real 8/1. Asserting the aggregator now counts the seeded fixture.
    """
    UserFactory.create_batch(5)
    Organization.objects.create(slug="alpha", name="Alpha", status=OrgStatus.ACTIVE)
    Organization.objects.create(slug="beta", name="Beta", status=OrgStatus.ACTIVE)
    # A pending-review org should NOT count toward orgs_active.
    Organization.objects.create(
        slug="gamma", name="Gamma", status=OrgStatus.PENDING_REVIEW
    )

    metrics = compute_metrics_live()

    assert metrics["total_users"] == 5
    assert metrics["orgs_active"] == 2
    assert metrics["orgs_pending_review"] == 1
    assert metrics["total_orgs"] == 3


@pytest.mark.django_db
def test_compute_metrics_live_does_not_persist_snapshot():
    """``compute_metrics_live`` is a read-only helper; the dashboard
    calls it on every render. It must NOT write a KPISnapshot row.
    """
    pre = KPISnapshot.objects.count()
    compute_metrics_live()
    assert KPISnapshot.objects.count() == pre


@pytest.mark.django_db
def test_compute_kpi_snapshot_uses_live_metrics():
    """Snapshot persistence must mirror the live numbers (single source
    of truth). After the DEFECT-Q fix, the cron and the dashboard share
    the same aggregator.
    """
    UserFactory.create_batch(2)
    Organization.objects.create(slug="snap1", name="Snap1", status=OrgStatus.ACTIVE)

    live = compute_metrics_live()
    snap = compute_kpi_snapshot()

    assert snap.metrics["total_users"] == live["total_users"]
    assert snap.metrics["orgs_active"] == live["orgs_active"]
    assert snap.metrics["total_orgs"] == live["total_orgs"]
