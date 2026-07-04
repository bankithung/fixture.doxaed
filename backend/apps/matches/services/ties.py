"""Team ties (P5): create the rubber series, recompute on every rubber
result, kill dead rubbers, complete the tie.

The tie mirrors the platform's derivation discipline: ``home/away_rubbers_won``
derive from the child rubbers' winner ids; the moment one side reaches
``stop_at_wins``, remaining unplayed rubbers are CANCELLED (dead rubbers,
never scored — ITTF practice) and the tie completes.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.matches.models import Match, MatchStatus, MatchTie

_FINAL = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)

# Sourced tie formats (data instances; custom shapes legal).
TIE_FORMATS: dict[str, dict] = {
    "olympic_tt": {
        "label": "Olympic table tennis (5 rubbers, doubles third)",
        "rubbers": [
            {"no": 1, "kind": "singles", "best_of": 5},
            {"no": 2, "kind": "singles", "best_of": 5},
            {"no": 3, "kind": "doubles", "best_of": 5},
            {"no": 4, "kind": "singles", "best_of": 5},
            {"no": 5, "kind": "singles", "best_of": 5},
        ],
        "stop_at_wins": 3,
        "max_matches_per_player": 2,
    },
    "worlds_2026_tt": {
        "label": "World Team Championships 2026 (5 singles)",
        "rubbers": [
            {"no": n, "kind": "singles", "best_of": 5} for n in range(1, 6)
        ],
        "stop_at_wins": 3,
        "max_matches_per_player": 2,
    },
    "sepak_team_regu": {
        "label": "Sepak takraw team event (3 regus)",
        "rubbers": [
            {"no": 1, "kind": "regu", "best_of": 3},
            {"no": 2, "kind": "regu", "best_of": 3},
            {"no": 3, "kind": "regu", "best_of": 3},
        ],
        "stop_at_wins": 2,
        "max_matches_per_player": 1,
    },
}


def create_tie(
    *, tournament, home_team, away_team, sport: str, leaf_key: str = "",
    fmt: dict | None = None, format_key: str | None = None,
    stage: str = "", group_label: str = "", by=None, request=None,
) -> MatchTie:
    """Create the tie + its rubber matches in one atomic write."""
    if fmt is None:
        fmt = TIE_FORMATS.get(format_key or "")
        if fmt is None:
            raise ValidationError("unknown_tie_format")
    rubbers = fmt.get("rubbers") or []
    need = int(fmt.get("stop_at_wins") or 0)
    if not rubbers or not need or need > len(rubbers):
        raise ValidationError("invalid_tie_format")

    with transaction.atomic():
        tie = MatchTie.objects.create(
            organization=tournament.organization,
            tournament=tournament,
            leaf_key=leaf_key,
            stage=stage,
            group_label=group_label,
            home_team=home_team,
            away_team=away_team,
            format={
                "rubbers": rubbers,
                "stop_at_wins": need,
                "max_matches_per_player": fmt.get("max_matches_per_player"),
            },
        )
        for r in rubbers:
            Match.objects.create(
                organization=tournament.organization,
                tournament=tournament,
                sport=sport,
                leaf_key=leaf_key,
                stage=stage,
                group_label=group_label,
                home_team=home_team,
                away_team=away_team,
                tie=tie,
                rubber_no=int(r.get("no") or 0),
                rubber_kind=str(r.get("kind") or ""),
            )
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN if by is not None else ActorRole.SYSTEM,
            event_type="match_tie_created",
            target_type="match_tie",
            target_id=tie.id,
            organization_id=tournament.organization_id,
            tournament_id=tournament.id,
            payload_after={"rubbers": len(rubbers), "stop_at_wins": need},
            request=request,
        )
    return tie


def recompute_tie(tie_id) -> MatchTie | None:
    """Post-commit hook: derive rubbers won; at stop_at_wins, cancel the
    dead rubbers and complete the tie. Idempotent — safe to re-fire."""
    with transaction.atomic():
        tie = (
            MatchTie.objects.select_for_update()
            .filter(id=tie_id)
            .first()
        )
        if tie is None:
            return None
        rubbers = list(
            Match.objects.select_for_update().filter(
                tie=tie, deleted_at__isnull=True
            )
        )
        home = sum(
            1 for r in rubbers
            if r.status in _FINAL and r.winner_id == tie.home_team_id
        )
        away = sum(
            1 for r in rubbers
            if r.status in _FINAL and r.winner_id == tie.away_team_id
        )
        need = int((tie.format or {}).get("stop_at_wins") or 0)
        decided = need > 0 and (home >= need or away >= need)

        updates = []
        if (tie.home_rubbers_won, tie.away_rubbers_won) != (home, away):
            tie.home_rubbers_won, tie.away_rubbers_won = home, away
            updates += ["home_rubbers_won", "away_rubbers_won"]
        new_status = "completed" if decided else (
            "live" if any(
                r.status in (MatchStatus.LIVE, MatchStatus.HALF_TIME)
                for r in rubbers
            ) or home or away else "scheduled"
        )
        if tie.status != new_status:
            tie.status = new_status
            updates.append("status")
        if updates:
            tie.save(update_fields=[*updates, "updated_at"])

        if decided:
            for r in rubbers:
                if r.status == MatchStatus.SCHEDULED:
                    # Dead rubber: never played, never scored (ITTF).
                    r.status = MatchStatus.CANCELLED
                    r.save(update_fields=["status", "updated_at"])
    return tie
