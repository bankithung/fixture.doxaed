"""Knockout advancement (invariant #9) — resolve typed dependency pointers.

When a match reaches a final result, any match whose home_source/away_source is
{"type": "winner_of"|"loser_of", "match_id": <id>} gets the resolved team filled
in. Invoked from the match-completion post-commit hook.
"""
from __future__ import annotations

import logging

from django.db import transaction
from django.db.models import Q

from apps.matches.models import Match, MatchStatus

logger = logging.getLogger(__name__)


_FINAL = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)


def advance_from_match(match_id) -> list[Match]:
    """Fill dependents that point at this match. Returns the matches updated."""
    m = Match.objects.filter(id=match_id, deleted_at__isnull=True).first()
    if m is None:
        return []
    resolved: list[Match] = []
    winner_id = m.winner_id
    loser_id = m.loser_id

    if winner_id is not None:
        mid = str(m.id)
        # Two feeder matches can finalize concurrently (separate on_commit
        # hooks) and share a dependent. Lock exactly the referencing
        # dependents (deterministic order, so concurrent passes can't
        # deadlock) and write ONLY the side each pointer resolves — writing
        # both team fields from an unlocked read clobbers the other feeder's
        # fill back to NULL.
        with transaction.atomic():
            deps = (
                Match.objects.select_for_update()
                .filter(tournament_id=m.tournament_id, deleted_at__isnull=True)
                .filter(Q(home_source__match_id=mid) | Q(away_source__match_id=mid))
                .exclude(id=m.id)
                .order_by("id")
            )
            for dep in deps:
                fields: list[str] = []
                for side in ("home", "away"):
                    src = getattr(dep, f"{side}_source") or {}
                    if src.get("match_id") != mid:
                        continue
                    if src.get("type") == "winner_of":
                        setattr(dep, f"{side}_team_id", winner_id)
                        fields.append(f"{side}_team")
                    elif src.get("type") == "loser_of":
                        if m.status == MatchStatus.WALKOVER:
                            # §9 A7: a walkover loser (withdrawal / no-show)
                            # never occupies a loser_of slot — stamp the side
                            # vacated; _settle_unopposed resolves the match
                            # for the other side once it holds a real team.
                            if not src.get("walkover_vacated"):
                                setattr(
                                    dep, f"{side}_source",
                                    {**src, "walkover_vacated": True},
                                )
                                fields.append(f"{side}_source")
                        else:
                            setattr(dep, f"{side}_team_id", loser_id)
                            fields.append(f"{side}_team")
                if fields:
                    dep.save(update_fields=[*fields, "updated_at"])
                    resolved.append(dep)

    # group_position pointers (invariant #9 — previously silently ignored):
    # once this match's GROUP is fully final, standings positions resolve any
    # dependents declaring {"type": "group_position", "group_label", "position"}.
    resolved.extend(_resolve_group_positions(m))
    for dep in resolved:
        _settle_unopposed(dep)
    # Deferred multi-stage materialization: when this match's stage has fully
    # finalized, draw the next stage that sources from it (multi-stage §5.4).
    from apps.fixtures.services.stages import materialize_ready_stages

    materialize_ready_stages(m)
    return resolved


def _settle_unopposed(dep: Match) -> None:
    """Resolve a scheduled match one side of which cannot contest it — the
    slot was walkover-vacated (§9 A7) or the placed team has withdrawn — as a
    walkover for the other side, once that side holds a real team. Both sides
    out (a double withdrawal) is left for the organizer."""
    from apps.matches.services.state import WALKOVER_SCORE, transition_match
    from apps.teams.models import TeamStatus

    if dep.status != MatchStatus.SCHEDULED:
        return

    def _unopposed(side: str) -> bool:
        if (getattr(dep, f"{side}_source") or {}).get("walkover_vacated"):
            return True
        team = getattr(dep, f"{side}_team", None)
        return team is not None and team.status == TeamStatus.WITHDRAWN

    home_out, away_out = _unopposed("home"), _unopposed("away")
    if home_out == away_out:  # both fine, or both unopposed
        return
    win_side = "away" if home_out else "home"
    if getattr(dep, f"{win_side}_team_id") is None:
        return  # the surviving side isn't known yet — settle on its fill
    dep.home_score, dep.away_score = (
        (0, WALKOVER_SCORE) if home_out else (WALKOVER_SCORE, 0)
    )
    dep.save(update_fields=["home_score", "away_score", "updated_at"])
    transition_match(
        match=dep, to_status=MatchStatus.WALKOVER,
        reason="unopposed: opponent withdrew or slot walkover-vacated",
    )


def _resolve_group_positions(m: Match) -> list[Match]:
    if m.stage != "group" or not m.group_label or m.status not in _FINAL:
        return []
    group = Match.objects.filter(
        tournament_id=m.tournament_id, stage="group",
        group_label=m.group_label, deleted_at__isnull=True,
    )
    if group.exclude(status__in=_FINAL).exists():
        return []  # group not finished yet

    from apps.matches.services.standings import compute_standings

    rows = compute_standings(m.tournament, group_label=m.group_label)
    resolved: list[Match] = []
    # Same locking discipline as winner_of/loser_of filling: two groups can
    # finalize concurrently and feed different sides of one dependent, so
    # lock the referencing rows and write only the sides this group resolves.
    pos_q = Q(home_source__type="group_position") | Q(away_source__type="group_position")
    with transaction.atomic():
        deps = (
            Match.objects.select_for_update()
            .filter(tournament_id=m.tournament_id, deleted_at__isnull=True)
            .filter(pos_q)
            .order_by("id")
        )
        for dep in deps:
            fields: list[str] = []
            for side in ("home", "away"):
                src = getattr(dep, f"{side}_source") or {}
                if (
                    src.get("type") == "group_position"
                    and src.get("group_label") == m.group_label
                    and getattr(dep, f"{side}_team_id") is None
                ):
                    pos = int(src.get("position") or 0)
                    if 1 <= pos <= len(rows):
                        setattr(dep, f"{side}_team_id", rows[pos - 1]["team_id"])
                        fields.append(f"{side}_team")
            if fields:
                dep.save(update_fields=[*fields, "updated_at"])
                resolved.append(dep)
    return resolved


def stalled_slots(tournament) -> list[dict]:
    """Bracket slots whose FEEDER finished but whose team never arrived (P3
    advancement health). Advancement runs in a swallowed post-commit hook —
    when it fails (or a bridge misroutes, stages finding), the bracket
    stalls SILENTLY. The control room surfaces what this returns; repair is
    one re-fire away.
    """
    stalled: list[dict] = []
    dependents = Match.objects.filter(
        tournament=tournament, deleted_at__isnull=True,
    ).exclude(home_source={}, away_source={})
    feeder_ids: set = set()
    rows: list[tuple] = []
    for dep in dependents:
        for side in ("home", "away"):
            if getattr(dep, f"{side}_team_id") is not None:
                continue
            src = getattr(dep, f"{side}_source") or {}
            if src.get("type") not in ("winner_of", "loser_of"):
                continue
            fid = src.get("match_id")
            if not fid:
                continue
            rows.append((dep, side, src, fid))
            feeder_ids.add(fid)
    if not rows:
        return stalled
    feeders = {
        str(f.id): f
        for f in Match.objects.filter(id__in=feeder_ids)
    }
    for dep, side, src, fid in rows:
        feeder = feeders.get(str(fid))
        if feeder is None or feeder.status not in _FINAL:
            continue  # feeder still to play — not stalled, just pending
        # Walkover losers legitimately never fill loser_of slots (§9 A7).
        if src.get("type") == "loser_of" and feeder.status == MatchStatus.WALKOVER:
            continue
        stalled.append({
            "match_id": str(dep.id),
            "side": side,
            "source_type": src.get("type"),
            "feeder_match_id": str(fid),
            "feeder_status": feeder.status,
        })
    return stalled
