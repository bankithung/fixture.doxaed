from __future__ import annotations

from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.fixtures.services.generate import generate_round_robin
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


class GenerateFixturesView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        try:
            matches = generate_round_robin(
                tournament=t, group_size=int(request.data.get("group_size", 5))
            )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        return Response({"generated": len(matches)}, status=201)
