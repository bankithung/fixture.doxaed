from __future__ import annotations

from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.tournaments.scope import accessible_tournaments
from apps.tournaments.serializers import (
    TournamentCreateSerializer,
    TournamentSerializer,
)
from apps.tournaments.services.create import create_tournament


class TournamentListCreateView(GenericAPIView):
    """`GET /api/tournaments/` — tournaments the user can access (isolation-scoped).
    `POST /api/tournaments/` — self-serve create; auto-provisions a workspace.
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
