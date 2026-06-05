from __future__ import annotations

from django.db import IntegrityError
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.teams.serializers import SchoolRegistrationSerializer
from apps.teams.services.registration import (
    create_registration_link,
    register_school,
    resolve_registration_link,
)
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


class RegistrationLinkCreateView(GenericAPIView):
    """`POST /api/tournaments/{id}/registration-link/` — organizer mints a
    shareable link schools use to self-register. Token returned once."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        tournament = (
            Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
            .select_related("organization")
            .first()
        )
        if tournament is None or not accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists():
            raise NotFound("tournament_not_found")
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        link, token = create_registration_link(
            tournament=tournament, created_by=request.user,
            label=request.data.get("label", ""),
        )
        return Response(
            {"token": token, "path": f"/register/{token}", "tournament_id": str(tournament.id)},
            status=201,
        )


class PublicRegistrationView(GenericAPIView):
    """`GET/POST /api/register/{token}/` — AllowAny. GET returns tournament
    context; POST registers a school's teams + players via the link."""

    permission_classes = [AllowAny]
    serializer_class = SchoolRegistrationSerializer

    def get(self, request, token):
        link = resolve_registration_link(token)
        if link is None:
            raise NotFound("invalid_link")
        return Response(
            {"tournament_name": link.tournament.name, "tournament_id": str(link.tournament_id)}
        )

    def post(self, request, token):
        link = resolve_registration_link(token)
        if link is None:
            raise NotFound("invalid_link")
        ser = SchoolRegistrationSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            teams = register_school(
                tournament=link.tournament,
                school_name=ser.validated_data["school_name"],
                teams=ser.validated_data["teams"],
                channel="self",
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except IntegrityError:
            raise DRFValidationError(
                {"detail": "duplicate_team_name_or_jersey_in_submission"}
            )
        return Response(
            {"registered": len(teams), "teams": [t.name for t in teams]}, status=201
        )
