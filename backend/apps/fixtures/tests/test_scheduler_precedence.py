"""Audit fixes 2026-07-13: bracket precedence (a dependent never starts
before its feeders end), venue windows intersecting the daily window, the
stored min-rest constraint overriding the library default, scoped official
capacity seeing committed bookings, and the ``validate_schedule`` checks for
blackout windows / ceremonies / capacity / precedence that manual moves used
to slip past."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    ScopedRule,
    build_slots,
    config_from_dict,
    merge_stored_constraints,
    schedule_matches,
    validate_schedule,
)

D = date(2026, 8, 1)


def _cfg(**kw) -> ScheduleConfig:
    base = dict(
        date_start=D, date_end=D,
        daily_start=time(9, 0), daily_end=time(18, 0),
        slot_minutes=60, venues=["A", "B"],
        rest_minutes=30, max_per_team_per_day=10,
    )
    base.update(kw)
    return ScheduleConfig(**base)


# ------------------------------------------------------------------ precedence
def test_dependent_scheduled_after_feeder_ends():
    """A winner_of dependent must start after its feeder ends plus rest,
    even when a second venue offers the same first slot."""
    feeder = MatchSlotReq(id="f", round_no=1, match_no=1, home="t1", away="t2")
    dep = MatchSlotReq(id="d", round_no=2, match_no=2, home=None, away=None,
                       after=("f",))
    res = schedule_matches([feeder, dep], _cfg())
    f_start, _ = res.assignments["f"]
    d_start, _ = res.assignments["d"]
    assert d_start >= f_start + timedelta(minutes=60 + 30)


def test_group_position_dependent_waits_for_whole_group():
    """A knockout fed by group positions starts only after every group match."""
    g1 = MatchSlotReq(id="g1", round_no=1, match_no=1, home="t1", away="t2")
    g2 = MatchSlotReq(id="g2", round_no=2, match_no=2, home="t1", away="t3")
    ko = MatchSlotReq(id="ko", round_no=1, match_no=3, home=None, away=None,
                      stage_no=1, after=("g1", "g2"))
    res = schedule_matches([g1, g2, ko], _cfg())
    last_group_end = max(
        res.assignments["g1"][0], res.assignments["g2"][0]
    ) + timedelta(minutes=60)
    assert res.assignments["ko"][0] >= last_group_end + timedelta(minutes=30)


def test_unplaced_feeder_propagates_to_dependent():
    """When the feeder cannot be placed the dependent is unplaced too, never
    parked at an arbitrary slot."""
    cfg = _cfg(daily_end=time(10, 0), venues=["A"])  # exactly one 60-min slot
    f = MatchSlotReq(id="f", round_no=1, match_no=1, home="t1", away="t2")
    g = MatchSlotReq(id="g", round_no=1, match_no=2, home="t3", away="t4")
    d = MatchSlotReq(id="d", round_no=2, match_no=3, home=None, away=None,
                     after=("g",))
    res = schedule_matches([f, g, d], cfg)
    assert "g" in res.unscheduled and "d" in res.unscheduled


def test_not_before_bound_respected():
    """A feeder committed outside the run bounds the dependent's start."""
    bound = datetime.combine(D, time(14, 0))
    dep = MatchSlotReq(id="d", round_no=1, match_no=1, home=None, away=None,
                       not_before=bound)
    res = schedule_matches([dep], _cfg())
    assert res.assignments["d"][0] >= bound + timedelta(minutes=30)


def test_validate_flags_inverted_bracket():
    ms = [
        MatchSlotReq(id="f", round_no=1, match_no=1, home="t1", away="t2"),
        MatchSlotReq(id="d", round_no=2, match_no=2, home=None, away=None,
                     after=("f",)),
    ]
    cfg = _cfg()
    bad = {
        "f": (datetime.combine(D, time(12, 0)), "A"),
        "d": (datetime.combine(D, time(9, 0)), "B"),   # before its semi
    }
    codes = {v["code"] for v in validate_schedule(bad, ms, cfg)}
    assert "predecessor_order" in codes
    good = {
        "f": (datetime.combine(D, time(9, 0)), "A"),
        "d": (datetime.combine(D, time(12, 0)), "B"),
    }
    assert not [
        v for v in validate_schedule(good, ms, cfg)
        if v["code"] == "predecessor_order"
    ]


# ------------------------------------------------------------- venue windows
def test_venue_window_intersects_daily_window():
    """A venue window may narrow the daily window but never extend past it."""
    cfg = _cfg(
        daily_start=time(9, 0), daily_end=time(12, 0), venues=["A"],
        venue_windows={"A": [(time(8, 0), time(16, 0))]},
    )
    slots = build_slots(cfg)
    assert slots, "window intersection must not empty a valid overlap"
    for dt, _venue, wend in slots:
        assert dt.time() >= time(9, 0)
        assert wend.time() <= time(12, 0)


# ------------------------------------------------------------------ min rest
def test_stored_min_rest_lowers_library_default():
    cfg = config_from_dict({"date_start": D.isoformat()})
    merge_stored_constraints(cfg, [{
        "type": "min_rest_minutes", "scope": "all", "hard": True,
        "params": {"minutes": 20},
    }])
    assert cfg.rest_minutes == 20


def test_explicit_payload_rest_beats_smaller_stored_value():
    cfg = config_from_dict({"date_start": D.isoformat(), "rest_minutes": 45})
    merge_stored_constraints(cfg, [{
        "type": "min_rest_minutes", "scope": "all", "hard": True,
        "params": {"minutes": 20},
    }])
    assert cfg.rest_minutes == 45


def test_stored_min_rest_still_raises_over_explicit_payload():
    cfg = config_from_dict({"date_start": D.isoformat(), "rest_minutes": 45})
    merge_stored_constraints(cfg, [{
        "type": "min_rest_minutes", "scope": "all", "hard": True,
        "params": {"minutes": 90},
    }])
    assert cfg.rest_minutes == 90


# ------------------------------------------------------- capacity + bookings
def test_scoped_capacity_counts_committed_bookings():
    """A per-leaf run must not stack a 2nd concurrent match of a capped sport
    on top of another leaf's already-committed match."""
    cfg = _cfg(venues=["A", "B", "C"])
    cfg.constraint_rules.append(ScopedRule(
        "official_capacity", "sport:tt", True, 5, {"count": 1},
    ))
    booked = (
        "C", datetime.combine(D, time(9, 0)), datetime.combine(D, time(10, 0)),
        [], ("tt", "tt.u19.male.1v1"),
    )
    req = MatchSlotReq(id="m", round_no=1, match_no=1, home="t1", away="t2",
                       sport="tt", leaf_key="tt.u19.female.1v1")
    res = schedule_matches([req], cfg, preoccupied=[booked])
    assert res.assignments["m"][0] >= datetime.combine(D, time(10, 0))


# ------------------------------------------------- validate_schedule gaps
def test_validate_flags_blackout_window_move():
    ms = [MatchSlotReq(id="m", round_no=1, match_no=1, home="t1", away="t2")]
    cfg = _cfg()
    cfg.constraint_rules.append(ScopedRule(
        "recurring_blackout_window", "all", True, 5,
        {"from": time(12, 0), "to": time(13, 0), "days": None,
         "label": "daily_break"},
    ))
    inside = {"m": (datetime.combine(D, time(12, 30)), "A")}
    codes = {v["code"] for v in validate_schedule(inside, ms, cfg)}
    assert "blackout_window" in codes
    outside = {"m": (datetime.combine(D, time(14, 0)), "A")}
    assert not [
        v for v in validate_schedule(outside, ms, cfg)
        if v["code"] == "blackout_window"
    ]


def test_validate_flags_ceremony_block_move():
    ms = [MatchSlotReq(id="m", round_no=1, match_no=1, home="t1", away="t2")]
    cfg = _cfg()
    cfg.constraint_rules.append(ScopedRule(
        "ceremony_block", "all", True, 5,
        {"date": D, "from": time(9, 0), "to": time(10, 0),
         "label": "opening", "venues": None},
    ))
    during = {"m": (datetime.combine(D, time(9, 30)), "A")}
    codes = {v["code"] for v in validate_schedule(during, ms, cfg)}
    assert "ceremony_block" in codes


def test_validate_flags_official_capacity_breach():
    ms = [
        MatchSlotReq(id=f"m{i}", round_no=1, match_no=i,
                     home=f"t{2*i}", away=f"t{2*i+1}",
                     sport="sepak", leaf_key=f"sepak.leaf{i}")
        for i in range(3)
    ]
    cfg = _cfg(venues=["A", "B", "C"])
    cfg.constraint_rules.append(ScopedRule(
        "official_capacity", "sport:sepak", True, 5, {"count": 2},
    ))
    at = datetime.combine(D, time(9, 0))
    three = {"m0": (at, "A"), "m1": (at, "B"), "m2": (at, "C")}
    codes = {v["code"] for v in validate_schedule(three, ms, cfg)}
    assert "official_capacity_exceeded" in codes
    two = {"m0": (at, "A"), "m1": (at, "B"),
           "m2": (datetime.combine(D, time(11, 0)), "C")}
    assert not [
        v for v in validate_schedule(two, ms, cfg)
        if v["code"] == "official_capacity_exceeded"
    ]
