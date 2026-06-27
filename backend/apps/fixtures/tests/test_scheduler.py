"""FET-style scheduling engine: slot enumeration, hard-constraint satisfaction
(venue single-use, rest, max-per-day), explainable unscheduled reporting,
validate_schedule, and the apply_schedule integration over real matches."""
from __future__ import annotations

from datetime import date, datetime, time

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.fixtures.services.generate import generate_round_robin
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    apply_schedule,
    build_slots,
    config_from_dict,
    court_venue_name,
    schedule_matches,
    validate_schedule,
)
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()


# --------------------------------------------------------------------------- pure
def test_build_slots_counts():
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 2),
        daily_start=time(9, 0), daily_end=time(12, 0), slot_minutes=90,
        venues=["A", "B"],
    )
    slots = build_slots(cfg)
    # 9:00 and 10:30 fit before 12:00 → 2 slots/day/venue x 2 days x 2 venues = 8
    assert len(slots) == 8
    assert slots == sorted(slots, key=lambda s: (s[0], s[1]))


def test_excluded_dates_removed():
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 2),
        daily_start=time(9, 0), daily_end=time(12, 0), slot_minutes=90,
        venues=["A"], excluded_dates={date(2026, 8, 2)},
    )
    assert all(dt.date() == date(2026, 8, 1) for dt, _venue, _wend in build_slots(cfg))


def _reqs(n):
    # n single-round matches between distinct team pairs
    return [
        MatchSlotReq(id=f"m{i}", round_no=1, match_no=i,
                     home=f"t{2*i}", away=f"t{2*i+1}")
        for i in range(n)
    ]


def test_venue_single_use_and_full_placement():
    cfg = ScheduleConfig(date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
                         daily_start=time(9, 0), daily_end=time(18, 0),
                         slot_minutes=90, venues=["A"], rest_minutes=0,
                         max_per_team_per_day=99)
    res = schedule_matches(_reqs(4), cfg)
    assert not res.unscheduled
    # no two matches share a (datetime, venue) slot
    assert len({v for v in res.assignments.values()}) == 4


def test_rest_minutes_forces_spacing_for_shared_team():
    # both matches involve team "shared" → must be spaced by slot+rest
    matches = [
        MatchSlotReq(id="m1", round_no=1, match_no=1, home="shared", away="a"),
        MatchSlotReq(id="m2", round_no=1, match_no=2, home="shared", away="b"),
    ]
    cfg = ScheduleConfig(date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
                         daily_start=time(9, 0), daily_end=time(18, 0),
                         slot_minutes=60, venues=["A", "B"], rest_minutes=60,
                         max_per_team_per_day=99)
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    t1, t2 = sorted(dt for dt, _ in res.assignments.values())
    assert (t2 - t1).total_seconds() >= (60 + 60) * 60  # slot + rest


def test_later_stage_is_timed_after_an_earlier_stage():
    # multi-stage: a stage-1 knockout (round 1) must still be placed AFTER every
    # stage-0 group match, even those in a HIGHER round_no — stage_no leads the
    # ordering so a bracket never lands mid-group.
    matches = [
        MatchSlotReq(id="g1", round_no=1, match_no=1, home="a", away="b", stage_no=0),
        MatchSlotReq(id="g2", round_no=2, match_no=2, home="c", away="d", stage_no=0),
        MatchSlotReq(id="ko", round_no=1, match_no=3, home="e", away="f", stage_no=1),
    ]
    cfg = ScheduleConfig(date_start=date(2026, 8, 1), date_end=date(2026, 8, 3),
                         daily_start=time(9, 0), daily_end=time(18, 0),
                         slot_minutes=90, venues=["A"], rest_minutes=0,
                         max_per_team_per_day=99)
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    ko_start = res.assignments["ko"][0]
    group_starts = [res.assignments[m][0] for m in ("g1", "g2")]
    assert ko_start > max(group_starts)  # knockout after all groups


def test_max_per_team_per_day_blocks_same_day():
    matches = [
        MatchSlotReq(id="m1", round_no=1, match_no=1, home="x", away="a"),
        MatchSlotReq(id="m2", round_no=1, match_no=2, home="x", away="b"),
    ]
    cfg = ScheduleConfig(date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
                         daily_start=time(9, 0), daily_end=time(18, 0),
                         slot_minutes=60, venues=["A", "B", "C"], rest_minutes=0,
                         max_per_team_per_day=1)
    res = schedule_matches(matches, cfg)
    # only one of team x's two matches fits on the single day
    assert len(res.unscheduled) == 1


def test_unscheduled_reported_when_infeasible():
    cfg = ScheduleConfig(date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
                         daily_start=time(9, 0), daily_end=time(10, 30),
                         slot_minutes=90, venues=["A"], rest_minutes=0,
                         max_per_team_per_day=99)
    # 1 slot available, 3 matches
    res = schedule_matches(_reqs(3), cfg)
    assert len(res.assignments) == 1 and len(res.unscheduled) == 2
    assert any("could not be placed" in e for e in res.explanation)


def test_validate_schedule_flags_venue_and_rest():
    matches = _reqs(2)
    same = datetime(2026, 8, 1, 9, 0)
    cfg = ScheduleConfig(date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
                         slot_minutes=60, venues=["A"], rest_minutes=30)
    bad = {"m0": (same, "A"), "m1": (same, "A")}  # both in the same venue slot
    v = validate_schedule(bad, matches, cfg)
    assert any(x["code"] == "venue_double_booked" for x in v)


# ----------------------------------------------------------------- court capacity
def _hall_cfg(count: int) -> ScheduleConfig:
    return ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["Hall"], venue_counts={"Hall": count}, rest_minutes=0,
        max_per_team_per_day=99,
    )


def test_court_venue_name_format():
    # The court-suffix format is the single source of truth (U+00B7 MIDDLE DOT).
    assert court_venue_name("Hall", 2) == "Hall · T2"
    assert court_venue_name("Hall", 2) == "Hall · T2"


def test_court_capacity_overflow_across_distinct_courts():
    # 2-court hall, 3 mutually-overlapping matches on T1/T2/T3 — distinct court
    # strings (so NOT venue_double_booked) but 3 concurrent on a 2-court base.
    matches = _reqs(3)
    at = datetime(2026, 8, 1, 9, 0)
    assign = {
        "m0": (at, court_venue_name("Hall", 1)),
        "m1": (at, court_venue_name("Hall", 2)),
        "m2": (at, court_venue_name("Hall", 3)),
    }
    v = validate_schedule(assign, matches, _hall_cfg(2))
    cap = [x for x in v if x["code"] == "court_capacity_exceeded"]
    assert cap, v
    assert cap[0]["venue"] == "Hall" and cap[0]["capacity"] == 2
    assert cap[0]["match_id"] in {"m0", "m1", "m2"}
    # Distinct courts → no same-court double-book reported.
    assert not any(x["code"] == "venue_double_booked" for x in v)


def test_court_capacity_within_count_ok():
    matches = _reqs(2)
    at = datetime(2026, 8, 1, 9, 0)
    assign = {
        "m0": (at, court_venue_name("Hall", 1)),
        "m1": (at, court_venue_name("Hall", 2)),
    }
    v = validate_schedule(assign, matches, _hall_cfg(2))
    assert not any(x["code"] == "court_capacity_exceeded" for x in v)


def test_court_capacity_counts_bare_base_absorption():
    # A bare-base "Hall" booking (legacy / preoccupied) occupies a court; two
    # more overlapping court matches push a 2-court base over capacity. The
    # reported subject must be a MOVABLE match, never the fixed booking.
    matches = _reqs(2)
    at = datetime(2026, 8, 1, 9, 0)
    end = datetime(2026, 8, 1, 10, 0)
    assign = {
        "m0": (at, court_venue_name("Hall", 1)),
        "m1": (at, court_venue_name("Hall", 2)),
    }
    preoccupied = [("Hall", at, end, set())]
    v = validate_schedule(assign, matches, _hall_cfg(2), preoccupied=preoccupied)
    cap = [x for x in v if x["code"] == "court_capacity_exceeded"]
    assert cap, v
    assert cap[0]["match_id"] in {"m0", "m1"}


def test_court_capacity_same_court_is_double_book_not_capacity():
    # Two overlapping on the SAME court of a 2-court base: that's the existing
    # venue_double_booked (exact string), and base concurrency (2) == cap, so
    # NO court_capacity_exceeded — the two codes stay complementary.
    matches = _reqs(2)
    at = datetime(2026, 8, 1, 9, 0)
    court = court_venue_name("Hall", 1)
    v = validate_schedule({"m0": (at, court), "m1": (at, court)}, matches, _hall_cfg(2))
    assert any(x["code"] == "venue_double_booked" for x in v)
    assert not any(x["code"] == "court_capacity_exceeded" for x in v)


def test_court_capacity_single_court_cross_string_collision():
    # A single-court venue (count=1) is NOT skipped: a stale "Hall · T1" (left
    # over after count dropped to 1) and a bare "Hall" booking occupy the one
    # physical court at the same time — distinct strings, so venue_double_booked
    # misses it, but the capacity pass must flag the cross-court collision.
    matches = _reqs(2)
    at = datetime(2026, 8, 1, 9, 0)
    assign = {
        "m0": (at, court_venue_name("Hall", 1)),  # stale court string
        "m1": (at, "Hall"),                        # bare base — same court
    }
    v = validate_schedule(assign, matches, _hall_cfg(1))
    assert any(x["code"] == "court_capacity_exceeded" for x in v), v


def test_court_capacity_single_court_same_string_is_only_double_book():
    matches = _reqs(2)
    at = datetime(2026, 8, 1, 9, 0)
    v = validate_schedule({"m0": (at, "Hall"), "m1": (at, "Hall")}, matches, _hall_cfg(1))
    assert any(x["code"] == "venue_double_booked" for x in v)
    assert not any(x["code"] == "court_capacity_exceeded" for x in v)


def test_court_capacity_distinct_times_ok():
    matches = _reqs(2)
    court = court_venue_name("Hall", 1)
    assign = {
        "m0": (datetime(2026, 8, 1, 9, 0), court),
        "m1": (datetime(2026, 8, 1, 10, 30), court),  # 60-min slot → no overlap
    }
    v = validate_schedule(assign, matches, _hall_cfg(2))
    assert not any(x["code"] == "court_capacity_exceeded" for x in v)


def test_greedy_schedule_never_violates_court_capacity():
    # Parity: a schedule the greedy placer accepts on an N-court venue must
    # yield ZERO court_capacity_exceeded from the validator (the two paths
    # must agree). 6 matches on a 2-court hall.
    matches = _reqs(6)
    cfg = _hall_cfg(2)
    res = schedule_matches(matches, cfg)
    assert not res.unscheduled
    v = validate_schedule(res.assignments, matches, cfg)
    assert not any(x["code"] == "court_capacity_exceeded" for x in v)


def test_config_from_dict_minimal():
    cfg = config_from_dict({"date_start": "2026-08-01", "date_end": "2026-08-03"})
    assert cfg.date_start == date(2026, 8, 1) and cfg.date_end == date(2026, 8, 3)
    assert cfg.venues == ["Main Ground"]


# --------------------------------------------------------------------------- integration
@pytest.mark.django_db
def test_apply_schedule_persists_and_audits():
    admin = User.objects.create_user(email="s@sch.test", password="FixtureDemo2026!",
                                     is_active=True)
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Sched Cup")
    register_school(tournament=t, school_name="Alpha", teams=[{"name": "A", "players": []}])
    register_school(tournament=t, school_name="Beta", teams=[{"name": "B", "players": []}])
    register_school(tournament=t, school_name="Gamma", teams=[{"name": "C", "players": []}])
    generate_round_robin(tournament=t, group_size=4)
    assert Match.objects.filter(tournament=t).count() == 3  # round-robin of 3

    res = apply_schedule(
        tournament=t,
        config={"date_start": "2026-08-01", "date_end": "2026-08-05",
                "slot_minutes": 60, "venues": ["Ground 1", "Ground 2"],
                "rest_minutes": 30, "max_per_team_per_day": 1},
        by=admin,
    )
    assert not res.unscheduled
    for m in Match.objects.filter(tournament=t):
        assert m.scheduled_at is not None and m.venue
    assert AuditEvent.objects.filter(
        event_type="fixtures_scheduled", target_id=t.id
    ).exists()


@pytest.mark.django_db
def test_apply_schedule_with_optimizer_persists_and_keeps_flag():
    """End-to-end: the optimize flag flows config_from_dict → greedy seed →
    optimizer → persisted slots; every match lands and the flag round-trips."""
    admin = User.objects.create_user(email="opt@sch.test", password="FixtureDemo2026!",
                                     is_active=True)
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Optimize Cup")
    for s in ("Alpha", "Beta", "Gamma", "Delta"):
        register_school(tournament=t, school_name=s,
                        teams=[{"name": s[0], "players": []}])
    generate_round_robin(tournament=t, group_size=4)

    res = apply_schedule(
        tournament=t,
        config={"date_start": "2026-08-01", "date_end": "2026-08-03",
                "slot_minutes": 60, "venues": ["Ground 1"],
                "rest_minutes": 30, "max_per_team_per_day": 1,
                "optimize": True, "optimize_engine": "local"},
        by=admin,
    )
    assert not res.unscheduled
    for m in Match.objects.filter(tournament=t):
        assert m.scheduled_at is not None and m.venue
    # The stored config kept the optimize flag for re-runs.
    t.refresh_from_db()
    assert t.scheduling_config.get("optimize") is True


@pytest.mark.django_db
def test_schedule_api_manager_only_and_isolation():
    from rest_framework.test import APIClient

    owner = User.objects.create_user(email="o@sch.test", password="FixtureDemo2026!",
                                     is_active=True)
    owner.email_verified_at = timezone.now()
    owner.save(update_fields=["email_verified_at"])
    t = create_tournament(user=owner, name="API Sched")
    register_school(tournament=t, school_name="A", teams=[{"name": "A", "players": []}])
    register_school(tournament=t, school_name="B", teams=[{"name": "B", "players": []}])
    generate_round_robin(tournament=t, group_size=4)

    c = APIClient()
    c.force_authenticate(user=owner)
    r = c.post(
        f"/api/tournaments/{t.id}/schedule/",
        {"date_start": "2026-08-01", "date_end": "2026-08-03", "venues": ["G1"]},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["scheduled"] == 1  # round-robin of 2 teams = 1 match

    # outsider cannot reach it -> 404 (no existence leak)
    outsider = User.objects.create_user(email="x@sch.test", password="FixtureDemo2026!",
                                        is_active=True)
    c2 = APIClient()
    c2.force_authenticate(user=outsider)
    assert c2.post(f"/api/tournaments/{t.id}/schedule/",
                   {"date_start": "2026-08-01", "date_end": "2026-08-03"},
                   format="json").status_code == 404
