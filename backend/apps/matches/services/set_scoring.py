"""Set/game-based scoring for net & racket sports (Volleyball, Table Tennis,
Sepak Takraw) + the sport-profile registry (spec 2026-06-10 §4).

Football is goal-based (event-sourced, see `events.py`/`scoring.py`). Set
sports are won by *sets/games*: each set is first-to-N (win by margin,
optional hard cap), the match is best-of-K sets, and the DECIDING set may use
different numbers (volleyball's 15-point 5th set; sepak takraw's 15-point,
cap-17 tiebreak). We store per-set scores on `Match.set_scores` and mirror
**sets won** into `home_score`/`away_score` so winner/standings/advancement
logic keeps working unchanged.

Rules are data-driven: `SPORT_PROFILES` holds the researched defaults
(SGFI/ISTAF/FIVB/ITTF school formats); organizers override per tournament via
`Tournament.sports[].scoring` (persisted by the sports registry), and the
profile also carries scheduling hints (`duration_minutes`, `venue_type`) the
scheduler reads. Nothing about the football path changes.
"""
from __future__ import annotations

import uuid as _uuid

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.matches.models import Match, MatchStatus

# Per-sport competition profiles. `scoring.cap` = hard ceiling where a 1-point
# lead wins (deuce ends); `deciding` overrides the final set's numbers.
# `duration_minutes` is the slot estimate the scheduler uses; `venue_type`
# feeds venue-compatibility constraints (P3).
SPORT_PROFILES: dict[str, dict] = {
    "football": {
        "scoring": {"type": "goals"},
        "duration_minutes": 100,  # 2x45 + interval/turnaround (youth: override)
        "venue_type": "ground",
    },
    "volleyball": {
        "scoring": {
            "type": "sets", "best_of": 5, "points": 25, "win_by": 2,
            "cap": None, "deciding": {"points": 15, "win_by": 2, "cap": None},
        },
        "duration_minutes": 90,
        "venue_type": "indoor_court",
    },
    "table_tennis": {
        "scoring": {"type": "sets", "best_of": 3, "points": 11, "win_by": 2,
                    "cap": None},
        "duration_minutes": 30,
        "venue_type": "indoor_court",
    },
    "sepak_takraw": {
        "scoring": {
            "type": "sets", "best_of": 3, "points": 21, "win_by": 2,
            "cap": 25, "deciding": {"points": 15, "win_by": 2, "cap": 17},
        },
        "duration_minutes": 45,
        "venue_type": "indoor_court",
    },
    # BWF: every game to 21, win by 2, hard cap at 30 (29-all → next point
    # wins). The deciding game scores identically (ends change at 11).
    "badminton": {
        "scoring": {
            "type": "sets", "best_of": 3, "points": 21, "win_by": 2,
            "cap": 30, "deciding": {"points": 21, "win_by": 2, "cap": 30},
        },
        "duration_minutes": 45,
        "venue_type": "indoor_court",
    },
}

# Back-compat alias: the set-scoring subset of the profiles.
SPORT_SCORING_DEFAULTS: dict[str, dict] = {
    k: p["scoring"] for k, p in SPORT_PROFILES.items()
    if p["scoring"].get("type") == "sets"
}


def _norm(key: str | None) -> str:
    return (key or "").replace("-", "_").strip().lower()


def sport_profile(sport_key: str | None) -> dict | None:
    """The full profile (scoring + scheduling hints) for a sport, or None for
    sports outside the catalog (treated as goal-based, no hints)."""
    return SPORT_PROFILES.get(_norm(sport_key))


def scoring_rules(sport_key: str | None, override: dict | None = None) -> dict | None:
    """The set-scoring rules for a sport, or None if it's not a set-based sport
    (→ caller falls back to goal scoring). An organizer override with
    type='goals' explicitly turns a default set sport into a goal sport."""
    if override and override.get("type") == "goals":
        return None
    if override and override.get("type") == "sets":
        return override
    return SPORT_SCORING_DEFAULTS.get(_norm(sport_key))


def sport_override(match: Match) -> dict | None:
    """The organizer's per-tournament scoring override for this match's sport
    (from Tournament.sports[].scoring), if any."""
    for s in match.tournament.sports or []:
        if s.get("key") == match.sport:
            return s.get("scoring")
    return None


def rules_for_match(match: Match) -> dict | None:
    """Resolved set-scoring rules for a match (override → profile default), or
    None for goal-based matches. The single entry point views/serializers use."""
    return scoring_rules(match.sport, sport_override(match))


def is_set_based(sport_key: str | None, override: dict | None = None) -> bool:
    return scoring_rules(sport_key, override) is not None


def _set_params(rules: dict, deciding: bool) -> tuple[int, int, int | None]:
    """(points, win_by, cap) for a regular or deciding set."""
    points = int(rules.get("points", 11))
    win_by = int(rules.get("win_by", 2))
    cap = rules.get("cap")
    if deciding:
        d = rules.get("deciding") or {}
        points = int(d.get("points", points))
        win_by = int(d.get("win_by", win_by))
        cap = d.get("cap", cap)
    return points, win_by, cap


def compute_sets(set_scores: list, rules: dict) -> tuple[int, int]:
    """Validate the per-set scores against the rules and return (home_sets,
    away_sets). Sets are validated IN ORDER: the deciding set (entered at
    need-1 sets all) uses the `deciding` overrides, and no set may follow the
    one that decided the match. Raises ValidationError on any illegal set."""
    best_of = int(rules.get("best_of", 3))
    need = best_of // 2 + 1  # sets required to win the match

    if not isinstance(set_scores, list) or not set_scores:
        raise ValidationError("no_sets")

    home_sets = away_sets = 0
    for s in set_scores:
        if max(home_sets, away_sets) == need:
            raise ValidationError("set_after_match_decided")
        deciding = home_sets == away_sets == need - 1
        points, win_by, cap = _set_params(rules, deciding)
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
    idempotent on event_id, row-locked, only scores a scheduled/live match.
    Stores per-set scores + mirrors sets won into home_score/away_score; fires
    knockout advancement AND the live fan-out on commit (invariant #4: publish
    after the DB commit, so live viewers see set results too)."""
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
        from apps.matches.services.events import publish_match_event
        from apps.matches.services.state import _fire_advancement

        mid, tid = locked.id, locked.tournament_id
        transaction.on_commit(lambda: _fire_advancement(mid))
        # Dual fan-out: the match WS room + a tournament "score" tick (spec
        # 2026-06-12 §2.c) so the control room / public page refetch.
        transaction.on_commit(
            lambda: publish_match_event(mid, None, tid, kind="score")
        )
    return locked
