from __future__ import annotations

from django.core.exceptions import ValidationError
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.disputes.models import Dispute, DisputeStatus
from apps.disputes.serializers import (
    DisputeSerializer,
    RaiseDisputeSerializer,
    ResolveDisputeSerializer,
)
from apps.disputes.services.lifecycle import raise_dispute, transition_dispute
from apps.matches.models import Match
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


def _accessible_tournament_or_404(user, tournament_id) -> Tournament:
    if not accessible_tournaments(user).filter(id=tournament_id).exists():
        raise NotFound("tournament_not_found")
    return Tournament.objects.select_related("organization").get(id=tournament_id)


def _dispute_or_404(user, dispute_id) -> Dispute:
    d = (
        Dispute.objects.select_related(
            "tournament", "tournament__organization",
            "match", "match__home_team", "match__away_team",
        )
        .filter(id=dispute_id)
        .first()
    )
    if d is None or not accessible_tournaments(user).filter(id=d.tournament_id).exists():
        raise NotFound("dispute_not_found")
    return d


class TournamentDisputeView(GenericAPIView):
    """`GET/POST /api/tournaments/{id}/disputes/` — list (manager: all; else own)
    and raise a dispute (any accessible member)."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _accessible_tournament_or_404(request.user, tournament_id)
        qs = Dispute.objects.filter(tournament=t)
        if not can_manage_tournament(request.user, t):
            qs = qs.filter(raised_by=request.user)
        return Response(DisputeSerializer(qs, many=True).data)

    def post(self, request, tournament_id):
        t = _accessible_tournament_or_404(request.user, tournament_id)
        ser = RaiseDisputeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        match = None
        match_id = ser.validated_data.get("match_id")
        if match_id:
            match = Match.objects.filter(id=match_id, tournament=t).first()
        d = raise_dispute(
            tournament=t,
            raised_by=request.user,
            kind=ser.validated_data["kind"],
            description=ser.validated_data["description"],
            match=match,
            event_id=ser.validated_data.get("event_id"),
            request=request,
        )
        return Response(DisputeSerializer(d).data, status=201)


class _ManagerTransitionView(GenericAPIView):
    permission_classes = [IsAuthenticated]
    to_status: str = ""

    def post(self, request, dispute_id):
        d = _dispute_or_404(request.user, dispute_id)
        if not can_manage_tournament(request.user, d.tournament):
            raise PermissionDenied("not_tournament_manager")
        ser = ResolveDisputeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            transition_dispute(
                dispute=d, to_status=self.to_status, by=request.user,
                resolution=ser.validated_data["resolution"], request=request,
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid")})
        d.refresh_from_db()
        return Response(DisputeSerializer(d).data)


class ResolveDisputeView(_ManagerTransitionView):
    to_status = DisputeStatus.RESOLVED


class RejectDisputeView(_ManagerTransitionView):
    to_status = DisputeStatus.REJECTED


class WithdrawDisputeView(GenericAPIView):
    """The raiser withdraws their own dispute."""

    permission_classes = [IsAuthenticated]

    def post(self, request, dispute_id):
        d = _dispute_or_404(request.user, dispute_id)
        if d.raised_by_id != request.user.id:
            raise PermissionDenied("only_raiser_can_withdraw")
        try:
            transition_dispute(
                dispute=d, to_status=DisputeStatus.WITHDRAWN, by=request.user,
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid")})
        d.refresh_from_db()
        return Response(DisputeSerializer(d).data)
