"""Public school-data endpoints (owner: "schools can see their data - who
played, wins/losses any time"). AllowAny, gated by (slug, UUID) + a
public-facing tournament status; names and numbers only, no contact PII."""
from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from apps.badges.catalog import BADGE_TEMPLATES
from apps.badges.models import BadgeAward
from apps.matches.services.records import (
    institution_record,
    school_history,
    team_record,
)
from apps.teams.models import Institution, Team
from apps.tournaments.models import Tournament, TournamentStatus

_PUBLIC = (
    TournamentStatus.PUBLISHED,
    TournamentStatus.REGISTRATION_OPEN,
    TournamentStatus.SCHEDULED,
    TournamentStatus.LIVE,
    TournamentStatus.COMPLETED,
)


def _public_tournament_or_404(slug, tournament_id) -> Tournament:
    t = Tournament.objects.filter(
        id=tournament_id, slug=slug, deleted_at__isnull=True, status__in=_PUBLIC
    ).first()
    if t is None:
        raise NotFound("tournament_not_found")
    return t


def _badges_for(subject_filter) -> list[dict]:
    out = []
    for a in BadgeAward.objects.filter(
        revoked_at__isnull=True, **subject_filter
    ).order_by("-awarded_at"):
        template = BADGE_TEMPLATES.get(a.badge_key, {})
        out.append({
            "id": str(a.id),
            "badge_key": a.badge_key,
            "name": template.get("name", a.badge_key),
            "evidence": a.evidence,
        })
    return out


class PublicTournamentDirectoryView(GenericAPIView):
    """`GET /api/public/tournaments/` — the explore directory: every
    public-facing tournament with dates, season, sports, and a live flag.
    Cold visitors used to dead-end on the landing page with no way to find
    any tournament without an out-of-band link."""

    permission_classes = [AllowAny]

    def get(self, request):
        from apps.matches.models import Match, MatchStatus

        rows = []
        qs = (
            Tournament.objects.filter(
                deleted_at__isnull=True, status__in=_PUBLIC
            )
            .exclude(slug="")
            .order_by("-starts_at", "-created_at")
        )
        live_ids = set(
            Match.objects.filter(
                tournament__in=qs,
                status__in=(MatchStatus.LIVE, MatchStatus.HALF_TIME),
            ).values_list("tournament_id", flat=True)
        )
        for t in qs:
            rows.append({
                "id": str(t.id),
                "slug": t.slug,
                "name": t.name,
                "status": t.status,
                "season": t.season,
                "starts_at": t.starts_at.isoformat() if t.starts_at else None,
                "ends_at": t.ends_at.isoformat() if t.ends_at else None,
                "sports": [s.get("name", "") for s in (t.sports or [])],
                "live_now": t.id in live_ids,
            })
        return Response({"tournaments": rows})


class PublicTeamRecordView(GenericAPIView):
    """`GET /api/public/tournaments/{slug}/{id}/teams/{team_id}/` — one
    team's record, form, results, roster, and badges."""

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id, team_id):
        t = _public_tournament_or_404(slug, tournament_id)
        team = (
            Team.objects.filter(
                id=team_id, tournament=t, deleted_at__isnull=True
            )
            .select_related("institution")
            .first()
        )
        if team is None:
            raise NotFound("team_not_found")
        data = team_record(team)
        data["institution"] = (
            {"id": str(team.institution_id), "name": team.institution.name}
            if team.institution_id
            else None
        )
        data["roster"] = [
            {
                "player_id": str(p.id),
                "name": p.person.full_name if p.person_id else "",
                "jersey_no": p.jersey_no,
            }
            for p in team.players.filter(deleted_at__isnull=True).select_related(
                "person"
            )
        ]
        data["badges"] = _badges_for({"team_id": team.id})
        return Response(data)


class PublicInstitutionRecordView(GenericAPIView):
    """`GET /api/public/tournaments/{slug}/{id}/institutions/{inst_id}/record/`
    — a school's rollup for this tournament plus its season-grouped history
    across every public tournament it entered ("any time")."""

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id, inst_id):
        t = _public_tournament_or_404(slug, tournament_id)
        inst = Institution.objects.filter(
            id=inst_id, tournament=t, deleted_at__isnull=True
        ).first()
        if inst is None:
            raise NotFound("institution_not_found")
        data = institution_record(inst)
        data["badges"] = _badges_for(
            {"team__institution_id": inst.id}
        )
        data["history"] = school_history(inst.name)
        return Response(data)
