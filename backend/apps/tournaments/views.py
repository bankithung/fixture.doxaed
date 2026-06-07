from __future__ import annotations

from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.organizations.services.invitation import create_invitation
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments
from apps.tournaments.serializers import (
    TournamentCreateSerializer,
    TournamentInvitationCreateSerializer,
    TournamentMembershipSerializer,
    TournamentMembershipUpdateSerializer,
    TournamentSerializer,
)
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.rules import (
    can_edit_rules,
    merge_rules,
    update_settings,
)


class TournamentListCreateView(GenericAPIView):
    """`GET` — tournaments the user can access (isolation-scoped).
    `POST` — self-serve create; auto-provisions a workspace.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = TournamentCreateSerializer

    def get(self, request):
        qs = accessible_tournaments(request.user).select_related("organization", "sport")
        return Response(TournamentSerializer(qs, many=True).data)

    def post(self, request):
        if not request.user.email_verified_at:
            return Response({"detail": "verify_email_first"}, status=403)
        ser = TournamentCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        tournament = create_tournament(
            user=request.user,
            name=ser.validated_data["name"],
            sport_code=ser.validated_data.get("sport_code") or None,
            event_id=ser.validated_data.get("event_id"),
            request=request,
        )
        return Response(TournamentSerializer(tournament).data, status=201)


def _get_tournament_or_404(user, tournament_id) -> Tournament:
    """Resolve a tournament the user can access, else 404 (no existence leak)."""
    tournament = (
        Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
        .select_related("organization")
        .first()
    )
    if tournament is None or not accessible_tournaments(user).filter(id=tournament_id).exists():
        raise NotFound("tournament_not_found")
    return tournament


class TournamentInvitationCreateView(GenericAPIView):
    """`POST /api/tournaments/{id}/invitations/` — invite anyone by email to a
    tournament with a tournament-scoped role. The token is emailed, never returned.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = TournamentInvitationCreateSerializer

    def post(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        ser = TournamentInvitationCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        inv, _token = create_invitation(
            org=tournament.organization,
            tournament=tournament,
            email=ser.validated_data["email"],
            role=ser.validated_data["role"],
            invited_by=request.user,
            event_id=ser.validated_data.get("event_id"),
            request=request,
        )
        return Response(
            {
                "id": str(inv.id),
                "email": inv.email,
                "role": inv.role,
                "tournament_id": str(tournament.id),
                "status": inv.status,
            },
            status=201,
        )


def _settings_payload(tournament, user) -> dict:
    return {
        "rules": merge_rules(tournament.rules),
        "constraints": tournament.constraints or [],
        "rules_frozen_at": tournament.rules_frozen_at,
        "can_edit": can_edit_rules(tournament)
        and can_manage_tournament(user, tournament),
    }


class TournamentSettingsView(GenericAPIView):
    """`GET`/`PATCH /api/tournaments/{id}/settings/` — data-driven rules + constraints.

    PATCH is manager-only, idempotent on `event_id`, and blocked once rules are
    frozen (invariant 7) unless `amend=true` + a reason.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        return Response(_settings_payload(tournament, request.user))

    def patch(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        try:
            tournament = update_settings(
                tournament=tournament,
                rules=request.data.get("rules"),
                constraints=request.data.get("constraints"),
                by=request.user,
                amend=bool(request.data.get("amend")),
                reason=request.data.get("reason", ""),
                event_id=request.data.get("event_id"),
                request=request,
            )
        except PermissionError:
            return Response({"detail": "rules_frozen"}, status=409)
        except ValueError as exc:
            raise DRFValidationError({"detail": str(exc)})
        return Response(_settings_payload(tournament, request.user))


class ConstraintTypesView(GenericAPIView):
    """`GET /api/tournaments/constraint-types/` — static catalog for the UI builder."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from apps.fixtures.services.constraints import CONSTRAINT_TYPES

        return Response(CONSTRAINT_TYPES)


# ---------------------------------------------------------------------------
# Members (Increment 11)
# ---------------------------------------------------------------------------

# Roster statuses surfaced by default — `revoked` members are removed from the
# directory (mirrors the org member directory which lists only active rows).
_ROSTER_STATUSES = (
    TournamentMembershipStatus.ACTIVE,
    TournamentMembershipStatus.SUSPENDED,
)


class TournamentMembersView(GenericAPIView):
    """`GET /api/tournaments/{id}/members/` — the tournament roster.

    Viewable by any tournament member (access-scoped → 404 on no access, no
    existence leak). Returns active + suspended memberships (revoked excluded).
    """

    permission_classes = [IsAuthenticated]
    serializer_class = TournamentMembershipSerializer

    def get(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        qs = (
            TournamentMembership.objects.filter(
                tournament=tournament, status__in=_ROSTER_STATUSES
            )
            .select_related("user")
            .order_by("assigned_at")
        )
        return Response(TournamentMembershipSerializer(qs, many=True).data)


class TournamentMemberDetailView(GenericAPIView):
    """`PATCH /api/tournaments/{id}/members/{membership_id}/` — manage a member.

    Manager-only (else 403; 404 if the tournament is not accessible). Changes the
    member's role and/or status (e.g. status=revoked to remove). Refuses to
    remove/demote the last active admin (`last_admin`). Audited.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = TournamentMembershipUpdateSerializer

    def patch(self, request, tournament_id, membership_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")

        membership = get_object_or_404(
            TournamentMembership.objects.select_related("user"),
            id=membership_id,
            tournament=tournament,
        )
        ser = TournamentMembershipUpdateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        new_role = ser.validated_data.get("role")
        new_status = ser.validated_data.get("status")

        # Last-admin guard: block demoting (role change off admin) or
        # deactivating (status away from active) the sole active admin.
        demoting_admin = (
            membership.role == TournamentMembershipRole.ADMIN
            and new_role is not None
            and new_role != TournamentMembershipRole.ADMIN
        )
        deactivating_admin = (
            membership.role == TournamentMembershipRole.ADMIN
            and membership.status == TournamentMembershipStatus.ACTIVE
            and new_status is not None
            and new_status != TournamentMembershipStatus.ACTIVE
        )
        if demoting_admin or deactivating_admin:
            other_active_admins = (
                TournamentMembership.objects.filter(
                    tournament=tournament,
                    role=TournamentMembershipRole.ADMIN,
                    status=TournamentMembershipStatus.ACTIVE,
                )
                .exclude(id=membership.id)
                .exists()
            )
            if not other_active_admins:
                return Response({"detail": "last_admin"}, status=400)

        before = {"role": membership.role, "status": membership.status}
        update_fields: list[str] = []
        if new_role is not None and new_role != membership.role:
            membership.role = new_role
            update_fields.append("role")
        if new_status is not None and new_status != membership.status:
            membership.status = new_status
            update_fields.append("status")
            if new_status == TournamentMembershipStatus.REVOKED:
                membership.revoked_at = timezone.now()
                update_fields.append("revoked_at")

        if update_fields:
            membership.save(update_fields=update_fields)
            from apps.audit.models import ActorRole
            from apps.audit.services import emit_audit

            emit_audit(
                actor_user=request.user,
                actor_role=ActorRole.ADMIN,
                event_type="tournament_member_updated",
                target_type="tournament_membership",
                target_id=membership.id,
                payload_before=before,
                payload_after={"role": membership.role, "status": membership.status},
                organization_id=tournament.organization_id,
                tournament_id=tournament.id,
                request=request,
            )

        return Response(TournamentMembershipSerializer(membership).data)


class TournamentAuditView(GenericAPIView):
    """`GET /api/tournaments/{id}/audit/` — tournament-scoped audit feed.

    Manager-only (audit is sensitive → 403 for non-managers; 404 if the
    tournament is not accessible). Newest first, limited. Mirrors the org audit
    view's serialization shape.
    """

    _DEFAULT_LIMIT = 50
    _MAX_LIMIT = 200

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")

        from apps.audit.models import AuditEvent
        from apps.audit.serializers import AuditEventSerializer

        try:
            limit = int(request.query_params.get("limit") or self._DEFAULT_LIMIT)
        except (ValueError, TypeError):
            limit = self._DEFAULT_LIMIT
        limit = max(1, min(limit, self._MAX_LIMIT))

        qs = (
            AuditEvent.objects.filter(tournament_id=tournament.id)
            .select_related("actor_user")
            .order_by("-created_at", "-id")
        )
        page = list(qs[:limit])
        return Response({"results": AuditEventSerializer(page, many=True).data})
