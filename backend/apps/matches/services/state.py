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
    S.ABANDONED: set(),
    S.WALKOVER: set(),
}

_TERMINAL_WITH_RESULT = (S.COMPLETED, S.WALKOVER)

# Conventional walkover scoreline (football w/o award). Set on the match
# BEFORE transitioning to WALKOVER so winner_id/loser_id resolve and the
# advancement ripple (invariant #9) works unchanged.
WALKOVER_SCORE = 3


def can_transition(frm: str, to: str) -> bool:
    return to in ALLOWED_TRANSITIONS.get(frm, set())


def transition_match(*, match, to_status, by=None, reason="", request=None) -> Match:
    with transaction.atomic():
        locked = Match.objects.select_for_update().get(pk=match.pk)
        frm = locked.status
        if not can_transition(frm, to_status):
            raise ValidationError(f"Illegal match transition: {frm} -> {to_status}")

        locked.status = to_status
        if to_status == S.LIVE and not locked.current_period:
            locked.current_period = "first_half"
        elif to_status == S.HALF_TIME:
            locked.current_period = "half_time"
        locked.save(update_fields=["status", "current_period", "updated_at"])

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


def _fire_advancement(match_id) -> None:
    """Resolve dependent knockout matches once a result is final (invariant #9)."""
    try:
        from apps.fixtures.services.advance import advance_from_match

        advance_from_match(match_id)
    except Exception:  # pragma: no cover - post-commit hook must never crash the request
        logger.exception("advancement hook failed for match=%s", match_id)
