"""Tests for GET /api/audit/orgs/<slug>/ — org-scoped audit list.

Covers:
* Admin (with org.audit_log default-on) sees rows.
* Cross-org leak is blocked (audit rows from another org are not returned).
* Module-gated: a user without ``org.audit_log`` (e.g. team_manager) → 403.
* Pagination via ``cursor`` and ``limit``.
* Cursor stability across concurrent inserts (cursor never returns the
  same row twice and never skips rows whose ``created_at`` is older).
"""
from __future__ import annotations

import uuid

import pytest
from django.urls import reverse

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.organizations.models import MembershipRole
from apps.organizations.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
)
from apps.permissions.tests.factories import UserFactory


# Default-on roles for org.audit_log per v1Users.md A.2:
#   admin, co_organizer, game_coordinator, referee
_DEFAULT_AUDIT_ROLES = (
    MembershipRole.ADMIN,
    MembershipRole.CO_ORGANIZER,
    MembershipRole.GAME_COORDINATOR,
    MembershipRole.REFEREE,
)


def _seed_audit(org, *, count: int = 1, event_type: str = "user_login_success") -> list[AuditEvent]:
    rows: list[AuditEvent] = []
    for _ in range(count):
        rows.append(
            emit_audit(
                actor_user=None,
                actor_role=ActorRole.SYSTEM,
                event_type=event_type,
                target_type="user",
                target_id=uuid.uuid4(),
                organization_id=org.id,
            )
        )
    return rows


@pytest.fixture
def org(db):
    return OrganizationFactory(slug="acme")


@pytest.fixture
def admin_user(db, org):
    user = UserFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.ADMIN, is_active=True
    )
    return user


@pytest.fixture
def team_manager_user(db, org):
    """Role WITHOUT org.audit_log default — used for the deny test."""
    user = UserFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=MembershipRole.TEAM_MANAGER, is_active=True
    )
    return user


@pytest.mark.django_db
def test_admin_sees_org_audit_rows(loaded_modules, client, org, admin_user):
    _seed_audit(org, count=3)

    client.force_login(admin_user)
    url = reverse("audit:org-audit-list", kwargs={"slug": org.slug})
    resp = client.get(url)

    assert resp.status_code == 200, resp.content
    data = resp.json()
    assert "results" in data
    assert len(data["results"]) == 3
    # Newest first (DESC).
    assert data["results"][0]["event_type"] == "user_login_success"
    # Required fields per v1Users.md §6.
    row = data["results"][0]
    for field in (
        "id",
        "event_type",
        "actor_id",
        "actor_email_at_time",
        "target_id",
        "target_label",
        "payload",
        "created_at",
    ):
        assert field in row, f"missing field {field!r} in audit row"


@pytest.mark.django_db
def test_team_manager_denied_by_module_gate(loaded_modules, client, org, team_manager_user):
    """team_manager has no org.audit_log default → 403 from HasModule()."""
    _seed_audit(org, count=1)

    client.force_login(team_manager_user)
    url = reverse("audit:org-audit-list", kwargs={"slug": org.slug})
    resp = client.get(url)

    assert resp.status_code == 403, resp.content


@pytest.mark.django_db
def test_cross_org_leak_blocked(loaded_modules, client, org, admin_user):
    other_org = OrganizationFactory(slug="other-co")
    # Seed rows in *other* org; admin_user has no membership there.
    _seed_audit(other_org, count=2)
    # Seed one row in the admin's org so a successful response is non-empty.
    _seed_audit(org, count=1)

    client.force_login(admin_user)

    # 1. Admin can read their own org.
    url_own = reverse("audit:org-audit-list", kwargs={"slug": org.slug})
    own_resp = client.get(url_own)
    assert own_resp.status_code == 200
    own_results = own_resp.json()["results"]
    assert len(own_results) == 1

    # 2. Admin attempting to read the other org → 403 (no membership =
    #    HasModule resolves with no roles → returns empty set → False).
    url_other = reverse("audit:org-audit-list", kwargs={"slug": other_org.slug})
    other_resp = client.get(url_other)
    assert other_resp.status_code == 403, other_resp.content

    # 3. Even if they could request it, no row from `other_org` is in
    #    the response from /orgs/{org.slug}/ — verified above by length.
    assert all(
        r["target_id"] != str(other_org.id) for r in own_results
    )


@pytest.mark.django_db
def test_pagination_with_cursor(loaded_modules, client, org, admin_user):
    rows = _seed_audit(org, count=5)
    assert len(rows) == 5

    client.force_login(admin_user)
    url = reverse("audit:org-audit-list", kwargs={"slug": org.slug})

    # First page — limit 2.
    page1 = client.get(url, {"limit": 2}).json()
    assert len(page1["results"]) == 2
    assert page1["next_cursor"] is not None

    # Second page — pass cursor.
    page2 = client.get(url, {"limit": 2, "cursor": page1["next_cursor"]}).json()
    assert len(page2["results"]) == 2
    assert page2["next_cursor"] is not None

    # Third page — final row.
    page3 = client.get(url, {"limit": 2, "cursor": page2["next_cursor"]}).json()
    assert len(page3["results"]) == 1
    assert page3["next_cursor"] is None  # exhausted

    # No row appears on more than one page.
    page1_ids = {r["id"] for r in page1["results"]}
    page2_ids = {r["id"] for r in page2["results"]}
    page3_ids = {r["id"] for r in page3["results"]}
    assert page1_ids.isdisjoint(page2_ids)
    assert page1_ids.isdisjoint(page3_ids)
    assert page2_ids.isdisjoint(page3_ids)
    # All five rows accounted for.
    assert len(page1_ids | page2_ids | page3_ids) == 5


@pytest.mark.django_db
def test_cursor_stable_across_inserts(loaded_modules, client, org, admin_user):
    """A new row inserted AFTER the first page must not retroactively
    appear in the second page (cursor anchors on created_at + id).
    """
    initial = _seed_audit(org, count=3)

    client.force_login(admin_user)
    url = reverse("audit:org-audit-list", kwargs={"slug": org.slug})

    page1 = client.get(url, {"limit": 2}).json()
    assert len(page1["results"]) == 2

    # Insert a brand-new row — it has the LATEST created_at; the cursor
    # we hold is anchored on the older boundary, so it must NOT show up
    # when we request the next page.
    fresh = emit_audit(
        actor_user=None,
        actor_role=ActorRole.SYSTEM,
        event_type="user_login_success",
        target_type="user",
        target_id=uuid.uuid4(),
        organization_id=org.id,
    )

    page2 = client.get(url, {"limit": 5, "cursor": page1["next_cursor"]}).json()
    page2_ids = {r["id"] for r in page2["results"]}

    # Only the third original row should be returned. The fresh insert
    # has created_at greater than the cursor's anchor, so the cursor's
    # "<" filter excludes it.
    assert str(fresh.id) not in page2_ids
    expected_remaining = {str(initial[0].id)}  # the oldest of the three
    assert expected_remaining.issubset(page2_ids)


@pytest.mark.django_db
def test_filter_by_event_type(loaded_modules, client, org, admin_user):
    _seed_audit(org, count=2, event_type="user_login_success")
    _seed_audit(org, count=3, event_type="org_created")

    client.force_login(admin_user)
    url = reverse("audit:org-audit-list", kwargs={"slug": org.slug})

    resp = client.get(url, {"event_type": "org_created"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["results"]) == 3
    assert all(r["event_type"] == "org_created" for r in data["results"])


@pytest.mark.django_db
def test_unauthenticated_request_denied(loaded_modules, client, org):
    _seed_audit(org, count=1)
    url = reverse("audit:org-audit-list", kwargs={"slug": org.slug})

    resp = client.get(url)
    # IsAuthenticated → 403 with DRF SessionAuth + no creds.
    assert resp.status_code in (401, 403)
