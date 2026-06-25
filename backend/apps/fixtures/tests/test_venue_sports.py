"""Venue↔sport binding (owner ask 2026-06-25): a venue bound to specific
sports only hosts matches of those sports, so "2 courts per sport" is enforced
even when two sports share a venue_type (table tennis + sepak takraw are both
indoor_court). Empty list = any sport may use the venue (today's behaviour)."""
from __future__ import annotations

from datetime import date, time

from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    config_from_dict,
    schedule_matches,
)


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(13, 0), slot_minutes=60,
        venues=["TT Court", "Sepak Court"], rest_minutes=0,
        max_per_team_per_day=20,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _reqs() -> list[MatchSlotReq]:
    return [
        MatchSlotReq(id="tt1", round_no=1, match_no=1, home="A", away="B",
                     leaf_key="table_tennis.u14.boys.singles", sport="table_tennis"),
        MatchSlotReq(id="tt2", round_no=1, match_no=2, home="C", away="D",
                     leaf_key="table_tennis.u14.boys.singles", sport="table_tennis"),
        MatchSlotReq(id="sk1", round_no=1, match_no=3, home="E", away="F",
                     leaf_key="sepak_takraw.u14.boys", sport="sepak_takraw"),
        MatchSlotReq(id="sk2", round_no=1, match_no=4, home="G", away="H",
                     leaf_key="sepak_takraw.u14.boys", sport="sepak_takraw"),
    ]


def test_bound_venues_keep_each_sport_on_its_own_courts():
    cfg = _cfg(venue_sports={"TT Court": ["table_tennis"],
                             "Sepak Court": ["sepak_takraw"]})
    res = schedule_matches(_reqs(), cfg)
    assert len(res.assignments) == 4
    assert res.assignments["tt1"][1] == "TT Court"
    assert res.assignments["tt2"][1] == "TT Court"
    assert res.assignments["sk1"][1] == "Sepak Court"
    assert res.assignments["sk2"][1] == "Sepak Court"


def test_binding_can_make_a_match_unplaceable_when_its_court_is_full():
    """One TT-only court, two 60' TT matches, a 1-hour day → only one fits; the
    other can't borrow the Sepak court. Proves the binding is a hard gate."""
    cfg = _cfg(venues=["TT Court", "Sepak Court"],
               daily_end=time(10, 0),  # single 60' slot per court
               venue_sports={"TT Court": ["table_tennis"],
                             "Sepak Court": ["sepak_takraw"]})
    res = schedule_matches(_reqs(), cfg)
    # 1 TT + 1 Sepak placed; the 2nd of each can't cross to the other's court
    placed_tt = [m for m in ("tt1", "tt2") if m in res.assignments]
    placed_sk = [m for m in ("sk1", "sk2") if m in res.assignments]
    assert len(placed_tt) == 1 and len(placed_sk) == 1
    assert all(res.assignments[m][1] == "TT Court" for m in placed_tt)
    assert all(res.assignments[m][1] == "Sepak Court" for m in placed_sk)


def test_unbound_venue_accepts_any_sport():
    cfg = _cfg(venue_sports={})  # no bindings → today's behaviour
    res = schedule_matches(_reqs(), cfg)
    assert len(res.assignments) == 4  # all placed across both courts freely


def test_config_from_dict_parses_venue_sports():
    cfg = config_from_dict({
        "date_start": "2026-08-01", "date_end": "2026-08-01",
        "venues": [
            {"name": "TT Court", "sports": ["table_tennis", " "]},
            {"name": "Open Ground"},
        ],
    })
    assert cfg.venue_sports == {"TT Court": ["table_tennis"]}  # blanks dropped
    assert "Open Ground" not in cfg.venue_sports  # empty = any sport
