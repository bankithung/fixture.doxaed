"""Compute a league table from completed matches.

Points and tiebreaker order come from the tournament's data-driven rules
(Tournament.rules; defaults 3-1-0 + GD/GF), so changing the rules changes the
table without code changes. See the rules/constraints design spec.
"""
from __future__ import annotations

from apps.matches.models import Match, MatchStatus


def _sort_key(row: dict, tiebreakers: list[str]):
    key: list = []
    for tb in tiebreakers:
        if tb == "points":
            key.append(-row["Pts"])
        elif tb == "goal_difference":
            key.append(-row["GD"])
        elif tb == "goals_for":
            key.append(-row["GF"])
        elif tb == "goals_against":
            key.append(row["GA"])
        elif tb == "wins":
            key.append(-row["W"])
        elif tb == "name":
            key.append(row["name"])
        # "head_to_head" and unknown keys are a no-op in v1 (needs pairwise data).
    key.append(row["name"])  # stable final fallback
    return tuple(key)


def compute_standings(tournament, group_label: str | None = None) -> list[dict]:
    from apps.tournaments.services.rules import merge_rules

    rules = merge_rules(getattr(tournament, "rules", None))
    pts = rules["points"]
    win_pts, draw_pts, loss_pts = pts["win"], pts["draw"], pts["loss"]
    tiebreakers = rules["tiebreakers"]

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
            h["W"] += 1; a["L"] += 1; h["Pts"] += win_pts; a["Pts"] += loss_pts
        elif as_ > hs:
            a["W"] += 1; h["L"] += 1; a["Pts"] += win_pts; h["Pts"] += loss_pts
        else:
            h["D"] += 1; a["D"] += 1; h["Pts"] += draw_pts; a["Pts"] += draw_pts

    rows = list(table.values())
    for r in rows:
        r["GD"] = r["GF"] - r["GA"]
    rows.sort(key=lambda r: _sort_key(r, tiebreakers))
    return rows
