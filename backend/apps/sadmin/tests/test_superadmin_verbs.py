"""Tests for the 13 Super-admin verbs (v1Users.md §1.6).

Every verb must:
* Mutate state correctly.
* Emit one AuditEvent with actor_role='super_admin'.
* Carry the correct target_id / target_type.
"""
from __future__ import annotations

import pytest
from django.contrib.sessions.models import Session

from apps.audit.models import AuditEvent
from apps.sadmin.services import superadmin_verbs
from apps.sadmin.tests.factories import UserFactory


def _last_audit(event_type: str) -> AuditEvent:
    return AuditEvent.objects.filter(event_type=event_type).latest("created_at")


@pytest.mark.django_db
def test_suspend_user_writes_audit_and_deletes_sessions(super_admin, regular_user, rf):
    request = rf.post("/sadmin/users/suspend/")
    # Add a session that decodes to this user.
    from django.contrib.sessions.backends.db import SessionStore

    store = SessionStore()
    store["_auth_user_id"] = str(regular_user.id)
    store.create()

    superadmin_verbs.suspend_user(
        user=regular_user, suspended_by=super_admin, reason="abuse", request=request
    )
    regular_user.refresh_from_db()
    assert regular_user.is_active is False

    # The user's session has been deleted.
    assert not any(
        s.get_decoded().get("_auth_user_id") == str(regular_user.id)
        for s in Session.objects.all()
    )

    audit = _last_audit("user_suspended")
    assert audit.actor_role == "super_admin"
    assert audit.target_id == regular_user.id
    assert audit.target_type == "user"


@pytest.mark.django_db
def test_unsuspend_user_audits(super_admin, regular_user, rf):
    regular_user.is_active = False
    regular_user.save(update_fields=["is_active"])
    superadmin_verbs.unsuspend_user(
        user=regular_user, unsuspended_by=super_admin, request=rf.post("/")
    )
    regular_user.refresh_from_db()
    assert regular_user.is_active is True
    assert _last_audit("user_unsuspended").actor_role == "super_admin"


@pytest.mark.django_db
def test_force_logout_all_deletes_sessions_and_audits(super_admin, regular_user, rf):
    from django.contrib.sessions.backends.db import SessionStore

    for _ in range(3):
        store = SessionStore()
        store["_auth_user_id"] = str(regular_user.id)
        store.create()

    deleted = superadmin_verbs.force_logout_all(
        user=regular_user, requested_by=super_admin, reason="ops", request=rf.post("/")
    )
    assert deleted == 3
    audit = _last_audit("user_force_logged_out")
    assert audit.actor_role == "super_admin"
    assert audit.target_id == regular_user.id


@pytest.mark.django_db
def test_force_password_reset_audits(super_admin, regular_user, rf):
    superadmin_verbs.force_password_reset(
        user=regular_user, requested_by=super_admin, reason="user request", request=rf.post("/")
    )
    audit = _last_audit("force_password_reset_issued")
    assert audit.actor_role == "super_admin"
    assert audit.target_id == regular_user.id


@pytest.mark.django_db
def test_unlock_account_audits(super_admin, regular_user, rf):
    superadmin_verbs.unlock_account(
        user=regular_user, requested_by=super_admin, request=rf.post("/")
    )
    audit = _last_audit("user_unlocked")
    assert audit.actor_role == "super_admin"


@pytest.mark.django_db
def test_bulk_email_drafts_audit(super_admin, rf):
    UserFactory.create_batch(2)
    result = superadmin_verbs.bulk_email(
        target_filter={},
        subject="Hello",
        body="Body",
        requested_by=super_admin,
        request=rf.post("/"),
    )
    assert result["recipients"] >= 1
    audit = _last_audit("bulk_email_drafted")
    assert audit.actor_role == "super_admin"
    assert audit.payload_after["recipient_count"] == result["recipients"]


@pytest.mark.django_db
def test_system_health_returns_dict():
    info = superadmin_verbs.system_health()
    assert info["db"] is True
    assert "tables" in info


# ---------------------------------------------------------------------------
# Org verbs (delegating to apps.organizations.services.lifecycle)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sadmin_approve_calls_lifecycle_service(super_admin, rf):
    from apps.organizations.models import OrgStatus
    from apps.organizations.tests.factories import OrganizationFactory

    org = OrganizationFactory(status=OrgStatus.PENDING_REVIEW)

    superadmin_verbs.approve_org(
        org=org, approved_by=super_admin, request=rf.post("/")
    )

    org.refresh_from_db()
    assert org.status == OrgStatus.ACTIVE

    # Exactly one audit row produced (B.4: lifecycle owns emission;
    # the sadmin verb is a thin delegate and must not double-emit).
    audits = AuditEvent.objects.filter(
        event_type="org_approved", organization_id=org.id
    )
    assert audits.count() == 1
    assert audits.first().actor_role == "super_admin"


@pytest.mark.django_db
def test_sadmin_reject_calls_lifecycle_service(super_admin, rf):
    from apps.organizations.models import OrgStatus
    from apps.organizations.tests.factories import OrganizationFactory

    org = OrganizationFactory(status=OrgStatus.PENDING_REVIEW)

    superadmin_verbs.reject_org(
        org=org,
        rejected_by=super_admin,
        reason="duplicate registration",
        request=rf.post("/"),
    )

    org.refresh_from_db()
    assert org.status == OrgStatus.ARCHIVED

    audits = AuditEvent.objects.filter(
        event_type="org_rejected", organization_id=org.id
    )
    assert audits.count() == 1
    audit = audits.first()
    assert audit.actor_role == "super_admin"
    assert audit.reason == "duplicate registration"
