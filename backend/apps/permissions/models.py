"""permissions models — Module catalog + MembershipModuleGrant.

v1Users.md Appendix A.2 catalogs 22 modules; the registration form
builder adds a 23rd. The catalog is loaded by `python manage.py
load_modules` from `fixtures/modules.json`.

MembershipModuleGrant is keyed on (user, organization) per the
audit fix (Appendix A.4):

  > AUDIT FIX (2026-05-02): keyed on (user, organization), NOT on
  > OrganizationMembership. The original keying caused a multi-role
  > resolver bug where a granted=False revoke was silently bypassed
  > when the user had a SECOND active role granting the same module
  > via Layer 1 union. Per-(user, org) keying ensures a single source
  > of truth for module overrides regardless of how many roles the
  > user holds in the Org.
"""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class GrantState(models.TextChoices):
    """Override-grant tri-state.

    `default` — no override; falls through to role-default modules.
                (Recommended: do not materialize default rows; treat
                the absence of any row as `default`.)
    `grant`   — explicit grant; forces module ON regardless of role-default.
    `deny`    — explicit deny; forces module OFF even if role-default
                would include it.
    """

    DEFAULT = "default", _("Default (no override)")
    GRANT = "grant", _("Grant (force on)")
    DENY = "deny", _("Deny (force off)")


class Module(models.Model):
    """One row per module in the v1Users.md Appendix A.2 catalog (22 total).

    Loaded via `python manage.py load_modules` from
    `apps/permissions/fixtures/modules.json`. The fixture is the
    source of truth; the management command upserts on `code`.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    # Stable identifier; e.g., "tournament.editor", "match.scoring_console".
    code = models.CharField(max_length=64, unique=True)

    # Human-facing label (shown in module-override matrix UI).
    name = models.CharField(max_length=200)

    description = models.TextField(blank=True)

    # Grouping for the matrix UI: e.g., "org_scoped", "tournament_scoped",
    # "match_scoped", "personal".
    category = models.CharField(max_length=64, default="", db_index=True)

    # List of MembershipRole string values that get this module by default.
    # E.g., ["admin", "co_organizer"]. Source: Appendix A.3 default role
    # → module map.
    default_for_roles = models.JSONField(default=list, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "permissions_app"
        db_table = "permissions_module"
        ordering = ["category", "code"]
        indexes = [
            models.Index(fields=["category"], name="perm_module_category_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.code}"


class MembershipModuleGrant(models.Model):
    """Per-(user, organization) module override.

    KEY DECISION: keyed on (user, organization) — NOT on
    OrganizationMembership row. A user with multi-role memberships in
    one org gets ONE override per module that applies regardless of
    which role they're acting under (Appendix A.4 audit fix).

    Resolution order (Appendix A.4):
      1. Compute base set: union of `default_for_roles` across all
         active OrganizationMembership rows for (user, org).
      2. Apply overrides:
           - state=grant → add module to set.
           - state=deny  → remove module from set.
           - state=default → no-op.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="module_grants",
    )
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="module_grants",
    )
    module = models.ForeignKey(
        Module,
        on_delete=models.PROTECT,
        related_name="grants",
    )

    state = models.CharField(
        max_length=16,
        choices=GrantState.choices,
        default=GrantState.DEFAULT,
    )

    granted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="grants_made",
    )

    # Reason supplied at grant time. Mandatory at the service layer
    # (B.17 audit trail: every override change emits one audit row
    # with the reason). The DB allows blank to avoid breaking the
    # initial migration; the service layer enforces ≥20 chars.
    reason = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "permissions_app"
        db_table = "permissions_membership_module_grant"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "organization", "module"],
                name="unique_grant_per_user_org_module",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user", "organization"],
                name="perm_grant_user_org_idx",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return (
            f"{self.user_id}/{self.organization_id}/{self.module_id}={self.state}"
        )
