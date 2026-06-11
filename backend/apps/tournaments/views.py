from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
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
    TournamentStatus,
)
from apps.tournaments.permissions import can_access_module, can_manage_tournament
from apps.tournaments.scope import accessible_tournaments
from apps.tournaments.serializers import (
    TournamentCreateSerializer,
    TournamentInvitationCreateSerializer,
    TournamentMembershipSerializer,
    TournamentMembershipUpdateSerializer,
    TournamentSerializer,
    TournamentStageTransitionSerializer,
)
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.rules import (
    can_edit_rules,
    merge_rules,
    update_settings,
)
from apps.tournaments.services.sports import normalize_sports
from apps.tournaments.services.sports import sport_key as _sport_key  # noqa: F401 (re-export)
from apps.tournaments.services.state import (
    StageTransitionError,
    build_stage_payload,
    preview_transition,
    transition_tournament,
)


class TournamentListCreateView(GenericAPIView):
    """`GET` — tournaments the user can access (isolation-scoped).
    `POST` — self-serve create; auto-provisions a workspace.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = TournamentCreateSerializer

    def get(self, request):
        from apps.organizations.models import MembershipRole, OrganizationMembership

        tournaments = list(
            accessible_tournaments(request.user).select_related("organization", "sport")
        )
        # Per-user access context so each row can say HOW the user got here:
        # workspace owner/creator vs invited with tournament-scoped roles.
        invited_roles: dict = {}
        rows = TournamentMembership.objects.filter(
            user=request.user,
            status=TournamentMembershipStatus.ACTIVE,
            tournament_id__in=[tn.id for tn in tournaments],
        ).values_list("tournament_id", "role")
        for tournament_id, role in rows:
            invited_roles.setdefault(tournament_id, []).append(role)
        admin_org_ids = set(
            OrganizationMembership.objects.filter(
                user=request.user, is_active=True, role=MembershipRole.ADMIN
            ).values_list("organization_id", flat=True)
        )
        context = {
            "access_user": request.user,
            "invited_roles": invited_roles,
            "admin_org_ids": admin_org_ids,
        }
        return Response(
            TournamentSerializer(tournaments, many=True, context=context).data
        )

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


class TournamentDetailView(GenericAPIView):
    """`DELETE /api/tournaments/{id}/` — soft-delete a tournament (e.g. created by
    mistake). `PATCH {"active": bool}` — deactivate (archive) or reactivate it.

    Manager-only (admin/co-organizer or org admin). 404 on no access (no leak).
    Delete is blocked while the tournament is `live` (a match in progress)."""

    permission_classes = [IsAuthenticated]

    def delete(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        if tournament.status == TournamentStatus.LIVE:
            return Response({"detail": "tournament_live"}, status=409)

        tournament.deleted_at = timezone.now()
        tournament.save(update_fields=["deleted_at", "updated_at"])
        from apps.audit.models import ActorRole
        from apps.audit.services import emit_audit

        emit_audit(
            actor_user=request.user,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_deleted",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            payload_before={"status": tournament.status, "name": tournament.name},
            request=request,
        )

        # The hidden personal workspace was provisioned FOR this tournament;
        # once its last live tournament is gone the workspace is dead weight
        # that haunted the org switcher (owner 2026-06-10: "why all the
        # deleted list are here"). Archive it — audited, reversible.
        from apps.organizations.models import Organization, OrgStatus
        from apps.tournaments.models import Tournament as T

        org = tournament.organization
        if org.status == OrgStatus.ACTIVE and not T.objects.filter(
            organization=org, deleted_at__isnull=True
        ).exists():
            Organization.objects.filter(id=org.id).update(
                status=OrgStatus.ARCHIVED
            )
            emit_audit(
                actor_user=request.user,
                actor_role=ActorRole.ADMIN,
                event_type="organization_archived_empty_workspace",
                target_type="organization",
                target_id=org.id,
                organization_id=org.id,
                payload_before={"status": OrgStatus.ACTIVE},
                payload_after={"status": OrgStatus.ARCHIVED},
                request=request,
            )
        return Response(status=204)

    def patch(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        active = request.data.get("active")
        if not isinstance(active, bool):
            raise DRFValidationError({"detail": "active_required"})

        before = {"status": tournament.status}
        meta = dict(tournament.stage_meta or {})
        if active is False and tournament.status != TournamentStatus.ARCHIVED:
            # Deactivate: remember where we were so reactivation restores it.
            meta["status_before_archive"] = tournament.status
            tournament.stage_meta = meta
            tournament.status = TournamentStatus.ARCHIVED
            tournament.save(update_fields=["status", "stage_meta", "updated_at"])
        elif active is True and tournament.status == TournamentStatus.ARCHIVED:
            restored = meta.pop("status_before_archive", None) or TournamentStatus.DRAFT
            tournament.stage_meta = meta
            tournament.status = restored
            tournament.save(update_fields=["status", "stage_meta", "updated_at"])

        if tournament.status != before["status"]:
            from apps.audit.models import ActorRole
            from apps.audit.services import emit_audit

            emit_audit(
                actor_user=request.user,
                actor_role=ActorRole.ADMIN,
                event_type="tournament_active_changed",
                target_type="tournament",
                target_id=tournament.id,
                organization_id=tournament.organization_id,
                payload_before=before,
                payload_after={"status": tournament.status},
                request=request,
            )
        return Response(TournamentSerializer(tournament).data)


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
        # Management rights independent of the rules-freeze gate — drives the
        # archive/delete controls (you can archive/delete a frozen tournament).
        "can_manage": can_manage_tournament(user, tournament),
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


class TournamentSportsView(GenericAPIView):
    """`GET/PUT /api/tournaments/{id}/sports/` — the sports this tournament runs.

    GET: any tournament member (access-scoped → 404 on no access). PUT:
    manager-only; replaces the list, normalized by the sports registry
    (recursive category nodes with stable keys; legacy 2-level shape coerced;
    per-sport scoring/scheduling config preserved). Audited."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        return Response({"sports": tournament.sports or []})

    def put(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_access_module(request.user, tournament, "tournament.editor"):
            raise PermissionDenied("not_tournament_manager")
        try:
            cleaned = normalize_sports(request.data.get("sports"))
        except ValueError as exc:
            raise DRFValidationError({"detail": str(exc)})

        before = {"sports": tournament.sports or []}
        tournament.sports = cleaned
        tournament.save(update_fields=["sports", "updated_at"])
        from apps.audit.models import ActorRole
        from apps.audit.services import emit_audit

        emit_audit(
            actor_user=request.user,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_sports_updated",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            payload_before=before,
            payload_after={"sports": cleaned},
            request=request,
        )
        return Response({"sports": cleaned})


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

        # Duplicate-role guard: the person already holds the target role in an
        # active row → 400, not an IntegrityError 500 (the unique constraint
        # is unique_active_tournament_role).
        if (
            new_role is not None
            and new_role != membership.role
            and TournamentMembership.objects.filter(
                tournament=tournament,
                user=membership.user,
                role=new_role,
                status=TournamentMembershipStatus.ACTIVE,
            ).exclude(id=membership.id).exists()
        ):
            return Response({"detail": "duplicate_role"}, status=400)

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
            # Role/status changes alter the member's effective module set.
            from apps.permissions.services.resolver import (
                invalidate_tournament_cache,
            )

            invalidate_tournament_cache(membership.user_id, tournament.id)
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


class TournamentStageView(GenericAPIView):
    """GET the setup-stepper state; POST executes a stage transition.

    Mirrors the tournament view pattern: _get_tournament_or_404 (404-not-403),
    then the manager verb gate on writes. GET is visible to any member.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        return Response(build_stage_payload(tournament, request.user))

    def post(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        ser = TournamentStageTransitionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            tournament = transition_tournament(
                tournament=tournament,
                to_stage=ser.validated_data["to_stage"],
                ack_warnings=ser.validated_data.get("ack_warnings", False),
                reason=ser.validated_data.get("reason", ""),
                event_id=ser.validated_data.get("event_id"),
                by=request.user,
                request=request,
            )
        except StageTransitionError as exc:
            # blocked / unacknowledged warnings -> 409 with the consequences payload
            return Response(
                {"detail": exc.detail, "consequences": exc.consequences},
                status=409,
            )
        except DjangoValidationError as exc:
            # illegal transition -> 400 (mirrors transition_match contract)
            return Response({"detail": exc.messages[0]}, status=400)
        return Response(build_stage_payload(tournament, request.user))


class TournamentStagePreviewView(GenericAPIView):
    """POST a dry-run of a transition; never mutates. Manager-only."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        to_stage = request.data.get("to_stage")
        try:
            return Response(preview_transition(tournament, to_stage))
        except DjangoValidationError as exc:
            return Response({"detail": exc.messages[0]}, status=400)
