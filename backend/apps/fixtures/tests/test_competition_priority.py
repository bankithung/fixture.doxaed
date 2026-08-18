"""Host-authored scheduling order (owner 2026-08-17).

Two records, both fully data-driven — nothing about which competition matters,
or which round counts as "the finals", is hardcoded in the engine:

* ``competition_priority`` — which competition gets the early slots, and
  whether it drains before the next one starts or they progress together.
* ``closing_rounds_window`` — the last N rounds of EACH competition play from
  a date the host set; optionally nothing else plays from then on.
"""
from __future__ import annotations

from datetime import date, time

from apps.fixtures.services.constraints import validate_constraints
from apps.fixtures.services.optimizer import _candidates
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    competition_rank,
    config_from_dict,
    merge_stored_constraints,
    resolve_closing_rounds,
    schedule_matches,
    validate_schedule,
)

D1, D2, D3 = date(2026, 8, 17), date(2026, 8, 18), date(2026, 8, 19)

TT_BOYS = "table_tennis.u_14.boys.singles"
TT_GIRLS = "table_tennis.u_14.girls.singles"
TT_OPEN = "table_tennis.open_category.boys.singles"
SPK = "sepak_takraw.u_14.boys"


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=D1, date_end=D1,
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["A"], rest_minutes=0, max_per_team_per_day=99,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _req(mid, *, leaf_key, sport="", stage="knockout", round_no=1, match_no=1):
    return MatchSlotReq(
        id=mid, round_no=round_no, match_no=match_no,
        home=f"{mid}-h", away=f"{mid}-a",
        sport=sport or leaf_key.split(".")[0], leaf_key=leaf_key, stage=stage,
    )


def _order(res, matches):
    """Match ids sorted by the time they were actually given."""
    return [
        m.id for m in sorted(
            (m for m in matches if m.id in res.assignments),
            key=lambda m: res.assignments[m.id][0],
        )
    ]


# ------------------------------------------------------------ rank resolution
def test_rank_matches_a_leaf_a_prefix_or_a_whole_sport():
    order = ["sepak_takraw", "table_tennis.u_14", TT_OPEN]
    assert competition_rank(order, "sepak_takraw", SPK) == 0
    # A prefix names a subtree: both genders at U-14 sit at rank 1.
    assert competition_rank(order, "table_tennis", TT_BOYS) == 1
    assert competition_rank(order, "table_tennis", TT_GIRLS) == 1
    assert competition_rank(order, "table_tennis", TT_OPEN) == 2


def test_an_unlisted_competition_sorts_last_not_first():
    # Naming two categories must not invent an order for everything else.
    order = [TT_BOYS, TT_GIRLS]
    assert competition_rank(order, "sepak_takraw", SPK) == 2


def test_the_most_specific_entry_wins_regardless_of_list_position():
    # A broad rule first, one competition pulled out of it afterwards.
    order = ["table_tennis", TT_GIRLS]
    assert competition_rank(order, "table_tennis", TT_GIRLS) == 1
    assert competition_rank(order, "table_tennis", TT_BOYS) == 0


def test_a_partial_segment_matches_nothing():
    assert competition_rank(["table_tennis.u_1"], "table_tennis", TT_BOYS) == 1


# --------------------------------------------------------------- ordering
def test_without_a_priority_record_rounds_interleave_as_before():
    matches = [
        _req("g1", leaf_key=TT_GIRLS, round_no=1),
        _req("b1", leaf_key=TT_BOYS, round_no=1),
        _req("g2", leaf_key=TT_GIRLS, round_no=2),
        _req("b2", leaf_key=TT_BOYS, round_no=2),
    ]
    res = schedule_matches(matches, _cfg())
    # Round 1 of both before round 2 of either — the untouched default.
    assert _order(res, matches)[:2] == ["g1", "b1"]


def test_sequential_priority_drains_one_competition_before_the_next():
    cfg = _cfg()
    merge_stored_constraints(cfg, [{
        "type": "competition_priority",
        "params": {"order": [TT_BOYS, TT_GIRLS], "mode": "sequential"},
    }])
    matches = [
        _req("g1", leaf_key=TT_GIRLS, round_no=1),
        _req("b1", leaf_key=TT_BOYS, round_no=1),
        _req("g2", leaf_key=TT_GIRLS, round_no=2),
        _req("b2", leaf_key=TT_BOYS, round_no=2),
    ]
    res = schedule_matches(matches, cfg)
    assert _order(res, matches) == ["b1", "b2", "g1", "g2"]


def test_within_round_priority_keeps_competitions_progressing_together():
    cfg = _cfg()
    merge_stored_constraints(cfg, [{
        "type": "competition_priority",
        "params": {"order": [TT_GIRLS, TT_BOYS], "mode": "within_round"},
    }])
    matches = [
        _req("b1", leaf_key=TT_BOYS, round_no=1),
        _req("g1", leaf_key=TT_GIRLS, round_no=1),
        _req("b2", leaf_key=TT_BOYS, round_no=2),
        _req("g2", leaf_key=TT_GIRLS, round_no=2),
    ]
    res = schedule_matches(matches, cfg)
    # Girls first INSIDE each round; round 1 still fully precedes round 2.
    assert _order(res, matches) == ["g1", "b1", "g2", "b2"]


def test_priority_can_be_scoped_to_one_sport_only():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [{
        "type": "competition_priority", "scope": "sport:table_tennis",
        "params": {"order": [TT_GIRLS, TT_BOYS], "mode": "sequential"},
    }])
    matches = [
        _req("b1", leaf_key=TT_BOYS),
        _req("g1", leaf_key=TT_GIRLS),
        _req("s1", leaf_key=SPK),
    ]
    res = schedule_matches(matches, cfg)
    placed = _order(res, matches)
    assert placed.index("g1") < placed.index("b1")
    # Sepak is out of scope, so it keeps rank 0 and is never demoted by a rule
    # that says nothing about it.
    assert "s1" in placed


def test_priority_is_an_ordering_directive_and_never_blocks_a_match():
    cfg = _cfg()
    merge_stored_constraints(cfg, [{
        "type": "competition_priority",
        "params": {"order": ["nothing_matches_this"], "mode": "sequential"},
    }])
    matches = [_req("b1", leaf_key=TT_BOYS), _req("g1", leaf_key=TT_GIRLS)]
    res = schedule_matches(matches, cfg)
    assert res.unscheduled == []
    assert [v for v in res.violations if v.get("hard")] == []


def test_an_empty_or_unknown_mode_is_ignored_rather_than_guessed():
    cfg = _cfg()
    notes = merge_stored_constraints(cfg, [
        {"type": "competition_priority",
         "params": {"order": [], "mode": "sequential"}},
        {"type": "competition_priority",
         "params": {"order": [TT_BOYS], "mode": "whatever"}},
    ])
    assert [r for r in cfg.constraint_rules
            if r.type == "competition_priority"] == []
    assert notes == []


# ---------------------------------------------------------- closing rounds
def _bracket(leaf, prefix, rounds):
    """A little knockout: `rounds` rounds, one match each."""
    return [
        _req(f"{prefix}{r}", leaf_key=leaf, round_no=r, match_no=1)
        for r in range(1, rounds + 1)
    ]


def test_closing_rounds_resolve_per_competition_not_per_rule():
    cfg = _cfg(date_start=D1, date_end=D3)
    merge_stored_constraints(cfg, [{
        "type": "closing_rounds_window",
        "params": {"rounds_from_end": 2, "from_date": "last_day"},
    }])
    # Deep bracket (4 rounds) and a shallow one (2 rounds) in ONE rule.
    matches = _bracket(TT_BOYS, "b", 4) + _bracket(SPK, "s", 2)
    rules = [r for r in cfg.constraint_rules
             if r.type == "closing_rounds_window"]
    (_rule, closing, from_date), = resolve_closing_rounds(matches, rules, cfg)
    assert from_date == D3
    # Each competition counts back from ITS OWN last round.
    assert closing == {"b3", "b4", "s1", "s2"}


def test_a_closing_round_may_not_play_before_the_date_the_host_set():
    cfg = _cfg(date_start=D1, date_end=D2)
    merge_stored_constraints(cfg, [{
        "type": "closing_rounds_window",
        "params": {"rounds_from_end": 1, "from_date": "last_day"},
    }])
    matches = _bracket(TT_BOYS, "b", 3)
    res = schedule_matches(matches, cfg)
    assert res.unscheduled == []
    assert res.assignments["b3"][0].date() == D2
    # The earlier rounds are free to take day one.
    assert res.assignments["b1"][0].date() == D1


def test_exclusive_empties_the_closing_days_of_everything_else():
    cfg = _cfg(date_start=D1, date_end=D2)
    merge_stored_constraints(cfg, [{
        "type": "closing_rounds_window",
        "params": {"rounds_from_end": 1, "from_date": D2.isoformat(),
                   "exclusive": True},
    }])
    matches = _bracket(TT_BOYS, "b", 3)
    res = schedule_matches(matches, cfg)
    assert res.unscheduled == []
    days = {mid: res.assignments[mid][0].date() for mid in res.assignments}
    assert days["b3"] == D2                      # the final, on the final day
    assert days["b1"] == D1 and days["b2"] == D1  # and nothing else there


def test_without_exclusive_an_early_round_may_still_use_the_closing_day():
    cfg = _cfg(date_start=D1, date_end=D2, daily_end=time(10, 0))
    merge_stored_constraints(cfg, [{
        "type": "closing_rounds_window",
        "params": {"rounds_from_end": 1, "from_date": D2.isoformat()},
    }])
    # One slot a day, three matches: an early round MUST spill onto day two.
    matches = _bracket(TT_BOYS, "b", 3)
    res = schedule_matches(matches, cfg)
    assert res.assignments["b2"][0].date() == D2


def test_the_rule_can_be_scoped_to_one_competition():
    cfg = _cfg(date_start=D1, date_end=D2, venues=["A", "B"])
    merge_stored_constraints(cfg, [{
        "type": "closing_rounds_window", "scope": f"leaf:{TT_BOYS}",
        "params": {"rounds_from_end": 1, "from_date": "last_day"},
    }])
    matches = _bracket(TT_BOYS, "b", 2) + _bracket(SPK, "s", 2)
    res = schedule_matches(matches, cfg)
    assert res.assignments["b2"][0].date() == D2
    # Sepak is untouched: its final is free to play on day one.
    assert res.assignments["s2"][0].date() == D1


def test_a_hand_moved_final_is_reported_by_the_validator():
    cfg = _cfg(date_start=D1, date_end=D2)
    merge_stored_constraints(cfg, [{
        "type": "closing_rounds_window",
        "params": {"rounds_from_end": 1, "from_date": D2.isoformat(),
                   "exclusive": True},
    }])
    matches = _bracket(TT_BOYS, "b", 2)
    from datetime import datetime
    # The final dragged back onto day one, and a first round pushed onto the
    # cleared day: the two directions of the rule, both reported.
    vs = validate_schedule({
        "b1": (datetime.combine(D2, time(9, 0)), "A"),
        "b2": (datetime.combine(D1, time(9, 0)), "A"),
    }, matches, cfg)
    codes = {(v["code"], v["match_id"]) for v in vs}
    assert ("closing_round_too_early", "b2") in codes
    assert ("non_closing_round_too_late", "b1") in codes


def test_the_optimizer_gates_on_the_same_rule_as_the_greedy_pass():
    cfg = _cfg(date_start=D1, date_end=D2)
    merge_stored_constraints(cfg, [{
        "type": "closing_rounds_window",
        "params": {"rounds_from_end": 1, "from_date": D2.isoformat(),
                   "exclusive": True},
    }])
    matches = _bracket(TT_BOYS, "b", 2)
    cand = _candidates(matches, cfg)
    # The final can only be offered day-two slots; round one only day-one.
    assert {dt.date() for dt, _v in cand["b2"]} == {D2}
    assert {dt.date() for dt, _v in cand["b1"]} == {D1}


def test_a_missing_date_leaves_the_rule_inert_rather_than_guessing_one():
    cfg = _cfg(date_start=D1, date_end=D2)
    notes = merge_stored_constraints(cfg, [
        {"type": "closing_rounds_window", "params": {"rounds_from_end": 2}},
    ])
    assert [r for r in cfg.constraint_rules
            if r.type == "closing_rounds_window"] == []
    assert notes == []


# ------------------------------------------------------------------ catalog
def test_both_records_round_trip_through_the_catalog_validator():
    out = validate_constraints([
        {"type": "competition_priority",
         "params": {"order": [TT_BOYS, SPK], "mode": "sequential"}},
        {"type": "closing_rounds_window", "scope": "sport:table_tennis",
         "params": {"rounds_from_end": 2, "from_date": "2026-08-19",
                    "exclusive": True}},
    ])
    assert [r["type"] for r in out] == [
        "competition_priority", "closing_rounds_window",
    ]
    # Catalog defaults: the order is a preference, the window is a rule.
    assert out[0]["hard"] is False
    assert out[1]["hard"] is True
    assert out[1]["scope"] == "sport:table_tennis"


def test_config_from_dict_carries_both_records_into_the_engine():
    cfg = config_from_dict({
        "date_start": D1.isoformat(), "date_end": D2.isoformat(),
        "daily_start": "09:00", "daily_end": "18:00", "venues": ["A"],
    })
    notes = merge_stored_constraints(cfg, [
        {"type": "competition_priority",
         "params": {"order": [TT_BOYS], "mode": "within_round"}},
        {"type": "closing_rounds_window",
         "params": {"rounds_from_end": 1, "from_date": "last_day"}},
    ])
    assert len(notes) == 2
    assert {r.type for r in cfg.constraint_rules} == {
        "competition_priority", "closing_rounds_window",
    }


# ------------------------------------------- a main order AND a per-game one
def test_a_tournament_wide_order_and_a_per_sport_order_both_apply():
    """Owner 2026-08-18: "we will also have the main one but also per game".

    Each sport runs on its own courts, so its own list has to bind for its own
    matches while the tournament-wide list still covers everything else.
    """
    # ONE court, so the order is visible in the times: with two, sepak and
    # table tennis correctly run in parallel and nothing is being ranked.
    cfg = _cfg()
    merge_stored_constraints(cfg, [
        # The main order: sepak before table tennis.
        {"type": "competition_priority",
         "params": {"order": ["sepak_takraw", "table_tennis"],
                    "mode": "within_round"}},
        # Table tennis runs its own categories in its own order.
        {"type": "competition_priority", "scope": "sport:table_tennis",
         "params": {"order": [TT_GIRLS, TT_BOYS], "mode": "within_round"}},
    ])
    matches = [
        _req("b1", leaf_key=TT_BOYS),
        _req("g1", leaf_key=TT_GIRLS),
        _req("s1", leaf_key=SPK),
    ]
    res = schedule_matches(matches, cfg)
    placed = _order(res, matches)
    # The per-sport rule decides INSIDE table tennis...
    assert placed.index("g1") < placed.index("b1")
    # ...and the main rule still puts sepak first, because no sport rule covers
    # it. Before this, one rule won the whole run and the other was discarded.
    assert placed[0] == "s1"


def test_each_sport_may_pace_itself_differently():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "competition_priority", "scope": "sport:table_tennis",
         "params": {"order": [TT_GIRLS, TT_BOYS], "mode": "sequential"}},
        {"type": "competition_priority", "scope": "sport:sepak_takraw",
         "params": {"order": [SPK], "mode": "within_round"}},
    ])
    matches = [
        _req("b1", leaf_key=TT_BOYS, round_no=1),
        _req("g1", leaf_key=TT_GIRLS, round_no=1),
        _req("g2", leaf_key=TT_GIRLS, round_no=2),
        _req("s1", leaf_key=SPK, round_no=1),
    ]
    res = schedule_matches(matches, cfg)
    placed = _order(res, matches)
    # Table tennis drains the girls' rounds before the boys start.
    assert placed.index("g1") < placed.index("g2") < placed.index("b1")


def test_a_sport_rule_does_not_reorder_another_sport():
    cfg = _cfg(venues=["A", "B"])
    merge_stored_constraints(cfg, [
        {"type": "competition_priority", "scope": "sport:table_tennis",
         "params": {"order": [TT_GIRLS, TT_BOYS], "mode": "sequential"}},
    ])
    matches = [_req("s1", leaf_key=SPK), _req("s2", leaf_key=SPK, match_no=2)]
    res = schedule_matches(matches, cfg)
    # Out of scope entirely: sepak keeps its declared order, unranked.
    assert _order(res, matches) == ["s1", "s2"]
