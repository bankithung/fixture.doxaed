"""Public live viewer surface (one-way, invariant #11). Public by design, but
exposure is limited: rosters are only shown once the match is live/completed,
public-safe display names are preferred, and voided events are dropped."""
from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus
from apps.matches.services.set_scoring import rules_for_match

_ROSTER_VISIBLE = (MatchStatus.LIVE, MatchStatus.HALF_TIME, MatchStatus.COMPLETED)


def _name(person):
    """Public-safe name: the display name (e.g. 'M. Kikon') if set, else full."""
    if person is None:
        return ""
    return person.display_name or person.full_name


def _sport_meta(m) -> dict:
    """The SportDefinition slice a console/viewer needs to render this match
    sport-natively: family (timed|target), terms, definition version."""
    from apps.matches.services.sport_defs import get_definition

    d = get_definition(m.sport)
    return {
        "key": d.code,
        "name": d.display_name,
        "family": d.period_model,
        "terms": d.terms,
        "version": d.version,
        "officials_roles": list(d.officials_roles),
    }


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


def _staff_roster_access(request, m) -> bool:
    """Pre-kickoff roster visibility for the people who run the match:
    tournament managers, the scoring seat, and assigned officials."""
    user = getattr(request, "user", None)
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    if m.scorer_id and m.scorer_id == user.id:
        return True
    from apps.matches.models import MatchOfficial
    from apps.tournaments.permissions import can_manage_tournament

    if can_manage_tournament(user, m.tournament):
        return True
    return MatchOfficial.objects.filter(match=m, user=user).exists()


def _lineups(m) -> dict | None:
    """Confirmed lineups for the public hub (P6): starter/bench roles,
    shirt numbers and positional slots — only once the match is live/final
    (same gate as the roster) and only when a lineup was actually built."""
    from apps.matches.models import Lineup

    if m.status not in _ROSTER_VISIBLE:
        return None
    out: dict = {}
    for lineup in Lineup.objects.filter(match=m).select_related("team"):
        entries = [
            {
                "player_id": str(e.player_id),
                "name": _name(e.player.person),
                "role": e.role,
                "shirt_no": e.shirt_no,
                "positional_role": e.positional_role,
            }
            for e in lineup.entries.select_related("player__person").all()
        ]
        side = "home" if lineup.team_id == m.home_team_id else "away"
        out[side] = {"confirmed": True, "entries": entries}
    return out or None


def _stats(m, visible_events) -> list[dict]:
    """Per-team event-type counts for the hub's Stats tab — derived from the
    already-filtered (non-voided) event list, so it can never disagree with
    the timeline."""
    counted = (
        MatchEventType.SHOT, MatchEventType.SAVE, MatchEventType.CORNER,
        MatchEventType.FREE_KICK, MatchEventType.FOUL,
        MatchEventType.YELLOW_CARD, MatchEventType.RED_CARD,
        MatchEventType.ACE, MatchEventType.KILL, MatchEventType.BLOCK,
        MatchEventType.SERVICE_FAULT, MatchEventType.TIMEOUT,
    )
    rows = []
    for etype in counted:
        home = sum(
            1 for e in visible_events
            if e.event_type == etype and e.team_id == m.home_team_id
        )
        away = sum(
            1 for e in visible_events
            if e.event_type == etype and e.team_id == m.away_team_id
        )
        if home or away:
            rows.append({"type": etype, "home": home, "away": away})
    return rows


def _h2h(m) -> list[dict]:
    """Prior completed meetings of these two teams in this tournament
    (cross-tournament history arrives with the records service, P6)."""
    if m.home_team_id is None or m.away_team_id is None:
        return []
    prior = (
        Match.objects.filter(
            tournament=m.tournament,
            status__in=(MatchStatus.COMPLETED, MatchStatus.WALKOVER),
            deleted_at__isnull=True,
            home_team_id__in=(m.home_team_id, m.away_team_id),
            away_team_id__in=(m.home_team_id, m.away_team_id),
        )
        .exclude(id=m.id)
        .order_by("-scheduled_at", "-updated_at")[:10]
    )
    return [
        {
            "id": str(x.id),
            "status": x.status,
            "scheduled_at": x.scheduled_at.isoformat() if x.scheduled_at else None,
            "home_team_id": str(x.home_team_id),
            "away_team_id": str(x.away_team_id),
            "home_score": x.home_score,
            "away_score": x.away_score,
            "set_scores": x.set_scores,
        }
        for x in prior
    ]


class LiveMatchSnapshotView(GenericAPIView):
    permission_classes = [AllowAny]

    def get(self, request, match_id):
        m = (
            Match.objects.select_related(
                "home_team", "away_team", "tournament",
                "tournament__organization",
            )
            .filter(id=match_id, deleted_at__isnull=True)
            .first()
        )
        if m is None:
            raise NotFound("match_not_found")

        # Public viewers see rosters only once the match is live/final; the
        # STAFF who build the team sheets (tournament managers, this match's
        # scorer, its assigned officials) need them BEFORE kickoff — the
        # scoring console reads this same snapshot (audit 2026-07-13).
        include_players = (
            m.status in _ROSTER_VISIBLE or _staff_roster_access(request, m)
        )

        all_events = list(
            MatchEvent.objects.filter(match=m)
            .select_related(
                "player", "player__person",
                "related_player", "related_player__person",
            )
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
                    # Kickoff stamp — drives the console's running clock.
                    "started_at": m.started_at.isoformat() if m.started_at else None,
                    "home_pens": m.home_pens,
                    "away_pens": m.away_pens,
                    # Set-based sports: per-set scores + the resolved rules so
                    # public viewers render sets (home/away_score = sets won).
                    "sport": m.sport,
                    "set_scores": m.set_scores,
                    "scoring": rules_for_match(m),
                    # P6 hub: schedule context + back-nav target.
                    "scheduled_at": (
                        m.scheduled_at.isoformat() if m.scheduled_at else None
                    ),
                    "venue": m.venue,
                    "leaf_key": m.leaf_key,
                    "group_label": m.group_label,
                    # P1.d: the sport's console metadata — the client picks
                    # its console module (and terminology) from this, never
                    # from hardcoded sport checks.
                    "sport_meta": _sport_meta(m),
                    "lineups": _lineups(m),
                },
                "tournament": {
                    "id": str(m.tournament_id),
                    "slug": m.tournament.slug,
                    "name": m.tournament.name,
                    "time_zone": getattr(
                        m.tournament.organization, "time_zone", "UTC"
                    ) if m.tournament.organization_id else "UTC",
                },
                "stats": _stats(m, visible),
                "h2h": _h2h(m),
                "events": [
                    {
                        "sequence_no": e.sequence_no,
                        "type": e.event_type,
                        "team_id": str(e.team_id) if e.team_id else None,
                        "player": (
                            (_name(e.player.person) or None) if e.player else None
                        ),
                        "related_player": (
                            (_name(e.related_player.person) or None)
                            if e.related_player_id and e.related_player
                            else None
                        ),
                        "minute": e.minute,
                        "period": e.period,
                    }
                    for e in visible
                ],
            }
        )
