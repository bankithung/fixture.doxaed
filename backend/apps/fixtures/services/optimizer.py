"""Schedule optimizer (R12 / spec 2026-06-08 §3 seam).

The greedy ``schedule_matches`` produces a feasible SEED. This module searches
for a higher-soft-scored arrangement of the same matches over the same slot
grid and returns it ONLY when it is provably at least as good AND at least as
legal as the seed. Concretely, a proposal is accepted only when:

  1. every candidate slot a match may take already satisfies all *single-match*
     hard constraints (venue type, sport allow-list, window fit, scoped
     blackouts / reserve days, hard windows, per-team blackout dates) — this is
     enforced at candidate-generation time, so no search move can violate them;
  2. the COMPLETE proposal passes ``validate_schedule`` (venue overlap, team
     rest/overlap, per-day cap, exclusion groups, shared-player links, venue
     off-days, finals venue pins) — the engine's own hard-constraint oracle;
  3. ``official_capacity`` holds (the one multi-match constraint not covered by
     ``validate_schedule``) — checked here; and
  4. its soft score is >= the seed's.

Because acceptance is gated on the engine's OWN validator, the worst case is
exactly today's greedy schedule. Matches under a round/venue pin are frozen at
their seed slot (their pin windows are scarce and ``validate_schedule`` does not
re-check pin *times*), so the optimizer never disturbs a pinned final.

Two engines share the gate: a dependency-free local search (default) and an
optional CP-SAT/OR-Tools proposer (``optimize_engine="cpsat"``) whose output is
fed through the identical gate and then polished by local search. If OR-Tools is
absent or its model is infeasible, the run degrades silently to local search.
"""
from __future__ import annotations

import random
import time as _time
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from apps.fixtures.services.constraints import DEFAULT_WEIGHT, scope_matches
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    Preoccupied,
    ScheduleConfig,
    ScheduleResult,
    ScopedRule,
    _score_soft,
    build_slots,
    exclusion_member,
    expand_venues,
    resolve_pinned_rounds,
    validate_schedule,
)

# Default local-search effort when no wall-clock budget is given. Bounded so a
# big tournament can't stall a request; the wizard can pass optimize_seconds.
_DEFAULT_ITERS = 4000


def _teams(m: MatchSlotReq) -> list[str]:
    return [t for t in (m.home, m.away) if t]


def _dur(m: MatchSlotReq, cfg: ScheduleConfig) -> timedelta:
    return timedelta(minutes=m.duration_minutes or cfg.slot_minutes)


# ----------------------------------------------------------------- soft scoring
def assignment_quality(
    assignments: dict[str, tuple[datetime, str]],
    matches: list[MatchSlotReq],
    cfg: ScheduleConfig,
    *,
    preoccupied: Preoccupied | None = None,
) -> float:
    """Re-score a complete assignment with the engine's ``_score_soft`` blend
    (placed-ratio + day-spread + weighted soft-window satisfaction). Seed and
    proposal are both scored through THIS function, so the comparison is
    self-consistent regardless of how the greedy tracked its own window stats."""
    if not assignments:
        return 0.0
    by_id = {m.id: m for m in matches}
    team_busy: dict[str, list[tuple[datetime, datetime]]] = defaultdict(list)
    for mid, (dt, _venue) in assignments.items():
        m = by_id.get(mid)
        if not m:
            continue
        end = dt + _dur(m, cfg)
        for t in _teams(m):
            team_busy[t].append((dt, end))
    for booking in preoccupied or []:
        start, end, team_ids = booking[1], booking[2], booking[3]
        for t in team_ids:
            team_busy[t].append((start, end))

    soft_windows = [
        r for r in cfg.constraint_rules
        if r.type in ("preferred_window", "category_session_window") and not r.hard
    ]
    achieved = achievable = 0.0
    for mid, (dt, _venue) in assignments.items():
        m = by_id.get(mid)
        if not m:
            continue
        tkey = tuple(_teams(m))
        m_achievable = 2.0 if cfg.preferred_windows else 0.0
        m_hit = 2.0 if _preferred_hit(cfg, dt) else 0.0
        for r in soft_windows:
            if scope_matches(r.scope, sport=m.sport, leaf_key=m.leaf_key,
                             team_ids=tkey, team_tags=cfg.team_tags):
                w = 2.0 * r.weight / DEFAULT_WEIGHT
                m_achievable += w
                if _in_window(r, dt):
                    m_hit += w
        achieved += m_hit
        achievable += m_achievable

    window_sat = [achieved, achievable] if achievable > 0 else None
    score, _notes = _score_soft(
        assignments, team_busy, cfg, len(matches), window_sat
    )
    return score


def _preferred_hit(cfg: ScheduleConfig, dt: datetime) -> bool:
    return bool(cfg.preferred_windows) and any(
        w_start <= dt.time() < w_end for w_start, w_end in cfg.preferred_windows
    )


def _in_window(r: ScopedRule, dt: datetime) -> bool:
    days = r.params.get("days")
    if days and dt.weekday() not in days:
        return False
    return bool(r.params["from"] <= dt.time() < r.params["to"])


# ------------------------------------------------------ single-match candidates
def _single_match_ok(
    m: MatchSlotReq, dt: datetime, venue: str, end: datetime,
    cfg: ScheduleConfig, base_of: dict[str, str],
    scoped_blackout: list[ScopedRule], recurring_scoped: list[ScopedRule],
    reserve_scoped: list[ScopedRule], hard_windows: list[ScopedRule],
) -> bool:
    """Every per-match hard constraint that does NOT depend on other in-run
    matches (mirrors the single-match half of ``schedule_matches.feasible``).
    Slots already come from ``build_slots`` (calendar windows, all-scope cuts,
    per-venue off-days), so this layers on the type/scope/window checks."""
    base = base_of.get(venue, venue)
    if m.venue_type:
        vt = cfg.venue_types.get(base, "")
        if vt and vt != m.venue_type:
            return False
    allowed = cfg.venue_sports.get(base)
    if allowed and m.sport and m.sport not in allowed:
        return False
    teams = _teams(m)
    tkey = tuple(teams)

    def _scope(r: ScopedRule) -> bool:
        return scope_matches(r.scope, sport=m.sport, leaf_key=m.leaf_key,
                             team_ids=tkey, team_tags=cfg.team_tags)

    for r in scoped_blackout:
        if dt.date() in r.params["dates"] and _scope(r):
            return False
    for r in recurring_scoped:
        if _scope(r):
            days = r.params.get("days")
            if days is None or dt.weekday() in days:
                ws = datetime.combine(dt.date(), r.params["from"])
                we = datetime.combine(dt.date(), r.params["to"])
                if dt < we and ws < end:
                    return False
    for r in reserve_scoped:
        if dt.date() in r.params["dates"] and _scope(r):
            return False
    for r in hard_windows:
        if _scope(r):
            days = r.params.get("days")
            if days and dt.weekday() not in days:
                return False
            if not (dt.time() >= r.params["from"]
                    and end <= datetime.combine(dt.date(), r.params["to"])):
                return False
    for t in teams:
        if dt.date() in cfg.team_blackouts.get(t, ()):
            return False
    return True


def _candidates(
    matches: list[MatchSlotReq], cfg: ScheduleConfig,
) -> dict[str, list[tuple[datetime, str]]]:
    """Per-match list of (start, venue) slots that satisfy every single-match
    hard constraint — the search space the optimizer moves within."""
    slots = build_slots(cfg)
    base_of = dict(expand_venues(cfg))
    rules = cfg.constraint_rules
    scoped_blackout = [r for r in rules if r.type == "blackout_dates" and r.hard]
    recurring_scoped = [
        r for r in rules
        if r.type == "recurring_blackout_window" and r.hard and r.scope != "all"
    ]
    reserve_scoped = [r for r in rules if r.type == "reserve_days" and r.scope != "all"]
    hard_windows = [
        r for r in rules
        if r.type in ("preferred_window", "category_session_window") and r.hard
    ]
    out: dict[str, list[tuple[datetime, str]]] = {}
    for m in matches:
        dur = _dur(m, cfg)
        cand: list[tuple[datetime, str]] = []
        for start, venue, wend in slots:
            end = start + dur
            if end > wend:
                continue
            if _single_match_ok(m, start, venue, end, cfg, base_of,
                                 scoped_blackout, recurring_scoped,
                                 reserve_scoped, hard_windows):
                cand.append((start, venue))
        out[m.id] = cand
    return out


# ------------------------------------------------------------- capacity gate
def _max_concurrency(intervals: list[tuple[datetime, datetime]]) -> int:
    """Peak number of simultaneously-running intervals (sweep line)."""
    if not intervals:
        return 0
    events: list[tuple[datetime, int]] = []
    for s, e in intervals:
        events.append((s, 1))
        events.append((e, -1))
    events.sort(key=lambda x: (x[0], x[1]))
    cur = peak = 0
    for _t, delta in events:
        cur += delta
        peak = max(peak, cur)
    return peak


def _capacity_ok(
    assignments: dict[str, tuple[datetime, str]],
    matches: list[MatchSlotReq],
    cfg: ScheduleConfig,
    *,
    preoccupied: Preoccupied | None = None,
) -> bool:
    """``official_capacity`` is the one multi-match hard constraint
    ``validate_schedule`` does not cover; check peak concurrency per scope."""
    caps = [r for r in cfg.constraint_rules if r.type == "official_capacity"]
    if not caps:
        return True
    by_id = {m.id: m for m in matches}
    placed: list[tuple[datetime, datetime, str, str]] = []
    for mid, (dt, _v) in assignments.items():
        m = by_id.get(mid)
        if m:
            placed.append((dt, dt + _dur(m, cfg), m.sport, m.leaf_key))
    pre: list[tuple[datetime, datetime]] = []
    for booking in preoccupied or []:
        pre.append((booking[1], booking[2]))
    for r in caps:
        cap = int(r.params.get("count") or 0)
        if cap < 1:
            continue
        ivals = [
            (s, e) for s, e, sp, lf in placed
            if scope_matches(r.scope, sport=sp, leaf_key=lf)
        ]
        if r.scope == "all":
            ivals += pre
        if _max_concurrency(ivals) > cap:
            return False
    return True


def _legal(
    assignments: dict[str, tuple[datetime, str]],
    matches: list[MatchSlotReq], cfg: ScheduleConfig,
    *, preoccupied: Preoccupied | None, linked: dict[str, set[str]] | None,
) -> bool:
    """Full hard-constraint gate: the engine's validator + the capacity check.
    (Single-match constraints are guaranteed by candidate generation.)"""
    if validate_schedule(assignments, matches, cfg,
                         preoccupied=preoccupied, linked=linked):
        return False
    return _capacity_ok(assignments, matches, cfg, preoccupied=preoccupied)


# ------------------------------------------------------------- local search
def _local_search(
    seed: dict[str, tuple[datetime, str]],
    movable: list[str],
    candidates: dict[str, list[tuple[datetime, str]]],
    matches: list[MatchSlotReq],
    cfg: ScheduleConfig,
    *,
    preoccupied: Preoccupied | None,
    linked: dict[str, set[str]] | None,
    iters: int,
    seconds: float,
    rng: random.Random,
) -> dict[str, tuple[datetime, str]]:
    """Hill-climb from the seed: each step relocates a movable match (or places
    an unscheduled one) to a random candidate slot, keeping the change only when
    the full proposal is legal AND its soft score does not drop. Deterministic
    under a fixed ``rng`` + ``iters``; ``seconds`` (>0) adds a wall-clock cap."""
    cur = dict(seed)
    best = dict(cur)
    best_q = assignment_quality(best, matches, cfg, preoccupied=preoccupied)
    placeable = [mid for mid in movable if candidates.get(mid)]
    if not placeable:
        return best
    deadline = _time.monotonic() + seconds if seconds > 0 else None
    for i in range(iters):
        if deadline is not None and i % 64 == 0 and _time.monotonic() > deadline:
            break
        mid = rng.choice(placeable)
        slot = rng.choice(candidates[mid])
        if cur.get(mid) == slot:
            continue
        prev = cur.get(mid)
        cur[mid] = slot
        if _legal(cur, matches, cfg, preoccupied=preoccupied, linked=linked):
            q = assignment_quality(cur, matches, cfg, preoccupied=preoccupied)
            if q >= best_q:
                if q > best_q:
                    best_q = q
                    best = dict(cur)
                continue  # keep the (equal-or-better) move as the new current
        # reject: restore
        if prev is None:
            cur.pop(mid, None)
        else:
            cur[mid] = prev
    return best


# ------------------------------------------------------------- CP-SAT proposer
def _cpsat_propose(
    movable: list[str],
    fixed: dict[str, tuple[datetime, str]],
    candidates: dict[str, list[tuple[datetime, str]]],
    matches: list[MatchSlotReq],
    cfg: ScheduleConfig,
    *,
    preoccupied: Preoccupied | None,
    seconds: float,
) -> dict[str, tuple[datetime, str]] | None:
    """Optional OR-Tools CP-SAT model over per-match candidate slots: pick at
    most one slot per movable match, forbidding same-venue / same-team /
    exclusion overlaps and per-day caps, maximizing placements then soft
    preference. Returns an assignment (movable + fixed) or None when OR-Tools is
    unavailable or the model is infeasible. The result still passes through the
    shared legality gate, so a modeling gap can only cost a fallback."""
    try:
        from ortools.sat.python import cp_model
    except ImportError:
        return None

    by_id = {m.id: m for m in matches}
    model = cp_model.CpModel()
    # x[(mid, idx)] = this match takes candidate idx.
    x: dict[tuple[str, int], Any] = {}
    placed_lits: dict[str, list[Any]] = defaultdict(list)
    # Interval metadata per chosen candidate for conflict posting.
    info: list[tuple[Any, str, datetime, datetime, str]] = []  # lit, mid, s, e, venue
    for mid in movable:
        cands = candidates.get(mid) or []
        if not cands:
            continue
        m = by_id[mid]
        dur = _dur(m, cfg)
        for idx, (start, venue) in enumerate(cands):
            lit = model.NewBoolVar(f"x_{mid}_{idx}")
            x[(mid, idx)] = lit
            placed_lits[mid].append(lit)
            info.append((lit, mid, start, start + dur, venue))
        model.Add(sum(placed_lits[mid]) <= 1)

    # Fixed matches (pinned/frozen) become immovable obstacles.
    fixed_iv: list[tuple[str, datetime, datetime, str, str, str]] = []
    for mid, (start, venue) in fixed.items():
        m = by_id.get(mid)
        if m:
            fixed_iv.append((mid, start, start + _dur(m, cfg), venue, m.sport, m.leaf_key))

    rest = timedelta(minutes=cfg.rest_minutes)

    def _overlap(s1, e1, s2, e2, gap=timedelta(0)) -> bool:
        return s1 < e2 + gap and s2 < e1 + gap

    # Pairwise venue / team / exclusion conflicts among candidate intervals.
    members_rules = [
        r for r in cfg.constraint_rules if r.type == "no_concurrent_competitions"
    ]
    for a in range(len(info)):
        la, mid_a, sa, ea, va = info[a]
        ma = by_id[mid_a]
        for b in range(a + 1, len(info)):
            lb, mid_b, sb, eb, vb = info[b]
            if mid_a == mid_b:
                continue
            mb = by_id[mid_b]
            conflict = False
            if va == vb and _overlap(sa, ea, sb, eb):
                conflict = True
            if not conflict and (set(_teams(ma)) & set(_teams(mb))) \
                    and _overlap(sa, ea, sb, eb, rest):
                conflict = True
            if not conflict:
                for r in members_rules:
                    mem_a = exclusion_member(r.params["members"], ma.sport, ma.leaf_key)
                    mem_b = exclusion_member(r.params["members"], mb.sport, mb.leaf_key)
                    if mem_a is not None and mem_b is not None and mem_a != mem_b:
                        g = timedelta(minutes=int(r.params.get("gap_minutes") or 0))
                        if _overlap(sa, ea, sb, eb, g):
                            conflict = True
                            break
            if conflict:
                model.Add(la + lb <= 1)

    # Candidate vs fixed obstacle conflicts (same venue, shared team within the
    # rest gap, or different exclusion member within the transition gap).
    for la, mid_a, sa, ea, va in info:
        ma = by_id[mid_a]
        a_teams = set(_teams(ma))
        for fid, fs, fe, fv, fsp, flf in fixed_iv:
            mf = by_id.get(fid)
            bad = False
            if va == fv and _overlap(sa, ea, fs, fe):
                bad = True
            if not bad and mf and (a_teams & set(_teams(mf))) \
                    and _overlap(sa, ea, fs, fe, rest):
                bad = True
            if not bad:
                for r in members_rules:
                    mem_a = exclusion_member(r.params["members"], ma.sport, ma.leaf_key)
                    mem_f = exclusion_member(r.params["members"], fsp, flf)
                    if mem_a is not None and mem_f is not None and mem_a != mem_f:
                        g = timedelta(minutes=int(r.params.get("gap_minutes") or 0))
                        if _overlap(sa, ea, fs, fe, g):
                            bad = True
                            break
            if bad:
                model.Add(la == 0)

    # Per-team per-day cap.
    cap = cfg.max_per_team_per_day
    day_lits: dict[tuple[str, date], list[Any]] = defaultdict(list)
    for la, mid_a, sa, _ea, _va in info:
        for t in _teams(by_id[mid_a]):
            day_lits[(t, sa.date())].append(la)
    for (t, _d), lits in day_lits.items():
        base = sum(
            1 for _fid, fs, _fe, _fv, _sp, _lf in fixed_iv
            if _fid and t in _teams(by_id[_fid]) and fs.date() == _d
        )
        if len(lits) + base > cap:
            model.Add(sum(lits) <= max(0, cap - base))

    # Objective: place as many as possible (big weight), then favour preferred
    # windows (scaled to integers).
    terms = []
    for la, _mid_a, sa, _ea, _va in info:
        pref = 100 if _preferred_hit(cfg, sa) else 0
        terms.append((1000 + pref) * la)
    model.Maximize(sum(terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(1.0, seconds or 5.0)
    solver.parameters.num_search_workers = 4
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    out = dict(fixed)
    for mid in movable:
        cands = candidates.get(mid) or []
        for idx, slot in enumerate(cands):
            lit = x.get((mid, idx))
            if lit is not None and solver.Value(lit) == 1:
                out[mid] = slot
                break
    return out


# ------------------------------------------------------------- orchestrator
def optimize_schedule(
    seed: ScheduleResult,
    matches: list[MatchSlotReq],
    cfg: ScheduleConfig,
    *,
    preoccupied: Preoccupied | None = None,
    linked: dict[str, set[str]] | None = None,
) -> ScheduleResult:
    """Try to improve on the greedy ``seed``. Returns an improved
    ``ScheduleResult`` when one is found that is hard-legal and soft >= the
    seed; otherwise returns the seed unchanged. Pinned matches are frozen."""
    if not cfg.optimize or not matches:
        return seed

    seed_assign = dict(seed.assignments)
    seed_q = assignment_quality(seed_assign, matches, cfg, preoccupied=preoccupied)

    # Freeze pinned matches at their seed slot (scarce windows; validator does
    # not re-check pin times). They still constrain everything else.
    pinned_rules = [
        r for r in cfg.constraint_rules if r.type == "round_pinned_to_window"
    ]
    pin_of = resolve_pinned_rounds(matches, pinned_rules, cfg) if pinned_rules else {}
    # Freeze EVERY pinned match — scheduled or not. ``validate_schedule`` does
    # not re-check pin *times*, and candidate generation does not encode pin
    # windows, so a pinned match the seed left unplaced must NOT be dropped into
    # a pin-violating slot; it simply stays as the seed left it.
    frozen = set(pin_of)
    movable = [m.id for m in matches if m.id not in frozen]

    candidates = _candidates(matches, cfg)
    # A movable match's seed slot must remain a candidate (it was legal); make
    # sure the seed slot is present so "stay put" is always an option.
    for mid in movable:
        slot = seed_assign.get(mid)
        if slot is not None and slot not in candidates.get(mid, ()):
            candidates.setdefault(mid, []).append(slot)

    rng = random.Random(20260625)  # noqa: S311 — deterministic search, not crypto
    iters = _DEFAULT_ITERS
    seconds = cfg.optimize_seconds

    proposals: list[dict[str, tuple[datetime, str]]] = []
    if cfg.optimize_engine == "cpsat":
        # A pinned match the greedy seed could not place has no fixed slot —
        # skip it (it stays unscheduled), exactly as the local path handles it.
        fixed = {mid: seed_assign[mid] for mid in frozen if mid in seed_assign}
        cp = _cpsat_propose(
            movable, fixed, candidates, matches, cfg,
            preoccupied=preoccupied, seconds=seconds or 5.0,
        )
        if cp is not None and _legal(cp, matches, cfg,
                                     preoccupied=preoccupied, linked=linked):
            proposals.append(cp)

    # Always polish the best starting point with local search.
    start = max(
        [seed_assign, *proposals],
        key=lambda a: assignment_quality(a, matches, cfg, preoccupied=preoccupied),
    )
    polished = _local_search(
        start, movable, candidates, matches, cfg,
        preoccupied=preoccupied, linked=linked,
        iters=iters, seconds=seconds, rng=rng,
    )
    proposals.append(polished)

    best = seed_assign
    best_q = seed_q
    for prop in proposals:
        if not _legal(prop, matches, cfg, preoccupied=preoccupied, linked=linked):
            continue
        q = assignment_quality(prop, matches, cfg, preoccupied=preoccupied)
        if q > best_q:
            best, best_q = prop, q

    if best is seed_assign or best_q <= seed_q:
        return seed

    unscheduled = [m.id for m in matches if m.id not in best]
    explanation = list(seed.explanation)
    gain = round((best_q - seed_q) * 100)
    explanation.append(
        f"Optimizer improved the schedule quality by {gain} point(s) "
        f"({cfg.optimize_engine})."
    )
    return ScheduleResult(
        assignments=best,
        unscheduled=unscheduled,
        soft_score=best_q,
        explanation=explanation,
        violations=seed.violations,
    )
