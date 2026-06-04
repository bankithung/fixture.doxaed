"""Aggregate per-member × per-module override matrix for the SPA UI.

Powers `GET /api/permissions/orgs/{slug}/grants/matrix/` (Appendix B.16).

The matrix shows, for every active member of an Organization, which
modules they have by role-default, plus the explicit override state
(grant / deny / default) for each of the 22 catalog modules.

Layered on top of (not duplicating) the resolver:
  - Catalog source-of-truth: `Module.default_for_roles`.
  - Override source-of-truth: `MembershipModuleGrant`.
  - Effective set: `effective_modules(user, org)` (NOT used here — the
    matrix UI shows the layered breakdown, not the resolved frozenset).

Output is JSON-friendly. Acceptable to recompute on each call in
Phase 1A (no caching layer); typical Org has <500 members so the
worst-case is 500 × 22 = 11k cells, well within a single request budget.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from apps.organizations.models import OrganizationMembership
from apps.permissions.models import GrantState, MembershipModuleGrant, Module


# Mapping from module-code prefix to scope label exposed in the API.
# "personal.*" maps to "platform" per the existing fixture taxonomy used
# by the frontend (Appendix B.16); other prefixes pass through verbatim.
_SCOPE_OVERRIDES: dict[str, str] = {
    "personal": "platform",
}


def _scope_for(code: str) -> str:
    """Derive scope label from module code prefix.

    "org.*" → "org", "tournament.*" → "tournament", "match.*" → "match",
    "personal.*" → "platform".
    """
    prefix = code.split(".", 1)[0] if "." in code else code
    return _SCOPE_OVERRIDES.get(prefix, prefix)


def _serialize_modules(modules: list[Module]) -> list[dict[str, Any]]:
    """Serialize the 22-row module catalog into the matrix `modules` list."""
    return [
        {
            "key": m.code,
            "scope": _scope_for(m.code),
            "label": m.name,
            "description": m.description,
        }
        for m in modules
    ]


def build_matrix(organization) -> dict[str, Any]:
    """Build the full matrix payload for one Organization.

    Returns a dict of shape:
        {
          "modules": [{key, scope, label, description}, ... 22],
          "members": [
            {
              "user_id": str,
              "user_email": str,
              "user_full_name": str,
              "roles": [str, ...],
              "cells": {module_code: "default"|"grant"|"deny"},
              "role_defaults": {module_code: bool},
            }, ...
          ],
        }
    """
    # 1. Modules (sorted by category then code for stable UI ordering).
    modules = list(Module.objects.all().order_by("category", "code"))
    module_codes = [m.code for m in modules]

    # 2. Pre-compute role → set(module_codes that default-on for that role).
    #    This is one scan over the 22 catalog rows, not per-member.
    role_to_modules: dict[str, set[str]] = defaultdict(set)
    for m in modules:
        for role in m.default_for_roles or []:
            role_to_modules[role].add(m.code)

    # 3. Aggregate active memberships → user_id → set(roles).
    memberships = (
        OrganizationMembership.objects.filter(
            organization=organization, is_active=True
        )
        .select_related("user")
        .order_by("user__email", "role")
    )

    user_roles: dict[Any, set[str]] = defaultdict(set)
    user_obj: dict[Any, Any] = {}
    for mem in memberships:
        user_roles[mem.user_id].add(mem.role)
        # First-seen User instance is fine; all rows reference the same user.
        user_obj.setdefault(mem.user_id, mem.user)

    # 4. Pre-fetch all grant override rows for these users in one query.
    grant_rows = MembershipModuleGrant.objects.filter(
        organization=organization,
        user_id__in=list(user_roles.keys()),
    ).select_related("module").values_list(
        "user_id", "module__code", "state"
    )
    # Index: user_id → {module_code: state}
    user_overrides: dict[Any, dict[str, str]] = defaultdict(dict)
    for user_id, code, state in grant_rows:
        user_overrides[user_id][code] = state

    # 5. Build per-member cells + role_defaults.
    members: list[dict[str, Any]] = []
    for user_id, roles in user_roles.items():
        user = user_obj[user_id]

        # Role-default base set: union over the user's roles.
        base_codes: set[str] = set()
        for role in roles:
            base_codes |= role_to_modules.get(role, set())

        cells: dict[str, str] = {}
        role_defaults: dict[str, bool] = {}
        overrides = user_overrides.get(user_id, {})
        for code in module_codes:
            override = overrides.get(code)
            if override == GrantState.GRANT:
                cells[code] = "grant"
            elif override == GrantState.DENY:
                cells[code] = "deny"
            else:
                cells[code] = "default"
            role_defaults[code] = code in base_codes

        members.append(
            {
                "user_id": str(user_id),
                "user_email": getattr(user, "email", "") or "",
                "user_full_name": getattr(user, "name", "") or "",
                "roles": sorted(roles),
                "cells": cells,
                "role_defaults": role_defaults,
            }
        )

    return {
        "modules": _serialize_modules(modules),
        "members": members,
    }
