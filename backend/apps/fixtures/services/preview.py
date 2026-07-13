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
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any

from apps.fixtures.services.draw_config import (
    effective_draw_config,
    effective_stages,
)
from apps.fixtures.services.generate import (
    MatchPlan,
    _keep_apart_separators,
    _new_seed,
    _plan_by_category,
    _plate_label,
    _positional_qualifier_slots,
    _registered_teams,
    _small_group_max,
    _swiss_label,
    compute_inputs_hash,
    plan_double_elimination,
    plan_knockout_from_positions,
    plan_knockout_qualifiers,
    plan_plate_for_plans,
    plan_round_robin,
    plan_single_elimination,
    plan_swiss_round1,
)
from apps.fixtures.services.scheduler import (
    build_schedule_inputs,
    config_from_dict,
    merge_stored_constraints,
    resolve_team_tags,
    resolve_venue_unavailability,
    schedule_matches,
    stored_activated_reserve_days,
)
from apps.tournaments.services.sports import (
    iter_leaves,
    leaf_label,
    sport_for_leaf,
)


def stored_venue_records(tournament) -> list[dict[str, Any]]:
    """The workspace's stored Venue pool as scheduler venue records — the
    same fallback ``ScheduleFixturesView`` applies when a run names no
    venues, so preview ≡ commit on resources too."""
    from apps.fixtures.models import Venue

    return [
        {"name": v.name, "venue_type": v.venue_type,
         "windows": v.windows, "count": v.count,
         "unavailable_dates": v.unavailable_dates or [],
         "sports": v.sports or [], "breaks": v.breaks or []}
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


def _groups_knockout_params(
    cfg: dict[str, Any], stages: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Return the group-stage + qualifier params for a two-stage groups→knockout
    PREVIEW, or ``None`` if this config is not one. Handles BOTH shapes:

    * an explicit ``stages`` plan whose stage 0 is a ``round_robin`` and stage 1
      a ``knockout`` sourcing from it (``effective_stages`` returns it verbatim);
    * the flat ``format == "groups_knockout"`` (whose derived stages collapse to
      a single round_robin — Gap 2 left commit untouched on purpose — so it is
      detected straight from the flat draw_config keys).

    The knockout stays drawn only after results at COMMIT (deferred /
    eager-positional); this is the PREVIEW analogue that shows the full bracket
    up front with the eventual committed SIZE."""
    fmt = str(cfg.get("format") or "round_robin")
    seeding = str(cfg.get("seeding") or "registration")
    if (len(stages) >= 2 and stages[0].get("type") == "round_robin"
            and stages[1].get("type") == "knockout"):
        # `_validate_stages` makes a knockout the LAST stage and its `from`
        # reference an earlier stage, so a knockout at index 1 sources stage 0.
        s0, s1 = stages[0], stages[1]
        frm = s1.get("from") or {}
        return {
            "group_size": int(s0.get("group_size", cfg.get("group_size", 5))),
            "balance_groups": bool(
                s0.get("balance_groups", cfg.get("balance_groups", False))),
            "legs": int(s0.get("legs", cfg.get("legs", 1))),
            "seeding": str(s0.get("seeding", seeding)),
            "min_matches_per_team": s0.get("min_matches_per_team"),
            "advance_per_group": int(frm.get("advance_per_group", 2)),
            "advance_best_thirds": int(frm.get("advance_best_thirds", 0)),
            "third_place": bool(s1.get("third_place", False)),
        }
    if fmt == "groups_knockout":
        return {
            "group_size": int(cfg.get("group_size", 5)),
            "balance_groups": bool(cfg.get("balance_groups", False)),
            "legs": int(cfg.get("legs", 1)),
            "seeding": seeding,
            "min_matches_per_team": None,
            "advance_per_group": int(cfg.get("advance_per_group", 2)),
            "advance_best_thirds": int(cfg.get("advance_best_thirds") or 0),
            "third_place": bool(cfg.get("third_place", False)),
        }
    return None


def _plan_groups_to_knockout_preview(
    tournament, leaf_key: str | None, *, sports_cfg, sport: str,
    seed: int | None, group_size: int, balance_groups: bool, legs: int,
    seeding: str, min_matches_per_team: int | None, advance_per_group: int,
    advance_best_thirds: int, third_place: bool, warnings: list,
) -> list[MatchPlan]:
    """Preview a two-stage groups→knockout: the entry round-robin plans PLUS a
    PLACEHOLDER knockout drawn from group-position pointers, timed AFTER the
    groups via ``stage_no=1``. PURE — the placeholder bracket's group labels come
    from the PLANNED groups, never from committed ``Match`` rows (tenet 3 / the
    preview-must-not-read-or-write invariant), and only ``plan_*`` cores run.

    Bracket SIZE = ``advance_per_group * num_groups + advance_best_thirds`` — the
    eventual committed size (``generate_knockout_from_groups``). Best-thirds and
    overall-reseed need standings for their true identities/matchups, so each
    best-third is a results-free placeholder appended as a bottom seed and the
    positional cross-seed placement stands in for an overall reseed (that only
    changes matchups, not the count or the schedule)."""
    teams = _registered_teams(tournament, leaf_key)
    label_prefix = f"{leaf_label(sports_cfg, leaf_key)} · " if leaf_key else ""
    entry = plan_round_robin(
        teams, group_size=group_size, leaf_key=leaf_key or "", sport=sport,
        label_prefix=label_prefix, legs=legs, seeding=seeding, seed=seed,
        balance_groups=balance_groups,
        min_matches_per_team=min_matches_per_team,
        small_group_max=_small_group_max(tournament),
        separators=_keep_apart_separators(
            tournament, teams, leaf_key or "", sport, warnings,
        ),
        warnings=warnings,
    )
    groups = sorted({
        p.group_label for p in entry
        if p.stage == "group" and p.group_label
    })
    if not groups:
        return entry
    slots = _positional_qualifier_slots(groups, advance_per_group)
    # Best-thirds (increment N) / overall-reseed (increment O): the COUNT is the
    # committed bracket size; identities need standings, so each is a generic
    # placeholder appended as a bottom seed ("Best 3rd #k").
    for k in range(advance_best_thirds):
        slots.append({"type": "group_position", "best_third": True, "rank": k + 1})
    if len(slots) < 2:
        return entry  # not enough qualifiers to form a bracket
    knockout = plan_knockout_from_positions(
        slots, leaf_key=leaf_key or "", sport=sport, third_place=third_place,
        label_prefix=label_prefix,
    )
    for p in knockout:
        p.stage_no = 1  # times after the groups (scheduler orders by stage_no)
    # Rebase the knockout block's refs (and its winner_of/loser_of pointers) past
    # the entry plans so p{ref+1} ids stay globally unique and self-consistent.
    return entry + _rebase_plans(knockout, len(entry))


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

    # Two-stage groups→knockout (explicit `stages` OR flat `groups_knockout`):
    # preview the group stage AND a placeholder knockout with times (Gap 1/3).
    gk = _groups_knockout_params(
        cfg, effective_stages(tournament, leaf_key, cfg=cfg),
    )
    if gk is not None:
        return _plan_groups_to_knockout_preview(
            tournament, leaf_key, sports_cfg=sports_cfg, sport=sport,
            seed=seed, warnings=warnings, **gk,
        )

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
            bye_policy=str(cfg.get("bye_policy") or "seeded_byes"),
            label_prefix=f"{leaf_label(sports_cfg, leaf_key)} · " if leaf_key else "",
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
            label_prefix=f"{leaf_label(sports_cfg, leaf_key)} · " if leaf_key else "",
            separators=_keep_apart_separators(
                tournament, teams, leaf_key or "", sport, warnings,
            ),
            warnings=warnings,
        )
        return _with_plate(plans, cfg, sports_cfg, leaf_key, sport, warnings)
    if fmt == "double_elim":
        # Double elimination (increment Q): third_place/plate ignored — the
        # losers bracket is the consolation path and its final decides 3rd.
        teams_qs = Team.objects.filter(
            tournament=tournament, status=TeamStatus.REGISTERED,
            deleted_at__isnull=True,
        )
        if leaf_key:
            teams_qs = teams_qs.filter(leaf_key=leaf_key)
        teams = list(teams_qs.order_by("seed", "name"))
        return plan_double_elimination(
            teams, leaf_key=leaf_key or "", sport=sport,
            seeding=seeding, seed=seed,
            separators=_keep_apart_separators(
                tournament, teams, leaf_key or "", sport, warnings,
            ),
            warnings=warnings,
        )
    if fmt == "swiss":
        # Swiss is round-at-a-time (increment P): preview shows round 1 only
        # (later rounds depend on results, which a pure simulate cannot know).
        teams_qs = Team.objects.filter(
            tournament=tournament, status=TeamStatus.REGISTERED,
            deleted_at__isnull=True,
        )
        if leaf_key:
            teams_qs = teams_qs.filter(leaf_key=leaf_key)
        teams = list(teams_qs.order_by("seed", "name"))
        plans, _bye = plan_swiss_round1(
            teams, leaf_key=leaf_key or "", sport=sport,
            label=_swiss_label(sports_cfg, leaf_key),
            seeding=seeding, seed=seed,
        )
        return plans
    if fmt == "by_category":
        plans, _skipped = _plan_by_category(
            tournament, leaf_key, legs=int(cfg["legs"]),
            seeding=seeding, seed=seed, warnings=warnings,
        )
        return plans
    # Plain "round_robin": the group stage only ("groups_knockout" is handled
    # above, where its placeholder knockout is previewed too).
    teams = _registered_teams(tournament, leaf_key)
    return plan_round_robin(
        teams,
        group_size=int(cfg["group_size"]),
        leaf_key=leaf_key or "",
        sport=sport,
        label_prefix=f"{leaf_label(sports_cfg, leaf_key)} · " if leaf_key else "",
        legs=int(cfg["legs"]), seeding=seeding, seed=seed,
        # Thread balance_groups so the preview's group split matches the commit
        # path (views.py) — otherwise FIFA-balanced configs previewed plain
        # chunks, silently breaking preview==commit (review 2026-06-25).
        balance_groups=bool(cfg.get("balance_groups")),
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
    team_names: dict[str, str] | None = None,
) -> dict[str, Any]:
    """The §5.2 fairness block, extended with per-team analytics
    (increment R) — PURE computation over the simulated assignments:

    * ``teams``: per team — minimum/median rest minutes, early-slot count
      (start within the first 2 hours of the day's window), late-slot count
      (last 2 hours), venue spread (distinct PHYSICAL venues — sub-venues
      collapse to their base) and matches-per-day max.
    * ``flags``: outliers as stable i18n codes (§9 A5) — ``early_outlier``
      (more than 2x the median early-slot count) and ``rest_below_min``
      (minimum rest under the configured ``rest_minutes``).

    Legacy keys (``rest_min_by_team``/``venue_distribution``/``days_used``)
    stay for API back-compat."""
    from statistics import median

    from apps.fixtures.services.scheduler import expand_venues

    base_of = dict(expand_venues(cfg))
    day_anchor = datetime.combine(cfg.date_start, cfg.daily_start)
    early_cut = (day_anchor + timedelta(hours=2)).time()
    late_cut = (datetime.combine(cfg.date_start, cfg.daily_end)
                - timedelta(hours=2)).time()

    by_req = {r.id: r for r in reqs}
    team_intervals: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)
    team_venues: dict[str, set[str]] = defaultdict(set)
    team_early: dict[str, int] = defaultdict(int)
    team_late: dict[str, int] = defaultdict(int)
    team_per_day: dict[str, dict[Any, int]] = defaultdict(lambda: defaultdict(int))
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
                team_venues[tid].add(base_of.get(venue, venue))
                team_per_day[tid][start.date()] += 1
                if start.time() < early_cut:
                    team_early[tid] += 1
                if start.time() >= late_cut:
                    team_late[tid] += 1
    rest_min_by_team: dict[str, int] = {}
    rest_median_by_team: dict[str, int | float] = {}
    for tid, intervals in team_intervals.items():
        if len(intervals) < 2:
            continue
        intervals.sort()
        gaps = [
            int((intervals[i + 1][0] - intervals[i][1]).total_seconds() // 60)
            for i in range(len(intervals) - 1)
        ]
        rest_min_by_team[tid] = min(gaps)
        rest_median_by_team[tid] = median(gaps)

    names = team_names or {}
    ordered = sorted(team_intervals, key=lambda tid: (names.get(tid, ""), tid))
    teams: list[dict[str, Any]] = [
        {
            "team_id": tid,
            "name": names.get(tid, ""),
            "rest_min": rest_min_by_team.get(tid),
            "rest_median": rest_median_by_team.get(tid),
            "early": team_early.get(tid, 0),
            "late": team_late.get(tid, 0),
            "venues": len(team_venues[tid]),
            "max_per_day": max(team_per_day[tid].values(), default=0),
        }
        for tid in ordered
    ]
    flags: list[dict[str, Any]] = []
    early_median = median(e["early"] for e in teams) if teams else 0
    rest_median_all = (
        median(rest_min_by_team.values()) if rest_min_by_team else None
    )
    # An early-start outlier must be BOTH more than double the median AND a
    # meaningful absolute count. Without the floor, a median of 0 (most teams
    # never open a court) makes "> 2*median" fire for EVERY team that plays a
    # single morning match — flooding the check with "1 vs median 0" noise.
    # Opening one or two morning sessions is normal; 3+ is the real outlier.
    EARLY_OUTLIER_FLOOR = 3
    for e in teams:
        if e["early"] >= EARLY_OUTLIER_FLOOR and e["early"] > 2 * early_median:
            flags.append({
                "code": "early_outlier", "team_id": e["team_id"],
                "value": e["early"], "median": early_median,
            })
        if e["rest_min"] is not None and e["rest_min"] < cfg.rest_minutes:
            flags.append({
                "code": "rest_below_min", "team_id": e["team_id"],
                "value": e["rest_min"], "median": rest_median_all,
            })
    return {
        "teams": teams,
        "flags": flags,
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
    return _schedule_and_payload(
        tournament, plans, schedule=schedule, include_schedule=include_schedule,
        warnings=warnings, seed=seed, leaf_key=leaf_key,
    )


def _schedule_and_payload(
    tournament, plans: list[MatchPlan], *, schedule: dict[str, Any] | None,
    include_schedule: bool, warnings: list[dict[str, Any]],
    seed: int | None, leaf_key: str | None,
) -> dict[str, Any]:
    """Schedule a list of (already-planned) matches and shape the §5.2 preview
    body. Shared by the single-competition preview and the all-competitions
    preview, so both run through the SAME slot layer + payload (tenet 3)."""
    assignments: dict[str, tuple[datetime, str]] = {}
    unscheduled: list[str] = []
    violations: list[dict[str, Any]] = []
    soft_score: float | None = None
    fairness: dict[str, Any] = {}
    explanation: list[str] = []
    # ref → the match's own length in minutes (per-competition duration, the
    # value the scheduler actually blocks) so the UI can show "15 min".
    dur_by_ref: dict[str, int] = {}
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
        resolve_venue_unavailability(sched_cfg, tournament)
        explanation = merge_stored_constraints(sched_cfg, tournament.constraints)
        reqs, preoccupied, linked = build_schedule_inputs(
            tournament, sched_cfg, leaf_key=leaf_key, plans=plans,
        )
        dur_by_ref = {
            r.id: int(r.duration_minutes or sched_cfg.slot_minutes) for r in reqs
        }
        result = schedule_matches(
            reqs, sched_cfg, preoccupied=preoccupied, linked=linked,
        )
        assignments = result.assignments
        unscheduled = result.unscheduled
        violations = result.violations
        soft_score = result.soft_score
        explanation = explanation + result.explanation
        from apps.teams.models import Team

        team_names = {
            str(tid): name
            for tid, name in Team.objects.filter(
                tournament=tournament, deleted_at__isnull=True
            ).values_list("id", "name")
        }
        fairness = _fairness(assignments, reqs, sched_cfg,
                             team_names=team_names)

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
            "duration_minutes": dur_by_ref.get(rid),
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


def _rebase_plans(plans: list[MatchPlan], base: int) -> list[MatchPlan]:
    """Shift each plan's ``ref`` (and any winner_of/loser_of source pointer that
    references a sibling plan) by ``base`` so plans concatenated from several
    competitions get globally-unique scheduler ids (``p{ref+1}``) — no id
    collisions when the all-competitions preview schedules every leaf together.
    Group/round-robin draws have no such pointers; knockout sources do."""
    if base == 0:
        return plans

    def _shift(src: Any) -> Any:
        if (isinstance(src, dict)
                and src.get("type") in ("winner_of", "loser_of")
                and isinstance(src.get("ref"), int)):
            return {**src, "ref": src["ref"] + base}
        return src

    return [
        replace(p, ref=p.ref + base,
                home_source=_shift(p.home_source),
                away_source=_shift(p.away_source))
        for p in plans
    ]


def preview_all_fixtures(
    *, tournament, schedule: dict[str, Any] | None = None,
    include_schedule: bool = True,
) -> dict[str, Any]:
    """Combined dry-run across EVERY competition (all sports + categories).

    Each leaf's draw is planned with its OWN effective format, then ALL of them
    are scheduled together in one run — so shared courts, official capacity and
    cross-sport clash rules are coordinated globally (publishing one competition
    at a time only sees the already-committed ones). Persists nothing — the same
    simulate-only contract as ``preview_fixtures``. The ``matches`` array spans
    every competition (each row carries its ``leaf_key``)."""
    leaves = iter_leaves(tournament.sports or [])
    warnings: list[dict[str, Any]] = []
    all_plans: list[MatchPlan] = []
    per_leaf_seed: dict[str, int | None] = {}
    base = 0
    for lf in leaves:
        lk = lf["leaf_key"]
        cfg = effective_draw_config(tournament, lk)
        seeding = str(cfg.get("seeding") or "registration")
        seed = int(cfg["seed"]) if cfg.get("seed") is not None else None
        if seeding == "random" and seed is None:
            seed = _new_seed()
        try:
            plans = _plan_for_config(
                tournament, lk, cfg, seed=seed, warnings=warnings,
            )
        except (ValueError, TypeError):
            # e.g. fewer than 2 registered teams — nothing to draw for this
            # competition yet. Surface it (C11): a silently absent competition
            # let organizers publish believing everything was drawn.
            warnings.append({"code": "skipped_leaf", "leaf_key": lk})
            continue
        per_leaf_seed[lk] = seed
        all_plans.extend(_rebase_plans(plans, base))
        base += len(plans)

    payload = _schedule_and_payload(
        tournament, all_plans, schedule=schedule,
        include_schedule=include_schedule, warnings=warnings,
        seed=None, leaf_key=None,
    )
    payload["per_leaf_seed"] = per_leaf_seed
    # Drift guard inputs for publish-all (C11): the stored-state hash per
    # previewed leaf, so Accept can 409 when anything changed since preview
    # (mirroring the single-leaf expected_inputs_hash contract).
    payload["per_leaf_inputs_hash"] = {
        lk: compute_inputs_hash(tournament, lk or None) for lk in per_leaf_seed
    }
    payload["competitions"] = len(leaves)
    return payload
