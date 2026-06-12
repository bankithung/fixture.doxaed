"""Dry-run fixture preview — a PURE simulate (redesign spec §5.2, D6/D10).

Persists nothing, touches no rows, takes no ``event_id``: the pairing layer
runs through the pure ``plan_*`` core and the slot layer through
``schedule_matches`` over inputs built by the SAME ``build_schedule_inputs``
the commit path uses (§9 A1 — preoccupied bookings and shared-player links
included), so an Accept with the returned ``seed`` +
``expected_inputs_hash`` reproduces the preview exactly.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from apps.fixtures.services.draw_config import effective_draw_config
from apps.fixtures.services.generate import (
    MatchPlan,
    _keep_apart_separators,
    _new_seed,
    _plan_by_category,
    _plate_label,
    _registered_teams,
    _small_group_max,
    compute_inputs_hash,
    plan_knockout_qualifiers,
    plan_plate_for_plans,
    plan_round_robin,
    plan_single_elimination,
)
from apps.fixtures.services.scheduler import (
    build_schedule_inputs,
    config_from_dict,
    merge_stored_constraints,
    resolve_team_tags,
    schedule_matches,
    stored_activated_reserve_days,
)
from apps.tournaments.services.sports import leaf_label, sport_for_leaf


def stored_venue_records(tournament) -> list[dict[str, Any]]:
    """The workspace's stored Venue pool as scheduler venue records — the
    same fallback ``ScheduleFixturesView`` applies when a run names no
    venues, so preview ≡ commit on resources too."""
    from apps.fixtures.models import Venue

    return [
        {"name": v.name, "venue_type": v.venue_type,
         "windows": v.windows, "count": v.count}
        for v in Venue.objects.filter(
            organization=tournament.organization, deleted_at__isnull=True
        ).order_by("name")
    ]


def _with_plate(
    plans: list[MatchPlan], cfg: dict[str, Any], sports_cfg,
    leaf_key: str | None, sport: str, warnings: list,
) -> list[MatchPlan]:
    """Append the consolation-plate plans (increment M) when the effective
    config asks for them — preview ≡ commit on the plate too (tenet 3)."""
    if not cfg.get("plate"):
        return plans
    return plans + plan_plate_for_plans(
        plans, leaf_key=leaf_key or "", sport=sport,
        label=_plate_label(sports_cfg, leaf_key), warnings=warnings,
    )


def _plan_for_config(
    tournament, leaf_key: str | None, cfg: dict[str, Any],
    *, seed: int | None, warnings: list,
) -> list[MatchPlan]:
    """Mirror ``GenerateFixturesView``'s dispatch over the PURE plan_* core
    (spec §4.5 layering already resolved into ``cfg``)."""
    from apps.teams.models import Team, TeamStatus

    fmt = str(cfg.get("format") or "round_robin")
    seeding = str(cfg.get("seeding") or "registration")
    sports_cfg = tournament.sports or []
    sport = sport_for_leaf(sports_cfg, leaf_key or "")

    if fmt == "knockout":
        teams_qs = Team.objects.filter(
            tournament=tournament, status=TeamStatus.REGISTERED,
            deleted_at__isnull=True,
        )
        if leaf_key:
            teams_qs = teams_qs.filter(leaf_key=leaf_key)
        teams = list(teams_qs.order_by("seed", "name"))
        plans = plan_single_elimination(
            teams, stage="knockout", leaf_key=leaf_key or "", sport=sport,
            third_place=bool(cfg.get("third_place")),
            seeding=seeding, seed=seed,
            separators=_keep_apart_separators(
                tournament, teams, leaf_key or "", sport, warnings,
            ),
            warnings=warnings,
        )
        return _with_plate(plans, cfg, sports_cfg, leaf_key, sport, warnings)
    if fmt == "knockout_from_groups":
        teams = plan_knockout_qualifiers(
            tournament, advance_per_group=int(cfg["advance_per_group"]),
            leaf_key=leaf_key,
            advance_best_thirds=int(cfg.get("advance_best_thirds") or 0),
            knockout_seeding=str(cfg.get("knockout_seeding") or "cross"),
            warnings=warnings,
        )
        plans = plan_single_elimination(
            teams, stage="knockout", leaf_key=leaf_key or "", sport=sport,
            third_place=bool(cfg.get("third_place")),
            separators=_keep_apart_separators(
                tournament, teams, leaf_key or "", sport, warnings,
            ),
            warnings=warnings,
        )
        return _with_plate(plans, cfg, sports_cfg, leaf_key, sport, warnings)
    if fmt == "by_category":
        plans, _skipped = _plan_by_category(
            tournament, leaf_key, legs=int(cfg["legs"]),
            seeding=seeding, seed=seed, warnings=warnings,
        )
        return plans
    # "round_robin" and "groups_knockout" both draw the group stage now (the
    # knockout is advanced later via format="knockout_from_groups").
    teams = _registered_teams(tournament, leaf_key)
    return plan_round_robin(
        teams,
        group_size=int(cfg["group_size"]),
        leaf_key=leaf_key or "",
        sport=sport,
        label_prefix=f"{leaf_label(sports_cfg, leaf_key)} — " if leaf_key else "",
        legs=int(cfg["legs"]), seeding=seeding, seed=seed,
        small_group_max=_small_group_max(tournament),
        separators=_keep_apart_separators(
            tournament, teams, leaf_key or "", sport, warnings,
        ),
        warnings=warnings,
    )


def _side_payload(team_id, source) -> dict[str, Any]:
    if team_id is not None:
        return {"team_id": str(team_id)}
    src = dict(source or {"type": "tbd"})
    if "ref" in src:
        src = {"type": src["type"], "ref": f"p{src['ref'] + 1}"}
    return {"source": src}


def _fairness(
    assignments: dict[str, tuple[datetime, str]], reqs, cfg,
) -> dict[str, Any]:
    """The §5.2 fairness block: per-team minimum rest, venue spread, days."""
    by_req = {r.id: r for r in reqs}
    team_intervals: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)
    venue_distribution: dict[str, int] = defaultdict(int)
    days: set = set()
    for rid, (start, venue) in assignments.items():
        req = by_req.get(rid)
        dur = timedelta(minutes=(req.duration_minutes if req and
                                 req.duration_minutes else cfg.slot_minutes))
        venue_distribution[venue] += 1
        days.add(start.date())
        for tid in ((req.home, req.away) if req else ()):
            if tid:
                team_intervals[tid].append((start, start + dur))
    rest_min_by_team: dict[str, int] = {}
    for tid, intervals in team_intervals.items():
        if len(intervals) < 2:
            continue
        intervals.sort()
        rest_min_by_team[tid] = int(min(
            (intervals[i + 1][0] - intervals[i][1]).total_seconds() // 60
            for i in range(len(intervals) - 1)
        ))
    return {
        "rest_min_by_team": rest_min_by_team,
        "venue_distribution": dict(venue_distribution),
        "days_used": len(days),
    }


def preview_fixtures(
    *, tournament, leaf_key: str | None = None,
    draw: dict[str, Any] | None = None,
    schedule: dict[str, Any] | None = None,
    include_schedule: bool = True,
) -> dict[str, Any]:
    """Simulate generate (+ optionally schedule) for one competition scope.

    Effective configs resolve exactly as the real endpoints would (defaults <
    legacy rules < draw_config["*"] < draw_config[leaf] < ``draw`` overrides;
    ``schedule`` overrides else the stored ``scheduling_config``, with the
    stored Venue pool as the resource fallback). Returns the §5.2 body —
    including the ``seed`` Accept must replay and the ``expected_inputs_hash``
    guard value. Raises ValueError on bad config (the view maps it to 400).
    """
    cfg = effective_draw_config(tournament, leaf_key, overrides=draw)
    seeding = str(cfg.get("seeding") or "registration")
    seed = int(cfg["seed"]) if cfg.get("seed") is not None else None
    if seeding == "random" and seed is None:
        seed = _new_seed()  # returned for replay — never persisted here

    warnings: list[dict[str, Any]] = []
    plans = _plan_for_config(
        tournament, leaf_key, cfg, seed=seed, warnings=warnings,
    )

    assignments: dict[str, tuple[datetime, str]] = {}
    unscheduled: list[str] = []
    violations: list[dict[str, Any]] = []
    soft_score: float | None = None
    fairness: dict[str, Any] = {}
    explanation: list[str] = []
    if include_schedule:
        payload = dict(schedule or {}) or dict(tournament.scheduling_config or {})
        if not payload.get("venues"):
            stored = stored_venue_records(tournament)
            if stored:
                payload["venues"] = stored
        sched_cfg = config_from_dict(payload)  # ValueError → 400 in the view
        # In-use reserve days stay on the calendar in preview too
        # (increment D — preview ≡ commit, tenet 3).
        sched_cfg.activated_reserve_days |= stored_activated_reserve_days(
            tournament
        )
        resolve_team_tags(sched_cfg, tournament)
        explanation = merge_stored_constraints(sched_cfg, tournament.constraints)
        reqs, preoccupied, linked = build_schedule_inputs(
            tournament, sched_cfg, leaf_key=leaf_key, plans=plans,
        )
        result = schedule_matches(
            reqs, sched_cfg, preoccupied=preoccupied, linked=linked,
        )
        assignments = result.assignments
        unscheduled = result.unscheduled
        violations = result.violations
        soft_score = result.soft_score
        explanation = explanation + result.explanation
        fairness = _fairness(assignments, reqs, sched_cfg)

    matches: list[dict[str, Any]] = []
    for p in plans:
        rid = f"p{p.ref + 1}"
        slot = assignments.get(rid)
        matches.append({
            "ref": rid,
            "leaf_key": p.leaf_key,
            "stage": p.stage,
            "group_label": p.group_label,
            "round_no": p.round_no,
            "home": _side_payload(p.home_team_id, p.home_source),
            "away": _side_payload(p.away_team_id, p.away_source),
            # Tournament-local wall clock (invariant 14) — naive ISO string.
            "scheduled_at": slot[0].isoformat() if slot else None,
            "venue": slot[1] if slot else None,
        })

    return {
        "matches": matches,
        "unscheduled": unscheduled,
        "violations": violations,
        "soft_score": soft_score,
        "fairness": fairness,
        "seed": seed,
        "inputs_hash": compute_inputs_hash(tournament, leaf_key),
        "warnings": warnings,
        "explanation": explanation,
        "leaf_key": leaf_key or "",
    }
