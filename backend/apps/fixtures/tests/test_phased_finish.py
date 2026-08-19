"""Finish the tournament in phases (owner 2026-08-19).

"I want all categories to play up to till semi final, and only after all
categories have played their semi then only the third places should play, and
all finals scheduled at the very end — final, first girls will play then the
boys at the end."

``closing_rounds_window`` can clear the last DAYS for the closing rounds; it
cannot sequence what happens inside them, and a third-place playoff shares its
round number with the final, so no count of rounds can order the two. The
``phased_finish`` record names the phases themselves. Nothing here is
hardcoded: which phases are barriers, and which competition's finals go first,
are both authored.
"""
from __future__ import annotations

from datetime import date, time, timedelta

from apps.fixtures.services.constraints import validate_constraints
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    competition_rank,
    merge_stored_constraints,
    resolve_finish_phases,
    schedule_matches,
    validate_schedule,
)

D1, D2 = date(2026, 8, 17), date(2026, 8, 18)

GIRLS = "table_tennis.u_14.girls.singles"
BOYS = "table_tennis.u_14.boys.singles"
SPK = "sepak_takraw.u_14.boys"


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=D1, date_end=D2,
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=30,
        venues=["A", "B"], rest_minutes=0, max_per_team_per_day=99,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _req(mid, *, leaf_key, round_no, match_no=1, third_place=False,
         after=(), stage="knockout"):
    return MatchSlotReq(
        id=mid, round_no=round_no, match_no=match_no,
        home=f"{mid}-h", away=f"{mid}-a",
        sport=leaf_key.split(".")[0], leaf_key=leaf_key, stage=stage,
        third_place=third_place, after=tuple(after),
    )


def _bracket(prefix: str, leaf: str) -> list[MatchSlotReq]:
    """A 4-team knockout: two semis (R1), then a third place and a final that
    SHARE round 2 — exactly how the generator emits them."""
    return [
        _req(f"{prefix}s1", leaf_key=leaf, round_no=1, match_no=1),
        _req(f"{prefix}s2", leaf_key=leaf, round_no=1, match_no=2),
        _req(f"{prefix}3rd", leaf_key=leaf, round_no=2, match_no=3,
             third_place=True, after=(f"{prefix}s1", f"{prefix}s2")),
        _req(f"{prefix}f", leaf_key=leaf, round_no=2, match_no=4,
             after=(f"{prefix}s1", f"{prefix}s2")),
    ]


def _rules(order, final_order=None, scope="all", solo=None, **cfg_over):
    stored = [{
        "type": "phased_finish", "scope": scope, "hard": True,
        "params": {"order": order, "final_order": final_order or [],
                   **({"one_at_a_time": solo} if solo else {})},
    }]
    cfg = _cfg(**cfg_over)
    merge_stored_constraints(cfg, validate_constraints(stored))
    return cfg


def _at(res, mid):
    return res.assignments[mid][0]


# --------------------------------------------------------- phase resolution
def test_the_phase_is_read_from_each_competitions_own_bracket():
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"])
    plans = resolve_finish_phases(matches, cfg.constraint_rules, cfg)
    assert len(plans) == 1
    phase = plans[0].phase_of
    assert phase["gs1"] == phase["gs2"] == "semi_final"
    # The third place and the final share round 2; only their SIDES tell them
    # apart, which is the whole reason a round number cannot express this.
    assert phase["g3rd"] == "third_place"
    assert phase["gf"] == "final"


def test_a_phase_the_host_did_not_list_is_not_part_of_the_rule():
    matches = _bracket("g", GIRLS)
    cfg = _rules(["third_place", "final"])
    plans = resolve_finish_phases(matches, cfg.constraint_rules, cfg)
    assert "gs1" not in plans[0].key_of
    assert set(plans[0].key_of) == {"g3rd", "gf"}


def test_a_deeper_bracket_counts_back_from_its_own_last_round():
    # One record, two bracket depths: an 8-team leaf's semis are round 2, a
    # 4-team leaf's are round 1. A literal round number could not do this.
    deep = [
        _req("d1", leaf_key=BOYS, round_no=1, match_no=1),
        _req("d2", leaf_key=BOYS, round_no=1, match_no=2),
        _req("dsemi", leaf_key=BOYS, round_no=2, match_no=3),
        _req("dfinal", leaf_key=BOYS, round_no=3, match_no=4),
    ]
    matches = deep + _bracket("g", GIRLS)
    cfg = _rules(["semi_final", "third_place", "final"])
    phase = resolve_finish_phases(matches, cfg.constraint_rules, cfg)[0].phase_of
    assert phase["dsemi"] == "semi_final"
    assert phase["dfinal"] == "final"
    assert phase.get("d1") is None  # "earlier" was not listed
    assert phase["gs1"] == "semi_final"


def test_scope_keeps_one_sport_out_of_another_sports_phases():
    matches = _bracket("g", GIRLS) + _bracket("s", SPK)
    cfg = _rules(["semi_final", "final"], scope="sport:table_tennis")
    keys = resolve_finish_phases(matches, cfg.constraint_rules, cfg)[0].key_of
    assert "gf" in keys
    assert not any(k.startswith("s") for k in keys)


# ------------------------------------------------------------ the barrier
def test_no_third_place_starts_until_every_semi_final_has_finished():
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"])
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    dur = 30 * 60
    semis_end = max(
        _at(res, m).timestamp() + dur for m in ("gs1", "gs2", "bs1", "bs2")
    )
    for third in ("g3rd", "b3rd"):
        assert _at(res, third).timestamp() >= semis_end


def test_every_third_place_finishes_before_any_final_starts():
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"])
    res = schedule_matches(matches, cfg)
    thirds_end = max(
        _at(res, m).timestamp() + 30 * 60 for m in ("g3rd", "b3rd")
    )
    for final in ("gf", "bf"):
        assert _at(res, final).timestamp() >= thirds_end


def test_the_finals_play_in_the_order_the_host_set():
    # "final, first girls will play then the boys at the end" — one entry per
    # gender, matched as a bare SEGMENT, not one entry per category.
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"],
                 final_order=["girls", "boys"])
    res = schedule_matches(matches, cfg)
    assert _at(res, "gf") + timedelta(minutes=30) <= _at(res, "bf")


def test_the_authored_order_is_obeyed_even_when_it_inverts_the_usual_one():
    # Nothing about "third places come before finals" is baked in: a host who
    # writes them the other way round gets them the other way round.
    matches = _bracket("g", GIRLS)
    cfg = _rules(["final", "third_place"])
    res = schedule_matches(matches, cfg)
    assert _at(res, "gf") < _at(res, "g3rd")


def test_without_the_record_nothing_changes():
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    res = schedule_matches(matches, _cfg())
    assert not res.unscheduled
    # The two brackets interleave freely; the girls' final may precede the
    # boys' semis. Only bracket precedence binds.
    assert _at(res, "gf") >= _at(res, "gs1")


# ------------------------------------------------- the validator agrees
def test_a_hand_moved_final_is_reported_out_of_order():
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"])
    res = schedule_matches(matches, cfg)
    hacked = dict(res.assignments)
    # Drag the girls' final back onto the semi-finals' slot.
    hacked["gf"] = res.assignments["gs1"]
    codes = [v["code"] for v in validate_schedule(hacked, matches, cfg)]
    assert "phase_out_of_order" in codes


def test_the_schedule_the_engine_built_passes_its_own_validator():
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"],
                 final_order=["girls", "boys"])
    res = schedule_matches(matches, cfg)
    assert [
        v for v in validate_schedule(res.assignments, matches, cfg)
        if v["code"] == "phase_out_of_order"
    ] == []


# ----------------------------------------------------------- the grammar
def test_a_bare_segment_matches_every_competition_carrying_it():
    order = ["girls", "boys"]
    assert competition_rank(order, "table_tennis", GIRLS) == 0
    assert competition_rank(order, "table_tennis", BOYS) == 1
    # A segment is the WEAKEST match: an exact leaf still overrides it.
    assert competition_rank(["girls", BOYS], "table_tennis", BOYS) == 1
    assert competition_rank([BOYS, "girls"], "table_tennis", BOYS) == 0
    # A segment is a FACT about the path, not a label: sepak's boys event
    # carries "boys" and ranks with the boys.
    assert competition_rank(order, "sepak_takraw", SPK) == 1
    # And a competition carrying neither segment stays unlisted, which sorts
    # last — naming two genders must not invent a rank for a mixed event.
    assert competition_rank(order, "chess", "chess.open") == 2


def test_the_setup_note_says_what_was_set():
    cfg = _cfg()
    notes = merge_stored_constraints(cfg, validate_constraints([{
        "type": "phased_finish", "scope": "all", "hard": True,
        "params": {"order": ["semi_final", "third_place", "final"],
                   "final_order": ["girls", "boys"]},
    }]))
    joined = " ".join(notes)
    assert "semi-finals" in joined and "third places" in joined
    assert "finals" in joined


def test_the_stored_record_round_trips_through_the_write_path():
    # The shape the API actually stores, through the same validator the
    # settings endpoint uses, into the engine's runtime model.
    stored = validate_constraints([{
        "type": "phased_finish", "scope": "sport:table_tennis", "hard": True,
        "params": {"order": ["semi_final", "final", "nonsense"],
                   "final_order": ["girls"]},
    }])
    assert stored[0]["type"] == "phased_finish"
    cfg = _cfg()
    merge_stored_constraints(cfg, stored)
    rules = [r for r in cfg.constraint_rules if r.type == "phased_finish"]
    assert rules and rules[0].scope == "sport:table_tennis"
    # A phase the engine does not recognise is dropped, never guessed at.
    assert rules[0].params["order"] == ["semi_final", "final"]
    assert rules[0].params["final_order"] == ["girls"]


def test_an_empty_order_is_no_rule_at_all():
    cfg = _cfg()
    merge_stored_constraints(cfg, validate_constraints([{
        "type": "phased_finish", "scope": "all", "hard": True,
        "params": {"order": [], "final_order": ["girls"]},
    }]))
    assert [r for r in cfg.constraint_rules if r.type == "phased_finish"] == []

# --------------------------------------- one final at a time, per sport
SPK_G = "sepak_takraw.u_14.girls"


def _overlaps(res, a, b, dur_a=30, dur_b=30):
    sa, sb = _at(res, a), _at(res, b)
    return sa < sb + timedelta(minutes=dur_b) and sb < sa + timedelta(minutes=dur_a)


def test_two_finals_of_one_sport_never_share_a_slot():
    # Owner 2026-08-19: "when one category's final is going on, no other final
    # of the same sport can go on."
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"], solo="sport")
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    assert not _overlaps(res, "gf", "bf")


def test_a_final_in_another_sport_may_run_at_the_same_time():
    # "if different sports then how is it — sepak girls final going on, then
    # at the same time TT categories' final can go on?" It can: different
    # halls, different officials, nothing shared.
    matches = _bracket("g", GIRLS) + _bracket("s", SPK_G)
    cfg = _rules(["semi_final", "third_place", "final"], solo="sport")
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    assert _overlaps(res, "gf", "sf")


def test_one_at_a_time_all_lets_nothing_share_the_finish():
    matches = _bracket("g", GIRLS) + _bracket("s", SPK_G)
    cfg = _rules(["semi_final", "third_place", "final"], solo="all")
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    assert not _overlaps(res, "gf", "sf")


def test_without_the_setting_finals_may_share_a_slot():
    # The default changes nothing: two courts, two finals, one time.
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"])
    res = schedule_matches(matches, cfg)
    assert _overlaps(res, "gf", "bf")


def test_only_the_LAST_phase_is_held_to_one_at_a_time():
    # The semis still run in parallel — serialising them would double the day
    # for no reason the host asked for.
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"], solo="sport")
    res = schedule_matches(matches, cfg)
    assert _overlaps(res, "gs1", "bs1")


def test_a_hand_moved_final_onto_another_is_reported():
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"], solo="sport")
    res = schedule_matches(matches, cfg)
    hacked = dict(res.assignments)
    hacked["bf"] = res.assignments["gf"]  # both TT finals at one time
    codes = [v["code"] for v in validate_schedule(hacked, matches, cfg)]
    assert "final_not_alone" in codes


def test_the_engines_own_schedule_passes_the_solo_check():
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS) + _bracket("s", SPK_G)
    cfg = _rules(["semi_final", "third_place", "final"],
                 final_order=["girls", "boys"], solo="sport")
    res = schedule_matches(matches, cfg)
    assert [v for v in validate_schedule(res.assignments, matches, cfg)
            if v["code"] == "final_not_alone"] == []


def test_an_unknown_answer_falls_back_to_letting_them_share():
    cfg = _cfg()
    merge_stored_constraints(cfg, validate_constraints([{
        "type": "phased_finish", "scope": "all", "hard": True,
        "params": {"order": ["final"], "one_at_a_time": "whenever"},
    }]))
    rule = [r for r in cfg.constraint_rules if r.type == "phased_finish"][0]
    assert rule.params["one_at_a_time"] == "none"


# ------------------------------------------- trying harder for a full house
def test_a_reserved_pass_is_only_used_when_it_places_more():
    # The retry must never trade a placed match for a tidier one: a schedule
    # that already fits is returned by the first pass, untouched.
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    cfg = _rules(["semi_final", "third_place", "final"])
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    assert not any("Held time" in e for e in res.explanation)


def test_the_deadline_never_leaves_a_match_with_no_time_at_all():
    # Holding room for the closing phases is a PREFERENCE: an ordinary match
    # that cannot fit before the deadline still gets a slot rather than being
    # dropped to make room.
    from apps.fixtures.services.scheduler import _schedule_once

    matches = _bracket("g", GIRLS) + _bracket("b", BOYS) + _bracket("s", SPK_G)
    cfg = _rules(["semi_final", "third_place", "final"])
    tight = _schedule_once(matches, cfg, reserve_phases=True)
    loose = _schedule_once(matches, cfg)
    assert len(tight.unscheduled) <= len(loose.unscheduled)


def test_without_a_phase_rule_the_retry_does_not_run():
    # Nothing is deferred, so holding room back would only take it away.
    matches = _bracket("g", GIRLS)
    res = schedule_matches(matches, _cfg(venues=["A"], date_end=D1))
    assert not any("Held time" in e for e in res.explanation)


# ------------------------------- a per-sport gap belongs to that sport only
def test_each_sport_keeps_its_own_link_gap():
    """Owner 2026-08-19: table tennis was being held to sepak's 40-minute
    same-school gap because the engine kept ONE pair of numbers and the last
    record read won. Twenty extra minutes on every table tennis match emptied
    whole mornings."""
    from apps.fixtures.services.scheduler import effective_link_gaps

    cfg = _cfg()
    merge_stored_constraints(cfg, validate_constraints([
        {"type": "no_institution_overlap", "scope": "sport:table_tennis",
         "hard": True, "params": {"within": "sport", "min_gap_minutes": 20,
                                  "cross_venue_gap_minutes": 60}},
        {"type": "no_institution_overlap", "scope": "sport:sepak_takraw",
         "hard": True, "params": {"within": "sport", "min_gap_minutes": 40,
                                  "cross_venue_gap_minutes": 60}},
    ]))
    tt = _req("t", leaf_key=GIRLS, round_no=1)
    spk = _req("s", leaf_key=SPK_G, round_no=1)
    assert effective_link_gaps(cfg, tt) == (20, 60)
    assert effective_link_gaps(cfg, spk) == (40, 60)


def test_one_record_governs_everything_as_before():
    from apps.fixtures.services.scheduler import effective_link_gaps

    cfg = _cfg()
    merge_stored_constraints(cfg, validate_constraints([
        {"type": "no_institution_overlap", "scope": "all", "hard": True,
         "params": {"within": "sport", "min_gap_minutes": 25,
                    "cross_venue_gap_minutes": 45}},
    ]))
    assert effective_link_gaps(cfg, _req("t", leaf_key=GIRLS, round_no=1)) == (25, 45)


def test_no_record_leaves_the_gap_unset():
    from apps.fixtures.services.scheduler import effective_link_gaps

    assert effective_link_gaps(_cfg(), _req("t", leaf_key=GIRLS, round_no=1)) == (
        None, None,
    )


# ------------------------------------------- the show court (owner 2026-08-19)
def test_pinning_the_final_does_not_drag_the_third_place_with_it():
    """A third-place playoff shares the final's round number. Pinning "final"
    used to pin both, so a show court had to hold twice what it was given."""
    from apps.fixtures.services.scheduler import resolve_pinned_rounds

    matches = _bracket("g", GIRLS)
    cfg = _cfg()
    merge_stored_constraints(cfg, validate_constraints([
        {"type": "round_pinned_to_window", "scope": "all", "hard": True,
         "params": {"round": "final", "venues": ["A"]}},
    ]))
    pinned = resolve_pinned_rounds(
        matches, [r for r in cfg.constraint_rules
                  if r.type == "round_pinned_to_window"], cfg,
    )
    assert "gf" in pinned
    assert "g3rd" not in pinned


def test_the_third_place_can_be_pinned_on_its_own():
    from apps.fixtures.services.scheduler import resolve_pinned_rounds

    matches = _bracket("g", GIRLS)
    cfg = _cfg()
    merge_stored_constraints(cfg, validate_constraints([
        {"type": "round_pinned_to_window", "scope": "all", "hard": True,
         "params": {"round": "third_place", "venues": ["A"]}},
    ]))
    pinned = resolve_pinned_rounds(
        matches, [r for r in cfg.constraint_rules
                  if r.type == "round_pinned_to_window"], cfg,
    )
    assert "g3rd" in pinned and "gf" not in pinned


def test_a_pinned_final_still_waits_for_the_phases_before_it():
    """Pinned matches are placed first so they can claim a scarce window. With
    a phase barrier that would put the finals down before the rounds they must
    follow, and everything else would have to fit around them."""
    matches = _bracket("g", GIRLS) + _bracket("b", BOYS)
    stored = [
        {"type": "phased_finish", "scope": "all", "hard": True,
         "params": {"order": ["semi_final", "third_place", "final"]}},
        {"type": "round_pinned_to_window", "scope": "all", "hard": True,
         "params": {"round": "final", "venues": ["A"]}},
    ]
    cfg = _cfg()
    merge_stored_constraints(cfg, validate_constraints(stored))
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    # Every third place still ends before any final starts.
    thirds = max(_at(res, m) + timedelta(minutes=30) for m in ("g3rd", "b3rd"))
    for final in ("gf", "bf"):
        assert _at(res, final) >= thirds
    # And both finals are on the pinned court.
    assert {res.assignments["gf"][1], res.assignments["bf"][1]} == {"A"}
