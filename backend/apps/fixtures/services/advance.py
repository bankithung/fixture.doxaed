"""Knockout advancement (invariant #9) — resolve typed dependency pointers.

When a match reaches a final result, any match whose home_source/away_source is
{"type": "winner_of"|"loser_of", "match_id": <id>} gets the resolved team filled
in. Invoked from the match-completion post-commit hook.
"""
from __future__ import annotations

import logging

from apps.matches.models import Match

logger = logging.getLogger(__name__)


def advance_from_match(match_id) -> list[Match]:
    """Fill dependents that point at this match. Returns the matches updated."""
    m = Match.objects.filter(id=match_id, deleted_at__isnull=True).first()
    if m is None:
        return []
    winner_id = m.winner_id
    loser_id = m.loser_id
    if winner_id is None:
        return []  # draw or not yet final → nothing to resolve

    mid = str(m.id)
    resolved: list[Match] = []
    deps = Match.objects.filter(tournament_id=m.tournament_id, deleted_at__isnull=True)
    for dep in deps:
        if dep.id == m.id:
            continue
        changed = False
        for side in ("home", "away"):
            src = getattr(dep, f"{side}_source") or {}
            if src.get("match_id") != mid:
                continue
            if src.get("type") == "winner_of":
                setattr(dep, f"{side}_team_id", winner_id)
                changed = True
            elif src.get("type") == "loser_of":
                setattr(dep, f"{side}_team_id", loser_id)
                changed = True
        if changed:
            dep.save(update_fields=["home_team", "away_team", "updated_at"])
            resolved.append(dep)
    return resolved
