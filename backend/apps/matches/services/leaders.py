"""Live leaderboards (owner ask: best players, teams, scorers — visible in
the app AND on the public pages, from day zero, updating as results land).

Derived on demand like scores/standings/badges: top scorers from the
non-voided event log, best defence / best attack from played matches (set
points when present, goals otherwise), plus the latest badge awards.
"""
from __future__ import annotations

from collections import defaultdict

from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus


def compute_leaders(tournament) -> dict:
    from apps.badges.catalog import BADGE_TEMPLATES
    from apps.badges.models import BadgeAward

    played = list(
        Match.objects.filter(
            tournament=tournament, deleted_at__isnull=True,
            status=MatchStatus.COMPLETED,
        ).select_related("home_team", "away_team")
    )

    voided = set(
        MatchEvent.objects.filter(
            tournament=tournament, event_type=MatchEventType.VOID,
            voids__isnull=False,
        ).values_list("voids_id", flat=True)
    )
    tally: dict = defaultdict(int)
    meta: dict = {}
    for e in MatchEvent.objects.filter(
        tournament=tournament,
        event_type__in=(MatchEventType.GOAL, MatchEventType.PENALTY_SCORED),
        player__isnull=False,
    ).select_related("player", "player__person", "player__team"):
        if e.id in voided:
            continue
        tally[e.player_id] += 1
        meta[e.player_id] = e.player
    scorers = [
        {
            "player_id": str(pid),
            "name": (
                meta[pid].person.full_name if meta[pid].person_id else str(pid)
            ),
            "team_name": meta[pid].team.name if meta[pid].team_id else "",
            "goals": n,
        }
        for pid, n in sorted(tally.items(), key=lambda kv: -kv[1])[:5]
    ]

    stats: dict = {}
    for m in played:
        if m.set_scores:
            hp = sum(int(x[0]) for x in m.set_scores)
            ap = sum(int(x[1]) for x in m.set_scores)
        else:
            hp, ap = m.home_score or 0, m.away_score or 0
        for tid, team, pf, pa in (
            (m.home_team_id, m.home_team, hp, ap),
            (m.away_team_id, m.away_team, ap, hp),
        ):
            if tid is None:
                continue
            row = stats.setdefault(
                tid,
                {"team_id": str(tid), "team_name": team.name,
                 "played": 0, "scored": 0, "conceded": 0},
            )
            row["played"] += 1
            row["scored"] += pf
            row["conceded"] += pa
    rows = list(stats.values())
    best_defence = sorted(rows, key=lambda r: (r["conceded"], -r["played"]))[:3]
    best_attack = sorted(rows, key=lambda r: -r["scored"])[:3]

    badges = [
        {
            "id": str(a.id),
            "name": BADGE_TEMPLATES.get(a.badge_key, {}).get("name", a.badge_key),
            "subject": (
                a.player.person.full_name
                if a.player_id and a.player.person_id
                else (a.team.name if a.team_id else "")
            ),
            "evidence": a.evidence,
        }
        for a in BadgeAward.objects.filter(
            tournament=tournament, revoked_at__isnull=True
        )
        .select_related("team", "player", "player__person")
        .order_by("-awarded_at")[:6]
    ]
    return {
        "played": len(played),
        "top_scorers": scorers,
        "best_defence": best_defence,
        "best_attack": best_attack,
        "latest_badges": badges,
    }
