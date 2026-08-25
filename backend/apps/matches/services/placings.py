"""Who came 1st, 2nd and 3rd — and what that is worth.

Spec: docs/superpowers/specs/2026-08-25-results-medal-tally-design.md.

**A placing is DERIVED, never recorded.** The fixture already knows who won:
a knockout's last round holds the final and, when the draw was configured with
``third_place``, the playoff beside it; a round robin has a table. So nothing
here writes a result — it reads the one the match engine already produced, and
the medal tally is a projection of the fixture the way a score is a projection
of the event log (invariant 4's spirit).

The one thing a host CAN write is an override, because a meet has events the
fixture never saw (the ANPSA reference sheet is athletics: 100m, Long Jump,
Shot Put have no matches at all) and because a mis-scored final has to be
correctable on the day without amending a match. An override names a winner for
one (competition, place); it never silently deletes a derived one.
"""
from __future__ import annotations

from apps.matches.models import Match, MatchStatus
from apps.tournaments.services.awards import (
    effective_awards,
    ladder_for,
    place_label,
    points_for,
    scoring_places,
)

#: A match that has produced a result. Mirrors standings.compute_standings.
_FINAL_STATUSES = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)

#: How a placing was arrived at, for the "how do you know" line in the UI.
SOURCE_FINAL = "final"
SOURCE_PLAYOFF = "third_place"
SOURCE_SEMI = "semi_final"
SOURCE_STANDINGS = "standings"
SOURCE_MANUAL = "manual"


def _is_third_place(match: Match) -> bool:
    """Both sides fed by ``loser_of`` = the third-place playoff.

    The same test ``fixtures.services.scheduler._is_third_place`` uses, and
    deliberately NOT the "· 3rd Place" group label the generator also writes:
    that label is a display string a host can retype, and a tally must not
    hang on one.
    """
    if (match.stage or "") == "losers":
        return False
    return all(
        isinstance(src, dict) and src.get("type") == "loser_of"
        for src in (match.home_source, match.away_source)
    )


def _loser_id(match: Match):
    """The side that lost a decided match (None while it is undecided or a
    draw — a knockout cannot end level, but a mis-entered score can)."""
    win = match.winner_id
    if not win:
        return None
    home, away = str(match.home_team_id or ""), str(match.away_team_id or "")
    if str(win) == home:
        return away or None
    if str(win) == away:
        return home or None
    return None


def _knockout_places(matches: list[Match], bronze_mode: str, want: int) -> dict[int, dict]:
    """Placings from the deepest knockout stage of one competition."""
    ko = [m for m in matches if (m.stage or "") == "knockout"]
    if not ko:
        return {}
    stage_no = max(m.stage_no for m in ko)
    ko = [m for m in ko if m.stage_no == stage_no]
    last_round = max(m.round_no for m in ko)
    closing = [m for m in ko if m.round_no == last_round]

    playoff = next((m for m in closing if _is_third_place(m)), None)
    # The final is the closing match that is NOT the playoff. Both sit in the
    # same round — a third-place match shares its round number with the final
    # and only the pointers tell them apart (spec 2026-08-19).
    final = next((m for m in closing if m is not playoff), None)

    out: dict[int, dict] = {}
    if final is not None and final.status in _FINAL_STATUSES and final.winner_id:
        out[1] = {"team_id": str(final.winner_id), "source": SOURCE_FINAL,
                  "match_id": str(final.id)}
        loser = _loser_id(final)
        if loser:
            out[2] = {"team_id": loser, "source": SOURCE_FINAL,
                      "match_id": str(final.id)}
    if playoff is not None:
        if playoff.status in _FINAL_STATUSES and playoff.winner_id:
            out[3] = {"team_id": str(playoff.winner_id), "source": SOURCE_PLAYOFF,
                      "match_id": str(playoff.id)}
            loser = _loser_id(playoff)
            if loser and want >= 4:
                out[4] = {"team_id": loser, "source": SOURCE_PLAYOFF,
                          "match_id": str(playoff.id)}
    elif bronze_mode == "shared" and last_round > 1:
        # No playoff: both losing semi-finalists take third, the racket-sport
        # norm. They SHARE the place — two bronzes, each worth full points,
        # which is what "shared" means and what ITTF/BWF do.
        semis = [m for m in ko if m.round_no == last_round - 1]
        losers = [
            _loser_id(m) for m in semis
            if m.status in _FINAL_STATUSES and m.winner_id
        ]
        losers = [t for t in losers if t]
        if losers and len(losers) == len(semis):
            out[3] = {"team_id": losers[0], "source": SOURCE_SEMI,
                      "shared_with": losers[1:], "match_id": ""}
    return out


def _standings_places(tournament, matches: list[Match], want: int) -> dict[int, dict]:
    """Placings from a table, for a competition that never reaches a knockout.

    Only when the whole competition is ONE group: with two groups and no
    knockout there is no single ranking, and inventing one by comparing tables
    that never met would be a made-up result.

    And only once every match is PLAYED. ``compute_standings`` deliberately
    seeds every team of a group at zero before a ball is kicked, so reading it
    early would hand out gold in draw order — a medal is only a medal when the
    table can no longer move.
    """
    from apps.matches.services.standings import compute_standings

    labels = {m.group_label for m in matches if m.group_label}
    if len(labels) != 1:
        return {}
    if not matches or any(m.status not in _FINAL_STATUSES for m in matches):
        return {}
    rows = compute_standings(tournament, group_label=labels.pop())
    out: dict[int, dict] = {}
    for i, row in enumerate(rows[:want], start=1):
        tid = str(row.get("team_id") or row.get("id") or "")
        if tid:
            out[i] = {"team_id": tid, "source": SOURCE_STANDINGS, "match_id": ""}
    return out


def competition_placings(
    tournament, leaf_key: str, *, awards: dict | None = None,
    matches: list[Match] | None = None,
) -> dict:
    """Every scoring placing in one competition, with its provenance.

    Returns ``{leaf_key, status, places: [...]}`` where status is:
      ``final``       every match played and the placings resolved
      ``provisional`` some placings resolved while the competition runs on
      ``pending``     nothing decided yet
    """
    aw = awards if awards is not None else effective_awards(tournament)
    if matches is None:
        matches = list(
            Match.objects.filter(
                tournament=tournament, leaf_key=leaf_key, deleted_at__isnull=True,
            )
        )
    want = scoring_places(aw, leaf_key)
    ladder = ladder_for(aw, leaf_key)

    # A competition that HAS a knockout is decided by it, full stop. Falling
    # back to the group table while the final is still to play would award a
    # medal the bracket is about to contradict.
    if any((m.stage or "") == "knockout" for m in matches):
        derived = _knockout_places(matches, aw.get("bronze") or "shared", want)
    else:
        derived = _standings_places(tournament, matches, want)

    for o in aw.get("overrides") or []:
        if o.get("leaf_key") != leaf_key:
            continue
        derived[int(o["place"])] = {
            "team_id": str(o.get("team_id") or ""),
            "label": o.get("label") or "",
            "note": o.get("note") or "",
            "source": SOURCE_MANUAL,
            "match_id": "",
        }

    places = []
    for row in ladder:
        place = int(row["place"])
        hit = derived.get(place)
        if not hit:
            continue
        places.append({
            "place": place,
            "label": place_label(place, ladder),
            "points": points_for(aw, leaf_key, place),
            "team_id": hit.get("team_id") or "",
            "team_label": hit.get("label") or "",
            "shared_with": hit.get("shared_with") or [],
            "source": hit.get("source") or "",
            "match_id": hit.get("match_id") or "",
            "note": hit.get("note") or "",
        })

    played = [m for m in matches if m.status in _FINAL_STATUSES]
    if not places:
        status = "pending"
    elif matches and len(played) == len(matches):
        status = "final"
    elif not matches:
        # No fixture at all: a hand-entered event is as final as it will ever
        # get, so it must not sit at "provisional" forever.
        status = "final"
    else:
        status = "provisional"
    return {"leaf_key": leaf_key, "status": status, "places": places}
