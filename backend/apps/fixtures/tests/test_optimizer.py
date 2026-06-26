"""R12 schedule optimizer (spec 2026-06-08 §3 seam).

The greedy ``schedule_matches`` is the SEED; ``optimize_schedule`` only adopts a
rearrangement that is hard-legal (the engine's own ``validate_schedule`` + a
capacity check) AND scores soft >= the seed — so it can never regress. These
tests prove: off-by-default, never-worse, a real improvement on a crafted
clustered instance, output always passes the validator, pins are frozen, and the
optional CP-SAT engine produces a legal, non-worse schedule.
"""
from __future__ import annotations

from datetime import date, datetime, time

import pytest

from apps.fixtures.services.optimizer import (
    _candidates,
    assignment_quality,
    optimize_schedule,
)
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    ScopedRule,
    schedule_matches,
    validate_schedule,
)


def _cfg(**kw) -> ScheduleConfig:
    base = dict(
        date_start=date(2026, 8, 1),
        date_end=date(2026, 8, 2),
        daily_start=time(9, 0),
        daily_end=time(12, 0),
        slot_minutes=60,
        venues=["G"],
        rest_minutes=0,
        max_per_team_per_day=2,
    )
    base.update(kw)
    return ScheduleConfig(**base)


def _clustering_matches() -> list[MatchSlotReq]:
    """Two matches that both field team A. Greedy packs them chronologically
    onto day 1 (A clusters → spread penalty); the optimum spreads them across
    the two days."""
    return [
        MatchSlotReq(id="m1", round_no=1, match_no=1, home="A", away="B"),
        MatchSlotReq(id="m2", round_no=1, match_no=2, home="A", away="C"),
    ]


def test_off_by_default_returns_seed_unchanged():
    cfg = _cfg()  # optimize defaults to False
    matches = _clustering_matches()
    seed = schedule_matches(matches, cfg)
    out = optimize_schedule(seed, matches, cfg)
    assert out is seed


def test_improves_a_clustered_schedule_and_stays_legal():
    cfg = _cfg(optimize=True)
    matches = _clustering_matches()
    seed = schedule_matches(matches, cfg)
    seed_q = assignment_quality(seed.assignments, matches, cfg)
    # Greedy clustered A's two matches on day 1 → spread < 1.
    assert seed_q < 1.0

    out = optimize_schedule(seed, matches, cfg)
    out_q = assignment_quality(out.assignments, matches, cfg)
    assert out_q > seed_q                      # strict improvement
    assert out_q == pytest.approx(1.0)         # perfect spread reachable
    # A now plays on two different days.
    a_days = {
        dt.date() for mid, (dt, _v) in out.assignments.items()
        if mid in ("m1", "m2")
    }
    assert len(a_days) == 2
    # And the result is hard-legal by the engine's own validator.
    assert validate_schedule(out.assignments, matches, cfg) == []


def test_candidates_relax_venue_type_so_the_optimizer_matches_the_seed():
    # The optimizer searches within `_candidates`. When an indoor sport's
    # profile wants "indoor_court" but every venue is typed "ground", the type
    # filter must relax HERE too (else 0 candidates → the optimizer could never
    # hold the seed's placement). The sport allow-list still binds the venue.
    cfg = _cfg(
        optimize=True,
        venues=["Court A", "Court B"],
        venue_types={"Court A": "ground", "Court B": "ground"},
        venue_sports={"Court A": ["sepak_takraw"], "Court B": ["table_tennis"]},
    )
    matches = [
        MatchSlotReq(id="m1", round_no=1, match_no=1, home="A", away="B",
                     sport="sepak_takraw", venue_type="indoor_court"),
        MatchSlotReq(id="m2", round_no=1, match_no=2, home="C", away="D",
                     sport="sepak_takraw", venue_type="indoor_court"),
    ]
    cand = _candidates(matches, cfg)
    # every match has feasible slots, all on the sepak-bound court only
    assert all(cand[m.id] for m in matches)
    assert {v for m in matches for (_dt, v) in cand[m.id]} == {"Court A"}
    # end-to-end: a full legal placement, never stranded
    seed = schedule_matches(matches, cfg)
    out = optimize_schedule(seed, matches, cfg)
    assert validate_schedule(out.assignments, matches, cfg) == []
    assert not out.unscheduled


def test_never_worse_than_seed_on_an_already_optimal_instance():
    cfg = _cfg(optimize=True)
    # One match → already perfect (placed + spread = 1); nothing to improve.
    matches = [MatchSlotReq(id="solo", round_no=1, match_no=1, home="A", away="B")]
    seed = schedule_matches(matches, cfg)
    out = optimize_schedule(seed, matches, cfg)
    assert out is seed


def test_output_assignment_is_always_valid_under_rest_and_capacity():
    # A denser instance with a real rest gap and a per-tournament official cap.
    cfg = _cfg(
        optimize=True, rest_minutes=30, slot_minutes=60,
        daily_end=time(15, 0),
        constraint_rules=[
            ScopedRule(type="official_capacity", scope="all", hard=True,
                       params={"count": 1}),
        ],
    )
    matches = [
        MatchSlotReq(id=f"m{i}", round_no=1, match_no=i, home=f"H{i}", away=f"A{i}")
        for i in range(4)
    ]
    seed = schedule_matches(matches, cfg)
    out = optimize_schedule(seed, matches, cfg)
    assert validate_schedule(out.assignments, matches, cfg) == []
    # official_capacity=1 ⇒ no two scheduled matches overlap in time at all.
    from itertools import pairwise
    iv = sorted(
        (dt, dt.replace(hour=dt.hour + 1))
        for dt, _v in out.assignments.values()
    )
    for (_s1, e1), (s2, _e2) in pairwise(iv):
        assert s2 >= e1


def test_pinned_match_is_frozen_even_when_moving_would_improve():
    # Both round-1 matches are pinned to day 1's window. Greedy clusters team A
    # on day 1; spreading to day 2 WOULD raise the soft score, but the pin
    # forbids it — the optimizer must leave the pinned matches exactly put.
    cfg = _cfg(
        optimize=True,
        constraint_rules=[
            ScopedRule(type="round_pinned_to_window", scope="all", hard=True,
                       params={"round": 1, "date": date(2026, 8, 1),
                               "from": time(9, 0), "to": time(12, 0)}),
        ],
    )
    matches = _clustering_matches()
    seed = schedule_matches(matches, cfg)
    # Both placed on day 1 (clustered, sub-optimal spread) but pinned there.
    assert {dt.date() for dt, _v in seed.assignments.values()} == {date(2026, 8, 1)}
    out = optimize_schedule(seed, matches, cfg)
    assert out.assignments == seed.assignments


def test_validate_schedule_honors_scoped_hard_rest_and_day_cap():
    # Regression (review 2026-06-25): validate_schedule used to read only the
    # GLOBAL rest/day-cap, so the optimizer gate was blind to scoped HARD rules.
    cfg = _cfg(rest_minutes=0, max_per_team_per_day=5, daily_end=time(18, 0),
               constraint_rules=[
                   ScopedRule(type="min_rest_minutes", scope="sport:tt",
                              hard=True, params={"minutes": 120}),
                   ScopedRule(type="max_matches_per_team_per_day", scope="sport:tt",
                              hard=True, params={"count": 1}),
               ])
    matches = [
        MatchSlotReq(id="a", round_no=1, match_no=1, home="X", away="Y", sport="tt"),
        MatchSlotReq(id="b", round_no=1, match_no=2, home="X", away="Z", sport="tt"),
    ]
    # X plays 09:00–10:00 then 10:30–11:30 → 30 min rest (< scoped 120) AND two
    # tt matches same day (> scoped cap 1). Both must be flagged now.
    bad = {
        "a": (datetime(2026, 8, 1, 9, 0), "G"),
        "b": (datetime(2026, 8, 1, 10, 30), "G"),
    }
    codes = {v["code"] for v in validate_schedule(bad, matches, cfg)}
    assert "insufficient_rest" in codes
    assert "exceeds_max_per_day" in codes


def test_optimizer_never_adopts_a_scoped_hard_rest_violation():
    # The whole safety guarantee: even with a scoped hard rest the optimizer's
    # output must be hard-legal by the engine's own validator.
    cfg = _cfg(optimize=True, rest_minutes=0, daily_end=time(18, 0),
               slot_minutes=60, max_per_team_per_day=5,
               constraint_rules=[
                   ScopedRule(type="min_rest_minutes", scope="sport:tt",
                              hard=True, params={"minutes": 120}),
               ])
    matches = [
        MatchSlotReq(id="a", round_no=1, match_no=1, home="X", away="Y", sport="tt"),
        MatchSlotReq(id="b", round_no=1, match_no=2, home="X", away="Z", sport="tt"),
        MatchSlotReq(id="c", round_no=1, match_no=3, home="P", away="Q", sport="tt"),
    ]
    seed = schedule_matches(matches, cfg)
    out = optimize_schedule(seed, matches, cfg)
    assert validate_schedule(out.assignments, matches, cfg) == []


def test_cpsat_with_unplaceable_pin_does_not_crash():
    # Regression: the CP-SAT branch indexed seed.assignments by every frozen
    # (pinned) id, KeyError-ing when the seed left a pinned match unscheduled.
    cfg = _cfg(optimize=True, optimize_engine="cpsat",
               constraint_rules=[
                   ScopedRule(type="round_pinned_to_window", scope="all", hard=True,
                              params={"round": 1, "date": date(2026, 8, 1),
                                      "from": time(9, 0), "to": time(9, 30)}),
               ])
    matches = _clustering_matches()  # 60-min matches can't fit a 30-min pin window
    seed = schedule_matches(matches, cfg)
    assert seed.unscheduled  # the pin is infeasible → seed leaves them unplaced
    out = optimize_schedule(seed, matches, cfg)  # must not raise
    assert validate_schedule(out.assignments, matches, cfg) == []


def test_cpsat_engine_is_legal_and_not_worse():
    pytest.importorskip("ortools")
    cfg = _cfg(optimize=True, optimize_engine="cpsat", optimize_seconds=3.0)
    matches = _clustering_matches()
    seed = schedule_matches(matches, cfg)
    seed_q = assignment_quality(seed.assignments, matches, cfg)
    out = optimize_schedule(seed, matches, cfg)
    out_q = assignment_quality(out.assignments, matches, cfg)
    assert out_q >= seed_q
    assert validate_schedule(out.assignments, matches, cfg) == []
    # Every match placed.
    assert set(out.assignments) == {"m1", "m2"}
