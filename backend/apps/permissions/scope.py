"""Scope-filter QuerySet base classes (Appendix B.2).

Other apps that own org-tenanted models (organizations, future
tournaments, teams, matches) should swap their default Manager for
`ScopedManager`. This is THE ONLY sanctioned way to filter by org —
hand-rolled `.filter(organization__in=...)` callsites are a code-smell
the multi-tenancy isolation tests will catch.

Integration pattern:

    # apps/tournaments/models.py
    from apps.permissions.scope import ScopedManager, ScopedQuerySet

    class TournamentQuerySet(ScopedQuerySet):
        # add tournament-specific .filter helpers here
        pass

    class Tournament(models.Model):
        organization = models.ForeignKey(Organization, ...)
        ...
        objects = ScopedManager.from_queryset(TournamentQuerySet)()

    # In a DRF view:
    queryset = Tournament.objects.scoped_for_user(self.request.user)
    queryset = Tournament.objects.module_gated(self.request.user, "tournament.editor")

The model MUST expose an `organization` FK (or `organization_id`).
Cross-org leak tests should call `Model.objects.scoped_for_user(user_in_org_X)`
and assert no rows from org Y are returned.
"""
from __future__ import annotations

from collections.abc import Iterable

from django.db import models


class ScopedQuerySet(models.QuerySet):
    """QuerySet that knows how to narrow itself to a user's accessible orgs.

    Two filters:
      - `scoped_for_user(user)` — returns rows in orgs where the user has
        ANY active OrganizationMembership. Super-user bypass returns all.
      - `module_gated(user, module_code)` — narrows further to orgs where
        the user has the given module in their effective set.
    """

    def _user_org_ids(self, user) -> Iterable:
        """Return the set of Organization UUIDs the user has any active
        membership in.
        """
        # Local import to avoid circular import.
        from apps.organizations.models import OrganizationMembership

        if not getattr(user, "is_authenticated", False):
            return []

        return list(
            OrganizationMembership.objects.filter(
                user=user, is_active=True
            ).values_list("organization_id", flat=True)
        )

    def scoped_for_user(self, user) -> models.QuerySet:
        """Filter to rows in orgs the user has any active membership in.

        Super-user bypass: returns the unmodified queryset.
        Anonymous / unauthenticated user: returns an empty queryset.
        """
        if user is None or not getattr(user, "is_authenticated", False):
            return self.none()
        if getattr(user, "is_superuser", False):
            return self
        org_ids = self._user_org_ids(user)
        return self.filter(organization_id__in=org_ids)

    def module_gated(self, user, module_code: str) -> models.QuerySet:
        """Filter to rows in orgs where the user has `module_code` enabled.

        Iterates the user's accessible org IDs and keeps only those for
        which `effective_modules(user, org)` contains the code. Hand-rolled
        loop is acceptable given small N (<= 50 orgs per user typical).

        Super-user bypass: returns the unmodified queryset.
        """
        from apps.organizations.models import Organization
        from apps.permissions.services.resolver import effective_modules

        if user is None or not getattr(user, "is_authenticated", False):
            return self.none()
        if getattr(user, "is_superuser", False):
            return self

        org_ids = self._user_org_ids(user)
        if not org_ids:
            return self.none()

        # Resolve effective_modules per org and keep those that pass.
        gated_ids: list = []
        # Fetch orgs in one query.
        org_map = {
            o.id: o for o in Organization.objects.filter(id__in=org_ids)
        }
        for org_id in org_ids:
            org = org_map.get(org_id)
            if org is None:
                continue
            if module_code in effective_modules(user, org):
                gated_ids.append(org_id)

        return self.filter(organization_id__in=gated_ids)


class ScopedManager(models.Manager.from_queryset(ScopedQuerySet)):
    """Manager that returns ScopedQuerySet.

    Use `.from_queryset(MyQS)()` to compose with a per-app QuerySet
    subclass that adds model-specific filters.
    """

    pass
