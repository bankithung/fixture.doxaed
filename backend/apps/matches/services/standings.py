"""Compute a league table from completed matches.

Points and tiebreaker order come from the tournament's data-driven rules
(Tournament.rules; defaults 3-1-0 + GD/GF), so changing the rules changes the
table without code changes. See the rules/constraints design spec.
"""
from __future__ import annotations

from django.db.models import Q

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
        elif tb == "head_to_head":
            # Mini-table rank among the teams tied on every PRIOR key,
            # precomputed by _apply_head_to_head (0 = best; 0 for untied rows).
            key.append(row.get("_h2h_rank", 0))
        elif tb == "name":
            key.append(row["name"])
    key.append(row["name"])  # stable final fallback
    return tuple(key)


def _apply_head_to_head(
    rows: list[dict],
    results: list[tuple],
    tiebreakers: list[str],
    pts: dict,
) -> None:
    """Annotate rows with ``_h2h_rank`` (stress-test #5 — head_to_head used to
    be a silent no-op, so tied qualification fell through to ALPHABETICAL
    order). Teams tied on every tiebreaker BEFORE ``head_to_head`` form a
    tie-group; a mini-table over only the matches BETWEEN those teams ranks
    them (mini points, mini GD, mini GF). Teams still level share a rank and
    fall through to the tiebreakers after ``head_to_head``."""
    if "head_to_head" not in tiebreakers:
        return
    prior = tiebreakers[: tiebreakers.index("head_to_head")]

    def prior_key(row: dict):
        return _sort_key(row, prior)[:-1]  # drop the name fallback

    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        groups.setdefault(prior_key(row), []).append(row)

    win_pts, draw_pts, loss_pts = pts["win"], pts["draw"], pts["loss"]
    for tied in groups.values():
        if len(tied) < 2:
            continue
        ids = {row["team_id"] for row in tied}
        mini = {tid: {"Pts": 0, "GD": 0, "GF": 0} for tid in ids}
        for home_id, away_id, hs, as_ in results:
            if home_id not in ids or away_id not in ids:
                continue
            mini[home_id]["GF"] += hs
            mini[home_id]["GD"] += hs - as_
            mini[away_id]["GF"] += as_
            mini[away_id]["GD"] += as_ - hs
            if hs > as_:
                mini[home_id]["Pts"] += win_pts
                mini[away_id]["Pts"] += loss_pts
            elif as_ > hs:
                mini[away_id]["Pts"] += win_pts
                mini[home_id]["Pts"] += loss_pts
            else:
                mini[home_id]["Pts"] += draw_pts
                mini[away_id]["Pts"] += draw_pts
        order = sorted(
            ids,
            key=lambda tid: (-mini[tid]["Pts"], -mini[tid]["GD"], -mini[tid]["GF"]),
        )
        # Equal mini-records share a rank (dense), so later tiebreakers decide.
        rank, prev = 0, None
        for i, tid in enumerate(order):
            cur = (mini[tid]["Pts"], mini[tid]["GD"], mini[tid]["GF"])
            if cur != prev:
                rank, prev = i, cur
            for row in tied:
                if row["team_id"] == tid:
                    row["_h2h_rank"] = rank


def _voided_team_ids(tournament, matches, rules, group_label) -> set:
    """``rules.withdrawal_policy.rr_results`` (redesign spec §2.6, §9 A7):
    under ``void_if_under_half_played`` a WITHDRAWN team that completed fewer
    than half of its (non-cancelled) matches in scope has ALL its results —
    including opponents' walkover awards — annulled and drops off the table;
    at half or more, everything (walkovers included) stands."""
    from apps.teams.models import TeamStatus

    policy = (rules.get("withdrawal_policy") or {}).get("rr_results")
    if policy != "void_if_under_half_played":
        return set()
    withdrawn = {
        team.id
        for m in matches
        for team in (m.home_team, m.away_team)
        if team is not None and team.status == TeamStatus.WITHDRAWN
    }
    if not withdrawn:
        return set()
    scope = Match.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).exclude(status=MatchStatus.CANCELLED)
    if group_label is not None:
        scope = scope.filter(group_label=group_label)
    voided = set()
    for tid in withdrawn:
        mine = scope.filter(Q(home_team_id=tid) | Q(away_team_id=tid))
        total = mine.count()
        played = mine.filter(status=MatchStatus.COMPLETED).count()
        if total and played * 2 < total:
            voided.add(tid)
    return voided


def compute_standings(tournament, group_label: str | None = None) -> list[dict]:
    from apps.tournaments.services.rules import merge_rules

    rules = merge_rules(getattr(tournament, "rules", None))
    pts = rules["points"]
    win_pts, draw_pts, loss_pts = pts["win"], pts["draw"], pts["loss"]
    tiebreakers = rules["tiebreakers"]

    # Walkovers enter the table only when they carry a scoreline (the
    # withdrawal executor awards 3-0); legacy score-less walkovers keep
    # falling through the None-score guard below — zero behavior change.
    qs = (
        Match.objects.filter(
            tournament=tournament,
            status__in=(MatchStatus.COMPLETED, MatchStatus.WALKOVER),
            deleted_at__isnull=True,
        )
        .select_related("home_team", "away_team")
    )
    if group_label is not None:
        qs = qs.filter(group_label=group_label)

    matches = list(qs)
    voided = _voided_team_ids(tournament, matches, rules, group_label)

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

    results: list[tuple] = []  # (home_id, away_id, hs, as) — feeds head-to-head
    for m in matches:
        if voided and (m.home_team_id in voided or m.away_team_id in voided):
            continue  # rules.withdrawal_policy.rr_results — results annulled
        h, a = row(m.home_team), row(m.away_team)
        if h is None or a is None or m.home_score is None or m.away_score is None:
            continue
        hs, as_ = m.home_score, m.away_score
        results.append((str(m.home_team_id), str(m.away_team_id), hs, as_))
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
    _apply_head_to_head(rows, results, tiebreakers, pts)
    rows.sort(key=lambda r: _sort_key(r, tiebreakers))
    for r in rows:
        r.pop("_h2h_rank", None)  # internal key — keep the response shape
    return rows
