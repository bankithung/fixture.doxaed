"""permissions app — RBAC modules + per-user override grants.

App label is `permissions_app` (NOT `permissions`) to avoid collision
with `django.contrib.auth`'s built-in `permissions` app label. All
internal references that need an app label (Meta.app_label, migration
dependencies) MUST use `permissions_app`.

Implements:
  - Module catalog (23 modules — Appendix A.2 of v1Users.md + the
    registration form builder).
  - MembershipModuleGrant — per-(user, organization) override row
    keyed on (user, org), NOT on OrganizationMembership.
  - effective_modules(user, organization) resolver — multi-role
    union + override layer (Appendix A.4).
  - ScopedQuerySet / ScopedManager scope-filter pattern (Appendix B.2).
  - DRF endpoints + HasModule permission class.
"""

default_app_config = "apps.permissions.apps.PermissionsConfig"
