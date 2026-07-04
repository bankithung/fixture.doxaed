"""Public school-data endpoints + the personal cross-tournament aggregate.

School data (owner: "schools can see their data - who played, wins/losses
any time") is AllowAny, gated by (slug, UUID) + a public-facing tournament
status; names and numbers only, no contact PII. MyTodayView is the
authenticated dashboard feed."""
from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
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


class PublicTournamentLeadersView(GenericAPIView):
    """`GET /api/public/tournaments/{slug}/{id}/leaders/` — the FIFA-style
    public leaderboard: present from day zero (empty arrays), refreshed by
    viewers on every SSE tick."""

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id):
        from apps.matches.services.leaders import compute_leaders

        t = _public_tournament_or_404(slug, tournament_id)
        full = request.query_params.get("full") in ("1", "true")
        return Response(compute_leaders(t, full=full))


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


class MyTodayView(GenericAPIView):
    """`GET /api/me/today/` — the operator command center feed: everything
    live or scheduled today across EVERY tournament the caller can access,
    plus a "needs you" strip (open disputes, unstaffed matches today). The
    root dashboard used to re-list tournaments instead of answering "what is
    happening right now"."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from datetime import timedelta

        from django.utils import timezone as dj_tz

        from apps.disputes.models import Dispute
        from apps.matches.models import Match, MatchStatus
        from apps.tournaments.scope import accessible_tournaments

        now = dj_tz.now()
        window_start = now - timedelta(hours=18)
        window_end = now + timedelta(hours=30)
        tournaments = list(accessible_tournaments(request.user)[:50])
        by_id = {t.id: t for t in tournaments}

        matches = (
            Match.objects.filter(
                tournament_id__in=by_id.keys(), deleted_at__isnull=True,
            )
            .filter(
                models_q_live()
                | models_q_window(window_start, window_end)
            )
            .select_related("home_team", "away_team", "tournament")
            .order_by("scheduled_at")[:80]
        )
        rows = []
        needs = []
        for m in matches:
            t = by_id.get(m.tournament_id)
            rows.append({
                "match_id": str(m.id),
                "tournament_id": str(m.tournament_id),
                "tournament_name": t.name if t else "",
                "home": m.home_team.name if m.home_team_id else "TBD",
                "away": m.away_team.name if m.away_team_id else "TBD",
                "status": m.status,
                "home_score": m.home_score,
                "away_score": m.away_score,
                "scheduled_at": m.scheduled_at.isoformat() if m.scheduled_at else None,
                "venue": m.venue,
                "live": m.status in (MatchStatus.LIVE, MatchStatus.HALF_TIME),
            })
            if (
                m.status == MatchStatus.SCHEDULED
                and m.scorer_id is None
                and m.scheduled_at is not None
                and now <= m.scheduled_at <= window_end
            ):
                needs.append({
                    "kind": "no_scorer",
                    "match_id": str(m.id),
                    "tournament_id": str(m.tournament_id),
                    "label": f"No scorer: "
                             f"{m.home_team.name if m.home_team_id else 'TBD'}"
                             f" vs {m.away_team.name if m.away_team_id else 'TBD'}",
                })
        open_disputes = Dispute.objects.filter(
            tournament_id__in=by_id.keys(),
            status__in=("open", "under_review"),
        ).select_related("tournament")[:20]
        for d in open_disputes:
            needs.append({
                "kind": "open_dispute",
                "tournament_id": str(d.tournament_id),
                "label": f"Open dispute in {d.tournament.name}",
            })
        return Response({"matches": rows, "needs": needs})


class MyOverviewView(GenericAPIView):
    """`GET /api/me/overview/` — the analytics rollup behind the root
    dashboard: totals, tournament status/sport mix, a matches-per-day series
    (past 30d + next 14d, bucketed in each tournament's own TZ per invariant
    14), per-tournament completion, and the latest results — all scoped to
    every tournament the caller can access."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from collections import Counter
        from datetime import timedelta
        from zoneinfo import ZoneInfo

        from django.db.models import Count, F, Q, Sum
        from django.utils import timezone as dj_tz

        from apps.matches.models import Match, MatchStatus
        from apps.teams.models import Player
        from apps.tournaments.scope import accessible_tournaments

        tournaments = list(accessible_tournaments(request.user))
        by_id = {t.id: t for t in tournaments}
        ids = list(by_id.keys())
        live_statuses = (MatchStatus.LIVE, MatchStatus.HALF_TIME)

        matches = Match.objects.filter(
            tournament_id__in=ids, deleted_at__isnull=True
        )
        agg = matches.aggregate(
            total=Count("id"),
            completed=Count("id", filter=Q(status=MatchStatus.COMPLETED)),
            live=Count("id", filter=Q(status__in=live_statuses)),
            # Goals only where home/away_score means goals (blank sport =
            # football; set-based sports store SETS won there).
            goals=Sum(
                F("home_score") + F("away_score"),
                filter=Q(status=MatchStatus.COMPLETED)
                & (Q(sport="") | Q(sport="football")),
            ),
        )
        teams_by_t = dict(
            Team.objects.filter(tournament_id__in=ids, deleted_at__isnull=True)
            .values_list("tournament_id")
            .annotate(n=Count("id"))
        )
        players_count = Player.objects.filter(
            tournament_id__in=ids, deleted_at__isnull=True
        ).count()
        institutions_count = Institution.objects.filter(
            tournament_id__in=ids, deleted_at__isnull=True
        ).count()

        # Tournament status mix (live* variants fold into "live").
        status_mix = Counter(
            "live" if t.status.startswith("live") else t.status
            for t in tournaments
        )

        # Sport mix: names from the tournaments' sports config; match counts
        # from Match.sport (blank = football).
        sport_names: dict[str, str] = {}
        sport_tournaments: Counter[str] = Counter()
        for t in tournaments:
            keys = set()
            for s in t.sports or []:
                key = s.get("key") or ""
                if not key:
                    continue
                keys.add(key)
                sport_names.setdefault(key, s.get("name") or key.replace("_", " ").title())
            if not keys and t.sport_id:
                keys.add(t.sport.code)
            for key in keys:
                sport_tournaments[key] += 1
        sport_matches: Counter[str] = Counter()
        for sport, n in (
            matches.values_list("sport").annotate(n=Count("id"))
        ):
            sport_matches[sport or "football"] += n
        sports = [
            {
                "key": key,
                "name": sport_names.get(key, key.replace("_", " ").title()),
                "tournaments": sport_tournaments.get(key, 0),
                "matches": sport_matches.get(key, 0),
            }
            for key in sorted(
                set(sport_tournaments) | set(sport_matches),
                key=lambda k: -(sport_matches.get(k, 0) + sport_tournaments.get(k, 0)),
            )
        ]

        # Matches-per-day series, bucketed in each tournament's own timezone.
        now = dj_tz.now()
        window_start = now - timedelta(days=31)
        window_end = now + timedelta(days=15)
        day_buckets: dict[str, dict[str, int]] = {}
        matches_today = 0
        matches_next7 = 0
        tz_cache: dict[str, ZoneInfo] = {}
        for t_id, scheduled_at, status in matches.filter(
            scheduled_at__gte=window_start, scheduled_at__lte=window_end
        ).values_list("tournament_id", "scheduled_at", "status"):
            t = by_id.get(t_id)
            tz_name = (t.time_zone if t else "") or "UTC"
            tz = tz_cache.get(tz_name)
            if tz is None:
                try:
                    tz = ZoneInfo(tz_name)
                except KeyError:
                    tz = ZoneInfo("UTC")
                tz_cache[tz_name] = tz
            local = scheduled_at.astimezone(tz)
            day = local.date().isoformat()
            bucket = day_buckets.setdefault(
                day, {"completed": 0, "live": 0, "scheduled": 0}
            )
            if status == MatchStatus.COMPLETED:
                bucket["completed"] += 1
            elif status in live_statuses:
                bucket["live"] += 1
            else:
                bucket["scheduled"] += 1
            local_today = now.astimezone(tz).date()
            delta_days = (local.date() - local_today).days
            if delta_days == 0:
                matches_today += 1
            if 0 < delta_days <= 7 and status == MatchStatus.SCHEDULED:
                matches_next7 += 1
        matches_per_day = [
            {"date": day, **counts}
            for day, counts in sorted(day_buckets.items())
        ]

        # Per-tournament completion (the progress rail).
        per_t = {
            row["tournament_id"]: row
            for row in matches.values("tournament_id").annotate(
                total=Count("id"),
                completed=Count("id", filter=Q(status=MatchStatus.COMPLETED)),
                live=Count("id", filter=Q(status__in=live_statuses)),
            )
        }
        progress = []
        for t in tournaments:
            row = per_t.get(t.id)
            progress.append({
                "id": str(t.id),
                "slug": t.slug,
                "name": t.name,
                "status": t.status,
                "total": row["total"] if row else 0,
                "completed": row["completed"] if row else 0,
                "live": row["live"] if row else 0,
                "teams": teams_by_t.get(t.id, 0),
            })
        progress.sort(key=lambda p: (-p["live"], -p["total"]))

        recent = (
            matches.filter(status=MatchStatus.COMPLETED)
            .select_related("home_team", "away_team", "tournament")
            .order_by(F("ended_at").desc(nulls_last=True), "-updated_at")[:8]
        )
        recent_results = [
            {
                "match_id": str(m.id),
                "tournament_id": str(m.tournament_id),
                "tournament_name": m.tournament.name,
                "home": m.home_team.name if m.home_team_id else "TBD",
                "away": m.away_team.name if m.away_team_id else "TBD",
                "home_score": m.home_score,
                "away_score": m.away_score,
                "sport": m.sport or "football",
                "ended_at": m.ended_at.isoformat() if m.ended_at else None,
            }
            for m in recent
        ]

        return Response({
            "totals": {
                "tournaments": len(tournaments),
                "tournaments_live": sum(
                    1 for t in tournaments if t.status.startswith("live")
                ),
                "matches": agg["total"] or 0,
                "matches_completed": agg["completed"] or 0,
                "matches_live": agg["live"] or 0,
                "matches_today": matches_today,
                "matches_next7": matches_next7,
                "teams": sum(teams_by_t.values()),
                "players": players_count,
                "institutions": institutions_count,
                "goals": agg["goals"] or 0,
            },
            "tournament_status": [
                {"status": s, "count": n}
                for s, n in sorted(status_mix.items(), key=lambda kv: -kv[1])
            ],
            "sports": sports,
            "matches_per_day": matches_per_day,
            "progress": progress[:12],
            "recent_results": recent_results,
        })


def models_q_live():
    from django.db.models import Q

    return Q(status__in=("live", "half_time"))


def models_q_window(start, end):
    from django.db.models import Q

    return Q(status="scheduled", scheduled_at__gte=start, scheduled_at__lte=end)
