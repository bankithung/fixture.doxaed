"""Feedback triage tests."""
from __future__ import annotations

import pytest

from apps.audit.models import AuditEvent
from apps.sadmin.models import Feedback, FeedbackStatus
from apps.sadmin.services.feedback import (
    archive_feedback,
    submit_feedback,
    triage_feedback,
)
from apps.sadmin.tests.factories import FeedbackFactory


@pytest.mark.django_db
def test_submit_feedback_creates_row_and_audit(regular_user):
    fb = submit_feedback(
        user=regular_user,
        category="bug",
        subject="Login broken",
        body="Tried logging in with email user@example.com but failed",
    )
    assert isinstance(fb, Feedback)
    # B.11 redaction stripped the email
    assert "user@example.com" not in fb.body
    assert "[REDACTED]" in fb.body
    assert AuditEvent.objects.filter(event_type="feedback_submitted").count() == 1


@pytest.mark.django_db
def test_triage_flips_status_and_audits(super_admin):
    fb = FeedbackFactory()
    triaged = triage_feedback(
        feedback=fb,
        triaged_by=super_admin,
        status=FeedbackStatus.TRIAGED,
        internal_notes="Will look at later",
    )
    assert triaged.status == FeedbackStatus.TRIAGED
    assert triaged.triaged_at is not None
    assert triaged.triaged_by_id == super_admin.id
    audit = AuditEvent.objects.get(event_type="feedback_triaged")
    assert audit.actor_role == "super_admin"
    assert audit.target_id == fb.id


@pytest.mark.django_db
def test_triage_resolved_sets_resolved_at(super_admin):
    fb = FeedbackFactory()
    triage_feedback(
        feedback=fb,
        triaged_by=super_admin,
        status=FeedbackStatus.RESOLVED,
        internal_notes="",
    )
    fb.refresh_from_db()
    assert fb.resolved_at is not None


@pytest.mark.django_db
def test_archive_feedback(super_admin):
    fb = FeedbackFactory()
    archive_feedback(feedback=fb, archived_by=super_admin)
    fb.refresh_from_db()
    assert fb.status == FeedbackStatus.RESOLVED
    audit = AuditEvent.objects.get(event_type="feedback_archived")
    assert audit.reason == "archived"


@pytest.mark.django_db
def test_invalid_status_raises():
    fb = FeedbackFactory()
    with pytest.raises(ValueError):
        triage_feedback(
            feedback=fb, triaged_by=fb.submitted_by, status="invalid", internal_notes=""
        )
