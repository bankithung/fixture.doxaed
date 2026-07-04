"""Live leaderboards — PER SPORT (P1.b; fixes verified finding N7).

The old boards were football-shaped (top scorers / best attack / best
defence) and pooled EVERY sport into one table, summing 21-point sepak sets
against football goals and rendering "No goal scorers yet" over set-sport
tournaments. Boards now come from each sport's ``definition.leaderboards``
(catalog: docs/superpowers/specs/2026-07-04-sport-leaders-catalog.md), and
rows never mix sports. Reducers below implement the catalog's
"computable today" metrics; annotation-fed boards (aces, kills, blocks,
assists) arrive with the per-sport consoles that record those events.

Derived on demand like scores/standings/badges — day zero shows each
sport's empty boards, filling as results land.
"""
from __future__ import annotations

from collections import defaultdict

from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus
from apps.matches.services.sport_defs import SPORT_DEFINITIONS, get_definition

# Row caps mirroring the historic surface (5 players / 3 teams per board).
_PLAYER_TOP = 5
_TEAM_TOP = 3


def _team_aggregates(matches) -> list[dict]:
    """One pass over a sport's COMPLETED matches -> per-team raw aggregates.

    ``scored``/``conceded`` are POINTS for set sports (summed across sets)
    and GOALS for timed sports; ``sets_won/lost`` read the sets-won mirror
    (meaningless for football and unused by its boards)."""
    rows: dict = {}
    for m in matches:
        if m.set_scores:
            hp = sum(int(x[0]) for x in m.set_scores)
            ap = sum(int(x[1]) for x in m.set_scores)
        else:
            hp, ap = m.home_score or 0, m.away_score or 0
        hs, aw = m.home_score or 0, m.away_score or 0
        for tid, team, pf, pa, sw, sl in (
            (m.home_team_id, m.home_team, hp, ap, hs, aw),
            (m.away_team_id, m.away_team, ap, hp, aw, hs),
        ):
            if tid is None:
                continue
            r = rows.setdefault(
                tid,
                {"team_id": str(tid), "team_name": team.name, "played": 0,
                 "wins": 0, "scored": 0, "conceded": 0,
                 "sets_won": 0, "sets_lost": 0, "clean_sheets": 0},
            )
            r["played"] += 1
            r["scored"] += pf
            r["conceded"] += pa
            r["sets_won"] += sw
            r["sets_lost"] += sl
            if m.winner_id == tid:
                r["wins"] += 1
            if pa == 0:
                r["clean_sheets"] += 1
    return list(rows.values())


def _scorer_rows(tournament, match_ids, limit) -> list[dict]:
    """Top scorers from the non-voided GOAL-type event log of ONE sport's
    matches (live matches count — scorers update as goals land)."""
    voided = set(
        MatchEvent.objects.filter(
            tournament=tournament, event_type=MatchEventType.VOID,
            voids__isnull=False,
        ).values_list("voids_id", flat=True)
    )
    tally: dict = defaultdict(int)
    meta: dict = {}
    for e in MatchEvent.objects.filter(
        tournament=tournament, match_id__in=match_ids,
        event_type__in=(MatchEventType.GOAL, MatchEventType.PENALTY_SCORED),
        player__isnull=False,
    ).select_related("player", "player__person", "player__team"):
        if e.id in voided:
            continue
        tally[e.player_id] += 1
        meta[e.player_id] = e.player
    return [
        {
            "player_id": str(pid),
            "name": (
                meta[pid].person.full_name if meta[pid].person_id else str(pid)
            ),
            "team_name": meta[pid].team.name if meta[pid].team_id else "",
            "value": n,
        }
        for pid, n in sorted(tally.items(), key=lambda kv: -kv[1])[:limit]
    ]


def _team_board(spec, aggregates, limit) -> list[dict]:
    """Rank the aggregates by one board spec's metric."""
    def row(r, value, detail=""):
        return {
            "team_id": r["team_id"], "team_name": r["team_name"],
            "played": r["played"], "value": value, "detail": detail,
        }

    metric = spec.metric
    if metric == "wins":
        ranked = sorted(aggregates, key=lambda r: (-r["wins"], r["played"]))
        rows = [row(r, r["wins"]) for r in ranked]
    elif metric == "scored":
        ranked = sorted(aggregates, key=lambda r: -r["scored"])
        rows = [row(r, r["scored"]) for r in ranked]
    elif metric == "conceded":
        ranked = sorted(aggregates, key=lambda r: (r["conceded"], -r["played"]))
        rows = [row(r, r["conceded"]) for r in ranked]
    elif metric == "clean_sheets":
        ranked = sorted(aggregates, key=lambda r: -r["clean_sheets"])
        rows = [row(r, r["clean_sheets"]) for r in ranked]
    elif metric == "set_ratio":
        ranked = sorted(
            aggregates,
            key=lambda r: (-(r["sets_won"] - r["sets_lost"]), -r["sets_won"]),
        )
        rows = [
            row(r, f"{r['sets_won']}-{r['sets_lost']}")
            for r in ranked
        ]
    elif metric == "point_diff":
        ranked = sorted(
            aggregates, key=lambda r: -(r["scored"] - r["conceded"])
        )
        rows = [
            row(
                r,
                r["scored"] - r["conceded"],
                f"{r['scored']}:{r['conceded']}",
            )
            for r in ranked
        ]
    else:  # unknown metric: ship nothing rather than something wrong
        rows = []
    return rows[:limit]


def compute_leaders(tournament, full: bool = False) -> dict:
    from apps.badges.catalog import BADGE_TEMPLATES
    from apps.badges.models import BadgeAward

    matches = list(
        Match.objects.filter(
            tournament=tournament, deleted_at__isnull=True,
        ).select_related("home_team", "away_team")
    )
    by_code: dict[str, list] = defaultdict(list)
    for m in matches:
        by_code[get_definition(m.sport).code].append(m)

    player_top = None if full else _PLAYER_TOP
    team_top = None if full else _TEAM_TOP

    sports = []
    total_played = 0
    for code in sorted(by_code, key=lambda c: SPORT_DEFINITIONS[c].display_name):
        definition = SPORT_DEFINITIONS[code]
        group = by_code[code]
        played = [m for m in group if m.status == MatchStatus.COMPLETED]
        total_played += len(played)
        aggregates = _team_aggregates(played)
        boards = []
        for spec in definition.leaderboards:
            if spec.subject == "player":
                if spec.metric == "goals":
                    rows = _scorer_rows(
                        tournament, [m.id for m in group], player_top
                    )
                else:
                    rows = []  # annotation-fed boards land with the consoles
            else:
                rows = _team_board(spec, aggregates, team_top)
            boards.append({
                "key": spec.key,
                "label": spec.label,
                "subject": spec.subject,
                "fmt": spec.fmt,
                "rows": rows,
            })
        sports.append({
            "sport": code,
            "name": definition.display_name,
            "played": len(played),
            "boards": boards,
        })

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
        .order_by("-awarded_at")[: (None if full else 6)]
    ]
    return {
        "played": total_played,
        "sports": sports,
        "latest_badges": badges,
    }
