"""DRF views for the organizations app.

AIP-136 colon-syntax verbs (`POST /api/orgs/{uuid}:suspend/` etc.) are
routed by `urls.py` to the per-verb action methods here. Each verb
delegates to the service layer (no business logic in views).
"""
from __future__ import annotations

import uuid as _uuid
from typing import Any

from django.contrib.auth import login
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import (
    PermissionDenied as DjangoPermissionDenied,
    ValidationError as DjangoValidationError,
)
from django.http import Http404
from django.utils import timezone
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import (
    NotAuthenticated,
    PermissionDenied,
    ValidationError as DRFValidationError,
)
from rest_framework.generics import GenericAPIView, ListAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User

from apps.organizations.models import (
    AdminInvitation,
    InviteStatus,
    MembershipRole,
    Organization,
    OrganizationMembership,
)
from apps.organizations.permissions import (
    IsOrgAdminOrOwner,
    IsOrgMember,
    IsOrgOwner,
    IsSuperUser,
)
from apps.permissions.permissions import HasModule
from apps.organizations.serializers import (
    AcceptInvitationSerializer,
    AdminInvitationCreateSerializer,
    AdminInvitationSerializer,
    ArchiveSerializer,
    ChangeSlugSerializer,
    OrganizationCreateSerializer,
    OrganizationMembershipSerializer,
    OrganizationSerializer,
    OrganizationUpdateSerializer,
    OrgMemberDetailSerializer,
    RevokeInvitationSerializer,
    SuspendSerializer,
    TransferOwnershipSerializer,
)
from apps.organizations.services import invitation as invitation_svc
from apps.organizations.services import lifecycle as lifecycle_svc
from apps.organizations.services import ownership as ownership_svc
from apps.organizations.services import slug as slug_svc


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_uuid(value: str) -> bool:
    try:
        _uuid.UUID(str(value))
        return True
    except (ValueError, TypeError):
        return False


def _drf_raise(exc: DjangoValidationError) -> None:
    msgs = exc.messages if hasattr(exc, "messages") else [str(exc)]
    raise DRFValidationError(detail=msgs)


def _resolve_org(uuid_value) -> Organization:
    if not _is_uuid(uuid_value):
        raise DRFValidationError("Expected a UUID.")
    return get_object_or_404(Organization, pk=uuid_value, deleted_at__isnull=True)


def _resolve_org_by_slug_or_uuid(value) -> Organization:
    """Lookup an Organization by either its UUID or its slug.

    Used by the slug-routed alias endpoints. UUID is tried first so that
    a slug-shaped value that happens to be a valid UUID still resolves
    correctly. ``deleted_at`` rows are skipped. Raises ``Http404`` when
    neither match — DRF translates that into a 404 response.
    """
    if _is_uuid(value):
        org = Organization.objects.filter(
            pk=value, deleted_at__isnull=True
        ).first()
        if org is not None:
            return org
    org = Organization.objects.filter(
        slug=str(value).lower(), deleted_at__isnull=True
    ).first()
    if org is not None:
        return org
    raise Http404("Organization not found.")


# ---------------------------------------------------------------------------
# Org list / create / retrieve / update
# ---------------------------------------------------------------------------


class OrgListCreateView(GenericAPIView):
    """GET: list orgs the user has any active membership in.
    POST: super-admin only — create a new Organization in pending_review.
    """

    permission_classes = [IsAuthenticated]

    def get_serializer_class(self):
        if self.request.method == "POST":
            return OrganizationCreateSerializer
        return OrganizationSerializer

    @extend_schema(responses=OrganizationSerializer(many=True))
    def get(self, request):
        if request.user.is_superuser:
            qs = Organization.active_objects.all()
        else:
            org_ids = OrganizationMembership.objects.user_org_ids(request.user)
            qs = Organization.active_objects.filter(id__in=list(org_ids))
        return Response(OrganizationSerializer(qs, many=True).data)

    @extend_schema(
        request=OrganizationCreateSerializer,
        responses={201: OrganizationSerializer},
    )
    def post(self, request):
        if not request.user.is_superuser:
            raise PermissionDenied("Only super-admins can create organizations.")
        ser = OrganizationCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            org = lifecycle_svc.create_organization(
                slug=ser.validated_data["slug"],
                name=ser.validated_data["name"],
                created_by=request.user,
                time_zone=ser.validated_data.get("time_zone", "Asia/Kolkata"),
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(
            OrganizationSerializer(org).data, status=status.HTTP_201_CREATED
        )


class OrgDetailView(APIView):
    """GET / PATCH on /api/orgs/{slug_or_uuid}/.

    On GET with a slug match in `SlugRedirect`, returns a 301 with
    Location pointing at the canonical /api/orgs/{uuid}/.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(responses=OrganizationSerializer)
    def get(self, request, slug_or_uuid: str):
        if _is_uuid(slug_or_uuid):
            org = get_object_or_404(
                Organization, pk=slug_or_uuid, deleted_at__isnull=True
            )
        else:
            current, redirect_target = slug_svc.resolve_slug(slug_or_uuid)
            if current is not None:
                org = current
            elif redirect_target is not None:
                resp = Response(status=status.HTTP_301_MOVED_PERMANENTLY)
                resp["Location"] = f"/api/orgs/{redirect_target.id}/"
                return resp
            else:
                return Response(status=status.HTTP_404_NOT_FOUND)
        # Authorization: user must be a member or super-admin.
        if not request.user.is_superuser:
            if not OrganizationMembership.objects.filter(
                user=request.user, organization=org, is_active=True
            ).exists():
                raise PermissionDenied("Not a member of this organization.")
        return Response(OrganizationSerializer(org).data)

    @extend_schema(
        request=OrganizationUpdateSerializer,
        responses=OrganizationSerializer,
    )
    def patch(self, request, slug_or_uuid: str):
        if not _is_uuid(slug_or_uuid):
            raise DRFValidationError("PATCH requires a UUID, not a slug.")
        org = _resolve_org(slug_or_uuid)
        # Admin/owner or super-admin only.
        if not request.user.is_superuser:
            if not OrganizationMembership.objects.filter(
                user=request.user,
                organization=org,
                is_active=True,
                role=MembershipRole.ADMIN,
            ).exists():
                raise PermissionDenied("Admin role required.")
        ser = OrganizationUpdateSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        update_fields = []
        for field in ("name", "time_zone"):
            if field in ser.validated_data:
                setattr(org, field, ser.validated_data[field])
                update_fields.append(field)
        if update_fields:
            org.save(update_fields=update_fields)
        return Response(OrganizationSerializer(org).data)


# ---------------------------------------------------------------------------
# Verbs (AIP-136 colon syntax)
# ---------------------------------------------------------------------------


class OrgChangeSlugView(APIView):
    """POST /api/orgs/{uuid}:change_slug/"""

    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    @extend_schema(request=ChangeSlugSerializer, responses=OrganizationSerializer)
    def post(self, request, uuid):
        org = _resolve_org(uuid)
        ser = ChangeSlugSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            org = slug_svc.change_slug(
                org=org,
                new_slug=ser.validated_data["new_slug"],
                changed_by=request.user,
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(OrganizationSerializer(org).data)


class OrgSuspendView(APIView):
    permission_classes = [IsAuthenticated, IsSuperUser]

    @extend_schema(request=SuspendSerializer, responses=OrganizationSerializer)
    def post(self, request, uuid):
        org = _resolve_org(uuid)
        ser = SuspendSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            org = lifecycle_svc.suspend_org(
                org=org,
                suspended_by=request.user,
                reason=ser.validated_data["reason"],
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(OrganizationSerializer(org).data)


class OrgUnsuspendView(APIView):
    permission_classes = [IsAuthenticated, IsSuperUser]
    serializer_class = OrganizationSerializer  # for drf-spectacular auto-detection

    @extend_schema(request=None, responses=OrganizationSerializer)
    def post(self, request, uuid):
        org = _resolve_org(uuid)
        try:
            org = lifecycle_svc.unsuspend_org(
                org=org, unsuspended_by=request.user, request=request
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(OrganizationSerializer(org).data)


class OrgArchiveView(APIView):
    """Owner or super-admin only."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=ArchiveSerializer, responses=OrganizationSerializer)
    def post(self, request, uuid):
        org = _resolve_org(uuid)
        if not request.user.is_superuser:
            is_owner = OrganizationMembership.objects.filter(
                user=request.user,
                organization=org,
                is_active=True,
                role=MembershipRole.ADMIN,
                is_org_owner=True,
            ).exists()
            if not is_owner:
                raise PermissionDenied("Only the org owner or super-admin can archive.")
        ser = ArchiveSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            org = lifecycle_svc.archive_org(
                org=org,
                archived_by=request.user,
                reason=ser.validated_data["reason"],
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(OrganizationSerializer(org).data)


class OrgTransferOwnershipView(APIView):
    """Current owner only. Atomic swap."""

    permission_classes = [IsAuthenticated, IsOrgOwner]

    @extend_schema(request=TransferOwnershipSerializer, responses=OrganizationSerializer)
    def post(self, request, uuid):
        org = _resolve_org(uuid)
        ser = TransferOwnershipSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        new_owner = get_object_or_404(
            User, pk=ser.validated_data["new_owner_user_id"]
        )
        try:
            ownership_svc.transfer_ownership(
                org=org,
                current_owner_user=request.user,
                new_owner_user=new_owner,
                requested_by=request.user,
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(OrganizationSerializer(org).data)


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


class OrgMembersListView(ListAPIView):
    """Module-gated by `org.member_directory` — defaults to admin /
    co_organizer / game_coordinator per the v1Users.md catalog. A
    per-user `MembershipModuleGrant` deny override revokes access even
    for those role defaults.
    """

    serializer_class = OrganizationMembershipSerializer
    permission_classes = [IsAuthenticated, HasModule("org.member_directory")]

    def get_organization(self):
        return _resolve_org(self.kwargs["uuid"])

    def get_queryset(self):
        return OrganizationMembership.objects.filter(
            organization=self.get_organization(), is_active=True
        )


class OrgMemberRemoveView(APIView):
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    @extend_schema(responses={204: OpenApiResponse(description="Removed")})
    def delete(self, request, uuid, membership_id):
        org = _resolve_org(uuid)
        membership = get_object_or_404(
            OrganizationMembership, pk=membership_id, organization=org
        )
        from django.utils import timezone as _tz

        from apps.audit.models import ActorRole
        from apps.audit.services import emit_audit

        if membership.is_org_owner:
            raise PermissionDenied("Cannot remove the org owner directly. Transfer ownership first.")

        if membership.is_active:
            membership.is_active = False
            membership.removed_at = _tz.now()
            membership.save(update_fields=["is_active", "removed_at"])
            emit_audit(
                actor_user=request.user,
                actor_role=ActorRole.ADMIN,
                event_type="member_role_revoked",
                target_type="organization_membership",
                target_id=membership.id,
                payload_after={"is_active": False},
                organization_id=org.id,
                request=request,
            )
            # A removed member must lose module access NOW, not at cache TTL.
            from django.db import transaction

            from apps.permissions.services.resolver import invalidate_cache

            uid, oid = membership.user_id, org.id
            transaction.on_commit(lambda: invalidate_cache(uid, oid))
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Invitations
# ---------------------------------------------------------------------------


class OrgInvitationsView(APIView):
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    @extend_schema(responses=AdminInvitationSerializer(many=True))
    def get(self, request, uuid):
        org = _resolve_org(uuid)
        qs = AdminInvitation.objects.filter(organization=org).order_by("-created_at")
        return Response(AdminInvitationSerializer(qs, many=True).data)

    @extend_schema(
        request=AdminInvitationCreateSerializer, responses=AdminInvitationSerializer
    )
    def post(self, request, uuid):
        org = _resolve_org(uuid)
        ser = AdminInvitationCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            inv, _plaintext = invitation_svc.create_invitation(
                org=org,
                email=ser.validated_data["email"],
                role=ser.validated_data["role"],
                invited_by=request.user,
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(
            AdminInvitationSerializer(inv).data, status=status.HTTP_201_CREATED
        )


class OrgInvitationRevokeView(APIView):
    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    @extend_schema(request=RevokeInvitationSerializer, responses=AdminInvitationSerializer)
    def post(self, request, uuid, invitation_id):
        org = _resolve_org(uuid)
        inv = get_object_or_404(
            AdminInvitation, pk=invitation_id, organization=org
        )
        ser = RevokeInvitationSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            inv = invitation_svc.revoke_invitation(
                invitation=inv,
                revoked_by=request.user,
                reason=ser.validated_data.get("reason", ""),
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(AdminInvitationSerializer(inv).data)


class InvitationAcceptView(APIView):
    """POST /api/invitations:accept/

    AllowAny: a logged-out invitee can accept. If the invite's email has no
    account, one is created inline (password required); the email is taken from
    the signed invite, NEVER the request body (account-takeover guard). If an
    active account already exists, respond 401 `login_required`.
    """

    permission_classes = [AllowAny]

    @extend_schema(request=AcceptInvitationSerializer, responses=None)
    def post(self, request):
        ser = AcceptInvitationSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        token = ser.validated_data["token"]

        invite = invitation_svc.get_invitation_by_token(token)
        if invite is None or invite.status != InviteStatus.PENDING:
            raise DRFValidationError({"detail": "invalid_or_used_invitation"})

        user = request.user if request.user.is_authenticated else None
        if user is None:
            existing = User.objects.filter(email=invite.email).first()
            if existing is not None and existing.is_active:
                return Response(
                    {"detail": "login_required", "email": invite.email},
                    status=status.HTTP_401_UNAUTHORIZED,
                )
            password = ser.validated_data.get("password")
            if existing is not None and not existing.is_active:
                # Pre-existing (unverified) account: the invite token proves
                # email ownership, so activate + mark verified — but NEVER reset
                # the password. Invite-acceptance must not double as a password
                # reset (security review HIGH); a body-supplied password is
                # ignored for pre-existing accounts. Lost passwords go through
                # the dedicated password-reset flow.
                user = existing
                user.is_active = True
                if user.email_verified_at is None:
                    user.email_verified_at = timezone.now()
                user.save(update_fields=["is_active", "email_verified_at"])
            else:
                if not password:
                    return Response(
                        {"detail": "password_required"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                try:
                    validate_password(password)
                except DjangoValidationError as exc:
                    raise DRFValidationError({"password": list(exc.messages)})
                user = User.objects.create_user(
                    email=invite.email,  # from the invite, NEVER the request body
                    password=password,
                    name=ser.validated_data.get("name", ""),
                    is_active=True,
                )
                user.email_verified_at = timezone.now()
                user.save(update_fields=["email_verified_at"])
            login(request, user, backend="django.contrib.auth.backends.ModelBackend")
        else:
            # Authenticated accept: the invitation is bound to a specific email.
            # Refuse to bind it to a DIFFERENT signed-in account — otherwise
            # whoever happens to be logged in on the device silently consumes the
            # invite as the wrong person and the real invitee never gets in (the
            # logged-out path already forces the identity to invite.email; this
            # closes the same gap for the logged-in path). Surface both emails so
            # the SPA can offer a "switch account" path. Mirrors the by-id
            # accept's email-ownership guard.
            if (user.email or "").strip().lower() != (
                invite.email or ""
            ).strip().lower():
                return Response(
                    {
                        "detail": "email_mismatch",
                        "invited_email": invite.email,
                        "current_email": user.email,
                    },
                    status=status.HTTP_409_CONFLICT,
                )

        try:
            membership = invitation_svc.accept_invitation(
                token_plaintext=token,
                accepting_user=user,
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)

        org_slug = getattr(getattr(membership, "organization", None), "slug", None)
        if org_slug is None and invite.tournament_id:
            org_slug = invite.tournament.organization.slug
        return Response(
            {
                "org_slug": org_slug,
                "tournament_id": str(invite.tournament_id) if invite.tournament_id else None,
            },
            status=status.HTTP_200_OK,
        )


# ---------------------------------------------------------------------------
# In-app invitations inbox (the logged-in invitee's view)
# ---------------------------------------------------------------------------


class MyInvitationsView(APIView):
    """GET /api/invitations/

    Returns ALL invitations addressed to the signed-in user's email
    (case-insensitive), enriched for the inbox UI: actionable PENDING ones
    first (newest first), then the history (accepted / declined / revoked /
    expired). A PENDING invite past its expiry is reported as ``expired``
    (effective status — the DB row is materialized lazily on accept).
    Tournament-scoped invites carry a ``tournament_id`` + ``tournament_name``;
    org-level invites have both null.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(responses=None)
    def get(self, request):
        email = (request.user.email or "").strip().lower()
        if not email:
            return Response([])
        now = timezone.now()
        qs = (
            AdminInvitation.objects.filter(email__iexact=email)
            .select_related("organization", "tournament", "invited_by")
            .order_by("-created_at")
        )

        def effective_status(inv) -> str:
            if inv.status == InviteStatus.PENDING and inv.expires_at <= now:
                return InviteStatus.EXPIRED
            return inv.status

        data = [
            {
                "id": str(inv.id),
                "email": inv.email,
                "role": inv.role,
                "status": effective_status(inv),
                "organization_name": inv.organization.name,
                "tournament_id": (
                    str(inv.tournament_id) if inv.tournament_id else None
                ),
                "tournament_name": (
                    inv.tournament.name if inv.tournament_id else None
                ),
                "invited_by_email": (
                    inv.invited_by.email if inv.invited_by_id else None
                ),
                "expires_at": inv.expires_at,
                "created_at": inv.created_at,
            }
            for inv in qs
        ]
        # Actionable invites first; both groups newest-first (qs order is
        # stable through the sort).
        data.sort(key=lambda row: row["status"] != InviteStatus.PENDING)
        return Response(data)


class InvitationAcceptByIdView(APIView):
    """POST /api/invitations/{uuid}:accept/

    In-app accept by invitation id. The signed-in user proves ownership by
    matching the invite email. Wrong email → 403; already-accepted / expired /
    declined / revoked → 400.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses=None)
    def post(self, request, invitation_id):
        try:
            membership = invitation_svc.accept_invitation_by_id(
                invitation_id=invitation_id,
                accepting_user=request.user,
                request=request,
            )
        except DjangoPermissionDenied as exc:
            raise PermissionDenied(str(exc) or "Forbidden")
        except DjangoValidationError as exc:
            msgs = exc.messages if hasattr(exc, "messages") else [str(exc)]
            if "invitation_not_found" in msgs:
                raise Http404("Invitation not found.")
            _drf_raise(exc)

        tournament_id = getattr(membership, "tournament_id", None)
        body = {
            "membership_id": str(membership.id),
            "role": membership.role,
            "status": "accepted",
        }
        if tournament_id is not None:
            body["tournament_id"] = str(tournament_id)
        return Response(body, status=status.HTTP_200_OK)


class InvitationDeclineView(APIView):
    """POST /api/invitations/{uuid}:decline/

    In-app decline by invitation id. Email-ownership enforced (403). Only a
    PENDING invitation may be declined; otherwise 400.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses=None)
    def post(self, request, invitation_id):
        try:
            invitation_svc.decline_invitation(
                invitation_id=invitation_id,
                declining_user=request.user,
                request=request,
            )
        except DjangoPermissionDenied as exc:
            raise PermissionDenied(str(exc) or "Forbidden")
        except DjangoValidationError as exc:
            msgs = exc.messages if hasattr(exc, "messages") else [str(exc)]
            if "invitation_not_found" in msgs:
                raise Http404("Invitation not found.")
            _drf_raise(exc)
        return Response({"status": "declined"}, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Slug-routed aliases (frontend SPA expects these)
# ---------------------------------------------------------------------------
#
# These views proxy to the same service-layer logic the UUID-based views
# use. Slug→UUID resolution is the only addition. UUID-based endpoints
# remain canonical (back-compat for AIP-136 colon verbs).
#
# Permission classes here are the canonical `IsOrgAdminOrOwner` /
# `IsOrgOwner` from `apps/organizations/permissions.py` — that module's
# `_resolve_org_from_view` is now slug-aware (UUID detection branch),
# so the same class works for both UUID and slug routes.


class OrgMembersBySlugView(APIView):
    """GET /api/orgs/{slug}/members/

    Returns one row per user (not per membership). Multiple membership
    rows for the same user (e.g. admin + co_organizer) are collapsed:
    ``roles`` is the distinct list, ``joined_at`` is MIN(created_at),
    ``is_org_owner`` is OR across the user's rows.
    """

    permission_classes = [IsAuthenticated, HasModule("org.member_directory")]

    def get_organization(self):
        return _resolve_org_by_slug_or_uuid(self.kwargs["slug"])

    @extend_schema(responses=OrgMemberDetailSerializer(many=True))
    def get(self, request, slug: str):
        org = self.get_organization()
        rows = (
            OrganizationMembership.objects.filter(
                organization=org, is_active=True
            )
            .select_related("user")
            .order_by("created_at")
        )
        # Aggregate by user_id.
        agg: dict[Any, dict[str, Any]] = {}
        for r in rows:
            entry = agg.get(r.user_id)
            if entry is None:
                agg[r.user_id] = {
                    "id": r.id,
                    "user_id": r.user_id,
                    "email": r.user.email,
                    "full_name": getattr(r.user, "name", "") or "",
                    "roles": [r.role],
                    "is_org_owner": bool(r.is_org_owner),
                    "joined_at": r.created_at,
                    "is_active": True,
                }
            else:
                if r.role not in entry["roles"]:
                    entry["roles"].append(r.role)
                if r.is_org_owner:
                    entry["is_org_owner"] = True
                if r.created_at < entry["joined_at"]:
                    entry["joined_at"] = r.created_at
        data = list(agg.values())
        return Response(OrgMemberDetailSerializer(data, many=True).data)


class OrgInvitationsBySlugView(APIView):
    """GET / POST /api/orgs/{slug}/invitations/"""

    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    def get_organization(self):
        return _resolve_org_by_slug_or_uuid(self.kwargs["slug"])

    @extend_schema(responses=AdminInvitationSerializer(many=True))
    def get(self, request, slug: str):
        org = self.get_organization()
        qs = AdminInvitation.objects.filter(organization=org).order_by("-created_at")
        return Response(AdminInvitationSerializer(qs, many=True).data)

    @extend_schema(
        request=AdminInvitationCreateSerializer, responses=AdminInvitationSerializer
    )
    def post(self, request, slug: str):
        org = self.get_organization()
        ser = AdminInvitationCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            inv, _plaintext = invitation_svc.create_invitation(
                org=org,
                email=ser.validated_data["email"],
                role=ser.validated_data.get("role"),
                roles=ser.validated_data.get("roles"),
                invited_by=request.user,
                request=request,
                event_id=ser.validated_data.get("event_id"),
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(
            AdminInvitationSerializer(inv).data, status=status.HTTP_201_CREATED
        )


class OrgInvitationByIdSlugView(APIView):
    """DELETE /api/orgs/{slug}/invitations/{invitation_id}/

    Plain DELETE = revoke. Mirrors the AIP-136
    ``{uuid}/invitations/{id}:revoke/`` colon verb but uses the simpler
    REST shape the SPA expects.
    """

    permission_classes = [IsAuthenticated, IsOrgAdminOrOwner]

    def get_organization(self):
        return _resolve_org_by_slug_or_uuid(self.kwargs["slug"])

    @extend_schema(responses={204: OpenApiResponse(description="Revoked")})
    def delete(self, request, slug: str, invitation_id):
        org = self.get_organization()
        inv = get_object_or_404(
            AdminInvitation, pk=invitation_id, organization=org
        )
        try:
            invitation_svc.revoke_invitation(
                invitation=inv,
                revoked_by=request.user,
                reason="",
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(status=status.HTTP_204_NO_CONTENT)


class InvitationAcceptByPathView(InvitationAcceptView):
    """POST /api/orgs/invitations/accept/

    Path alias of ``/api/invitations:accept/``. Same body, same logic.
    """


class OwnershipTransferBySlugView(APIView):
    """POST /api/orgs/{slug}/ownership/transfer/

    Slug-routed proxy of the AIP-136
    ``{uuid}:transfer_ownership/`` colon verb.
    """

    permission_classes = [IsAuthenticated, IsOrgOwner]

    def get_organization(self):
        return _resolve_org_by_slug_or_uuid(self.kwargs["slug"])

    @extend_schema(
        request=TransferOwnershipSerializer, responses=OrganizationSerializer
    )
    def post(self, request, slug: str):
        org = self.get_organization()
        ser = TransferOwnershipSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        new_owner = get_object_or_404(
            User, pk=ser.validated_data["new_owner_user_id"]
        )
        try:
            ownership_svc.transfer_ownership(
                org=org,
                current_owner_user=request.user,
                new_owner_user=new_owner,
                requested_by=request.user,
                request=request,
            )
        except DjangoValidationError as exc:
            _drf_raise(exc)
        return Response(OrganizationSerializer(org).data)
