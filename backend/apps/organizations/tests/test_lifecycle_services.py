"""Tests for the organization lifecycle services (approve / reject).

The lifecycle service is the canonical (B.4) home of the org status
transitions; sadmin's verb is a thin delegate.
"""
from __future__ import annotations

import pytest
from django.core.exceptions import ValidationError

from apps.accounts.tests.factories import UserFactory
from apps.audit.models import AuditEvent
from apps.organizations.models import OrgStatus
from apps.organizations.services import lifecycle as lifecycle_svc
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# approve_org
# ---------------------------------------------------------------------------


def test_approve_pending_org_flips_to_active():
    actor = UserFactory()
    org = OrganizationFactory(status=OrgStatus.PENDING_REVIEW)

    result = lifecycle_svc.approve_org(org=org, approved_by=actor)

    assert result is org
    org.refresh_from_db()
    assert org.status == OrgStatus.ACTIVE


def test_approve_writes_audit_event():
    actor = UserFactory()
    org = OrganizationFactory(status=OrgStatus.PENDING_REVIEW)

    lifecycle_svc.approve_org(org=org, approved_by=actor)

    audit = AuditEvent.objects.filter(
        event_type="org_approved", organization_id=org.id
    ).get()
    assert audit.actor_role == "super_admin"
    assert audit.target_id == org.id
    assert audit.target_type == "organization"
    assert audit.payload_before == {"status": OrgStatus.PENDING_REVIEW}
    assert audit.payload_after == {"status": OrgStatus.ACTIVE}


def test_approve_rejects_already_active_org():
    actor = UserFactory()
    org = OrganizationFactory(status=OrgStatus.ACTIVE)

    with pytest.raises(ValidationError):
        lifecycle_svc.approve_org(org=org, approved_by=actor)

    org.refresh_from_db()
    assert org.status == OrgStatus.ACTIVE
    assert not AuditEvent.objects.filter(
        event_type="org_approved", organization_id=org.id
    ).exists()


# ---------------------------------------------------------------------------
# reject_org
# ---------------------------------------------------------------------------


def test_reject_pending_org_flips_to_archived():
    actor = UserFactory()
    org = OrganizationFactory(status=OrgStatus.PENDING_REVIEW)

    lifecycle_svc.reject_org(
        org=org, rejected_by=actor, reason="duplicate org submission"
    )

    org.refresh_from_db()
    assert org.status == OrgStatus.ARCHIVED
    assert org.archived_at is not None


def test_reject_requires_reason():
    actor = UserFactory()
    org = OrganizationFactory(status=OrgStatus.PENDING_REVIEW)

    with pytest.raises(ValidationError):
        lifecycle_svc.reject_org(org=org, rejected_by=actor, reason="")

    with pytest.raises(ValidationError):
        lifecycle_svc.reject_org(org=org, rejected_by=actor, reason="short")

    org.refresh_from_db()
    assert org.status == OrgStatus.PENDING_REVIEW


def test_reject_writes_audit_with_reason():
    actor = UserFactory()
    org = OrganizationFactory(status=OrgStatus.PENDING_REVIEW)

    reason = "fraudulent registration"
    lifecycle_svc.reject_org(org=org, rejected_by=actor, reason=reason)

    audit = AuditEvent.objects.filter(
        event_type="org_rejected", organization_id=org.id
    ).get()
    assert audit.actor_role == "super_admin"
    assert audit.target_id == org.id
    assert audit.reason == reason
    assert audit.payload_before == {"status": OrgStatus.PENDING_REVIEW}
    assert audit.payload_after["status"] == OrgStatus.ARCHIVED
    assert audit.payload_after["reason"] == reason


def test_reject_already_archived_raises():
    actor = UserFactory()
    org = OrganizationFactory(status=OrgStatus.ARCHIVED)

    with pytest.raises(ValidationError):
        lifecycle_svc.reject_org(
            org=org, rejected_by=actor, reason="some valid reason"
        )
