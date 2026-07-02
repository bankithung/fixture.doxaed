"""Badge award endpoints: the tournament honours board (member view) and the
public gallery (share targets). Read-only — awards are engine-derived."""
from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.badges.catalog import BADGE_TEMPLATES
from apps.badges.models import BadgeAward
from apps.tournaments.models import Tournament, TournamentStatus
from apps.tournaments.scope import accessible_tournaments

_PUBLIC_STATUSES = (
    TournamentStatus.PUBLISHED,
    TournamentStatus.REGISTRATION_OPEN,
    TournamentStatus.SCHEDULED,
    TournamentStatus.LIVE,
    TournamentStatus.COMPLETED,
)


def _rows(tournament) -> list[dict]:
    awards = (
        BadgeAward.objects.filter(tournament=tournament, revoked_at__isnull=True)
        .select_related("team", "player", "player__person", "match")
        .order_by("-awarded_at")
    )
    out = []
    for a in awards:
        template = BADGE_TEMPLATES.get(a.badge_key, {})
        out.append({
            "id": str(a.id),
            "badge_key": a.badge_key,
            "name": template.get("name", a.badge_key),
            "description": template.get("description", ""),
            "leaf_key": a.leaf_key,
            "stage_no": a.stage_no,
            "group_label": a.group_label,
            "subject_type": a.subject_type,
            "team_id": str(a.team_id) if a.team_id else None,
            "team_name": a.team.name if a.team_id else None,
            "player_id": str(a.player_id) if a.player_id else None,
            "player_name": (
                a.player.person.full_name
                if a.player_id and a.player.person_id
                else None
            ),
            "match_id": str(a.match_id) if a.match_id else None,
            "evidence": a.evidence,
            "awarded_at": a.awarded_at.isoformat(),
        })
    return out


class TournamentBadgesView(GenericAPIView):
    """`GET /api/tournaments/{id}/badges/` — the honours board."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.get(id=tournament_id)
        return Response({"badges": _rows(t)})


class BadgeCardView(GenericAPIView):
    """`GET /api/public/badges/{award_id}/card.png` — the shareable social
    card (1200x630 OG image). Public: award ids are UUIDv7 capabilities and
    the tournament must be public-facing."""

    permission_classes = [AllowAny]

    def get(self, request, award_id):
        from django.http import FileResponse

        award = (
            BadgeAward.objects.filter(id=award_id, revoked_at__isnull=True)
            .select_related("tournament", "team", "player", "player__person")
            .first()
        )
        if award is None or award.tournament.status not in _PUBLIC_STATUSES:
            raise NotFound("badge_not_found")
        from apps.badges.services.cards import render_share_card

        path = render_share_card(award)
        return FileResponse(open(path, "rb"), content_type="image/png")


class PublicTournamentBadgesView(GenericAPIView):
    """`GET /api/public/tournaments/{slug}/{id}/badges/` — public gallery."""

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id):
        t = Tournament.objects.filter(
            id=tournament_id, slug=slug, deleted_at__isnull=True,
            status__in=_PUBLIC_STATUSES,
        ).first()
        if t is None:
            raise NotFound("tournament_not_found")
        return Response({"badges": _rows(t)})
