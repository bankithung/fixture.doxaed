"""School-facing records (owner requirement 2026-06-29: "schools can see
their data - who played, wins/losses any time").

All DERIVED on demand from Match rows and the event log — the same discipline
as scores, standings, suspensions, and badges. Three altitudes:

- ``team_record``        one team's full record across its leaf (group +
                         knockout), with recent form and every result row
- ``institution_record`` a school's rollup across all its teams in one
                         tournament
- ``school_history``     the cross-tournament view, season-grouped, resolved
                         by normalized institution name (a canonical
                         SchoolProfile FK can replace the resolver later
                         without changing this shape)
"""
from __future__ import annotations

import re
from collections import defaultdict

from apps.matches.models import Match, MatchStatus

_FINAL = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().casefold())


def _result_for(m: Match, team_id) -> str:
    if m.winner_id is None:
        return "D"
    return "W" if m.winner_id == team_id else "L"


def _match_row(m: Match, team_id, tz=None) -> dict:
    home = m.home_team_id == team_id
    opponent = m.away_team if home else m.home_team
    return {
        "match_id": str(m.id),
        "opponent": opponent.name if opponent else "TBD",
        "home": home,
        "score": (
            f"{m.home_score}-{m.away_score}"
            if m.home_score is not None and m.away_score is not None
            else None
        ),
        "set_scores": m.set_scores or [],
        "result": _result_for(m, team_id),
        "status": m.status,
        "stage": m.stage,
        "group_label": m.group_label,
        "scheduled_at": m.scheduled_at.isoformat() if m.scheduled_at else None,
        "venue": m.venue,
    }


def team_record(team) -> dict:
    """P/W/D/L + scored/conceded + form + every result for one team."""
    matches = sorted(
        Match.objects.filter(
            tournament_id=team.tournament_id, deleted_at__isnull=True,
        )
        .filter(models_q_team(team.id))
        .select_related("home_team", "away_team"),
        key=lambda m: (m.scheduled_at or m.created_at),
    )
    played = [m for m in matches if m.status in _FINAL]
    wins = sum(1 for m in played if m.winner_id == team.id)
    losses = sum(1 for m in played if m.winner_id and m.winner_id != team.id)
    draws = len(played) - wins - losses
    pf = pa = 0
    for m in played:
        if m.status != MatchStatus.COMPLETED:
            continue
        home = m.home_team_id == team.id
        if m.set_scores:
            hs = sum(int(s[0]) for s in m.set_scores)
            as_ = sum(int(s[1]) for s in m.set_scores)
        else:
            hs, as_ = m.home_score or 0, m.away_score or 0
        pf += hs if home else as_
        pa += as_ if home else hs
    return {
        "team_id": str(team.id),
        "team_name": team.name,
        "leaf_key": team.leaf_key,
        "played": len(played),
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "scored": pf,
        "conceded": pa,
        "difference": pf - pa,
        "form": [_result_for(m, team.id) for m in played[-5:]],
        "matches": [_match_row(m, team.id) for m in matches],
    }


def models_q_team(team_id):
    from django.db.models import Q

    return Q(home_team_id=team_id) | Q(away_team_id=team_id)


def institution_record(institution) -> dict:
    """A school's rollup for one tournament: every team + the totals."""
    from apps.teams.models import Team, TeamStatus

    teams = Team.objects.filter(
        institution=institution, deleted_at__isnull=True,
    ).exclude(status=TeamStatus.WITHDRAWN)
    rows = [team_record(t) for t in teams]
    totals = {
        k: sum(r[k] for r in rows)
        for k in ("played", "wins", "draws", "losses", "scored", "conceded")
    }
    totals["difference"] = totals["scored"] - totals["conceded"]
    return {
        "institution_id": str(institution.id),
        "institution_name": institution.name,
        "tournament_id": str(institution.tournament_id),
        "totals": totals,
        "teams": rows,
    }


def school_history(name: str) -> list[dict]:
    """Cross-tournament history for a school name (normalized match), grouped
    by season — the "any time" view. Only public-facing tournaments appear."""
    from apps.teams.models import Institution
    from apps.tournaments.models import TournamentStatus

    public = (
        TournamentStatus.PUBLISHED, TournamentStatus.REGISTRATION_OPEN,
        TournamentStatus.SCHEDULED, TournamentStatus.LIVE,
        TournamentStatus.COMPLETED,
    )
    wanted = _norm_name(name)
    out = []
    # S5 spine first: institutions linked to a canonical SchoolProfile with
    # this name (survives renames + merges); the normalized-name scan stays
    # as the fallback for unlinked rows.
    from apps.teams.models import SchoolProfile

    profile_ids = list(
        SchoolProfile.objects.filter(
            normalized_name=wanted, merged_into__isnull=True
        ).values_list("id", flat=True)
    )
    insts = (
        Institution.objects.filter(deleted_at__isnull=True)
        .select_related("tournament")
        .order_by("-created_at")
    )
    for inst in insts:
        via_profile = (
            inst.school_profile_id is not None
            and inst.school_profile_id in profile_ids
        )
        if not via_profile and _norm_name(inst.name) != wanted:
            continue
        t = inst.tournament
        if t.deleted_at is not None or t.status not in public:
            continue
        rec = institution_record(inst)
        out.append({
            "tournament_id": str(t.id),
            "tournament_name": t.name,
            "tournament_slug": t.slug,
            "season": t.season or (str(t.starts_at.year) if t.starts_at else ""),
            "starts_at": t.starts_at.isoformat() if t.starts_at else None,
            "status": t.status,
            "totals": rec["totals"],
            "teams": [
                {k: r[k] for k in ("team_id", "team_name", "leaf_key", "played",
                                   "wins", "draws", "losses")}
                for r in rec["teams"]
            ],
        })
    seasons: dict[str, list] = defaultdict(list)
    for row in out:
        seasons[row["season"] or "undated"].append(row)
    return [
        {"season": season, "tournaments": rows}
        for season, rows in sorted(seasons.items(), reverse=True)
    ]
