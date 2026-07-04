"""Match state machine (PRD §5.5) — guarded, audited transitions (invariant #6).

On a terminal result (completed/walkover) we fire the advancement hook via
transaction.on_commit (invariant #9) so dependent knockout matches resolve.
"""
from __future__ import annotations

import logging

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone as dj_tz

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.live.publish import publish_tournament_tick
from apps.matches.models import Match, MatchStatus

logger = logging.getLogger(__name__)

S = MatchStatus

# from -> allowed to-states. Empty set = terminal.
# PRD §5.5: an in-play match can also be walked over (team leaves the pitch),
# postponed (weather hold that won't resume today), or cancelled — these used
# to be reachable only from SCHEDULED, so a mid-match interruption's only
# legal exit was ABANDONED.
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    S.SCHEDULED: {S.LIVE, S.CANCELLED, S.POSTPONED, S.WALKOVER},
    S.LIVE: {S.HALF_TIME, S.COMPLETED, S.ABANDONED, S.WALKOVER, S.POSTPONED, S.CANCELLED},
    S.HALF_TIME: {S.LIVE, S.COMPLETED, S.ABANDONED, S.WALKOVER, S.POSTPONED, S.CANCELLED},
    S.POSTPONED: {S.SCHEDULED, S.LIVE, S.CANCELLED},
    S.COMPLETED: set(),
    S.CANCELLED: set(),
    # Replay (PRD §5.5 draft v4, decision 71): the abandoned result is void —
    # the guarded transition clears scores/pens/sets/period (reason required).
    S.ABANDONED: {S.SCHEDULED},
    S.WALKOVER: set(),
}

# Interrupting a match IN PLAY is always explained (audit defensibility);
# pre-match postpone/cancel stays reason-optional (routine rescheduling).
_IN_PLAY = (S.LIVE, S.HALF_TIME)
_REASON_REQUIRED_FROM_PLAY = (S.ABANDONED, S.POSTPONED, S.CANCELLED)

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

        # P1: sport-gate football phases. A set sport pauses between sets on
        # its own and must never enter HALF_TIME — the console already hid the
        # button, but the API accepted it (architecture finding).
        if to_status == S.HALF_TIME:
            from apps.matches.services.set_scoring import rules_for_match

            if rules_for_match(locked) is not None:
                raise ValidationError("no_half_time_for_set_sport")

        replay = frm == S.ABANDONED and to_status == S.SCHEDULED
        if (
            frm in _IN_PLAY
            and to_status in _REASON_REQUIRED_FROM_PLAY
            and not (reason or "").strip()
        ):
            raise ValidationError("reason_required")
        if to_status == S.WALKOVER:
            _stamp_walkover(locked, winner_team_id)
        elif to_status == S.COMPLETED:
            _guard_knockout_draw(locked)
        elif replay:
            _reset_for_replay(locked, reason)

        locked.status = to_status
        update_fields = ["status", "current_period", "updated_at"]
        if to_status == S.LIVE:
            if not locked.current_period:
                # P1: the opening period is a sport trait — football kicks off
                # its first half; a set sport opens set/game 1.
                from apps.matches.services.sport_defs import get_definition

                locked.current_period = get_definition(locked.sport).opening_period
            elif frm == S.HALF_TIME:
                # Resume: the sticky "half_time" label used to survive the
                # whole second half (the scoreboard read "Live · half time").
                locked.current_period = "second_half"
            # Kickoff consumes the control-room "called" annotation —
            # called_at auto-clears on the transition to live (owner
            # decision 2026-06-12, spec 2026-06-12 §2.b).
            locked.called_at = None
            update_fields.append("called_at")
            # Stamp the actual kickoff once (R11). A resume from half-time
            # keeps the original start.
            if locked.started_at is None:
                locked.started_at = dj_tz.now()
                update_fields.append("started_at")
        elif to_status == S.HALF_TIME:
            locked.current_period = "half_time"
        # Actual end time on any terminal end — drives elastic re-timing (R11).
        if to_status in (S.COMPLETED, S.WALKOVER, S.ABANDONED):
            locked.ended_at = dj_tz.now()
            update_fields.append("ended_at")
        if replay:
            # A replay voids the prior result, including its actual times.
            locked.started_at = None
            locked.ended_at = None
            update_fields += [
                "home_score", "away_score", "home_pens", "away_pens",
                "set_scores", "started_at", "ended_at",
            ]
        locked.save(update_fields=update_fields)

        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_status_changed",
            target_type="match",
            target_id=locked.id,
            organization_id=locked.organization_id,
            tournament_id=locked.tournament_id,
            match_id=locked.id,
            reason=reason,
            payload_before={"status": frm},
            payload_after={"status": to_status},
            request=request,
        )

        if to_status in _TERMINAL_WITH_RESULT:
            mid = locked.id
            transaction.on_commit(lambda: _fire_advancement(mid))
            transaction.on_commit(lambda: _fire_badges(mid))
            if locked.tie_id:
                tie_id = locked.tie_id
                transaction.on_commit(lambda: _fire_tie(tie_id))
        # Tournament lifecycle spine (PRD §5.2): first kickoff flips the
        # tournament LIVE; the last terminal result flips it COMPLETED.
        # Registered AFTER advancement so a deferred next stage materializes
        # before the completion check looks for open matches.
        lc_tid, lc_status = locked.tournament_id, to_status
        if to_status == S.LIVE:
            transaction.on_commit(lambda: _fire_lifecycle(lc_tid, lc_status))
        elif to_status in (S.COMPLETED, S.WALKOVER, S.CANCELLED):
            transaction.on_commit(lambda: _fire_lifecycle(lc_tid, lc_status))
        # Elastic re-timing (R11): a completed match's real end time ripples to
        # the later matches on its court (opt-in per tournament). Post-commit so
        # it sees the persisted ended_at and never blocks the result.
        if to_status == S.COMPLETED:
            rid = locked.id
            transaction.on_commit(lambda: _fire_reflow(rid))
        # Live delivery (spec 2026-06-12 §2.c): transitions used to publish
        # NOTHING — the console polled. Thin post-commit "state" tick.
        tick_mid, tick_tid = locked.id, locked.tournament_id
        transaction.on_commit(
            lambda: publish_tournament_tick(tick_tid, tick_mid, "state")
        )
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


# P5: the football periods a scorer can move a LIVE match through
# explicitly. Kickoff/half-time transitions stay implicit; extra time and
# the shootout phase are deliberate steps (knockout + level + enabled in
# rules.match). TARGET sports have no periods to set.
_SETTABLE_PERIODS = (
    "extra_time_first", "extra_time_second", "penalties",
)


def set_match_period(*, match, period: str, by=None, request=None) -> Match:
    """Move a LIVE football match into extra time or the shootout phase."""
    from apps.matches.services.set_scoring import rules_for_match
    from apps.tournaments.services.rules import merge_rules

    if period not in _SETTABLE_PERIODS:
        raise ValidationError("invalid_period")
    with transaction.atomic():
        locked = Match.objects.select_for_update().get(pk=match.pk)
        if locked.status != S.LIVE:
            raise ValidationError("period_change_requires_live")
        if rules_for_match(locked) is not None:
            raise ValidationError("no_periods_for_set_sport")
        if locked.stage == "group" or not locked.stage:
            raise ValidationError("extra_time_knockout_only")
        if (locked.home_score or 0) != (locked.away_score or 0):
            raise ValidationError("extra_time_requires_level_score")
        cfg = merge_rules(getattr(locked.tournament, "rules", None))["match"]
        if period.startswith("extra_time") and not cfg.get("extra_time"):
            raise ValidationError("extra_time_disabled")
        if period == "penalties" and not cfg.get("penalties"):
            raise ValidationError("penalties_disabled")

        before = locked.current_period
        locked.current_period = period
        locked.save(update_fields=["current_period", "updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="match_period_changed",
            target_type="match",
            target_id=locked.id,
            organization_id=locked.organization_id,
            tournament_id=locked.tournament_id,
            match_id=locked.id,
            payload_before={"period": before},
            payload_after={"period": period},
            request=request,
        )
        mid, tid = locked.id, locked.tournament_id
        transaction.on_commit(
            lambda: __import__(
                "apps.matches.services.events", fromlist=["publish_match_event"]
            ).publish_match_event(mid, None, tid, kind="score")
        )
    return locked


def _stamp_walkover(locked: Match, winner_team_id) -> None:
    """A walkover MUST carry a decisive result, or `winner_id` stays None and
    the bracket silently stalls (stress-test #3). Either the caller pre-set a
    decisive score (team-withdrawal path), or `winner_team_id` names the side
    being awarded the match — anything else is rejected loudly."""
    if winner_team_id is not None:
        wid = str(winner_team_id)
        # P1: the awarded scoreline is a sport trait. Football keeps the
        # conventional 3-0; a set sport awards best_of//2+1 SETS (a "3-0"
        # sets tally in a best-of-3 was an illegal result). set_scores stay
        # EMPTY on a walkover — nothing was played, and stats/badges rely on
        # empty set_scores to skip walkovers (master plan §6 guard).
        from apps.matches.services.set_scoring import rules_for_match

        rules = rules_for_match(locked)
        win_score = (
            WALKOVER_SCORE if rules is None
            else int(rules.get("best_of", 3)) // 2 + 1
        )
        if wid == str(locked.home_team_id):
            locked.home_score, locked.away_score = win_score, 0
        elif wid == str(locked.away_team_id):
            locked.home_score, locked.away_score = 0, win_score
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


def _fire_tie(tie_id) -> None:
    """Post-commit: a rubber finished — re-derive its team tie (P5)."""
    try:
        from apps.matches.services.ties import recompute_tie

        recompute_tie(tie_id)
    except Exception:  # pragma: no cover - post-commit hook must never crash
        logger.exception("tie hook failed for tie=%s", tie_id)


def _fire_badges(match_id) -> None:
    """Post-commit: reconcile the finished match's competition badges."""
    try:
        from apps.badges.services.engine import fire_badge_recompute

        fire_badge_recompute(match_id)
    except Exception:  # pragma: no cover - post-commit hook must never crash
        logger.exception("badge hook failed for match=%s", match_id)


def _fire_lifecycle(tournament_id, to_status) -> None:
    """Drive the tournament lifecycle from match state (PRD §5.2 spine)."""
    try:
        from apps.tournaments.services.state import (
            mark_tournament_live,
            maybe_complete_tournament,
        )

        if to_status == S.LIVE:
            mark_tournament_live(tournament_id)
        else:
            maybe_complete_tournament(tournament_id)
    except Exception:  # pragma: no cover - post-commit hook must never crash the request
        logger.exception("lifecycle hook failed for tournament=%s", tournament_id)


def _fire_reflow(match_id) -> None:
    """Elastic re-timing hook (R11): ripple a completed match's real end time to
    its court's later matches. Opt-in + conservative; must never crash."""
    try:
        from apps.fixtures.services.repair import reflow_from_actual

        reflow_from_actual(match_id)
    except Exception:  # pragma: no cover - post-commit hook must never crash the request
        logger.exception("reflow hook failed for match=%s", match_id)
