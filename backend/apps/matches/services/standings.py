"""Compute a league table from completed matches (3-1-0; GD then GF tiebreak)."""
from __future__ import annotations

from apps.matches.models import Match, MatchStatus


def compute_standings(tournament, group_label: str | None = None) -> list[dict]:
    qs = (
        Match.objects.filter(
            tournament=tournament, status=MatchStatus.COMPLETED, deleted_at__isnull=True
        )
        .select_related("home_team", "away_team")
    )
    if group_label is not None:
        qs = qs.filter(group_label=group_label)

    table: dict = {}

    def row(team):
        if team is None:
            return None
        r = table.get(team.id)
        if r is None:
            r = {
                "team_id": str(team.id),
                "name": team.name,
                "school": team.school,
                "P": 0, "W": 0, "D": 0, "L": 0, "GF": 0, "GA": 0, "Pts": 0,
            }
            table[team.id] = r
        return r

    for m in qs:
        h, a = row(m.home_team), row(m.away_team)
        if h is None or a is None or m.home_score is None or m.away_score is None:
            continue
        hs, as_ = m.home_score, m.away_score
        h["P"] += 1; a["P"] += 1
        h["GF"] += hs; h["GA"] += as_; a["GF"] += as_; a["GA"] += hs
        if hs > as_:
            h["W"] += 1; a["L"] += 1; h["Pts"] += 3
        elif as_ > hs:
            a["W"] += 1; h["L"] += 1; a["Pts"] += 3
        else:
            h["D"] += 1; a["D"] += 1; h["Pts"] += 1; a["Pts"] += 1

    rows = list(table.values())
    for r in rows:
        r["GD"] = r["GF"] - r["GA"]
    rows.sort(key=lambda r: (-r["Pts"], -r["GD"], -r["GF"], r["name"]))
    return rows
