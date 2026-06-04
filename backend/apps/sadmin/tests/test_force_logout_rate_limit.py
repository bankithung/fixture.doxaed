"""B.21 alarm: log a warning when force_logout_all runs >20/hour per SA.

Phase 1A: log warning, do NOT block. Verify the WARNING fires.
"""
from __future__ import annotations

import logging

import pytest
from django.core.cache import cache

from apps.sadmin.services import superadmin_verbs


@pytest.mark.django_db
def test_force_logout_rate_alarm_logs_warning(super_admin, regular_user, rf, caplog):
    cache.delete(f"sadmin:force_logout_all:{super_admin.id}")
    caplog.set_level(logging.WARNING, logger="apps.sadmin.services.superadmin_verbs")

    # 21st call should trigger the warning.
    for _ in range(21):
        superadmin_verbs.force_logout_all(
            user=regular_user,
            requested_by=super_admin,
            reason="ops",
            request=rf.post("/"),
        )

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert any(
        "B.21 ALARM" in r.message and "force_logout_all" in r.message
        for r in warnings
    )


@pytest.mark.django_db
def test_suspend_user_rate_alarm_logs_warning(super_admin, rf, caplog):
    from apps.sadmin.tests.factories import UserFactory

    cache.delete(f"sadmin:suspend_user:{super_admin.id}")
    caplog.set_level(logging.WARNING, logger="apps.sadmin.services.superadmin_verbs")

    # 51st call → warning.
    users = [UserFactory() for _ in range(51)]
    for u in users:
        superadmin_verbs.suspend_user(
            user=u, suspended_by=super_admin, reason="r", request=rf.post("/")
        )

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert any(
        "B.21 ALARM" in r.message and "suspend_user" in r.message
        for r in warnings
    )
