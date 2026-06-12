"""Match state machine (PRD §5.5) — guarded, audited transitions (invariant #6).

On a terminal result (completed/walkover) we fire the advancement hook via
transaction.on_commit (invariant #9) so dependent knockout matches resolve.
"""
from __future__ import annotations

import logging

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.matches.models import Match, MatchStatus

logger = logging.getLogger(__name__)

S = MatchStatus

# from -> allowed to-states. Empty set = terminal.
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    S.SCHEDULED: {S.LIVE, S.CANCELLED, S.POSTPONED, S.WALKOVER},
    S.LIVE: {S.HALF_TIME, S.COMPLETED, S.ABANDONED},
    S.HALF_TIME: {S.LIVE, S.COMPLETED, S.ABANDONED},
    S.POSTPONED: {S.SCHEDULED, S.LIVE, S.CANCELLED},
    S.COMPLETED: set(),
    S.CANCELLED: set(),
    # Replay (PRD §5.5 draft v4, decision 71): the abandoned result is void —
    # the guarded transition clears scores/pens/sets/period (reason required).
    S.ABANDONED: {S.SCHEDULED},
    S.WALKOVER: set(),
}

_TERMINAL_WITH_RESULT = (S.COMPLETED, S.WALKOVER)

# Conventional walkover scoreline (football w/o award). Set on the match
# BEFORE transitioning to WALKOVER so winner_id/loser_id resolve and the
# advancement ripple (invariant #9) works unchanged.
WALKOVER_SCORE = 3


def can_transition(frm: str, to: str) -> bool:
    return to in ALLOWED_TRANSITIONS.get(frm, set())


def transition_match(
    *, match, to_status, by=None, reason="", request=None, winner_team_id=None
) -> Match:
    with transaction.atomic():
        locked = Match.objects.select_for_update().get(pk=match.pk)
        frm = locked.status
        if not can_transition(frm, to_status):
            raise ValidationError(f"Illegal match transition: {frm} -> {to_status}")

        replay = frm == S.ABANDONED and to_status == S.SCHEDULED
        if to_status == S.WALKOVER:
            _stamp_walkover(locked, winner_team_id)
        elif to_status == S.COMPLETED:
            _guard_knockout_draw(locked)
        elif replay:
            _reset_for_replay(locked, reason)

        locked.status = to_status
        if to_status == S.LIVE and not locked.current_period:
            locked.current_period = "first_half"
        elif to_status == S.HALF_TIME:
            locked.current_period = "half_time"
        update_fields = ["status", "current_period", "updated_at"]
        if replay:
            update_fields += [
                "home_score", "away_score", "home_pens", "away_pens",
                "set_scores",
            ]
        locked.save(update_fields=update_fields)

        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_status_changed",
            target_type="match",
            target_id=locked.id,
            organization_id=locked.organization_id,
            reason=reason,
            payload_before={"status": frm},
            payload_after={"status": to_status},
            request=request,
        )

        if to_status in _TERMINAL_WITH_RESULT:
            mid = locked.id
            transaction.on_commit(lambda: _fire_advancement(mid))
    return locked


def _guard_knockout_draw(locked: Match) -> None:
    """A knockout match completing LEVEL used to stall the bracket silently
    (stress-test #4): winner_id stayed None and dependents waited forever.
    Refuse the completion loudly — the scorer either records the shootout
    first (rules.match.penalties) or the result genuinely can't stand."""
    if locked.stage == "group" or not locked.stage:
        return  # draws are a normal league result
    if locked.home_score is None or locked.away_score is None:
        return  # score-less completion is guarded elsewhere
    if locked.home_score != locked.away_score:
        return
    if locked.home_pens is not None and locked.away_pens is not None \
            and locked.home_pens != locked.away_pens:
        return  # shootout already decided it
    from apps.tournaments.services.rules import merge_rules

    match_rules = merge_rules(getattr(locked.tournament, "rules", None))["match"]
    if match_rules.get("penalties"):
        raise ValidationError("knockout_draw_needs_shootout")
    raise ValidationError("knockout_match_cannot_end_drawn")


def _reset_for_replay(locked: Match, reason: str) -> None:
    """ABANDONED → SCHEDULED (PRD §5.5 draft v4): the replay starts fresh —
    the abandoned result is void, so scores/pens/sets/period clear. The
    original events stay in the immutable log (invariant #4 — strikethrough,
    never deletion). An audit reason is REQUIRED: a replay without a
    recorded why is indefensible in a dispute."""
    if not (reason or "").strip():
        raise ValidationError("reason_required")
    locked.home_score = None
    locked.away_score = None
    locked.home_pens = None
    locked.away_pens = None
    locked.set_scores = []
    locked.current_period = ""


def _stamp_walkover(locked: Match, winner_team_id) -> None:
    """A walkover MUST carry a decisive result, or `winner_id` stays None and
    the bracket silently stalls (stress-test #3). Either the caller pre-set a
    decisive score (team-withdrawal path), or `winner_team_id` names the side
    being awarded the match — anything else is rejected loudly."""
    if winner_team_id is not None:
        wid = str(winner_team_id)
        if wid == str(locked.home_team_id):
            locked.home_score, locked.away_score = WALKOVER_SCORE, 0
        elif wid == str(locked.away_team_id):
            locked.home_score, locked.away_score = 0, WALKOVER_SCORE
        else:
            raise ValidationError("walkover_winner_not_in_match")
        locked.save(update_fields=["home_score", "away_score", "updated_at"])
        return
    decisive = (
        locked.home_score is not None
        and locked.away_score is not None
        and locked.home_score != locked.away_score
    )
    if not decisive:
        raise ValidationError("walkover_requires_winner")


def _fire_advancement(match_id) -> None:
    """Resolve dependent knockout matches once a result is final (invariant #9)."""
    try:
        from apps.fixtures.services.advance import advance_from_match

        advance_from_match(match_id)
    except Exception:  # pragma: no cover - post-commit hook must never crash the request
        logger.exception("advancement hook failed for match=%s", match_id)
