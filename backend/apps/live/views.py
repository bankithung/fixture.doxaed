"""Public live viewer surface (one-way). SSE streaming is the transport upgrade;
this pollable JSON snapshot is what the viewer renders today."""
from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from apps.matches.models import Match, MatchEvent


def _team(t):
    if t is None:
        return None
    players = [
        {
            "id": str(p.id),
            "name": p.person.full_name if p.person else "",
            "jersey_no": p.jersey_no,
            "position": p.position,
        }
        for p in t.players.filter(deleted_at__isnull=True)
        .select_related("person")
        .order_by("jersey_no", "id")
    ]
    return {
        "id": str(t.id),
        "name": t.name,
        "short_name": t.short_name,
        "players": players,
    }


class LiveMatchSnapshotView(GenericAPIView):
    permission_classes = [AllowAny]

    def get(self, request, match_id):
        m = (
            Match.objects.select_related("home_team", "away_team")
            .filter(id=match_id, deleted_at__isnull=True)
            .first()
        )
        if m is None:
            raise NotFound("match_not_found")
        events = list(
            MatchEvent.objects.filter(match=m)
            .select_related("player", "player__person")
            .order_by("-sequence_no")[:30]
        )
        return Response(
            {
                "match": {
                    "id": str(m.id),
                    "status": m.status,
                    "current_period": m.current_period,
                    "home_team": _team(m.home_team),
                    "away_team": _team(m.away_team),
                    "home_score": m.home_score,
                    "away_score": m.away_score,
                },
                "events": [
                    {
                        "sequence_no": e.sequence_no,
                        "type": e.event_type,
                        "team_id": str(e.team_id) if e.team_id else None,
                        "player": (
                            e.player.person.full_name
                            if e.player and e.player.person
                            else None
                        ),
                        "minute": e.minute,
                        "period": e.period,
                    }
                    for e in events
                ],
            }
        )
