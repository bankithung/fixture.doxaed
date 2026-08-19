"""How far the same-school keep-apart rule reaches (owner 2026-08-18).

The owner's words: *"if one school is playing under 14 sepak then the same
school should not be scheduled in the other court for girls … yes if they are
different sports it's fine, but if they are not then they should not be at the
same time."*

So the rule is per SPORT, not per school. A school's sepak boys and sepak girls
cannot run at once; its sepak and its table tennis can. `within` is the
author's dial — `sport` (this), `leaf` (one exact competition), or `any` (the
blunt original) — because the owner also asked that no rule be hardcoded.
"""
from __future__ import annotations

from datetime import date, datetime, time

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    build_schedule_inputs,
    merge_stored_constraints,
    schedule_matches,
    validate_schedule,
)
from apps.teams.models import Institution, InstitutionStatus, Team, TeamStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

SEPAK_BOYS = "sepak_takraw.u14.boys"
SEPAK_GIRLS = "sepak_takraw.u14.girls"
TT_BOYS = "table_tennis.u14.boys"


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _setup(slug):
    t = create_tournament(user=_user(f"{slug}@test.local"), name=f"Cup {slug}")
    inst = Institution.objects.create(
        organization=t.organization, tournament=t, slug=f"grace-{slug}",
        name="Grace School", status=InstitutionStatus.REGISTERED,
    )
    return t, inst


def _team(t, inst, name, leaf, *, sport=None):
    return Team.objects.create(
        organization=t.organization, tournament=t, institution=inst,
        slug=name.lower().replace(" ", "-"), name=name,
        leaf_key=leaf, sport=sport if sport is not None else leaf.split(".")[0],
        status=TeamStatus.REGISTERED,
    )


def _cfg(records):
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=30,
        venues=["A"],
    )
    merge_stored_constraints(cfg, records)
    return cfg


def _record(**params):
    return {"type": "no_institution_overlap", "scope": params.pop("scope", "all"),
            "params": params}


def _linked(t, records):
    _reqs, _pre, linked = build_schedule_inputs(t, _cfg(records))
    return linked


# ------------------------------------------------------- the owner's example
def test_one_school_s_sepak_boys_and_girls_never_run_at_once():
    t, inst = _setup("sepak")
    boys = _team(t, inst, "Grace Sepak Boys", SEPAK_BOYS)
    girls = _team(t, inst, "Grace Sepak Girls", SEPAK_GIRLS)

    linked = _linked(t, [_record()])
    assert linked.get(str(boys.id)) == {str(girls.id)}
    assert linked.get(str(girls.id)) == {str(boys.id)}


def test_the_same_school_s_other_sport_is_free_to_run_alongside():
    """The half of the rule that makes it usable: binding every sport together
    would idle half the courts for no reason."""
    t, inst = _setup("cross")
    _team(t, inst, "Grace Sepak", SEPAK_BOYS)
    _team(t, inst, "Grace TT", TT_BOYS)

    assert _linked(t, [_record()]) == {}


def test_the_blunt_version_is_still_available_by_asking_for_it():
    t, inst = _setup("blunt")
    sepak = _team(t, inst, "Grace Sepak", SEPAK_BOYS)
    tt = _team(t, inst, "Grace TT", TT_BOYS)

    linked = _linked(t, [_record(within="any")])
    assert linked.get(str(sepak.id)) == {str(tt.id)}


def test_within_leaf_binds_only_one_competition():
    t, inst = _setup("leaf")
    a = _team(t, inst, "Grace Sepak A", SEPAK_BOYS)
    b = _team(t, inst, "Grace Sepak B", SEPAK_BOYS)
    girls = _team(t, inst, "Grace Sepak Girls", SEPAK_GIRLS)

    linked = _linked(t, [_record(within="leaf")])
    assert linked.get(str(a.id)) == {str(b.id)}
    # Boys and girls are the same SPORT but not the same competition.
    assert str(girls.id) not in linked


def test_two_different_schools_are_never_linked():
    t, inst = _setup("two")
    other = Institution.objects.create(
        organization=t.organization, tournament=t, slug="pine",
        name="Pine Academy", status=InstitutionStatus.REGISTERED,
    )
    _team(t, inst, "Grace Sepak", SEPAK_BOYS)
    _team(t, other, "Pine Sepak", SEPAK_GIRLS)

    assert _linked(t, [_record()]) == {}


# --------------------------------------------------------------- flexibility
def test_the_rule_does_nothing_until_it_is_authored():
    """No hard-coded rules (owner 2026-08-17): a tournament that never wrote
    the record schedules exactly as it does today."""
    t, inst = _setup("optin")
    _team(t, inst, "Grace Sepak Boys", SEPAK_BOYS)
    _team(t, inst, "Grace Sepak Girls", SEPAK_GIRLS)

    assert _linked(t, []) == {}


def test_it_can_be_authored_for_one_sport_and_left_off_elsewhere():
    """Scope narrows it further: bind sepak, leave table tennis alone even
    though both are the same school and the same sport as each other."""
    t, inst = _setup("scoped")
    s_boys = _team(t, inst, "Grace Sepak Boys", SEPAK_BOYS)
    s_girls = _team(t, inst, "Grace Sepak Girls", SEPAK_GIRLS)
    tt_a = _team(t, inst, "Grace TT A", TT_BOYS)
    tt_b = _team(t, inst, "Grace TT B", TT_BOYS)

    linked = _linked(t, [_record(scope="sport:sepak_takraw")])
    assert linked.get(str(s_boys.id)) == {str(s_girls.id)}
    assert str(tt_a.id) not in linked and str(tt_b.id) not in linked


def test_an_unknown_within_falls_back_rather_than_widening_the_rule():
    """A typo must not silently turn "same sport" into "every sport" and idle
    the whole draw."""
    t, inst = _setup("typo")
    _team(t, inst, "Grace Sepak", SEPAK_BOYS)
    _team(t, inst, "Grace TT", TT_BOYS)

    cfg = _cfg([_record(within="everything")])
    assert cfg.institution_link_within == "sport"
    _reqs, _pre, linked = build_schedule_inputs(t, cfg)
    assert linked == {}


def test_the_generation_note_says_which_reach_was_used():
    """The organizer has to be able to read back what the rule actually does."""
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=30,
        venues=["A"],
    )
    notes = merge_stored_constraints(cfg, [_record()])
    assert any("SAME SPORT" in n for n in notes), notes

    cfg2 = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=30,
        venues=["A"],
    )
    notes2 = merge_stored_constraints(cfg2, [_record(within="any")])
    assert any("in any sport" in n for n in notes2), notes2


def test_a_team_with_no_sport_column_still_groups_by_its_leaf():
    """`Team.sport` was added after `leaf_key`; older rows have it blank, and
    the leaf key is sport-prefixed, so it must be the fallback."""
    t, inst = _setup("legacy")
    boys = _team(t, inst, "Grace Sepak Boys", SEPAK_BOYS, sport="")
    girls = _team(t, inst, "Grace Sepak Girls", SEPAK_GIRLS, sport="")
    tt = _team(t, inst, "Grace TT", TT_BOYS, sport="")

    linked = _linked(t, [_record()])
    assert linked.get(str(boys.id)) == {str(girls.id)}
    assert str(tt.id) not in linked


def test_it_composes_with_the_teacher_rule_without_either_swallowing_the_other():
    from apps.teams.models import RosterMemberKind, TeamStaff
    from apps.teams.services import roster as roster_svc

    t, inst = _setup("compose")
    sepak = _team(t, inst, "Grace Sepak", SEPAK_BOYS)
    tt_a = _team(t, inst, "Grace TT A", TT_BOYS)
    tt_b = _team(t, inst, "Grace TT B", TT_BOYS)
    teacher = roster_svc.declare_member(
        tournament=t, institution=inst, full_name="Mr Ao",
        kind=RosterMemberKind.TEACHER,
    )
    # One teacher runs the sepak side AND one table-tennis team.
    for team in (sepak, tt_a):
        TeamStaff.objects.create(
            organization=t.organization, team=team, member=teacher,
        )

    linked = _linked(t, [
        _record(),
        {"type": "no_staff_overlap", "scope": "all", "params": {}},
    ])
    # Same sport → the two TT teams are linked by the school rule…
    assert str(tt_b.id) in linked.get(str(tt_a.id), set())
    # …and across sports the TEACHER still binds sepak to her TT team, which
    # the school rule alone would have allowed to run together.
    assert str(sepak.id) in linked.get(str(tt_a.id), set())


# ------------------------------- the gap the validator judges the pair by
# `validate_schedule` used to read the GLOBAL `cfg.rest_minutes` for a linked
# pair while the placer resolved the scoped, venue-aware gap the host wrote.
# The two disagreed in both directions: on the live tournament the validator
# invented 42 conflicts in the greedy's own output (which made the packing pass
# a silent no-op), and with a wider authored gap it would instead have let the
# optimizer and every repair verb walk straight through the rule.
GAP_D = date(2026, 8, 1)


def _gap_cfg(records, **over):
    base = dict(
        date_start=GAP_D, date_end=GAP_D,
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=30,
        venues=["Hall", "Field"], venue_counts={"Hall": 2},
        rest_minutes=5, max_per_team_per_day=9,
    )
    base.update(over)
    cfg = ScheduleConfig(**base)
    merge_stored_constraints(cfg, records)
    return cfg


def _gap_matches(sport="sepak_takraw", leaf=SEPAK_BOYS):
    return [
        MatchSlotReq(id="m1", round_no=1, match_no=1, home="a", away="b",
                     sport=sport, leaf_key=leaf),
        MatchSlotReq(id="m2", round_no=1, match_no=2, home="c", away="d",
                     sport=sport, leaf_key=leaf),
    ]


def _at(h, m=0):
    return datetime.combine(GAP_D, time(h, m))


LINK = {"a": {"c"}, "c": {"a"}}


def test_a_gap_wider_than_the_global_rest_is_now_reported():
    """The permissive direction: the host asked for an hour between one
    school's two matches and the validator was blessing five minutes."""
    cfg = _gap_cfg([_record(min_gap_minutes=60, cross_venue_gap_minutes=60)])
    placed = {"m1": (_at(9), "Hall · T1"), "m2": (_at(9, 35), "Hall · T2")}
    codes = [
        v["code"] for v in validate_schedule(
            placed, _gap_matches(), cfg, linked=LINK,
        )
    ]
    assert "shared_player_conflict" in codes


def test_a_gap_narrower_than_the_global_rest_now_validates_clean():
    """The strict direction, and the one that shipped: the host wrote 0 and
    the validator was charging the global 5, so the engine's OWN schedule
    failed the engine's own oracle and the packing pass adopted nothing."""
    cfg = _gap_cfg([_record(min_gap_minutes=0, cross_venue_gap_minutes=0)])
    placed = {"m1": (_at(9), "Hall · T1"), "m2": (_at(9, 30), "Hall · T2")}
    assert validate_schedule(placed, _gap_matches(), cfg, linked=LINK) == []


def test_the_cross_venue_gap_governs_a_pair_in_two_different_halls():
    """Changing venues costs travel time, which is why the record carries two
    numbers. Same hall clears at 10 minutes; across halls it does not."""
    cfg = _gap_cfg([_record(min_gap_minutes=10, cross_venue_gap_minutes=90)])
    same_hall = {"m1": (_at(9), "Hall · T1"), "m2": (_at(9, 40), "Hall · T2")}
    assert validate_schedule(same_hall, _gap_matches(), cfg, linked=LINK) == []

    across = {"m1": (_at(9), "Hall · T1"), "m2": (_at(9, 40), "Field")}
    codes = [
        v["code"] for v in validate_schedule(
            across, _gap_matches(), cfg, linked=LINK,
        )
    ]
    assert "shared_player_conflict" in codes


def test_each_sport_is_judged_by_its_own_record():
    """Two records, one per sport. Before the resolver, whichever was read
    last governed both — a 40-minute sepak gap emptied table tennis mornings."""
    cfg = _gap_cfg([
        _record(scope="sport:table_tennis", min_gap_minutes=0,
                cross_venue_gap_minutes=0),
        _record(scope="sport:sepak_takraw", min_gap_minutes=90,
                cross_venue_gap_minutes=90),
    ])
    tt = _gap_matches(sport="table_tennis", leaf=TT_BOYS)
    sepak = _gap_matches()
    back_to_back = {"m1": (_at(9), "Hall · T1"), "m2": (_at(9, 30), "Hall · T2")}

    assert validate_schedule(back_to_back, tt, cfg, linked=LINK) == []
    assert [
        v["code"] for v in validate_schedule(
            back_to_back, sepak, cfg, linked=LINK,
        )
    ] == ["shared_player_conflict"]


def test_the_greedy_s_own_schedule_passes_its_own_validator():
    """The parity that matters: whatever the placer emits under a scoped link
    record, the validator must call clean. `optimizer._legal` gates on this,
    so a phantom violation here turns the whole packing pass into a no-op."""
    cfg = _gap_cfg([
        _record(scope="sport:table_tennis", min_gap_minutes=20,
                cross_venue_gap_minutes=60),
        _record(scope="sport:sepak_takraw", min_gap_minutes=40,
                cross_venue_gap_minutes=60),
    ])
    matches = [
        MatchSlotReq(id=f"{sport}-{i}", round_no=1, match_no=i,
                     home=f"{sport}-h{i}", away=f"{sport}-a{i}",
                     sport=sport, leaf_key=leaf)
        for sport, leaf in (("table_tennis", TT_BOYS), ("sepak_takraw", SEPAK_BOYS))
        for i in range(4)
    ]
    # Every team of one sport linked to every other — one school, four teams.
    linked = {
        m.home: {o.home for o in matches if o.sport == m.sport and o is not m}
        for m in matches
    }
    res = schedule_matches(matches, cfg, linked=linked)
    assert res.unscheduled == []
    assert validate_schedule(res.assignments, matches, cfg, linked=linked) == []
