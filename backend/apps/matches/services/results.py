"""The medal tally: one read that answers who won what, per school, per
category group and per student.

Spec: docs/superpowers/specs/2026-08-25-results-medal-tally-design.md.

ONE payload feeds all three views of the public Results tab. They are filters
over the same numbers rather than three endpoints, so the grid, the champion
podiums and the student list can never disagree about who won — the same reason
the public match centre is one page over one fetch.
"""
from __future__ import annotations

from collections import defaultdict

from apps.matches.models import Match
from apps.matches.services.placings import competition_placings
from apps.teams.models import Player, RosterMember, Team
from apps.teams.services.crest import crest_url
from apps.tournaments.services.awards import (
    effective_awards,
    group_leaves,
    ladder_for,
)
from apps.tournaments.services.sports import iter_leaves

#: Team statuses that can hold a medal. A withdrawn or disqualified team is not
#: a participant, exactly as the entries matrix reads it.
LIVE_TEAM_STATUSES = ("registered", "draft", "pending_approval")


def _medal_key(place: int) -> str:
    return str(place)


def _blank_medals(places: list[int]) -> dict[str, int]:
    return {_medal_key(p): 0 for p in places}


def _rank_rows(rows: list[dict], decide: str, places: list[int]) -> list[dict]:
    """Order a table and stamp a rank, ties sharing a rank.

    ``points`` ranks by the ladder's own arithmetic (a spread of silvers can
    beat one gold); ``golds`` is Olympic ordering, where one gold outranks any
    number of silvers. Both fall through to the remaining medal counts and then
    the name, so the order is total and stable.
    """
    def sort_key(r: dict):
        counts = [-r["medals"].get(_medal_key(p), 0) for p in places]
        if decide == "golds":
            return (*counts, -r["points"], r["name"].lower())
        return (-r["points"], *counts, r["name"].lower())

    ordered = sorted(rows, key=sort_key)
    rank = 0
    prev = None
    for i, row in enumerate(ordered, start=1):
        key = sort_key(row)[:-1]  # the name is a stabiliser, never a tiebreak
        if prev is None or key != prev:
            rank = i
            prev = key
        row["rank"] = rank
    return ordered


def results_payload(tournament) -> dict:
    """Everything the Results tab renders, in one read."""
    awards = effective_awards(tournament)
    leaves = iter_leaves(tournament.sports)
    leaf_keys = [leaf["leaf_key"] for leaf in leaves]

    teams = {
        str(t.id): t
        for t in Team.objects.filter(
            tournament=tournament, deleted_at__isnull=True,
        ).select_related("institution")
    }
    matches_by_leaf: dict[str, list[Match]] = defaultdict(list)
    for m in Match.objects.filter(tournament=tournament, deleted_at__isnull=True):
        matches_by_leaf[m.leaf_key or ""].append(m)

    # A competition an entry names but the tree no longer resolves is still a
    # real competition — the entries matrix makes the same promise, and a medal
    # must never become invisible because a category was renamed.
    for key in sorted({t.leaf_key for t in teams.values() if t.leaf_key}):
        if key and key not in leaf_keys:
            leaf_keys.append(key)
            leaves.append({
                "sport_key": key.split(".", 1)[0],
                "sport_name": key.split(".", 1)[0],
                "leaf_key": key,
                "path": key.split(".")[1:],
                "label": key,
            })

    # Every place any ladder in this tournament scores, for blank medal maps.
    all_places = sorted({
        int(row["place"])
        for key in leaf_keys
        for row in ladder_for(awards, key)
    }) or [1, 2, 3]

    # ---------------------------------------------------------------- schools
    school_rows: dict[str, dict] = {}

    def school_row(inst) -> dict:
        sid = str(inst.id)
        if sid not in school_rows:
            school_rows[sid] = {
                "id": sid,
                "name": inst.name,
                "short_name": inst.short_name,
                "crest": crest_url(inst.logo_ref),
                "medals": _blank_medals(all_places),
                "points": 0,
                "results": {},   # leaf_key -> [placing, ...]
            }
        return school_rows[sid]

    competitions: list[dict] = []
    for leaf in leaves:
        key = leaf["leaf_key"]
        placings = competition_placings(
            tournament, key, awards=awards, matches=matches_by_leaf.get(key, []),
        )
        entries = []
        for place in placings["places"]:
            # A shared place (two losing semi-finalists, no playoff) is ONE
            # place held by several teams, each carrying the full points —
            # that is what sharing a bronze means.
            ids = [place["team_id"], *place.get("shared_with", [])]
            winners = []
            for tid in [i for i in ids if i]:
                team = teams.get(tid)
                inst = getattr(team, "institution", None) if team else None
                winner = {
                    "team_id": tid,
                    "team_name": team.name if team else (place["team_label"] or ""),
                    "institution_id": str(inst.id) if inst else "",
                    "institution_name": inst.name if inst else (team.school if team else ""),
                    "crest": crest_url(inst.logo_ref) if inst else "",
                }
                winners.append(winner)
                if inst is not None:
                    row = school_row(inst)
                    row["medals"][_medal_key(place["place"])] = (
                        row["medals"].get(_medal_key(place["place"]), 0) + 1
                    )
                    row["points"] += place["points"]
                    row["results"].setdefault(key, []).append({
                        "place": place["place"],
                        "points": place["points"],
                        "label": place["label"],
                        "team_name": winner["team_name"],
                    })
            if not winners and place["team_label"]:
                # A hand-entered winner that is not a registered team (the
                # athletics case): named, scored, but it belongs to no school
                # row, so it is reported on the competition only.
                winners.append({
                    "team_id": "", "team_name": place["team_label"],
                    "institution_id": "", "institution_name": "", "crest": "",
                })
            entries.append({**place, "winners": winners})

        competitions.append({
            "leaf_key": key,
            "sport_key": leaf["sport_key"],
            "sport_name": leaf["sport_name"],
            "path": list(leaf["path"]),
            "label": leaf["label"],
            "status": placings["status"],
            "places": entries,
        })

    # Schools that entered but have not medalled still belong in the grid: a
    # blank row IS the answer to "did we win anything".
    for team in teams.values():
        if team.status in LIVE_TEAM_STATUSES and team.institution_id:
            school_row(team.institution)

    schools = _rank_rows(list(school_rows.values()), "points", all_places)

    # ----------------------------------------------------------------- groups
    comp_by_leaf = {c["leaf_key"]: c for c in competitions}
    groups = []
    for g in awards.get("groups") or []:
        keys = group_leaves(g, leaf_keys)
        rows: dict[str, dict] = {}
        for key in keys:
            comp = comp_by_leaf.get(key)
            if not comp:
                continue
            for place in comp["places"]:
                for winner in place["winners"]:
                    iid = winner["institution_id"]
                    if not iid:
                        continue
                    row = rows.setdefault(iid, {
                        "id": iid,
                        "name": winner["institution_name"],
                        "crest": winner["crest"],
                        "medals": _blank_medals(all_places),
                        "points": 0,
                    })
                    row["medals"][_medal_key(place["place"])] = (
                        row["medals"].get(_medal_key(place["place"]), 0) + 1
                    )
                    row["points"] += place["points"]
        table = _rank_rows(list(rows.values()), g.get("decide") or "points", all_places)
        statuses = {comp_by_leaf[k]["status"] for k in keys if k in comp_by_leaf}
        groups.append({
            "key": g["key"],
            "label": g["label"],
            "include": g.get("include") or [],
            "decide": g.get("decide") or "points",
            "leaf_keys": keys,
            "status": (
                "final" if statuses and statuses == {"final"}
                else "pending" if statuses == {"pending"} or not statuses
                else "provisional"
            ),
            "table": table,
            "champions": [r for r in table if r["rank"] == 1],
        })

    # --------------------------------------------------------------- students
    students = _student_rows(tournament, teams, comp_by_leaf, all_places)

    decided = sum(1 for c in competitions if c["status"] == "final")
    return {
        "tournament": {
            "id": str(tournament.id),
            "slug": tournament.slug,
            "name": tournament.name,
            "status": tournament.status,
            "starts_at": tournament.starts_at.isoformat() if tournament.starts_at else None,
            "ends_at": tournament.ends_at.isoformat() if tournament.ends_at else None,
        },
        "awards": {
            "enabled": bool(awards.get("enabled")),
            "ladder": awards.get("ladder") or [],
            "bronze": awards.get("bronze"),
            "places": all_places,
        },
        "competitions": competitions,
        "schools": schools,
        "groups": groups,
        "students": students,
        "totals": {
            "schools": len(schools),
            "competitions": len(competitions),
            "decided": decided,
            "medals": sum(
                len(p["winners"]) for c in competitions for p in c["places"]
            ),
            "points": sum(r["points"] for r in schools),
            "students": len(students),
        },
    }


def _student_rows(tournament, teams, comp_by_leaf, all_places) -> list[dict]:
    """Every student, the events they played and what those events won.

    A student is ONE row across every team they are in — the whole point of the
    participants layer (spec 2026-08-17): a child in three events is one child.

    **Each player carries the FULL points of their team's placing** (owner
    2026-08-25). A doubles pair that wins gold shows 5 against both partners:
    the school counts the medal once, and this view answers "what was this
    child part of", not "how do we divide a medal". Splitting would make a
    singles player look worth twice a doubles player.
    """
    placing_by_team: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    for key, comp in comp_by_leaf.items():
        for place in comp["places"]:
            for winner in place["winners"]:
                if winner["team_id"]:
                    placing_by_team[winner["team_id"]].append((key, place))

    players = (
        Player.objects.filter(tournament=tournament, deleted_at__isnull=True)
        .select_related("person", "team", "team__institution")
    )
    roster = {
        (str(r.institution_id), str(r.person_id)): r
        for r in RosterMember.objects.filter(
            tournament=tournament, deleted_at__isnull=True,
        )
    }

    rows: dict[str, dict] = {}
    for p in players:
        team = p.team
        if team is None or team.deleted_at is not None:
            continue
        if team.status not in LIVE_TEAM_STATUSES:
            continue
        inst = team.institution
        pid = str(p.person_id)
        row = rows.get(pid)
        if row is None:
            member = roster.get((str(team.institution_id), pid))
            row = rows[pid] = {
                "person_id": pid,
                "name": p.person.display_name or p.person.full_name,
                "institution_id": str(inst.id) if inst else "",
                "institution_name": inst.name if inst else team.school,
                "crest": crest_url(inst.logo_ref) if inst else "",
                "class_section": getattr(member, "class_section", "") or "",
                "roll_no": getattr(member, "roll_no", "") or "",
                "events": [],
                "medals": _blank_medals(all_places),
                "points": 0,
            }
        comp = comp_by_leaf.get(team.leaf_key or "")
        wins = placing_by_team.get(str(team.id), [])
        # A team can hold more than one placing only through an override; the
        # loop keeps that honest rather than assuming one.
        if wins:
            for _key, place in wins:
                row["events"].append({
                    "leaf_key": team.leaf_key or "",
                    "label": comp["label"] if comp else (team.leaf_key or ""),
                    "sport_name": comp["sport_name"] if comp else "",
                    "team_id": str(team.id),
                    "team_name": team.name,
                    "place": place["place"],
                    "place_label": place["label"],
                    "points": place["points"],
                    "status": comp["status"] if comp else "pending",
                })
                row["medals"][_medal_key(place["place"])] = (
                    row["medals"].get(_medal_key(place["place"]), 0) + 1
                )
                row["points"] += place["points"]
        else:
            row["events"].append({
                "leaf_key": team.leaf_key or "",
                "label": comp["label"] if comp else (team.leaf_key or ""),
                "sport_name": comp["sport_name"] if comp else "",
                "team_id": str(team.id),
                "team_name": team.name,
                "place": None,
                "place_label": "",
                "points": 0,
                "status": comp["status"] if comp else "pending",
            })

    out = list(rows.values())
    for row in out:
        row["event_count"] = len(row["events"])
        row["medal_count"] = sum(row["medals"].values())
    out.sort(key=lambda r: (-r["points"], -r["medal_count"], r["name"].lower()))
    return out
