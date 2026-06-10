from __future__ import annotations

from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.fixtures.services.generate import (
    generate_knockout_from_groups,
    generate_round_robin,
    generate_round_robin_by_category,
    generate_single_elimination,
)
from apps.fixtures.services.scheduler import apply_schedule
from apps.teams.models import Team, TeamStatus
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
        fmt = request.data.get("format", "round_robin")
        try:
            if fmt == "knockout":
                teams = list(
                    Team.objects.filter(
                        tournament=t, status=TeamStatus.REGISTERED, deleted_at__isnull=True
                    ).order_by("seed", "name")
                )
                matches = generate_single_elimination(tournament=t, teams=teams)
            elif fmt == "knockout_from_groups":
                matches = generate_knockout_from_groups(tournament=t)
            elif fmt == "by_category":
                matches = generate_round_robin_by_category(tournament=t)
            else:
                matches = generate_round_robin(
                    tournament=t, group_size=int(request.data.get("group_size", 5))
                )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        return Response({"generated": len(matches), "format": fmt}, status=201)


class ScheduleFixturesView(GenericAPIView):
    """POST /api/tournaments/{id}/schedule/ — run the FET-style engine over the
    tournament's matches with the wizard's constraint payload; persist + explain."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        try:
            result = apply_schedule(
                tournament=t, config=request.data or {}, by=request.user, request=request
            )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        return Response(
            {
                "scheduled": len(result.assignments),
                "unscheduled": result.unscheduled,
                "soft_score": result.soft_score,
                "explanation": result.explanation,
            }
        )
