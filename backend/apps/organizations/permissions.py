"""DRF permission classes for the organizations app.

These check `OrganizationMembership` rows directly; module-level RBAC
(via the permissions agent's `effective_modules(user, org)` resolver)
plugs in on top once that surface is online. Until then we leave a
TODO at the call site that needs module gating.

Each class derives the active Org from one of:
  - `view.kwargs['org_uuid']`
  - `view.kwargs['uuid']`
  - `view.kwargs['slug_or_uuid']`
  - `view.kwargs['slug']`
"""
from __future__ import annotations

import uuid as _uuid
from typing import Optional

from rest_framework.permissions import BasePermission

from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
)


def _resolve_org_from_view(view) -> Optional[Organization]:
    """Resolve the active Organization from common URL kwargs.

    Detects whether the kwarg value is a UUID (filter on `pk`) or a slug
    (filter on `slug`). Postgres' UUID column raises ValidationError for
    non-UUID strings, so blindly doing `pk=candidate` against a slug like
    "doxaed" would 500 — hence the explicit branch here.
    """
    kwargs = getattr(view, "kwargs", {}) or {}
    candidate = (
        kwargs.get("uuid")
        or kwargs.get("org_uuid")
        or kwargs.get("slug_or_uuid")
        or kwargs.get("slug")
    )
    if not candidate:
        return None

    candidate_str = str(candidate)
    try:
        candidate_uuid = _uuid.UUID(candidate_str)
    except (ValueError, TypeError, AttributeError):
        candidate_uuid = None

    if candidate_uuid is not None:
        org = Organization.objects.filter(
            pk=candidate_uuid, deleted_at__isnull=True
        ).first()
        if org is not None:
            return org
        # Fall through: a string that *parses* as a UUID is never a slug
        # (slugs are lowercase ASCII with hyphens). Return None.
        return None

    # Non-UUID candidate → treat as slug. Slugs are stored lower-case.
    org = Organization.objects.filter(
        slug=candidate_str.lower(), deleted_at__isnull=True
    ).first()
    return org


class _OrgMembershipPermission(BasePermission):
    """Base — enforces 'authenticated AND has matching membership'.

    Subclasses define `allowed_roles` and `require_owner`.
    """

    allowed_roles: tuple[str, ...] = tuple(MembershipRole.values)
    require_owner: bool = False

    def has_permission(self, request, view) -> bool:
        user = request.user
        if not getattr(user, "is_authenticated", False):
            return False
        if getattr(user, "is_superuser", False):
            return True

        org = _resolve_org_from_view(view)
        if org is None:
            # Resource-level views without an org slug pass through here;
            # object-level permission filters at the queryset layer.
            return True

        qs = OrganizationMembership.objects.filter(
            user=user,
            organization=org,
            is_active=True,
            role__in=self.allowed_roles,
        )
        if self.require_owner:
            qs = qs.filter(is_org_owner=True, role=MembershipRole.ADMIN)
        return qs.exists()


class IsOrgMember(_OrgMembershipPermission):
    """Any active membership in the resolved Org."""

    allowed_roles = tuple(MembershipRole.values)


class IsOrgAdminOrOwner(_OrgMembershipPermission):
    """Active admin membership (owner or non-owner) in the resolved Org."""

    allowed_roles = (MembershipRole.ADMIN,)


class IsOrgOwner(_OrgMembershipPermission):
    """Active is_org_owner=True admin membership in the resolved Org."""

    allowed_roles = (MembershipRole.ADMIN,)
    require_owner = True


class IsSuperUser(BasePermission):
    """Platform-level Super-admin (Django is_superuser flag)."""

    def has_permission(self, request, view) -> bool:
        user = request.user
        return bool(
            getattr(user, "is_authenticated", False) and getattr(user, "is_superuser", False)
        )
