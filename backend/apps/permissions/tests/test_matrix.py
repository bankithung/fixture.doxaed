"""Tests for the aggregate per-member × per-module matrix endpoint
and the slug-routed alias views (Appendix B.16).

Endpoint under test:
    GET /api/permissions/orgs/{slug}/grants/matrix/

Plus slug aliases:
    GET  /api/permissions/orgs/{slug}/me/modules/
    GET  /api/permissions/orgs/{slug}/users/{user_uuid}/grants/
    PUT  /api/permissions/orgs/{slug}/users/{user_uuid}/grants/

The matrix shape:
    {
      "modules": [{key, scope, label, description}, ... 22],
      "members": [
        {
          "user_id", "user_email", "user_full_name", "roles": [...],
          "cells": {module_code: "default"|"grant"|"deny"},
          "role_defaults": {module_code: bool},
        }, ...
      ],
    }
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from rest_framework.test import APIClient

from apps.organizations.models import (
    MembershipRole,
    OrganizationMembership,
)
from apps.permissions.models import GrantState, MembershipModuleGrant, Module
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)


pytestmark = pytest.mark.django_db


def _api(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def admin_org(loaded_modules):
    """An admin user (with member_directory module) seated in a fresh Org."""
    org = OrganizationFactory(slug="acme")
    admin = UserFactory()
    OrganizationMembershipFactory(
        user=admin,
        organization=org,
        role=MembershipRole.ADMIN,
        is_org_owner=True,
    )
    return admin, org


# ---------------------------------------------------------------------------
# Matrix endpoint behaviour
# ---------------------------------------------------------------------------


def test_matrix_returns_23_modules(admin_org):
    admin, org = admin_org
    resp = _api(admin).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert "modules" in body
    assert len(body["modules"]) == 23
    # Each module row has the required keys.
    for row in body["modules"]:
        assert set(row.keys()) >= {"key", "scope", "label", "description"}
    # Scope mapping: org.* → "org", tournament.* → "tournament",
    # match.* → "match", personal.* → "platform".
    scope_for = {row["key"]: row["scope"] for row in body["modules"]}
    assert scope_for["org.settings"] == "org"
    assert scope_for["tournament.editor"] == "tournament"
    # Look up a known match-scope code that exists in the fixture.
    if "match.scoring_console" in scope_for:
        assert scope_for["match.scoring_console"] == "match"
    # personal.* mapping if present in fixture.
    personal_keys = [k for k in scope_for if k.startswith("personal.")]
    for k in personal_keys:
        assert scope_for[k] == "platform"


def test_matrix_includes_member_with_aggregated_roles(admin_org):
    """A user with two active memberships (different roles) shows up as
    ONE entry in `members` with both roles in the `roles` list."""
    admin, org = admin_org
    multi = UserFactory(name="Alice Smith", email="alice@example.test")
    OrganizationMembershipFactory(
        user=multi, organization=org, role=MembershipRole.CO_ORGANIZER
    )
    # Second active row for same user under a different role.
    OrganizationMembership.objects.create(
        user=multi,
        organization=org,
        role=MembershipRole.GAME_COORDINATOR,
        is_active=True,
    )

    resp = _api(admin).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    by_user = {m["user_id"]: m for m in body["members"]}
    assert str(multi.id) in by_user
    multi_row = by_user[str(multi.id)]
    assert set(multi_row["roles"]) == {
        MembershipRole.CO_ORGANIZER,
        MembershipRole.GAME_COORDINATOR,
    }
    assert multi_row["user_email"] == "alice@example.test"
    assert multi_row["user_full_name"] == "Alice Smith"


def test_matrix_cells_reflect_role_defaults(admin_org):
    """For a member with a known role, role_defaults[module] tracks the
    `default_for_roles` of that module. Cells are `default` when no
    override row exists."""
    admin, org = admin_org
    member = UserFactory()
    OrganizationMembershipFactory(
        user=member, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    resp = _api(admin).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    by_user = {m["user_id"]: m for m in body["members"]}
    row = by_user[str(member.id)]

    # tournament.editor has co_organizer in default_for_roles → True
    assert row["role_defaults"]["tournament.editor"] is True
    # No override → cell is "default"
    assert row["cells"]["tournament.editor"] == "default"
    # match.scoring_console — not default for co_organizer (it's for
    # admin/co_organizer/game_coordinator/match_scorer per fixture).
    # The co_organizer DOES have it per the fixture above; pick a module
    # that we know is NOT default for co_organizer. Use the team_manager-only
    # fallback: there is no "co_organizer-excluded" common module, but
    # `org.member_directory` is default for co_organizer → True.
    assert row["role_defaults"]["org.member_directory"] is True


def test_matrix_explicit_grant_overrides_default(admin_org):
    """An explicit `state=grant` row → cell="grant"."""
    admin, org = admin_org
    member = UserFactory()
    OrganizationMembershipFactory(
        user=member, organization=org, role=MembershipRole.TEAM_MANAGER
    )
    bracket = Module.objects.get(code="tournament.bracket_editor")
    MembershipModuleGrant.objects.create(
        user=member,
        organization=org,
        module=bracket,
        state=GrantState.GRANT,
        reason="Granted bracket access for testing — twenty plus chars.",
    )

    resp = _api(admin).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    by_user = {m["user_id"]: m for m in body["members"]}
    row = by_user[str(member.id)]

    assert row["cells"]["tournament.bracket_editor"] == "grant"
    # role_default for team_manager on bracket_editor is False
    assert row["role_defaults"]["tournament.bracket_editor"] is False


def test_matrix_explicit_deny_removes_default(admin_org):
    """An explicit `state=deny` row → cell="deny" even if role-default
    would have included the module."""
    admin, org = admin_org
    member = UserFactory()
    OrganizationMembershipFactory(
        user=member, organization=org, role=MembershipRole.CO_ORGANIZER
    )
    editor = Module.objects.get(code="tournament.editor")
    MembershipModuleGrant.objects.create(
        user=member,
        organization=org,
        module=editor,
        state=GrantState.DENY,
        reason="Denied editor access for testing — twenty plus chars.",
    )

    resp = _api(admin).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    by_user = {m["user_id"]: m for m in body["members"]}
    row = by_user[str(member.id)]

    assert row["cells"]["tournament.editor"] == "deny"
    # Role-default still reports True (deny is an override layered on top).
    assert row["role_defaults"]["tournament.editor"] is True


def test_matrix_requires_member_directory_module(loaded_modules):
    """A user without `org.member_directory` cannot read the matrix."""
    org = OrganizationFactory(slug="closed")
    referee = UserFactory()
    OrganizationMembershipFactory(
        user=referee, organization=org, role=MembershipRole.REFEREE
    )
    resp = _api(referee).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    # HasModule fails-closed → 403.
    assert resp.status_code in (403, 404), resp.content


# ---------------------------------------------------------------------------
# PUT /grants/ accepts the cells body shape (SPA matrix UI submit)
# ---------------------------------------------------------------------------


def test_put_grants_accepts_cells_shape(admin_org):
    admin, org = admin_org
    target = UserFactory()
    OrganizationMembershipFactory(
        user=target, organization=org, role=MembershipRole.TEAM_MANAGER
    )
    eid = str(_uuid.uuid4())
    resp = _api(admin).put(
        f"/api/permissions/orgs/{org.slug}/users/{target.id}/grants/",
        data={
            "cells": {
                "tournament.bracket_editor": "grant",
                "tournament.schedule_editor": "grant",
            },
            "reason": "Granting bracket and schedule for tournament prep run.",
            "event_id": eid,
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    body = resp.json()
    # Two new rows persisted.
    rows = MembershipModuleGrant.objects.filter(user=target, organization=org)
    codes_to_state = {r.module.code: r.state for r in rows}
    assert codes_to_state.get("tournament.bracket_editor") == GrantState.GRANT
    assert codes_to_state.get("tournament.schedule_editor") == GrantState.GRANT
    # Effective modules now contain bracket + schedule even though
    # team_manager doesn't get them by default.
    eff = set(body.get("effective_modules", []))
    assert "tournament.bracket_editor" in eff
    assert "tournament.schedule_editor" in eff


# ---------------------------------------------------------------------------
# Slug aliases proxy to UUID logic correctly
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Security regression: override-management endpoints are admin-only.
# v1Users.md §2 line 736 reserves the override-grant verb to Admin in v1.0.
# Co-organizer / Game-coordinator / Match-scorer / Referee / Team-manager
# may have `org.member_directory` for read access but cannot manage the
# per-user module override matrix.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "role",
    [
        MembershipRole.CO_ORGANIZER,
        MembershipRole.GAME_COORDINATOR,
        MembershipRole.MATCH_SCORER,
        MembershipRole.REFEREE,
        MembershipRole.TEAM_MANAGER,
    ],
)
def test_matrix_get_forbidden_for_non_admin_roles(loaded_modules, role):
    """DEFECT-J regression: only admin may read the override matrix.

    Co-organizer + Game-coordinator have `org.member_directory` by
    default, so the previous `HasModule("org.member_directory")` gate
    let them through. The canonical gate is admin-only per v1Users.md
    §2 line 736.
    """
    org = OrganizationFactory(slug="acme")
    user = UserFactory()
    OrganizationMembershipFactory(user=user, organization=org, role=role)
    resp = _api(user).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    assert resp.status_code == 403, resp.content


def test_matrix_get_allowed_for_admin(admin_org):
    """Admin (org owner) reads the override matrix successfully."""
    admin, org = admin_org
    resp = _api(admin).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    assert resp.status_code == 200, resp.content


def test_matrix_get_forbidden_for_member_with_no_role(loaded_modules):
    """A user with no active membership in the org must get 403."""
    org = OrganizationFactory(slug="acme")
    outsider = UserFactory()  # no membership row
    resp = _api(outsider).get(f"/api/permissions/orgs/{org.slug}/grants/matrix/")
    assert resp.status_code == 403, resp.content


@pytest.mark.parametrize(
    "role",
    [
        MembershipRole.CO_ORGANIZER,
        MembershipRole.GAME_COORDINATOR,
    ],
)
def test_user_grants_get_forbidden_for_non_admin_with_member_directory(
    loaded_modules, role
):
    """`UserGrantsBySlugView` GET is admin-only even though
    co_organizer / game_coordinator hold `org.member_directory`.
    """
    org = OrganizationFactory(slug="acme")
    actor = UserFactory()
    target = UserFactory()
    OrganizationMembershipFactory(user=actor, organization=org, role=role)
    OrganizationMembershipFactory(
        user=target, organization=org, role=MembershipRole.TEAM_MANAGER
    )
    resp = _api(actor).get(
        f"/api/permissions/orgs/{org.slug}/users/{target.id}/grants/"
    )
    assert resp.status_code == 403, resp.content


def test_user_grants_put_forbidden_for_co_organizer(loaded_modules):
    """`UserGrantsBySlugView` PUT is admin-only.

    Co-organizer holds `org.member_directory` so they previously could
    PUT — that's the bug we're fixing here.
    """
    org = OrganizationFactory(slug="acme")
    actor = UserFactory()
    target = UserFactory()
    OrganizationMembershipFactory(
        user=actor, organization=org, role=MembershipRole.CO_ORGANIZER
    )
    OrganizationMembershipFactory(
        user=target, organization=org, role=MembershipRole.TEAM_MANAGER
    )
    resp = _api(actor).put(
        f"/api/permissions/orgs/{org.slug}/users/{target.id}/grants/",
        data={
            "cells": {"tournament.bracket_editor": "grant"},
            "reason": "Co-organizer should not be able to grant overrides.",
        },
        format="json",
    )
    assert resp.status_code == 403, resp.content


def test_my_modules_by_slug_readable_by_any_member(loaded_modules):
    """`MyModulesBySlugView` is per-user — every member may read their
    own effective modules. Make sure the admin-only tightening above
    didn't accidentally over-tighten this view.
    """
    org = OrganizationFactory(slug="acme")
    referee = UserFactory()
    OrganizationMembershipFactory(
        user=referee, organization=org, role=MembershipRole.REFEREE
    )
    resp = _api(referee).get(f"/api/permissions/orgs/{org.slug}/me/modules/")
    assert resp.status_code == 200, resp.content
    assert "modules" in resp.json()


def test_slug_alias_resolves_to_existing_uuid_logic(admin_org):
    """The slug-routed `/me/modules/` and `/users/.../grants/` paths
    return the same payload as the existing UUID-routed endpoints."""
    admin, org = admin_org
    target = UserFactory()
    OrganizationMembershipFactory(
        user=target, organization=org, role=MembershipRole.CO_ORGANIZER
    )

    # /me/modules/ slug variant
    resp_slug = _api(admin).get(
        f"/api/permissions/orgs/{org.slug}/me/modules/"
    )
    assert resp_slug.status_code == 200, resp_slug.content
    resp_uuid = _api(admin).get(
        f"/api/permissions/me/modules/?org={org.id}"
    )
    assert resp_uuid.status_code == 200, resp_uuid.content
    assert sorted(resp_slug.json()["modules"]) == sorted(
        resp_uuid.json()["modules"]
    )

    # /users/{uuid}/grants/ slug variant — GET returns same shape as UUID.
    resp_slug_g = _api(admin).get(
        f"/api/permissions/orgs/{org.slug}/users/{target.id}/grants/"
    )
    assert resp_slug_g.status_code == 200, resp_slug_g.content
    resp_uuid_g = _api(admin).get(
        f"/api/permissions/orgs/{org.id}/users/{target.id}/grants/"
    )
    assert resp_uuid_g.status_code == 200, resp_uuid_g.content
    assert resp_slug_g.json().keys() == resp_uuid_g.json().keys()

    # Non-existent slug → 404.
    resp_404 = _api(admin).get(
        "/api/permissions/orgs/no-such-org/grants/matrix/"
    )
    assert resp_404.status_code in (403, 404)
