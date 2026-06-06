from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.matches.models import Match
from apps.matches.serializers import (
    MatchSerializer,
    RecordEventSerializer,
    RecordScoreSerializer,
    TransitionSerializer,
)
from apps.matches.services.events import record_match_event
from apps.matches.services.scoring import assign_scorer, record_score
from apps.matches.services.standings import compute_standings
from apps.matches.services.state import transition_match
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments

User = get_user_model()


def _accessible_tournament_or_404(user, tournament_id) -> Tournament:
    if not accessible_tournaments(user).filter(id=tournament_id).exists():
        raise NotFound("tournament_not_found")
    return Tournament.objects.select_related("organization").get(id=tournament_id)


def _match_or_404(user, match_id) -> Match:
    match = (
        Match.objects.filter(id=match_id, deleted_at__isnull=True)
        .select_related("tournament", "tournament__organization")
        .first()
    )
    if match is None or not accessible_tournaments(user).filter(
        id=match.tournament_id
    ).exists():
        raise NotFound("match_not_found")
    return match


def _can_score(user, match: Match) -> bool:
    """A match can be scored by a tournament manager, the per-match assigned
    scorer, or any active match_scorer member of the tournament."""
    if can_manage_tournament(user, match.tournament):
        return True
    if match.scorer_id == user.id:
        return True
    return TournamentMembership.objects.filter(
        user=user,
        tournament=match.tournament,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    ).exists()


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


class AssignScorerView(GenericAPIView):
    """`POST /api/matches/{id}/scorer/` — a manager assigns a scorer to a match.
    Body: {"user_id": "<uuid>"}. The target must be a tournament member."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not can_manage_tournament(request.user, match.tournament):
            raise PermissionDenied("not_tournament_manager")
        target = User.objects.filter(id=request.data.get("user_id")).first()
        if target is None:
            raise DRFValidationError({"detail": "user_not_found"})
        try:
            assign_scorer(match=match, user=target, by=request.user, request=request)
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid_assignment")})
        match.refresh_from_db()
        return Response(MatchSerializer(match).data)


class RecordScoreView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
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


class RecordMatchEventView(GenericAPIView):
    """`POST /api/matches/{id}/events/` — append a live event (goal/card/etc.).
    Scores derive from the event log (invariant #4)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_score")
        ser = RecordEventSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        side = ser.validated_data.get("side")
        team = (
            match.home_team if side == "home"
            else match.away_team if side == "away"
            else None
        )
        player = None
        player_id = ser.validated_data.get("player_id")
        if player_id:
            from apps.teams.models import Player

            player = Player.objects.filter(
                id=player_id, tournament=match.tournament, deleted_at__isnull=True
            ).first()
            if player is None:
                raise DRFValidationError({"detail": "player_not_found"})
            if team is not None and player.team_id != team.id:
                raise DRFValidationError({"detail": "player_not_on_team"})
            if team is None:
                team = player.team
        record_match_event(
            match=match,
            event_type=ser.validated_data["event_type"],
            team=team,
            player=player,
            minute=ser.validated_data.get("minute"),
            by=request.user,
            event_id=ser.validated_data.get("event_id"),
            request=request,
        )
        match.refresh_from_db()
        return Response(MatchSerializer(match).data, status=201)


class TransitionMatchView(GenericAPIView):
    """`POST /api/matches/{id}/transition/` — move the match through its state
    machine (start/half-time/complete/etc.)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_transition")
        ser = TransitionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            transition_match(
                match=match,
                to_status=ser.validated_data["to_status"],
                by=request.user,
                reason=ser.validated_data.get("reason", ""),
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "illegal_transition")})
        match.refresh_from_db()
        return Response(MatchSerializer(match).data)
