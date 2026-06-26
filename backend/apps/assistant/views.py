"""Setup-assistant chat endpoint.

POST /api/tournaments/<id>/assistant/chat/  {messages: [{role, content}, ...]}
  -> {reply, actions: [{label, ok}], changed}

Manager-only (it performs setup writes); each write still flows through the same
service-layer permission/validation as the manual form. The Gemini key never
leaves the server.
"""
from __future__ import annotations

from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle

from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments

from .gemini import GeminiError
from .service import run_assistant


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


class AssistantChatView(GenericAPIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "assistant"

    def post(self, request, tournament_id):
        tournament = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")

        messages = request.data.get("messages")
        if not isinstance(messages, list):
            raise ValidationError({"messages": "expected a list of {role, content}"})

        try:
            result = run_assistant(
                tournament=tournament, user=request.user, messages=messages, request=request,
            )
        except GeminiError as exc:
            code = str(exc)
            status = 503 if code == "gemini_not_configured" else 502
            return Response(
                {"detail": "assistant_unavailable", "code": code,
                 "reply": "The assistant is unavailable right now. Please try again, "
                          "or fill the form manually."},
                status=status,
            )
        return Response(result)
