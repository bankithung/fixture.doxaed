"""Public live viewer surface (one-way, invariant #11). Public by design, but
exposure is limited: rosters are only shown once the match is live/completed,
public-safe display names are preferred, and voided events are dropped."""
from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus

_ROSTER_VISIBLE = (MatchStatus.LIVE, MatchStatus.HALF_TIME, MatchStatus.COMPLETED)


def _name(person):
    """Public-safe name: the display name (e.g. 'M. Kikon') if set, else full."""
    if person is None:
        return ""
    return person.display_name or person.full_name


def _team(t, include_players: bool):
    if t is None:
        return None
    players = []
    if include_players:
        players = [
            {
                "id": str(p.id),
                "name": _name(p.person),
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

        include_players = m.status in _ROSTER_VISIBLE

        all_events = list(
            MatchEvent.objects.filter(match=m)
            .select_related("player", "player__person")
            .order_by("sequence_no")
        )
        voided_ids = {
            e.voids_id
            for e in all_events
            if e.event_type == MatchEventType.VOID and e.voids_id
        }
        visible = [
            e
            for e in all_events
            if e.event_type != MatchEventType.VOID and e.id not in voided_ids
        ]
        visible = list(reversed(visible))[:30]

        return Response(
            {
                "match": {
                    "id": str(m.id),
                    "status": m.status,
                    "current_period": m.current_period,
                    "home_team": _team(m.home_team, include_players),
                    "away_team": _team(m.away_team, include_players),
                    "home_score": m.home_score,
                    "away_score": m.away_score,
                },
                "events": [
                    {
                        "sequence_no": e.sequence_no,
                        "type": e.event_type,
                        "team_id": str(e.team_id) if e.team_id else None,
                        "player": (
                            (_name(e.player.person) or None) if e.player else None
                        ),
                        "minute": e.minute,
                        "period": e.period,
                    }
                    for e in visible
                ],
            }
        )
