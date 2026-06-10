"""Set/game-based scoring for racket & net sports (Table Tennis, Sepak Takraw).

Football is goal-based (event-sourced, see `events.py`/`scoring.py`). These sports
are won by *sets/games*: each set is first-to-N (win by 2, optional hard cap), and
the match is best-of-K sets. We store the per-set scores on `Match.set_scores` and
mirror **sets won** into `home_score`/`away_score` so the existing winner/standings/
advancement logic keeps working unchanged.

Rules are data-driven: defaults per sport here (the values the organizer picked),
overridable per tournament via `Tournament.sports[].scoring` later. Nothing about
the football path changes.
"""
from __future__ import annotations

import uuid as _uuid

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.matches.models import Match, MatchStatus

# Defaults the organizer selected (editable later). `cap` = hard ceiling where a
# 1-point lead wins (deuce ends); `best_of` sets the match length.
SPORT_SCORING_DEFAULTS: dict[str, dict] = {
    "table_tennis": {"type": "sets", "points": 11, "win_by": 2, "cap": None, "best_of": 3},
    "sepak_takraw": {"type": "sets", "points": 21, "win_by": 2, "cap": 25, "best_of": 3},
}


def _norm(key: str | None) -> str:
    return (key or "").replace("-", "_").strip().lower()


def scoring_rules(sport_key: str | None, override: dict | None = None) -> dict | None:
    """The set-scoring rules for a sport, or None if it's not a set-based sport
    (→ caller falls back to goal scoring)."""
    if override and override.get("type") == "sets":
        return override
    return SPORT_SCORING_DEFAULTS.get(_norm(sport_key))


def is_set_based(sport_key: str | None, override: dict | None = None) -> bool:
    return scoring_rules(sport_key, override) is not None


def compute_sets(set_scores: list, rules: dict) -> tuple[int, int]:
    """Validate the per-set scores against the rules and return (home_sets,
    away_sets). Raises ValidationError on any malformed/illegal set."""
    points = int(rules.get("points", 11))
    win_by = int(rules.get("win_by", 2))
    cap = rules.get("cap")
    best_of = int(rules.get("best_of", 3))
    need = best_of // 2 + 1  # sets required to win the match

    if not isinstance(set_scores, list) or not set_scores:
        raise ValidationError("no_sets")

    home_sets = away_sets = 0
    for s in set_scores:
        if not (isinstance(s, (list, tuple)) and len(s) == 2):
            raise ValidationError("bad_set")
        try:
            h, a = int(s[0]), int(s[1])
        except (TypeError, ValueError):
            raise ValidationError("bad_set") from None
        if h < 0 or a < 0 or h == a:
            raise ValidationError("bad_set_score")
        hi, lo = max(h, a), min(h, a)
        if cap and hi > int(cap):
            raise ValidationError("set_above_cap")
        if hi < points:
            raise ValidationError("set_below_target")
        if (hi - lo) < win_by and not (cap and hi == int(cap)):
            raise ValidationError("set_not_won_by_margin")
        if h > a:
            home_sets += 1
        else:
            away_sets += 1

    if home_sets == away_sets:
        raise ValidationError("match_not_decided")
    if max(home_sets, away_sets) != need:
        raise ValidationError("wrong_set_count")
    return home_sets, away_sets


def record_set_result(
    *, match: Match, set_scores: list, rules: dict, by=None,
    event_id: _uuid.UUID | None = None, request=None,
) -> Match:
    """Record a set-based result and complete the match. Mirrors `record_score`:
    idempotent on event_id, row-locked, only scores a scheduled/live match. Stores
    per-set scores + mirrors sets won into home_score/away_score; fires knockout
    advancement on commit."""
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="match_scored"
        ).first()
        if prior is not None:
            return Match.objects.get(pk=match.pk)

    home_sets, away_sets = compute_sets(set_scores, rules)
    norm_scores = [[int(s[0]), int(s[1])] for s in set_scores]

    with transaction.atomic():
        locked = Match.objects.select_for_update().get(pk=match.pk)
        if locked.status not in (MatchStatus.SCHEDULED, MatchStatus.LIVE):
            raise ValidationError(f"Cannot score a match in status '{locked.status}'.")
        before = {
            "home": locked.home_score,
            "away": locked.away_score,
            "set_scores": locked.set_scores,
            "status": locked.status,
        }
        locked.home_score = home_sets
        locked.away_score = away_sets
        locked.set_scores = norm_scores
        locked.status = MatchStatus.COMPLETED
        locked.save(
            update_fields=["home_score", "away_score", "set_scores", "status", "updated_at"]
        )
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_scored",
            target_type="match",
            target_id=locked.id,
            organization_id=locked.organization_id,
            idempotency_key=event_id,
            payload_before=before,
            payload_after={"home": home_sets, "away": away_sets, "set_scores": norm_scores},
            request=request,
        )
        from apps.matches.services.state import _fire_advancement

        mid = locked.id
        transaction.on_commit(lambda: _fire_advancement(mid))
    return locked
