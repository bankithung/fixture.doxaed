"""Every state-change verb emits exactly one AuditEvent with the right
event_type and organization_id.
"""
from __future__ import annotations

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.audit.models import AuditEvent

from apps.organizations.models import (
    InviteStatus,
    MembershipRole,
)
from apps.organizations.services import (
    invitation as invitation_svc,
    lifecycle as lifecycle_svc,
    ownership as ownership_svc,
    slug as slug_svc,
)
from apps.organizations.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
)


pytestmark = pytest.mark.django_db


def _audit_count(**filters) -> int:
    return AuditEvent.objects.filter(**filters).count()


def test_org_create_emits_audit():
    actor = UserFactory()
    pre = _audit_count()
    org = lifecycle_svc.create_organization(
        slug="new-org", name="New Org", created_by=actor, request=None
    )
    assert _audit_count(event_type="org_created", organization_id=org.id) == 1
    assert _audit_count() == pre + 1


def test_org_suspend_unsuspend_emit_audit():
    actor = UserFactory()
    org = OrganizationFactory()
    lifecycle_svc.suspend_org(org=org, suspended_by=actor, reason="bad behaviour")
    assert _audit_count(event_type="org_suspended", organization_id=org.id) == 1
    lifecycle_svc.unsuspend_org(org=org, unsuspended_by=actor)
    assert _audit_count(event_type="org_unsuspended", organization_id=org.id) == 1


def test_org_archive_emits_audit():
    actor = UserFactory()
    org = OrganizationFactory()
    lifecycle_svc.archive_org(org=org, archived_by=actor, reason="end of life")
    assert _audit_count(event_type="org_deleted", organization_id=org.id) == 1


def test_change_slug_emits_audit():
    actor = UserFactory()
    org = OrganizationFactory(slug="before")
    slug_svc.change_slug(org=org, new_slug="after", changed_by=actor)
    assert _audit_count(event_type="org_settings_changed", organization_id=org.id) == 1


def test_ownership_transfer_emits_audit():
    org = OrganizationFactory()
    owner = UserFactory()
    successor = UserFactory()
    OrganizationMembershipFactory(
        user=owner, organization=org, role=MembershipRole.ADMIN, is_org_owner=True
    )
    OrganizationMembershipFactory(
        user=successor, organization=org, role=MembershipRole.ADMIN
    )
    ownership_svc.transfer_ownership(
        org=org,
        current_owner_user=owner,
        new_owner_user=successor,
        requested_by=owner,
    )
    assert (
        _audit_count(event_type="ownership_transfer_accepted", organization_id=org.id)
        == 1
    )


def test_invitation_create_revoke_accept_emit_audit(rf):
    org = OrganizationFactory()
    inviter = UserFactory()
    accepting = UserFactory()
    request = rf.post("/")
    from django.contrib.sessions.backends.db import SessionStore

    request.session = SessionStore()
    request.session.create()

    inv, plaintext = invitation_svc.create_invitation(
        org=org, email="a@example.test", invited_by=inviter, request=request
    )
    assert _audit_count(event_type="member_invite_sent", organization_id=org.id) == 1

    invitation_svc.accept_invitation(
        token_plaintext=plaintext, accepting_user=accepting, request=request
    )
    assert _audit_count(event_type="member_invite_accepted", organization_id=org.id) == 1

    # Second invitation, then revoke.
    inv2, _ = invitation_svc.create_invitation(
        org=org, email="b@example.test", invited_by=inviter, request=request
    )
    invitation_svc.revoke_invitation(
        invitation=inv2, revoked_by=inviter, reason="changed mind", request=request
    )
    assert _audit_count(event_type="member_invite_revoked", organization_id=org.id) == 1
