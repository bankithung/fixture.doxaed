from __future__ import annotations

from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.organizations.services.invitation import create_invitation
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments
from apps.tournaments.serializers import (
    TournamentCreateSerializer,
    TournamentInvitationCreateSerializer,
    TournamentSerializer,
)
from apps.tournaments.services.create import create_tournament


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
