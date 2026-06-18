"""Cross-competition mutual exclusion (``no_concurrent_competitions``).

A "clash" rule names two or more competitions (sport keys or leaf keys) that
may never be live at the same moment — even on different courts — because they
share athletes, officials, a venue, or one audience (owner ask, 2026-06-18).
Members of the SAME competition still run in parallel; only matches of
*different* named members are kept apart (optionally with a transition gap).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from apps.fixtures.services.constraints import CONSTRAINT_TYPES, validate_constraints
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    merge_stored_constraints,
    schedule_matches,
    validate_schedule,
)

SAT = date(2026, 8, 1)


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=SAT, date_end=SAT,
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["A", "B"], rest_minutes=0, max_per_team_per_day=99,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _req(id, *, sport="", leaf_key="", match_no=1):
    return MatchSlotReq(id=id, round_no=1, match_no=match_no,
                        home=f"{id}-h", away=f"{id}-a",
                        sport=sport, leaf_key=leaf_key)


def _exclude(cfg, members, *, gap_minutes=0):
    merge_stored_constraints(cfg, [{
        "type": "no_concurrent_competitions",
        "params": {"members": members, "gap_minutes": gap_minutes},
    }])


# ------------------------------------------------------------------- catalog
def test_type_is_in_catalog():
    spec = next(
        (c for c in CONSTRAINT_TYPES if c["type"] == "no_concurrent_competitions"),
        None,
    )
    assert spec is not None
    assert spec["hard"] is True
    assert spec["scopes"] == ["all"]
    assert spec["layer"] == "S"


def test_validate_constraints_round_trips_members():
    out = validate_constraints([{
        "type": "no_concurrent_competitions",
        "params": {"members": ["sepak", "tt"], "gap_minutes": 15},
    }])
    assert out[0]["type"] == "no_concurrent_competitions"
    assert out[0]["params"]["members"] == ["sepak", "tt"]


# ---------------------------------------------------------------------- merge
def test_merge_emits_a_resolved_rule():
    cfg = _cfg()
    _exclude(cfg, ["sepak", "tt"])
    rules = [r for r in cfg.constraint_rules if r.type == "no_concurrent_competitions"]
    assert len(rules) == 1
    assert set(rules[0].params["members"]) == {"sepak", "tt"}


def test_merge_ignores_groups_with_fewer_than_two_members():
    cfg = _cfg()
    _exclude(cfg, ["sepak"])           # a single member can't clash with anything
    _exclude(cfg, [])                  # empty
    assert not [r for r in cfg.constraint_rules
                if r.type == "no_concurrent_competitions"]


# ------------------------------------------------------------- enforcement
def test_two_named_sports_never_overlap_even_with_free_courts():
    cfg = _cfg()  # two venues — without the rule both would land at 09:00
    _exclude(cfg, ["sepak", "tt"])
    res = schedule_matches(
        [_req("s", sport="sepak", leaf_key="sepak.u14"),
         _req("t", sport="tt", leaf_key="tt.u14", match_no=2)],
        cfg,
    )
    assert len(res.assignments) == 2
    (sa, _), (ta, _) = res.assignments["s"], res.assignments["t"]
    assert abs((ta - sa).total_seconds()) >= 3600  # one ends before the other starts


def test_same_competition_still_runs_in_parallel():
    cfg = _cfg()
    _exclude(cfg, ["sepak", "tt"])
    res = schedule_matches(
        [_req("s1", sport="sepak", leaf_key="sepak.u14"),
         _req("s2", sport="sepak", leaf_key="sepak.u14", match_no=2)],
        cfg,
    )
    starts = {dt for dt, _v in res.assignments.values()}
    assert starts == {datetime(2026, 8, 1, 9, 0)}  # both at 09:00 on the two courts


def test_transition_gap_is_respected():
    cfg = _cfg(slot_minutes=30)  # 30-min grid + 30-min matches
    _exclude(cfg, ["sepak", "tt"], gap_minutes=30)
    res = schedule_matches(
        [_req("s", sport="sepak", leaf_key="sepak.u14"),
         _req("t", sport="tt", leaf_key="tt.u14", match_no=2)],
        cfg,
    )
    starts = sorted(dt for dt, _v in res.assignments.values())
    # first 09:00-09:30; without the gap the second would slot at 09:30, but the
    # 30-min transition buffer pushes it to 10:00.
    assert starts == [datetime(2026, 8, 1, 9, 0), datetime(2026, 8, 1, 10, 0)]


def test_leaf_level_members_are_honoured():
    cfg = _cfg()
    _exclude(cfg, ["sepak.u14", "tt.u14"])  # specific leaves, not whole sports
    res = schedule_matches(
        [_req("s", sport="sepak", leaf_key="sepak.u14"),
         _req("t", sport="tt", leaf_key="tt.u14", match_no=2)],
        cfg,
    )
    starts = sorted(dt for dt, _v in res.assignments.values())
    assert starts[1] - starts[0] >= timedelta(hours=1)


def test_other_competition_already_on_calendar_blocks_a_per_leaf_run():
    # Per-leaf scheduling: the other sport's matches arrive as preoccupied
    # bookings carrying their (sport, leaf) so the rule still applies.
    cfg = _cfg()
    _exclude(cfg, ["sepak", "tt"])
    pre = [("A", datetime(2026, 8, 1, 9, 0), datetime(2026, 8, 1, 10, 0),
            [], ("sepak", "sepak.u14"))]
    res = schedule_matches(
        [_req("t", sport="tt", leaf_key="tt.u14")], cfg, preoccupied=pre,
    )
    # court B is free at 09:00 but the rule forbids overlapping the sepak booking
    assert res.assignments["t"][0] >= datetime(2026, 8, 1, 10, 0)


# ---------------------------------------------------------- repair validation
def test_validate_flags_a_manual_overlap():
    cfg = _cfg()
    _exclude(cfg, ["sepak", "tt"])
    matches = [_req("s", sport="sepak", leaf_key="sepak.u14"),
               _req("t", sport="tt", leaf_key="tt.u14", match_no=2)]
    # Manually parked overlapping on the two courts — illegal under the rule.
    assignments = {
        "s": (datetime(2026, 8, 1, 9, 0), "A"),
        "t": (datetime(2026, 8, 1, 9, 0), "B"),
    }
    codes = {v["code"] for v in validate_schedule(assignments, matches, cfg)}
    assert "concurrent_competitions" in codes
