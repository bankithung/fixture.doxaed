"""AdminInvitation: create → accept happy path + sad paths."""
from __future__ import annotations

import datetime as dt

import pytest
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import (
    InviteStatus,
    MembershipRole,
    OrganizationMembership,
)
from apps.organizations.services import invitation as invitation_svc
from apps.organizations.tests.factories import OrganizationFactory


pytestmark = pytest.mark.django_db


def _make_request_with_session(rf):
    request = rf.post("/")
    # Attach a minimal session so cycle_key() doesn't blow up.
    from django.contrib.sessions.backends.db import SessionStore

    request.session = SessionStore()
    request.session.create()
    return request


def test_invitation_happy_path(rf):
    org = OrganizationFactory()
    inviter = UserFactory()
    accepting = UserFactory()
    request = _make_request_with_session(rf)

    inv, plaintext = invitation_svc.create_invitation(
        org=org,
        email="invitee@example.test",
        role=MembershipRole.CO_ORGANIZER,
        invited_by=inviter,
        request=request,
    )
    assert inv.status == InviteStatus.PENDING
    assert inv.token_hash != plaintext
    assert plaintext  # plaintext returned only at creation time

    membership = invitation_svc.accept_invitation(
        token_plaintext=plaintext, accepting_user=accepting, request=request
    )
    assert membership.is_active
    assert membership.role == MembershipRole.CO_ORGANIZER
    assert membership.user_id == accepting.id

    inv.refresh_from_db()
    assert inv.status == InviteStatus.ACCEPTED
    assert inv.accepted_at is not None
    assert inv.accepted_by_user_id == accepting.id


def test_invitation_token_replay_rejected(rf):
    org = OrganizationFactory()
    inviter = UserFactory()
    accepting = UserFactory()
    request = _make_request_with_session(rf)

    inv, plaintext = invitation_svc.create_invitation(
        org=org, email="x@example.test", invited_by=inviter, request=request
    )
    invitation_svc.accept_invitation(
        token_plaintext=plaintext, accepting_user=accepting, request=request
    )
    # Replay → must reject.
    with pytest.raises(ValidationError):
        invitation_svc.accept_invitation(
            token_plaintext=plaintext, accepting_user=accepting, request=request
        )


def test_invitation_expired_token_rejected(rf):
    org = OrganizationFactory()
    inviter = UserFactory()
    accepting = UserFactory()
    request = _make_request_with_session(rf)

    inv, plaintext = invitation_svc.create_invitation(
        org=org, email="y@example.test", invited_by=inviter, request=request
    )
    inv.expires_at = timezone.now() - dt.timedelta(days=1)
    inv.save(update_fields=["expires_at"])

    with pytest.raises(ValidationError):
        invitation_svc.accept_invitation(
            token_plaintext=plaintext, accepting_user=accepting, request=request
        )
    inv.refresh_from_db()
    assert inv.status == InviteStatus.EXPIRED


def test_invitation_revoked_token_rejected(rf):
    org = OrganizationFactory()
    inviter = UserFactory()
    accepting = UserFactory()
    request = _make_request_with_session(rf)

    inv, plaintext = invitation_svc.create_invitation(
        org=org, email="z@example.test", invited_by=inviter, request=request
    )
    invitation_svc.revoke_invitation(
        invitation=inv, revoked_by=inviter, reason="changed mind", request=request
    )
    with pytest.raises(ValidationError):
        invitation_svc.accept_invitation(
            token_plaintext=plaintext, accepting_user=accepting, request=request
        )


def test_invitation_invalid_token_rejected(rf):
    accepting = UserFactory()
    request = _make_request_with_session(rf)
    with pytest.raises(ValidationError):
        invitation_svc.accept_invitation(
            token_plaintext="not-a-real-token", accepting_user=accepting, request=request
        )


def test_invitation_unique_pending_per_email_per_org(rf):
    org = OrganizationFactory()
    inviter = UserFactory()
    request = _make_request_with_session(rf)
    invitation_svc.create_invitation(
        org=org, email="dup@example.test", invited_by=inviter, request=request
    )
    with pytest.raises(ValidationError):
        invitation_svc.create_invitation(
            org=org, email="dup@example.test", invited_by=inviter, request=request
        )


def test_invitation_session_cycled_on_accept(rf):
    org = OrganizationFactory()
    inviter = UserFactory()
    accepting = UserFactory()
    request = _make_request_with_session(rf)
    inv, plaintext = invitation_svc.create_invitation(
        org=org, email="sess@example.test", invited_by=inviter, request=request
    )
    pre_key = request.session.session_key
    invitation_svc.accept_invitation(
        token_plaintext=plaintext, accepting_user=accepting, request=request
    )
    post_key = request.session.session_key
    # cycle_key() rotates the session id.
    assert pre_key is not None
    assert post_key is not None
    assert pre_key != post_key
