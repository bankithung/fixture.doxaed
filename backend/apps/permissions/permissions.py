"""DRF permission classes — module-gated access.

Usage:

    from apps.permissions.permissions import HasModule

    class TournamentEditView(generics.UpdateAPIView):
        permission_classes = [IsAuthenticated, HasModule("tournament.editor")]

        def get_organization(self):
            # Tell HasModule which org context to check against.
            return Tournament.objects.get(pk=self.kwargs["pk"]).organization

`HasModule(module_code)` returns a permission CLASS (not instance) so
DRF's `permission_classes = [...]` machinery can instantiate it.

The view can expose a `get_organization()` hook OR set
`view.organization` (or pass it via `view.kwargs["org_uuid"]`). The
permission class tries each path in turn.
"""
from __future__ import annotations

import uuid

from rest_framework.permissions import BasePermission

from apps.permissions.services.resolver import has_module


def HasModule(module_code: str):
    """Class factory: returns a BasePermission subclass bound to module_code."""

    class _HasModuleImpl(BasePermission):
        message = f"User lacks required module: {module_code}"

        def __init__(self):
            self.module_code = module_code

        def has_permission(self, request, view) -> bool:
            user = getattr(request, "user", None)
            if user is None or not getattr(user, "is_authenticated", False):
                return False
            if getattr(user, "is_superuser", False):
                return True

            org = self._resolve_organization(request, view)
            if org is None:
                return False

            return has_module(user, org, module_code)

        def _resolve_organization(self, request, view):
            """Best-effort resolution of the org context for this request.

            In order:
              1. view.get_organization() — preferred explicit hook
              2. view.organization
              3. view.kwargs['org_uuid']  → load Organization
              4. request.org_context (set by middleware, if any)
            """
            if hasattr(view, "get_organization"):
                try:
                    return view.get_organization()
                except Exception:
                    return None

            if hasattr(view, "organization") and view.organization is not None:
                return view.organization

            kwargs = getattr(view, "kwargs", {}) or {}
            org_uuid = kwargs.get("org_uuid") or kwargs.get("organization_uuid")
            if org_uuid:
                try:
                    from apps.organizations.models import Organization

                    return Organization.objects.filter(id=uuid.UUID(str(org_uuid))).first()
                except (ValueError, TypeError):
                    return None

            return getattr(request, "org_context", None)

    _HasModuleImpl.__name__ = f"HasModule_{module_code.replace('.', '_')}"
    return _HasModuleImpl
