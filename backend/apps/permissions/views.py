"""DRF views for the permissions app.

Endpoints:
  GET  /api/permissions/me/modules/?org={uuid}
  GET  /api/permissions/modules/
  GET  /api/permissions/orgs/{org_uuid}/users/{user_uuid}/grants/
  PUT  /api/permissions/orgs/{org_uuid}/users/{user_uuid}/grants/
  GET  /api/permissions/orgs/{slug}/me/modules/             (slug alias)
  GET  /api/permissions/orgs/{slug}/users/{user_uuid}/grants/   (slug alias)
  PUT  /api/permissions/orgs/{slug}/users/{user_uuid}/grants/   (slug alias)
  GET  /api/permissions/orgs/{slug}/grants/matrix/          (B.16 aggregate)

The two `/orgs/{org_uuid}/users/{user_uuid}/grants/` endpoints are
admin-only — gated by HasModule("org.member_directory") since that's
the canonical "manage memberships" surface in v1Users.md.
"""
from __future__ import annotations

import uuid

from django.http import Http404
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.organizations.permissions import IsOrgAdminOrOwner
from apps.permissions.models import Module
from apps.permissions.permissions import HasModule  # noqa: F401  (kept for back-compat / external imports)
from apps.permissions.serializers import (
    BulkGrantsCellsSerializer,
    BulkGrantsSerializer,
    EffectiveModulesSerializer,
    GrantRowSerializer,
    MatrixResponseSerializer,
    ModuleSerializer,
)
from apps.permissions.services.grants import (
    GrantValidationError,
    bulk_set_grants,
)
from apps.permissions.services.matrix import build_matrix
from apps.permissions.services.resolver import effective_modules


def _resolve_org_by_slug_or_uuid(value: str):
    """Resolve an Organization by slug or UUID string. Returns None if missing.

    Honours soft-delete (rows with `deleted_at` set are treated as 404).
    Local helper — mirrors the convention in
    `apps.organizations.views._resolve_org` but allows either form.
    """
    from apps.organizations.models import Organization

    if value is None:
        return None
    try:
        as_uuid = uuid.UUID(str(value))
    except (ValueError, TypeError):
        as_uuid = None

    if as_uuid is not None:
        return Organization.objects.filter(
            id=as_uuid, deleted_at__isnull=True
        ).first()
    return Organization.objects.filter(
        slug=value, deleted_at__isnull=True
    ).first()


class ModuleCatalogView(generics.ListAPIView):
    """GET /api/permissions/modules/ — lists all modules.

    Auth required. Used by the frontend module-override matrix UI.
    """

    queryset = Module.objects.all().order_by("category", "code")
    serializer_class = ModuleSerializer
    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses=ModuleSerializer(many=True),
        description="List all modules in the catalog.",
    )
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)


class MyEffectiveModulesView(APIView):
    """GET /api/permissions/me/modules/?org={uuid}

    Returns the requesting user's effective module set in the given Org.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="org",
                description="Organization UUID",
                required=True,
                type=str,
            ),
        ],
        responses={200: EffectiveModulesSerializer},
        description="Return the effective module set for the requesting user in the given Org.",
    )
    def get(self, request):
        from apps.organizations.models import Organization

        org_id = request.query_params.get("org")
        if not org_id:
            return Response(
                {"detail": "Missing required query param: org"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            org_uuid = uuid.UUID(org_id)
        except (ValueError, TypeError):
            return Response(
                {"detail": "Invalid org UUID."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        org = Organization.objects.filter(id=org_uuid).first()
        if org is None:
            return Response(
                {"detail": "Organization not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        modules = sorted(effective_modules(request.user, org))
        return Response({"modules": modules})


class UserGrantsView(APIView):
    """GET / PUT /api/permissions/orgs/{org_uuid}/users/{user_uuid}/grants/

    Admin-only. v1Users.md §2 (line 736 / line 815) reserves the
    override-grant verb to Admin in v1.0 — Co-organizer / Game-coordinator
    / Match-scorer / Referee / Team-manager all have the Member Directory
    module by default but cannot manage other users' module overrides.
    Hence we gate on role (`IsOrgAdminOrOwner`), not on
    `HasModule("org.member_directory")`.
    """

    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    def get_organization(self):
        from apps.organizations.models import Organization

        org_uuid = self.kwargs.get("org_uuid")
        try:
            return Organization.objects.filter(id=uuid.UUID(str(org_uuid))).first()
        except (ValueError, TypeError):
            return None

    def get_target_user(self):
        from apps.accounts.models import User

        user_uuid = self.kwargs.get("user_uuid")
        return get_object_or_404(User, id=uuid.UUID(str(user_uuid)))

    @extend_schema(
        responses={200: GrantRowSerializer(many=True)},
        description="List all grant rows + computed default-on modules for a user in an org.",
    )
    def get(self, request, org_uuid, user_uuid):
        from apps.permissions.models import MembershipModuleGrant

        org = self.get_organization()
        if org is None:
            return Response(
                {"detail": "Organization not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        target_user = self.get_target_user()

        rows = (
            MembershipModuleGrant.objects.filter(
                user=target_user, organization=org
            )
            .select_related("module")
            .order_by("module__category", "module__code")
        )
        serialized = GrantRowSerializer(rows, many=True).data

        effective = sorted(effective_modules(target_user, org))

        return Response(
            {
                "grants": serialized,
                "effective_modules": effective,
            }
        )

    @extend_schema(
        request=BulkGrantsSerializer,
        responses={200: GrantRowSerializer(many=True)},
        description=(
            "Replace grants atomically. Accepts EITHER "
            "`{grants: [{module, state}], reason}` (existing shape) OR "
            "`{cells: {module_code: state}, reason, event_id?}` (SPA matrix shape). "
            "If both keys are present, `cells` wins."
        ),
    )
    def put(self, request, org_uuid, user_uuid):
        org = self.get_organization()
        if org is None:
            return Response(
                {"detail": "Organization not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        target_user = self.get_target_user()

        # Accept both shapes. Frontend matrix UI sends `cells`; the
        # existing per-user grants UI sends `grants`.
        if isinstance(request.data, dict) and "cells" in request.data:
            ser = BulkGrantsCellsSerializer(data=request.data)
            ser.is_valid(raise_exception=True)
            payload = ser.validated_data
            grants_pairs = [
                (code, state) for code, state in payload["cells"].items()
            ]
            reason = payload["reason"]
        else:
            ser = BulkGrantsSerializer(data=request.data)
            ser.is_valid(raise_exception=True)
            payload = ser.validated_data
            grants_pairs = [
                (g["module"], g["state"]) for g in payload["grants"]
            ]
            reason = payload["reason"]

        try:
            bulk_set_grants(
                user=target_user,
                organization=org,
                grants=grants_pairs,
                granted_by=request.user,
                reason=reason,
                request=request,
            )
        except GrantValidationError as exc:
            return Response(
                {"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST
            )

        # Return the resulting grant set + new effective modules.
        from apps.permissions.models import MembershipModuleGrant

        rows = (
            MembershipModuleGrant.objects.filter(
                user=target_user, organization=org
            )
            .select_related("module")
            .order_by("module__category", "module__code")
        )
        return Response(
            {
                "grants": GrantRowSerializer(rows, many=True).data,
                "effective_modules": sorted(
                    effective_modules(target_user, org)
                ),
            }
        )


# ---------------------------------------------------------------------------
# Slug-routed aliases (Appendix B.16 — frontend-friendly URLs)
# ---------------------------------------------------------------------------


class MyModulesBySlugView(APIView):
    """GET /api/permissions/orgs/{slug}/me/modules/

    Slug alias for `MyEffectiveModulesView`. Same auth (`IsAuthenticated`)
    and same response shape; the org context is taken from the URL path
    instead of a query string.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses={200: EffectiveModulesSerializer},
        description=(
            "Slug-routed alias of /me/modules/?org=<uuid>. "
            "Returns effective module set for the authenticated user "
            "in the org identified by slug."
        ),
    )
    def get(self, request, slug):
        org = _resolve_org_by_slug_or_uuid(slug)
        if org is None:
            raise Http404("Organization not found.")
        modules = sorted(effective_modules(request.user, org))
        return Response({"modules": modules})


class UserGrantsBySlugView(UserGrantsView):
    """GET / PUT /api/permissions/orgs/{slug}/users/{user_uuid}/grants/

    Slug alias for `UserGrantsView`. Inherits all GET/PUT behavior; only
    overrides `get_organization` to resolve from the slug path kwarg.
    The HasModule("org.member_directory") gate still applies.
    """

    def get_organization(self):
        slug = self.kwargs.get("slug")
        org = _resolve_org_by_slug_or_uuid(slug)
        if org is None:
            return None
        return org

    # Pass-through wrappers so URL routing's slug kwarg matches the
    # method signatures of the parent class (which expect `org_uuid`).
    @extend_schema(
        responses={200: GrantRowSerializer(many=True)},
        description="Slug-routed alias for GET /grants/ — same response shape.",
    )
    def get(self, request, slug, user_uuid):
        return super().get(request, org_uuid=slug, user_uuid=user_uuid)

    @extend_schema(
        request=BulkGrantsSerializer,
        responses={200: GrantRowSerializer(many=True)},
        description=(
            "Slug-routed alias for PUT /grants/. Accepts EITHER the "
            "`{grants: [{module, state}], reason}` shape or the SPA matrix "
            "`{cells: {module: state}, reason, event_id?}` shape."
        ),
    )
    def put(self, request, slug, user_uuid):
        return super().put(request, org_uuid=slug, user_uuid=user_uuid)


class MatrixView(APIView):
    """GET /api/permissions/orgs/{slug}/grants/matrix/

    Aggregate per-member × per-module override matrix for the SPA's
    Module Override Matrix UI (Appendix B.16).

    Admin-only. v1Users.md §2 reserves override-grant management to
    Admin (line 736: "the override-grant verb is reserved to Admin in
    v1.0"). Even though Co-organizer and Game-coordinator have the
    Member Directory module by default for read access, they cannot
    view or mutate the per-user override matrix. Hence we gate on
    `IsOrgAdminOrOwner`, not on `HasModule("org.member_directory")`.
    """

    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    def get_organization(self):
        slug = self.kwargs.get("slug")
        return _resolve_org_by_slug_or_uuid(slug)

    @extend_schema(
        responses={200: MatrixResponseSerializer},
        description=(
            "Aggregate override matrix: for every active member in the org, "
            "list each module's role-default truth and explicit override state."
        ),
    )
    def get(self, request, slug):
        org = self.get_organization()
        if org is None:
            raise Http404("Organization not found.")
        return Response(build_matrix(org))
