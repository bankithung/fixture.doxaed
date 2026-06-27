"""Multi-stage competition orchestration (multi-stage design §5, §6.3).

A competition's ``draw_config[leaf].stages`` is an ordered plan. The ENTRY stage
is generated immediately; later stages are materialized by the advancement
finalization hook (``materialize_ready_stages``) once their source stage
completes — DEFERRED materialization, reusing the existing single-stage planners
and the groups→knockout bridge. Multi-stage is orchestration, not new pairing.
"""
from __future__ import annotations

from django.db import transaction

from apps.matches.models import Match, MatchStatus

_FINAL = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)


def _stage_idx(stages: list, ref, fallback: int) -> int:
    """Positional index of the stage with id ``ref`` (or ``fallback``)."""
    for i, s in enumerate(stages):
        if s.get("id") == ref:
            return i
    return fallback


def _seeded_teams(tournament, leaf_key: str) -> list:
    from apps.teams.models import Team, TeamStatus

    qs = Team.objects.filter(
        tournament=tournament, status=TeamStatus.REGISTERED, deleted_at__isnull=True,
    )
    if leaf_key:
        qs = qs.filter(leaf_key=leaf_key)
    return list(qs.order_by("seed", "name"))


def _generate_entry_stage(tournament, leaf_key: str, stage: dict, warnings: list):
    """Generate stage 0 by dispatching to the existing single-stage generator
    for its type (matches default to stage_no=0)."""
    from apps.fixtures.services.generate import (
        generate_double_elimination,
        generate_round_robin,
        generate_single_elimination,
        generate_swiss,
    )

    typ = stage["type"]
    seeding = stage.get("seeding", "registration")
    if typ == "knockout":
        return generate_single_elimination(
            tournament=tournament, teams=_seeded_teams(tournament, leaf_key),
            leaf_key=leaf_key, third_place=bool(stage.get("third_place", False)),
            plate=bool(stage.get("plate", False)), seeding=seeding, warnings=warnings,
        )
    if typ == "swiss":
        return generate_swiss(
            tournament=tournament, teams=_seeded_teams(tournament, leaf_key),
            leaf_key=leaf_key, seeding=seeding, warnings=warnings,
        )
    if typ == "double_elim":
        return generate_double_elimination(
            tournament=tournament, teams=_seeded_teams(tournament, leaf_key),
            leaf_key=leaf_key, seeding=seeding, warnings=warnings,
        )
    return generate_round_robin(
        tournament=tournament, group_size=int(stage.get("group_size", 5)),
        leaf_key=leaf_key, legs=int(stage.get("legs", 1)), seeding=seeding,
        balance_groups=bool(stage.get("balance_groups", False)),
        min_matches_per_team=stage.get("min_matches_per_team"), warnings=warnings,
    )


def generate_stages_for_leaf(*, tournament, leaf_key, stages, cfg=None, warnings=None):
    """Generate the entry stage now; later stages are deferred to the
    finalization hook. Idempotent: returns the leaf's matches if any exist."""
    existing = list(Match.objects.filter(
        tournament=tournament, leaf_key=leaf_key, deleted_at__isnull=True,
    ))
    if existing:
        return existing
    return _generate_entry_stage(tournament, leaf_key, stages[0], warnings or [])


def materialize_ready_stages(match) -> list:
    """Draw the NEXT stage that sources from ``match``'s stage, once that source
    stage is fully final (deferred materialization). v1: a knockout stage
    sourced from a round_robin stage, via the existing groups→knockout bridge,
    stamped with the multi-stage index. A tournament-row lock + re-check
    serialize concurrent final-match commits (the TOCTOU double-draw guard)."""
    from apps.fixtures.services.draw_config import effective_stages
    from apps.fixtures.services.generate import generate_knockout_from_groups
    from apps.tournaments.models import Tournament

    leaf = match.leaf_key or ""  # "" = whole-tournament scope
    stages = effective_stages(match.tournament, leaf)
    if len(stages) <= 1:
        return []  # single-stage (incl. every legacy competition) — nothing to do

    cur = match.stage_no
    nxt_i, frm = None, {}
    for i, s in enumerate(stages):
        if i == 0:
            continue
        f = s.get("from") or {}
        if _stage_idx(stages, f.get("stage"), i - 1) == cur:
            nxt_i, frm = i, f
            break
    if nxt_i is None:
        return []
    nxt = stages[nxt_i]
    if nxt["type"] != "knockout":
        return []  # v1 deferred path materializes a knockout next stage

    src = Match.objects.filter(
        tournament=match.tournament, leaf_key=leaf, stage_no=cur, deleted_at__isnull=True,
    )
    if not src.exists() or src.exclude(status__in=_FINAL).exists():
        return []  # source stage not finished yet

    with transaction.atomic():
        Tournament.objects.select_for_update().get(pk=match.tournament_id)
        if Match.objects.filter(
            tournament=match.tournament, leaf_key=leaf, stage_no=nxt_i,
            deleted_at__isnull=True,
        ).exists():
            return []  # already materialized (re-check under the lock)
        created = generate_knockout_from_groups(
            tournament=match.tournament,
            advance_per_group=int(frm.get("advance_per_group", 2)),
            leaf_key=leaf or None, third_place=bool(nxt.get("third_place", False)),
            plate=bool(nxt.get("plate", False)),
            advance_best_thirds=int(frm.get("advance_best_thirds", 0)),
            knockout_seeding=str(frm.get("seeding", "cross")), warnings=[],
        )
        ids = [m.id for m in created]
        Match.objects.filter(id__in=ids).exclude(stage_no=nxt_i).update(stage_no=nxt_i)
    return created
