"""P3 scheduler upgrade (spec 2026-06-10): per-sport durations with interval
occupancy, venue types/windows, stored-constraint enforcement, tournament-TZ
persistence, never-touch-live guard, and per-leaf runs that respect other
competitions' bookings."""
from __future__ import annotations

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    apply_schedule,
    config_from_dict,
    merge_stored_constraints,
    schedule_matches,
)
from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.rules import update_settings
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["A"], rest_minutes=0, max_per_team_per_day=99,
    )
    base.update(over)
    return ScheduleConfig(**base)


# ------------------------------------------------------------------ durations
def test_variable_durations_use_interval_overlap_not_slot_equality():
    # a 100' football match at 9:00 must block a 30' TT match at 10:00 on the
    # same venue (the old exact-tuple occupancy would have allowed it)
    matches = [
        MatchSlotReq(id="fb", round_no=1, match_no=1, home="f1", away="f2",
                     duration_minutes=100),
        MatchSlotReq(id="tt", round_no=1, match_no=2, home="t1", away="t2",
                     duration_minutes=30),
    ]
    res = schedule_matches(matches, _cfg())
    assert not res.unscheduled
    (fb_dt, fb_v), (tt_dt, tt_v) = res.assignments["fb"], res.assignments["tt"]
    assert fb_v == tt_v == "A"
    assert fb_dt == datetime(2026, 8, 1, 9, 0)
    # next grid start is 10:00 but 9:00+100' = 10:40 → TT lands at 11:00
    assert tt_dt >= datetime(2026, 8, 1, 10, 40)


def test_match_must_fit_its_venue_window():
    # window ends 10:00; a 100' match cannot start at 9:00
    matches = [MatchSlotReq(id="m", round_no=1, match_no=1, home="a", away="b",
                            duration_minutes=100)]
    res = schedule_matches(matches, _cfg(daily_end=time(10, 0)))
    assert res.unscheduled == ["m"]


# ------------------------------------------------------------------ venue types
def test_venue_type_compatibility():
    matches = [MatchSlotReq(id="tt", round_no=1, match_no=1, home="a", away="b",
                            venue_type="indoor_court")]
    cfg = _cfg(venues=["Ground", "Hall"],
               venue_types={"Ground": "ground", "Hall": "indoor_court"})
    res = schedule_matches(matches, cfg)
    assert res.assignments["tt"][1] == "Hall"
    # no compatible venue → unscheduled, never mis-placed
    cfg2 = _cfg(venues=["Ground"], venue_types={"Ground": "ground"})
    res2 = schedule_matches(matches, cfg2)
    assert res2.unscheduled == ["tt"]


def test_rich_venue_records_parse_types_and_windows():
    cfg = config_from_dict({
        "date_start": "2026-08-01", "date_end": "2026-08-01",
        "venues": [
            {"name": "Hall", "venue_type": "indoor_court",
             "windows": [{"from": "10:00", "to": "13:00"}]},
            "Main Ground",
        ],
    })
    assert cfg.venues == ["Hall", "Main Ground"]
    assert cfg.venue_types == {"Hall": "indoor_court"}
    assert cfg.venue_windows == {"Hall": [(time(10, 0), time(13, 0))]}


# ------------------------------------------------------------------ stored constraints
def test_stored_constraints_are_enforced():
    cfg = _cfg(date_end=date(2026, 8, 3))
    notes = merge_stored_constraints(cfg, [
        {"type": "blackout_dates", "params": {"dates": ["2026-08-01"]}},
        {"type": "team_unavailable",
         "params": {"team_id": "tA", "dates": ["2026-08-02"]}},
        {"type": "min_rest_minutes", "params": {"minutes": 120}},
        {"type": "max_matches_per_team_per_day", "params": {"count": 2}},
    ])
    assert cfg.excluded_dates == {date(2026, 8, 1)}
    assert cfg.team_blackouts == {"tA": {date(2026, 8, 2)}}
    assert cfg.rest_minutes == 120
    assert cfg.max_per_team_per_day == 2
    assert len(notes) == 4

    # team tA can only land on Aug 3 (Aug 1 blacked out globally, Aug 2 for tA)
    res = schedule_matches(
        [MatchSlotReq(id="m", round_no=1, match_no=1, home="tA", away="tB")], cfg
    )
    assert res.assignments["m"][0].date() == date(2026, 8, 3)


def test_preferred_window_soft_constraint_steers_placement():
    cfg = _cfg()
    merge_stored_constraints(cfg, [
        {"type": "preferred_window", "params": {"from": "15:00", "to": "17:00"}},
    ])
    res = schedule_matches(
        [MatchSlotReq(id="m", round_no=1, match_no=1, home="a", away="b")], cfg
    )
    assert time(15, 0) <= res.assignments["m"][0].time() < time(17, 0)


# ------------------------------------------------------------------ integration
def _admin(email="sched@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!",
                                 is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


@pytest.mark.django_db
def test_apply_schedule_per_leaf_tz_status_guard_and_config_persist():
    admin = _admin()
    t = create_tournament(user=admin, name="Games")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}]},
        {"name": "Table Tennis"},
    ])
    t.save(update_fields=["sports"])
    register_school(tournament=t, school_name="A", teams=[
        {"name": "FB-A", "sport": "football", "leaf_key": "football.u15", "players": []},
        {"name": "TT-A", "sport": "table_tennis", "leaf_key": "table_tennis", "players": []},
    ])
    register_school(tournament=t, school_name="B", teams=[
        {"name": "FB-B", "sport": "football", "leaf_key": "football.u15", "players": []},
        {"name": "TT-B", "sport": "table_tennis", "leaf_key": "table_tennis", "players": []},
    ])
    from apps.fixtures.services.generate import generate_round_robin_by_category

    generate_round_robin_by_category(tournament=t)
    fb = Match.objects.get(tournament=t, leaf_key="football.u15")
    tt = Match.objects.get(tournament=t, leaf_key="table_tennis")

    config = {"date_start": "2026-08-01", "date_end": "2026-08-01",
              "venues": ["Ground"]}
    # schedule ONLY the football leaf
    res = apply_schedule(tournament=t, config=config, by=admin,
                         leaf_key="football.u15")
    assert list(res.assignments) == [str(fb.id)]
    fb.refresh_from_db()
    tt.refresh_from_db()
    assert tt.scheduled_at is None  # other leaf untouched
    # invariant 14: persisted in the TOURNAMENT timezone (Asia/Kolkata default)
    local = fb.scheduled_at.astimezone(ZoneInfo(t.time_zone))
    assert (local.hour, local.minute) == (9, 0)
    t.refresh_from_db()
    assert t.scheduling_config == config  # wizard prefill persists

    # the TT leaf schedules AROUND football's booking on the shared venue:
    # football 9:00+100' (profile duration) → TT (30') can't start before 10:40
    res2 = apply_schedule(tournament=t, config=config, by=admin,
                          leaf_key="table_tennis")
    tt.refresh_from_db()
    assert str(tt.id) in res2.assignments
    tt_local = tt.scheduled_at.astimezone(ZoneInfo(t.time_zone))
    assert tt_local.replace(tzinfo=None) >= datetime(2026, 8, 1, 10, 40)

    # status guard: a live match is never rescheduled
    fb.status = MatchStatus.LIVE
    fb.save(update_fields=["status"])
    before = fb.scheduled_at
    apply_schedule(tournament=t, config={"date_start": "2026-09-01",
                                         "date_end": "2026-09-01",
                                         "venues": ["Other"]}, by=admin)
    fb.refresh_from_db()
    assert fb.scheduled_at == before


@pytest.mark.django_db
def test_stored_tournament_constraints_reach_the_engine():
    admin = _admin("c@test.local")
    t = create_tournament(user=admin, name="Blackout Cup")
    register_school(tournament=t, school_name="A", teams=[{"name": "A", "players": []}])
    register_school(tournament=t, school_name="B", teams=[{"name": "B", "players": []}])
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    update_settings(
        tournament=t, by=admin,
        constraints=[{"type": "blackout_dates",
                      "params": {"dates": ["2026-08-01"]}}],
    )
    res = apply_schedule(
        tournament=t,
        config={"date_start": "2026-08-01", "date_end": "2026-08-02",
                "venues": ["G"]},
        by=admin,
    )
    (dt, _v), = res.assignments.values()
    assert dt.date() == date(2026, 8, 2)  # stored blackout respected
    assert any("blackout" in e.lower() for e in res.explanation)
