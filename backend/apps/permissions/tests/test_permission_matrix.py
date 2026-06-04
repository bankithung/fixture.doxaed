"""Permission-matrix smoke test — parametrized over (role, module_code, expected).

This is the load-bearing canonical-RBAC test from CLAUDE.md invariant 12.
For each (role × module) cell, asserts that a user holding ONLY that role
gets the module in their effective set IFF the catalog says so via
`default_for_roles`.

Source of truth: `apps/permissions/fixtures/modules.json` (Appendix A.2 + B.16).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.organizations.models import MembershipRole
from apps.permissions.services.resolver import effective_modules
from apps.permissions.tests.factories import (
    OrganizationFactory,
    OrganizationMembershipFactory,
    UserFactory,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent / "fixtures" / "modules.json"
)


def _load_matrix_cells():
    """Yield (role, module_code, expected_default) tuples for parametrize."""
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    roles = [r.value for r in MembershipRole]
    cells = []
    for entry in data:
        code = entry["code"]
        defaults = set(entry.get("default_for_roles", []))
        for role in roles:
            cells.append((role, code, role in defaults))
    return cells


MATRIX_CELLS = _load_matrix_cells()


@pytest.mark.django_db
@pytest.mark.parametrize("role,module_code,expected", MATRIX_CELLS)
def test_permission_matrix_cell(loaded_modules, role, module_code, expected):
    user = UserFactory()
    org = OrganizationFactory()
    OrganizationMembershipFactory(
        user=user, organization=org, role=role,
        # admin role requires is_org_owner=True for one_owner_per_org constraint
        # not to bite — use False here; one_owner constraint only fires when True.
        is_org_owner=False,
    )

    actual = effective_modules(user, org)
    if expected:
        assert module_code in actual, (
            f"Role {role!r} should default to module {module_code!r} per fixture "
            f"but resolver returned absence."
        )
    else:
        assert module_code not in actual, (
            f"Role {role!r} should NOT default to module {module_code!r} per fixture "
            f"but resolver included it."
        )
