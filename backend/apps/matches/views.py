from __future__ import annotations

from django.core.exceptions import ValidationError
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.matches.models import Match
from apps.matches.serializers import MatchSerializer, RecordScoreSerializer
from apps.matches.services.scoring import record_score
from apps.matches.services.standings import compute_standings
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


def _accessible_tournament_or_404(user, tournament_id) -> Tournament:
    if not accessible_tournaments(user).filter(id=tournament_id).exists():
        raise NotFound("tournament_not_found")
    return Tournament.objects.select_related("organization").get(id=tournament_id)


class TournamentMatchListView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _accessible_tournament_or_404(request.user, tournament_id)
        qs = (
            Match.objects.filter(tournament=t, deleted_at__isnull=True)
            .select_related("home_team", "away_team")
            .order_by("group_label", "match_no")
        )
        return Response(MatchSerializer(qs, many=True).data)


class TournamentStandingsView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _accessible_tournament_or_404(request.user, tournament_id)
        labels = sorted(
            set(
                Match.objects.filter(tournament=t, deleted_at__isnull=True)
                .values_list("group_label", flat=True)
            )
        )
        groups = [
            {"group_label": lbl, "rows": compute_standings(t, group_label=lbl)}
            for lbl in labels
        ]
        return Response({"groups": groups})


class RecordScoreView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = (
            Match.objects.filter(id=match_id, deleted_at__isnull=True)
            .select_related("tournament", "tournament__organization")
            .first()
        )
        if match is None or not accessible_tournaments(request.user).filter(
            id=match.tournament_id
        ).exists():
            raise NotFound("match_not_found")
        if not (
            can_manage_tournament(request.user, match.tournament)
            or match.scorer_id == request.user.id
        ):
            raise PermissionDenied("not_allowed_to_score")

        ser = RecordScoreSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            record_score(
                match=match,
                home_score=ser.validated_data["home_score"],
                away_score=ser.validated_data["away_score"],
                by=request.user,
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid_score")})
        match.refresh_from_db()
        return Response(MatchSerializer(match).data)
