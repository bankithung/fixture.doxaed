"""Scheduler upgrades (redesign spec §4.7 / §9 A2-A5): subtractive slot grid
(recurring blackout windows, ceremony blocks, reserve days), Venue.count
sub-venue expansion with the bare-name absorption rule, pinned-rounds-first
placement, official_capacity concurrency caps, tunable person-overlap gaps,
and structured violations with stable i18n codes + concrete relaxations."""
from __future__ import annotations

import json
from datetime import date, datetime, time

from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    build_slots,
    config_from_dict,
    merge_stored_constraints,
    schedule_matches,
)

# Aug 2026: the 1st is a Saturday, the 2nd a Sunday, the 3rd a Monday.
SAT, SUN, MON = date(2026, 8, 1), date(2026, 8, 2), date(2026, 8, 3)


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=SAT, date_end=SAT,
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["A"], rest_minutes=0, max_per_team_per_day=99,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _req(id, *, sport="", leaf_key="", stage="", round_no=1, match_no=1,
         home=None, away=None):
    return MatchSlotReq(id=id, round_no=round_no, match_no=match_no,
                        home=home if home is not None else f"{id}-h",
                        away=away if away is not None else f"{id}-a",
                        sport=sport, leaf_key=leaf_key, stage=stage)


# ------------------------------------------------------------ subtractive grid
def test_recurring_blackout_window_subtracts_matching_weekdays():
    cfg = _cfg(date_start=SAT, date_end=SUN)
    merge_stored_constraints(cfg, [
        {"type": "recurring_blackout_window",
         "params": {"days": ["sun"], "from": "06:00", "to": "13:00"}},
    ])
    slots = build_slots(cfg)
    sunday = [dt for dt, _v, _w in slots if dt.date() == SUN]
    assert sunday and all(dt.time() >= time(13, 0) for dt in sunday)
    saturday = [dt for dt, _v, _w in slots if dt.date() == SAT]
    assert any(dt.time() == time(9, 0) for dt in saturday)  # Saturday untouched


def test_recurring_blackout_days_null_means_every_day():
    cfg = _cfg(slot_minutes=90)
    merge_stored_constraints(cfg, [
        {"type": "recurring_blackout_window",
         "params": {"from": "12:00", "to": "14:00"}},  # daily lunch break
    ])
    starts = [dt.time() for dt, _v, _w in build_slots(cfg)]
    assert all(not (time(12, 0) <= s < time(14, 0)) for s in starts)
    assert time(14, 0) in starts  # the window re-opens exactly at the cut end
    # a match can't straddle into the cut: 10:30 + 90' = 12:00 fits, but the
    # 90' grid start at 11:00 inside (9:00-12:00) would end 12:30 — the
    # sub-window end caps it, so feasibility rejects it.
    res = schedule_matches(
        [_req("m1"), _req("m2", match_no=2), _req("m3", match_no=3)], cfg
    )
    for dt, _v in res.assignments.values():
        assert not (time(12, 0) <= dt.time() < time(14, 0))


def test_scoped_recurring_blackout_only_blocks_matching_sport():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "recurring_blackout_window", "scope": "sport:football",
         "params": {"from": "09:00", "to": "13:00"}},
    ])
    res = schedule_matches([
        _req("fb", sport="football"), _req("tt", sport="table_tennis", match_no=2),
    ], cfg)
    assert res.assignments["fb"][0].time() >= time(13, 0)
    assert res.assignments["tt"][0].time() == time(9, 0)


def test_ceremony_block_removes_grid_for_its_venues():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "ceremony_block",
         "params": {"date": "2026-08-01", "from": "09:00", "to": "11:00",
                    "venues": ["A"]}},
    ])
    slots = build_slots(cfg)
    a_starts = [dt.time() for dt, v, _w in slots if v == "A" and dt.date() == SAT]
    assert all(s >= time(11, 0) for s in a_starts)
    b_starts = [dt.time() for dt, v, _w in slots if v == "B"]
    assert time(9, 0) in b_starts  # other venue keeps its morning


def test_ceremony_block_without_venues_blocks_everything():
    cfg = _cfg()
    merge_stored_constraints(cfg, [
        {"type": "ceremony_block",
         "params": {"date": "2026-08-01", "from": "09:00", "to": "11:00"}},
    ])
    res = schedule_matches([_req("m")], cfg)
    assert res.assignments["m"][0].time() >= time(11, 0)


def test_reserve_days_excluded_at_generation():
    cfg = _cfg(date_end=SUN)
    merge_stored_constraints(cfg, [
        {"type": "reserve_days", "params": {"dates": ["2026-08-01"]}},
    ])
    assert all(dt.date() == SUN for dt, _v, _w in build_slots(cfg))


def test_sport_scoped_reserve_days_let_other_sports_play():
    cfg = _cfg(date_end=SUN, venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "reserve_days", "scope": "sport:football",
         "params": {"dates": ["2026-08-01"]}},
    ])
    res = schedule_matches([
        _req("fb", sport="football"), _req("tt", sport="table_tennis", match_no=2),
    ], cfg)
    assert res.assignments["fb"][0].date() == SUN
    assert res.assignments["tt"][0].date() == SAT


# ---------------------------------------------------------- venue count (§2.3)
def test_venue_count_expands_into_parallel_sub_venues():
    cfg = _cfg(venues=["Hall"], venue_counts={"Hall": 2})
    res = schedule_matches([_req("m1"), _req("m2", match_no=2)], cfg)
    assert not res.unscheduled
    (d1, v1), (d2, v2) = res.assignments["m1"], res.assignments["m2"]
    assert d1 == d2  # parallel — two tables
    assert {v1, v2} == {"Hall · T1", "Hall · T2"}


def test_config_from_dict_parses_venue_count():
    cfg = config_from_dict({
        "date_start": "2026-08-01", "date_end": "2026-08-01",
        "venues": [{"name": "Hall", "count": 4}, "Ground"],
    })
    assert cfg.venue_counts == {"Hall": 4}
    assert cfg.venues == ["Hall", "Ground"]


def test_bare_name_booking_consumes_one_unit_of_capacity():
    # A legacy booking stored as "Hall" (no sub-venue suffix) must consume one
    # table — not zero (double-booking) and not all of them (§9 A2).
    cfg = _cfg(venues=["Hall"], venue_counts={"Hall": 2})
    pre = [("Hall", datetime(2026, 8, 1, 9, 0), datetime(2026, 8, 1, 10, 0), [])]
    res = schedule_matches([_req("m1"), _req("m2", match_no=2)], cfg,
                           preoccupied=pre)
    times = sorted(dt for dt, _v in res.assignments.values())
    assert times[0] == datetime(2026, 8, 1, 9, 0)   # one free table at 9:00
    assert times[1] >= datetime(2026, 8, 1, 10, 0)  # the other waits


def test_bare_name_bookings_at_capacity_block_all_sub_venues():
    cfg = _cfg(venues=["Hall"], venue_counts={"Hall": 2})
    pre = [
        ("Hall", datetime(2026, 8, 1, 9, 0), datetime(2026, 8, 1, 10, 0), []),
        ("Hall", datetime(2026, 8, 1, 9, 0), datetime(2026, 8, 1, 10, 0), []),
    ]
    res = schedule_matches([_req("m1")], cfg, preoccupied=pre)
    assert res.assignments["m1"][0] >= datetime(2026, 8, 1, 10, 0)


# ------------------------------------------------------------ pinned rounds
def _bracket_reqs():
    return [
        _req("s1", leaf_key="football.u15", stage="knockout", round_no=1,
             match_no=1, home="t1", away="t2"),
        _req("s2", leaf_key="football.u15", stage="knockout", round_no=1,
             match_no=2, home="t3", away="t4"),
        MatchSlotReq(id="final", round_no=2, match_no=3, home=None, away=None,
                     leaf_key="football.u15", stage="knockout"),
    ]


def test_pinned_final_lands_in_its_window_and_rounds_backfill():
    cfg = _cfg(date_end=MON)
    merge_stored_constraints(cfg, [
        {"type": "round_pinned_to_window", "scope": "leaf:football.u15",
         "params": {"round": "final", "date": "last_day", "from": "14:00"}},
    ])
    res = schedule_matches(_bracket_reqs(), cfg)
    assert not res.unscheduled
    f_dt, _ = res.assignments["final"]
    assert f_dt.date() == MON and f_dt.time() >= time(14, 0)
    for mid in ("s1", "s2"):
        assert res.assignments[mid][0] < f_dt  # earlier rounds back-fill


def test_pinned_round_that_cannot_fit_produces_violation():
    cfg = _cfg(date_end=MON)
    merge_stored_constraints(cfg, [
        {"type": "round_pinned_to_window", "scope": "leaf:football.u15",
         "params": {"round": "final", "date": "last_day", "from": "20:00"}},
    ])
    res = schedule_matches(_bracket_reqs(), cfg)
    assert "final" in res.unscheduled
    v = next(x for x in res.violations if x["code"] == "pinned_round_unplaced")
    assert v["hard"] is True and "final" in v["matches"]
    assert v["constraint"]["type"] == "round_pinned_to_window"
    assert {r["action"] for r in v["relaxations"]} & {"add_day", "add_venue"}
    json.dumps(res.violations)  # the structure must be JSON-safe (API contract)


# ------------------------------------------------------- resource capacities
def test_official_capacity_caps_concurrent_matches_per_sport():
    cfg = _cfg(venues=["A", "B", "C"])
    merge_stored_constraints(cfg, [
        {"type": "official_capacity", "scope": "sport:table_tennis",
         "params": {"count": 2}},
    ])
    res = schedule_matches([
        _req("m1", sport="table_tennis"),
        _req("m2", sport="table_tennis", match_no=2),
        _req("m3", sport="table_tennis", match_no=3),
        _req("fb", sport="football", match_no=4),
    ], cfg)
    assert not res.unscheduled
    starts = [res.assignments[m][0] for m in ("m1", "m2", "m3")]
    assert len([s for s in starts if s == min(starts)]) <= 2  # never 3 at once
    # football is out of scope: it can share the first slot
    assert res.assignments["fb"][0] == min(starts)


def test_official_capacity_scope_all_caps_total_concurrency():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "official_capacity", "scope": "all", "params": {"count": 1}},
    ])
    res = schedule_matches([
        _req("m1", sport="football"), _req("m2", sport="table_tennis", match_no=2),
    ], cfg)
    (d1, _), (d2, _) = res.assignments["m1"], res.assignments["m2"]
    assert d1 != d2  # despite two free venues


# ------------------------------------------------------- person-overlap gaps
def test_no_person_overlap_gaps_are_tunable_and_venue_aware():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "no_person_overlap",
         "params": {"min_gap_minutes": 30, "cross_venue_gap_minutes": 120}},
    ])
    linked = {"t-fb": {"t-bd"}, "t-bd": {"t-fb"}}
    res = schedule_matches([
        _req("fb", home="t-fb", away="t-x"),
        _req("bd", home="t-bd", away="t-y", match_no=2),
    ], cfg, linked=linked)
    assert not res.unscheduled
    (d1, v1), (d2, v2) = res.assignments["fb"], res.assignments["bd"]
    gap = (max(d1, d2) - min(d1, d2)).total_seconds() / 60 - 60  # minus 60' play
    if v1 == v2:
        assert gap >= 30
    else:
        assert gap >= 120


# ------------------------------------------------------ structured violations
def test_unplaced_matches_produce_structured_violation_with_relaxations():
    cfg = _cfg(daily_end=time(10, 30), slot_minutes=90, max_per_team_per_day=1)
    res = schedule_matches(
        [_req("m1"), _req("m2", match_no=2), _req("m3", match_no=3)], cfg
    )
    assert len(res.unscheduled) == 2
    v = next(x for x in res.violations if x["code"] == "matches_unplaced")
    assert sorted(v["matches"]) == sorted(res.unscheduled)
    actions = {r["action"] for r in v["relaxations"]}
    assert {"add_day", "add_venue"} <= actions
    assert all(r.get("code") for r in v["relaxations"])  # i18n codes (§9 A5)
    assert v["message"]
    json.dumps(res.violations)


def test_jointly_starving_session_windows_surface_demote_relaxation():
    cfg = _cfg()
    merge_stored_constraints(cfg, [
        {"type": "category_session_window", "scope": "leaf:football.u15",
         "hard": True, "params": {"from": "09:00", "to": "10:00"}},
        {"type": "category_session_window", "scope": "leaf:football.u15",
         "hard": True, "params": {"from": "14:00", "to": "15:00"}},
    ])
    res = schedule_matches([_req("m", leaf_key="football.u15")], cfg)
    assert res.unscheduled == ["m"]
    v = next(x for x in res.violations if x["code"] == "session_window_starved")
    assert v["constraint"]["type"] == "category_session_window"
    assert any(r["action"] == "demote_to_soft" for r in v["relaxations"])
