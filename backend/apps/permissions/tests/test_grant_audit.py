"""Every grant change emits exactly one AuditEvent (B.17)."""
from __future__ import annotations

import pytest

from apps.audit.models import AuditEvent
from apps.organizations.models import MembershipRole
from apps.permissions.models import GrantState
from apps.permissions.services.grants import (
    GrantValidationError,
    bulk_set_grants,
    clear_grants,
    set_grant,
)
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)


@pytest.mark.django_db
def test_set_grant_emits_one_audit(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    admin = UserFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER
    )

    before = AuditEvent.objects.count()
    set_grant(
        user=user,
        organization=org,
        module="tournament.bracket_editor",
        state="grant",
        granted_by=admin,
        reason="Tournament bracket testing — temporary access.",
    )
    after = AuditEvent.objects.count()
    assert after - before == 1

    row = AuditEvent.objects.latest("created_at")
    assert row.event_type == "module_grant_changed"
    assert row.target_type == "membership_module_grant"
    assert row.actor_user == admin
    assert row.organization_id == org.id
    assert row.payload_before == {
        "state": GrantState.DEFAULT.value,
        "module_code": "tournament.bracket_editor",
    }
    assert row.payload_after == {
        "state": GrantState.GRANT.value,
        "module_code": "tournament.bracket_editor",
    }


@pytest.mark.django_db
def test_set_grant_rejects_short_reason(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    admin = UserFactory()

    with pytest.raises(GrantValidationError):
        set_grant(
            user=user,
            organization=org,
            module="tournament.editor",
            state="grant",
            granted_by=admin,
            reason="too short",
        )


@pytest.mark.django_db
def test_bulk_set_grants_emits_one_audit_per_changed_module(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    admin = UserFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER
    )

    before = AuditEvent.objects.count()
    bulk_set_grants(
        user=user,
        organization=org,
        grants=[
            ("tournament.bracket_editor", "grant"),
            ("tournament.schedule_editor", "grant"),
        ],
        granted_by=admin,
        reason="Bulk grant for tournament testing — bracket and schedule.",
    )
    after = AuditEvent.objects.count()
    assert after - before == 2


@pytest.mark.django_db
def test_bulk_set_grants_skips_no_op_modules(loaded_modules):
    """If a (module, state) is already in that state, no audit row is emitted."""
    user = UserFactory()
    org = OrganizationFactory()
    admin = UserFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER
    )

    # First call — creates 1 row.
    bulk_set_grants(
        user=user,
        organization=org,
        grants=[("tournament.bracket_editor", "grant")],
        granted_by=admin,
        reason="Initial grant for bracket editor — long enough reason.",
    )
    mid = AuditEvent.objects.count()

    # Second call — same state, must be a no-op.
    bulk_set_grants(
        user=user,
        organization=org,
        grants=[("tournament.bracket_editor", "grant")],
        granted_by=admin,
        reason="Re-applying same state — no audit should fire here.",
    )
    end = AuditEvent.objects.count()
    assert end == mid


@pytest.mark.django_db
def test_clear_grants_emits_one_audit_per_row(loaded_modules):
    user = UserFactory()
    org = OrganizationFactory()
    admin = UserFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER
    )

    bulk_set_grants(
        user=user,
        organization=org,
        grants=[
            ("tournament.bracket_editor", "grant"),
            ("tournament.schedule_editor", "grant"),
        ],
        granted_by=admin,
        reason="Setting up two grants in advance for clear-test.",
    )
    before_clear = AuditEvent.objects.count()

    deleted = clear_grants(
        user=user,
        organization=org,
        granted_by=admin,
        reason="Clearing all grants for offboarding cleanup of user.",
    )
    after_clear = AuditEvent.objects.count()

    assert deleted == 2
    assert after_clear - before_clear == 2
