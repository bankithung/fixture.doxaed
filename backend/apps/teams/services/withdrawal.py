"""Minimal team-withdrawal executor (fixture-engine redesign §7 inc 16, §9 A7).

The smallest consumer that makes ``rules.withdrawal_policy`` real (a frozen
participant contract nothing enforces is worse than no key — §2.6 binding
rule): mark the team withdrawn, walkover its remaining *scheduled* matches via
the existing audited transition — the advance.py ripple (winner_of fills, the
§9 A7 loser_of vacate) is free. Matches whose opponent slot is still TBD are
left scheduled; advance.py resolves them as walkovers when the slot fills.
Standings handling (``rr_results: void_if_under_half_played``) lives in
``apps.matches.services.standings``. Postponement/repair workflows stay v2.
"""
from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import Q


def withdraw_team(*, team, by, event_id=None, reason: str = "", request=None) -> dict[str, Any]:
    """Withdraw ``team`` from its tournament. Idempotent twice over: an
    ``event_id`` replay returns the recorded outcome (invariant 3), and an
    already-withdrawn team is a no-op. Audited (``team_withdrawn``).

    Raises ValueError when ``rules.withdrawal_policy.fixtures`` names a policy
    v1 does not execute (only ``"walkover"`` is implemented) — never silently
    ignores a frozen contract.
    """
    from apps.audit.models import ActorRole, AuditEvent
    from apps.audit.services import emit_audit
    from apps.matches.models import Match, MatchStatus
    from apps.matches.services.state import WALKOVER_SCORE, transition_match
    from apps.teams.models import TeamStatus
    from apps.tournaments.services.rules import merge_rules

    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="team_withdrawn"
        ).first()
        if prior is not None:  # replay (invariant 3)
            payload = prior.payload_after or {}
            return {
                "team_id": str(team.id),
                "status": TeamStatus.WITHDRAWN,
                "walkover_matches": len(payload.get("walkover_match_ids") or []),
                "replayed": True,
            }

    if team.status == TeamStatus.WITHDRAWN:  # naturally idempotent
        return {
            "team_id": str(team.id),
            "status": team.status,
            "walkover_matches": 0,
            "replayed": True,
        }

    rules = merge_rules(getattr(team.tournament, "rules", None))
    fixtures_policy = (rules.get("withdrawal_policy") or {}).get("fixtures")
    if fixtures_policy != "walkover":
        raise ValueError(
            f"unsupported withdrawal_policy.fixtures: {fixtures_policy!r} "
            "(v1 executes 'walkover' only)"
        )

    with transaction.atomic():
        prior_status = team.status
        team.status = TeamStatus.WITHDRAWN
        team.save(update_fields=["status", "updated_at"])

        walkover_ids: list[str] = []
        remaining = (
            Match.objects.select_for_update()
            .filter(
                tournament_id=team.tournament_id,
                status=MatchStatus.SCHEDULED,
                deleted_at__isnull=True,
            )
            .filter(Q(home_team=team) | Q(away_team=team))
            .order_by("match_no")
        )
        for m in remaining:
            team_is_home = m.home_team_id == team.id
            opponent_id = m.away_team_id if team_is_home else m.home_team_id
            if opponent_id is None:
                # Opponent slot still TBD — advance.py walkovers it for the
                # other side when the slot fills (§9 A7 settle path).
                continue
            if team_is_home:
                m.home_score, m.away_score = 0, WALKOVER_SCORE
            else:
                m.home_score, m.away_score = WALKOVER_SCORE, 0
            m.save(update_fields=["home_score", "away_score", "updated_at"])
            transition_match(
                match=m, to_status=MatchStatus.WALKOVER, by=by,
                reason=reason or "team withdrew", request=request,
            )
            walkover_ids.append(str(m.id))

        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="team_withdrawn",
            target_type="team",
            target_id=team.id,
            organization_id=team.organization_id,
            tournament_id=team.tournament_id,
            idempotency_key=event_id,
            reason=reason,
            payload_before={"status": prior_status},
            payload_after={
                "status": TeamStatus.WITHDRAWN,
                "walkover_match_ids": walkover_ids,
            },
            request=request,
        )

    return {
        "team_id": str(team.id),
        "status": TeamStatus.WITHDRAWN,
        "walkover_matches": len(walkover_ids),
        "replayed": False,
    }
