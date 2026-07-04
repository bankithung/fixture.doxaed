"""Row-level scope-filter pattern (v1Users.md Appendix B.2).

`ScopedQuerySetMixin` is the mixin every tenant-scoped QuerySet plugs
into. It exposes `.scoped_for(user)` which restricts the queryset to
Organizations where the user has any active membership. Apps that need
fine-grained module-level filtering (e.g., GameCoord assigned-tournaments
only) layer that filtering on top of this base.

We deliberately do NOT bolt onto `apps.accounts.models.User` to grab
"accessible org IDs" — that helper lives on
`OrganizationMembership.objects.user_org_ids(user)` so the membership
table owns the lookup and we don't stomp on the accounts agent's User
class.
"""
from __future__ import annotations

from django.db import models


class ScopedQuerySetMixin:
    """Mixin for tenant-scoped QuerySets.

    Concrete usage::

        class TournamentQuerySet(ScopedQuerySetMixin, models.QuerySet):
            ORG_FIELD = "organization"

    Subclasses may override `ORG_FIELD` if the FK to Organization is
    named differently (e.g., `tournament__organization` for nested
    rows).
    """

    ORG_FIELD: str = "organization"

    def scoped_for(self, user) -> models.QuerySet:  # type: ignore[type-arg]
        """Restrict the queryset to orgs the user has any active
        membership in.
        """
        # Local import to avoid model-loading cycle.
        from apps.organizations.models import OrganizationMembership

        if not getattr(user, "is_authenticated", False):
            return self.none()  # type: ignore[attr-defined]

        if getattr(user, "is_superuser", False):
            return self  # type: ignore[return-value]

        org_ids = OrganizationMembership.objects.user_org_ids(user)
        return self.filter(**{f"{self.ORG_FIELD}__in": org_ids})  # type: ignore[attr-defined]


class OrgScopedQuerySet(ScopedQuerySetMixin, models.QuerySet):
    """Convenience concrete QuerySet for cases where the row IS an
    Organization (not a child).
    """

    def scoped_for(self, user):
        from apps.organizations.models import OrganizationMembership

        if not getattr(user, "is_authenticated", False):
            return self.none()
        if getattr(user, "is_superuser", False):
            return self
        org_ids = OrganizationMembership.objects.user_org_ids(user)
        return self.filter(id__in=org_ids)
