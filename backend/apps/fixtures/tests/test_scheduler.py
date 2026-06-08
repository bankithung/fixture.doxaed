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
    assert all(dt.date() == date(2026, 8, 1) for dt, _ in build_slots(cfg))


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
