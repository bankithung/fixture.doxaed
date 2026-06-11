"""Scope + weight become REAL in slot-time resolution (redesign spec §2.2 /
§4.7 / §9 A3): ``merge_stored_constraints`` routes scoped records into
``ScheduleConfig.constraint_rules`` resolved per ``MatchSlotReq`` (most-specific
scope wins for hard scalars; soft scores are weight-multiplied)."""
from __future__ import annotations

from datetime import date, time

from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    merge_stored_constraints,
    schedule_matches,
)


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["A"], rest_minutes=0, max_per_team_per_day=99,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _req(id, *, sport="", leaf_key="", home=None, away=None, match_no=1):
    return MatchSlotReq(id=id, round_no=1, match_no=match_no,
                        home=home or f"{id}-h", away=away or f"{id}-a",
                        sport=sport, leaf_key=leaf_key)


# ----------------------------------------------------------------- hard scalars
def test_sport_scoped_min_rest_applies_only_to_that_sport():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "min_rest_minutes", "scope": "sport:table_tennis",
         "hard": True, "params": {"minutes": 240}},
    ])
    assert cfg.rest_minutes == 0  # the global scalar is untouched
    # the shared team plays one TT and one football match
    matches = [
        MatchSlotReq(id="tt1", round_no=1, match_no=1, home="shared", away="x",
                     sport="table_tennis"),
        MatchSlotReq(id="tt2", round_no=1, match_no=2, home="shared", away="y",
                     sport="table_tennis"),
        MatchSlotReq(id="fb1", round_no=1, match_no=3, home="shared2", away="p",
                     sport="football"),
        MatchSlotReq(id="fb2", round_no=1, match_no=4, home="shared2", away="q",
                     sport="football"),
    ]
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    tt_gap = abs((res.assignments["tt2"][0] - res.assignments["tt1"][0]).total_seconds())
    fb_gap = abs((res.assignments["fb2"][0] - res.assignments["fb1"][0]).total_seconds())
    assert tt_gap >= (60 + 240) * 60  # duration + scoped rest
    assert fb_gap < (60 + 240) * 60   # football unaffected by the TT rule


def test_team_scoped_rest_wins_over_sport_scoped_rest():
    cfg = _cfg(date_end=date(2026, 8, 2), venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "min_rest_minutes", "scope": "sport:football",
         "hard": True, "params": {"minutes": 600}},
        {"type": "min_rest_minutes", "scope": "team:soft-kids",
         "hard": True, "params": {"minutes": 60}},
    ])
    matches = [
        MatchSlotReq(id="m1", round_no=1, match_no=1, home="soft-kids", away="x",
                     sport="football"),
        MatchSlotReq(id="m2", round_no=1, match_no=2, home="soft-kids", away="y",
                     sport="football"),
    ]
    res = schedule_matches(matches, cfg)
    gap = abs((res.assignments["m2"][0] - res.assignments["m1"][0]).total_seconds())
    # team scope (more specific) wins: 60' rest, not 600'
    assert (60 + 60) * 60 <= gap < (60 + 600) * 60


def test_leaf_scoped_max_per_day():
    cfg = _cfg(venues=["A", "B", "C"])
    merge_stored_constraints(cfg, [
        {"type": "max_matches_per_team_per_day", "scope": "leaf:football.u15",
         "hard": True, "params": {"count": 1}},
    ])
    matches = [
        MatchSlotReq(id="m1", round_no=1, match_no=1, home="t", away="a",
                     leaf_key="football.u15"),
        MatchSlotReq(id="m2", round_no=1, match_no=2, home="t", away="b",
                     leaf_key="football.u15"),
        MatchSlotReq(id="m3", round_no=1, match_no=3, home="t2", away="c",
                     leaf_key="table_tennis"),
        MatchSlotReq(id="m4", round_no=1, match_no=4, home="t2", away="d",
                     leaf_key="table_tennis"),
    ]
    res = schedule_matches(matches, cfg)
    # one of the two U15 matches can't fit on the single day; TT is uncapped
    assert res.unscheduled in (["m1"], ["m2"])


def test_scoped_blackout_dates_only_block_their_sport():
    cfg = _cfg(date_end=date(2026, 8, 2))
    merge_stored_constraints(cfg, [
        {"type": "blackout_dates", "scope": "sport:football",
         "hard": True, "params": {"dates": ["2026-08-01"]}},
    ])
    assert cfg.excluded_dates == set()  # not a global exclusion any more
    res = schedule_matches([
        _req("fb", sport="football"), _req("tt", sport="table_tennis", match_no=2),
    ], cfg)
    assert res.assignments["fb"][0].date() == date(2026, 8, 2)
    assert res.assignments["tt"][0].date() == date(2026, 8, 1)


# ------------------------------------------------------------------ soft weight
def test_scoped_preferred_window_steers_only_in_scope_matches():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "preferred_window", "scope": "sport:table_tennis",
         "hard": False, "params": {"from": "15:00", "to": "17:00"}},
    ])
    res = schedule_matches([
        _req("tt", sport="table_tennis"), _req("fb", sport="football", match_no=2),
    ], cfg)
    assert time(15, 0) <= res.assignments["tt"][0].time() < time(17, 0)
    assert res.assignments["fb"][0].time() == time(9, 0)  # out of scope: earliest


def test_higher_weight_window_wins_when_windows_compete():
    cfg = _cfg()
    merge_stored_constraints(cfg, [
        {"type": "preferred_window", "hard": False, "weight": 2,
         "params": {"from": "10:00", "to": "11:00"}},
        {"type": "preferred_window", "hard": False, "weight": 9,
         "params": {"from": "15:00", "to": "16:00"}},
    ])
    res = schedule_matches([_req("m")], cfg)
    assert res.assignments["m"][0].time() == time(15, 0)


def test_hard_window_restricts_placement_outright():
    cfg = _cfg()
    merge_stored_constraints(cfg, [
        {"type": "preferred_window", "hard": True,
         "params": {"from": "14:00", "to": "16:00"}},
    ])
    res = schedule_matches([_req("m")], cfg)
    assert res.assignments["m"][0].time() == time(14, 0)


def test_weekday_windows_apply_on_matching_days_only():
    # Aug 1 2026 is a Saturday; Aug 3 a Monday.
    cfg = _cfg(date_end=date(2026, 8, 3))
    merge_stored_constraints(cfg, [
        {"type": "preferred_window", "hard": False,
         "params": {"days": ["mon"], "from": "15:00", "to": "17:00"}},
    ])
    res = schedule_matches([_req("m")], cfg)
    dt, _ = res.assignments["m"]
    assert dt.date() == date(2026, 8, 3) and dt.time() == time(15, 0)


def test_legacy_unscoped_records_keep_their_scalar_behavior():
    cfg = _cfg(date_end=date(2026, 8, 3))
    notes = merge_stored_constraints(cfg, [
        {"type": "blackout_dates", "params": {"dates": ["2026-08-01"]}},
        {"type": "min_rest_minutes", "params": {"minutes": 120}},
        {"type": "max_matches_per_team_per_day", "params": {"count": 2}},
    ])
    assert cfg.excluded_dates == {date(2026, 8, 1)}
    assert cfg.rest_minutes == 120
    assert cfg.max_per_team_per_day == 2
    assert len(notes) == 3
