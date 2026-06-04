"""Tests for v1Users.md §2.3 Path B (public self-signup).

Path B = a stranger arrives at /auth/signup, fills the form, hits
submit. The endpoint must atomically create:

  1. User (is_active=False until email verification).
  2. Organization (status=pending_review, slug derived).
  3. OrganizationMembership (role=admin, is_org_owner=True,
     is_active=False — pending until SA approves the org).
  4. EmailVerificationToken.
  5. AuditEvent ``user_signup`` with Path B payload (org/membership ids).

Path A (invite-accept) is tested in
``apps/organizations/tests/test_invitation_flow.py`` — those users
join an existing Org and never hit this endpoint.
"""
from __future__ import annotations

import uuid

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.models import EmailVerificationToken, User
from apps.accounts.services import signup as signup_svc
from apps.audit.models import AuditEvent
from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
    OrgStatus,
)

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Service-layer tests (perform_signup)
# ---------------------------------------------------------------------------


def test_perform_signup_creates_full_path_b_chain():
    result = signup_svc.perform_signup(
        email="founder@newco.test",
        password="StrongP@ss12345",
        name="Founder",
        org_name="NewCo Sports",
    )

    assert result.created is True
    assert result.duplicate_email is False

    # 1. User
    assert result.user.email == "founder@newco.test"
    assert result.user.is_active is False
    assert result.user.email_verified_at is None

    # 2. Organization
    assert result.organization is not None
    assert result.organization.status == OrgStatus.PENDING_REVIEW
    assert result.organization.slug  # non-empty
    assert result.organization.created_by_id == result.user.id

    # 3. Membership
    assert result.membership is not None
    assert result.membership.role == MembershipRole.ADMIN
    assert result.membership.is_org_owner is True
    assert result.membership.is_active is False
    assert result.membership.organization_id == result.organization.id
    assert result.membership.user_id == result.user.id

    # 4. Email verification token
    tokens = EmailVerificationToken.objects.filter(user=result.user)
    assert tokens.count() == 1
    assert result.verification_token_plaintext is not None

    # 5. Audit event
    audit = AuditEvent.objects.filter(
        event_type="user_signup", target_id=result.user.id
    ).first()
    assert audit is not None
    assert audit.organization_id == result.organization.id
    assert audit.payload_after["path"] == "B"


def test_perform_signup_derives_slug_from_email_when_no_org_name():
    result = signup_svc.perform_signup(
        email="alice.smith@startup.test",
        password="StrongP@ss12345",
    )
    assert result.created is True
    assert result.organization is not None
    # Should be derived from email local-part (lowercased + dotted-cleaned).
    assert result.organization.slug.startswith("alice")


def test_perform_signup_handles_slug_collision():
    # Pre-create an org with the slug we'd otherwise derive.
    Organization.objects.create(
        slug="acme",
        name="Existing Acme",
        status=OrgStatus.ACTIVE,
    )
    result = signup_svc.perform_signup(
        email="founder@elsewhere.test",
        password="StrongP@ss12345",
        org_name="ACME",
    )
    assert result.created is True
    assert result.organization is not None
    assert result.organization.slug != "acme"
    # Falls back to ``acme-2``, ``acme-3``, etc.
    assert result.organization.slug.startswith("acme-")


def test_perform_signup_rejects_reserved_slug_and_picks_next():
    # ``signup`` is in RESERVED_SLUGS — the email local-part is "signup"
    # so the seed slug would be reserved; service must pick a free one.
    result = signup_svc.perform_signup(
        email="signup@reserved.test",
        password="StrongP@ss12345",
    )
    assert result.created is True
    assert result.organization is not None
    assert result.organization.slug != "signup"


def test_perform_signup_duplicate_email_is_no_op_for_org():
    User.objects.create_user(
        email="taken@example.test",
        password="OriginalP@ss12345",
        is_active=False,
    )
    pre_org_count = Organization.objects.count()

    result = signup_svc.perform_signup(
        email="taken@example.test",
        password="DifferentP@ss123!",
        org_name="Squatter Inc",
    )

    assert result.created is False
    assert result.duplicate_email is True
    # No new Org created — we don't silently mint a tenant for a
    # squatter trying to claim somebody else's email.
    assert Organization.objects.count() == pre_org_count
    assert OrganizationMembership.objects.filter(user=result.user).count() == 0


def test_perform_signup_idempotent_on_event_id():
    eid = uuid.uuid4()
    first = signup_svc.perform_signup(
        email="idem@example.test",
        password="StrongP@ss12345",
        org_name="Idem Sports",
        event_id=eid,
    )
    assert first.created is True

    second = signup_svc.perform_signup(
        email="idem@example.test",
        password="StrongP@ss12345",
        org_name="Idem Sports",
        event_id=eid,
    )
    assert second.created is False
    assert second.duplicate_email is False
    assert second.user.id == first.user.id
    assert second.organization is not None
    assert second.organization.id == first.organization.id
    # Only one audit row recorded under that idempotency key.
    assert (
        AuditEvent.objects.filter(idempotency_key=eid).count() == 1
    )


def test_perform_signup_atomic_rollback_on_failure(monkeypatch):
    """If membership creation explodes mid-flow, the User and Org must
    NOT remain in the DB — the whole transaction unwinds.
    """
    from apps.accounts.services import signup as svc

    def boom(*args, **kwargs):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(
        OrganizationMembership.objects,
        "create",
        boom,
    )

    pre_users = User.objects.count()
    pre_orgs = Organization.objects.count()

    with pytest.raises(RuntimeError):
        svc.perform_signup(
            email="rolled@back.test",
            password="StrongP@ss12345",
            org_name="Rollback Sports",
        )

    assert User.objects.count() == pre_users
    assert Organization.objects.count() == pre_orgs


# ---------------------------------------------------------------------------
# View-layer tests (POST /api/accounts/auth/signup/)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _disable_signup_throttle(request, monkeypatch):
    """Most view tests don't care about the rate limit — keep the limit
    high so 3 calls per test don't trip the bucket. Tests that do care
    opt-in via the ``signup_throttle`` mark.
    """
    if request.node.get_closest_marker("signup_throttle"):
        return  # let the test manage rates itself

    from apps.accounts import throttling

    monkeypatch.setattr(
        throttling.SignupRateThrottle,
        "get_rate",
        lambda self: "100/hour",
    )


def test_signup_endpoint_creates_path_b_chain():
    api = APIClient()
    response = api.post(
        reverse("accounts:signup"),
        data={
            "email": "view@signup.test",
            "password": "StrongP@ss12345",
            "name": "View Test",
            "org_name": "View Sports",
        },
        format="json",
    )
    assert response.status_code == status.HTTP_201_CREATED
    user = User.objects.get(email="view@signup.test")
    assert OrganizationMembership.objects.filter(user=user).count() == 1
    membership = OrganizationMembership.objects.get(user=user)
    assert membership.role == MembershipRole.ADMIN
    assert membership.is_org_owner is True
    assert membership.is_active is False
    assert membership.organization.status == OrgStatus.PENDING_REVIEW


def test_signup_endpoint_idempotent_replay_returns_200():
    api = APIClient()
    eid = str(uuid.uuid4())
    payload = {
        "email": "replay@signup.test",
        "password": "StrongP@ss12345",
        "org_name": "Replay Sports",
        "event_id": eid,
    }
    first = api.post(reverse("accounts:signup"), data=payload, format="json")
    assert first.status_code == status.HTTP_201_CREATED

    second = api.post(reverse("accounts:signup"), data=payload, format="json")
    # Replay should NOT 201 — invariant 3 says re-submit returns 200.
    assert second.status_code == status.HTTP_200_OK

    assert User.objects.filter(email="replay@signup.test").count() == 1
    user = User.objects.get(email="replay@signup.test")
    assert OrganizationMembership.objects.filter(user=user).count() == 1


def test_signup_endpoint_duplicate_email_is_enumeration_safe():
    User.objects.create_user(
        email="exists@signup.test",
        password="OriginalP@ss12345",
        is_active=False,
    )
    pre_orgs = Organization.objects.count()

    api = APIClient()
    response = api.post(
        reverse("accounts:signup"),
        data={
            "email": "exists@signup.test",
            "password": "DifferentP@ss12345",
        },
        format="json",
    )
    # B.11: same 201 status whether or not the email exists.
    assert response.status_code == status.HTTP_201_CREATED
    # ...but no new Org is provisioned.
    assert Organization.objects.count() == pre_orgs


@pytest.mark.signup_throttle
def test_signup_endpoint_rate_limit_enforced():
    """The 4th signup from the same IP within an hour must 429.

    Bypasses the autouse fixture's relaxed rate by instantiating the
    throttle directly with a known small rate; we patch the rate that
    DRF's ``SimpleRateThrottle`` reads at construction time so this
    doesn't depend on Django settings cache invalidation timing.
    """
    from django.core.cache import cache

    from apps.accounts import throttling

    cache.clear()

    # Pin the throttle rate for the duration of this test.
    original_get_rate = throttling.SignupRateThrottle.get_rate

    def _fixed_rate(self):
        return "3/hour"

    throttling.SignupRateThrottle.get_rate = _fixed_rate
    try:
        api = APIClient()
        # 3 requests succeed (regardless of duplicate-email enum-safety),
        # the 4th must be 429.
        for i in range(3):
            r = api.post(
                reverse("accounts:signup"),
                data={
                    "email": f"throttle{i}@signup.test",
                    "password": "StrongP@ss12345",
                },
                format="json",
            )
            assert r.status_code in (
                status.HTTP_200_OK,
                status.HTTP_201_CREATED,
            ), f"unexpected status on attempt {i}: {r.status_code}"

        blocked = api.post(
            reverse("accounts:signup"),
            data={
                "email": "throttle3@signup.test",
                "password": "StrongP@ss12345",
            },
            format="json",
        )
        assert blocked.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    finally:
        throttling.SignupRateThrottle.get_rate = original_get_rate
        cache.clear()


@pytest.mark.signup_throttle
def test_signup_throttle_class_reads_3_per_hour_from_settings():
    """Sanity-check the wiring: with default settings the rate is 3/hour."""
    from apps.accounts.throttling import SignupRateThrottle

    throttle = SignupRateThrottle()
    # ``rate`` is a string like "3/hour"; ``num_requests`` / ``duration``
    # are derived from it. Verify the spec's 3/hr/IP budget is in force.
    assert throttle.rate == "3/hour"
    assert throttle.num_requests == 3
    assert throttle.duration == 3600
