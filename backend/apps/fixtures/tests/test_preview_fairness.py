"""TDD — fairness analytics in the dry-run preview (increment R).

The preview response's ``fairness`` block grows per-team metrics computed
PURELY from the simulated assignments (no persistence): rest-minutes
min/median, early-slot count (first 2 hours of each day's window), late-slot
count (last 2 hours), venue spread and matches-per-day max — plus outlier
``flags`` (>2x-median early slots, rest below the configured gap). Legacy
keys (``rest_min_by_team``/``venue_distribution``/``days_used``) stay."""
from __future__ import annotations

from datetime import date, datetime, time

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.preview import _fairness, preview_fixtures
from apps.fixtures.services.scheduler import MatchSlotReq, ScheduleConfig
from apps.matches.models import Match
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()

LEAF = "football.u15"

SCHEDULE = {
    "date_start": "2026-08-01", "date_end": "2026-08-07",
    "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
    "venues": ["G"], "rest_minutes": 0, "max_per_team_per_day": 4,
}


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 7),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["G1", "G2"], rest_minutes=60, max_per_team_per_day=4,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _req(id, home, away, match_no=1):
    return MatchSlotReq(id=id, round_no=1, match_no=match_no,
                        home=home, away=away)


def _team(entry_list, tid):
    return next(t for t in entry_list if t["team_id"] == tid)


# -------------------------------------------------------------- pure metrics
def test_fairness_per_team_metrics():
    cfg = _cfg()
    reqs = [
        _req("m1", "A", "B", 1),
        _req("m2", "A", "C", 2),
        _req("m3", "A", "D", 3),
    ]
    assignments = {
        "m1": (datetime(2026, 8, 1, 9, 0), "G1"),    # early (9:00 < 11:00)
        "m2": (datetime(2026, 8, 1, 16, 30), "G2"),  # late (>= 16:00)
        "m3": (datetime(2026, 8, 2, 9, 30), "G1"),   # early
    }
    out = _fairness(assignments, reqs, cfg, team_names={"A": "Alpha"})
    a = _team(out["teams"], "A")
    assert a["name"] == "Alpha"
    # gaps: 10:00->16:30 = 390', 17:30->next-day 9:30 = 960'
    assert a["rest_min"] == 390
    assert a["rest_median"] == 675
    assert a["early"] == 2
    assert a["late"] == 1
    assert a["venues"] == 2
    assert a["max_per_day"] == 2  # two matches on Aug 1
    b = _team(out["teams"], "B")
    assert b["rest_min"] is None and b["rest_median"] is None
    assert (b["early"], b["late"], b["venues"], b["max_per_day"]) == (1, 0, 1, 1)
    # no outliers here: early counts [2,1,1,0] -> median 1, 2 is not > 2*1
    assert out["flags"] == []
    # legacy keys survive (API back-compat)
    assert out["rest_min_by_team"]["A"] == 390
    assert out["days_used"] == 2
    assert out["venue_distribution"] == {"G1": 2, "G2": 1}


def test_fairness_venue_spread_counts_base_venues_not_sub_venues():
    cfg = _cfg(venues=["Hall"], venue_counts={"Hall": 2})
    reqs = [_req("m1", "A", "B", 1), _req("m2", "A", "C", 2)]
    assignments = {
        "m1": (datetime(2026, 8, 1, 9, 0), "Hall · T1"),
        "m2": (datetime(2026, 8, 2, 9, 0), "Hall · T2"),
    }
    out = _fairness(assignments, reqs, cfg)
    assert _team(out["teams"], "A")["venues"] == 1  # one physical hall


def test_fairness_flags_rest_below_configured_minimum():
    cfg = _cfg(venues=["G"], rest_minutes=120)
    reqs = [_req("m1", "A", "B", 1), _req("m2", "A", "C", 2)]
    assignments = {
        "m1": (datetime(2026, 8, 1, 9, 0), "G"),
        "m2": (datetime(2026, 8, 1, 10, 30), "G"),  # 30' gap < 120'
    }
    out = _fairness(assignments, reqs, cfg)
    flag = next(f for f in out["flags"] if f["code"] == "rest_below_min")
    assert flag["team_id"] == "A"
    assert flag["value"] == 30
    assert flag["median"] == 30  # A is the only team with 2+ matches
    assert all(f["team_id"] == "A" for f in out["flags"])


def test_fairness_flags_early_slot_outlier_over_double_median():
    cfg = _cfg(venues=["G"], rest_minutes=0)
    reqs = [
        _req("m1", "A", "B", 1),
        _req("m2", "A", "C", 2),
        _req("m3", "A", "D", 3),
    ]
    assignments = {  # A opens every day; B/C/D each get one early slot
        "m1": (datetime(2026, 8, 1, 9, 0), "G"),
        "m2": (datetime(2026, 8, 2, 9, 0), "G"),
        "m3": (datetime(2026, 8, 3, 9, 0), "G"),
    }
    out = _fairness(assignments, reqs, cfg)
    flags = [f for f in out["flags"] if f["code"] == "early_outlier"]
    assert len(flags) == 1
    assert flags[0]["team_id"] == "A"
    assert flags[0]["value"] == 3
    assert flags[0]["median"] == 1  # early counts [3,1,1,1]


def test_fairness_no_early_outlier_for_single_morning_match_when_median_zero():
    # Regression: with median 0 (most teams never open a court), "> 2*median"
    # used to flag EVERY team that played one morning match, flooding the check
    # with "1 vs median 0" noise. Opening one session is normal -> no flags.
    cfg = _cfg(venues=["G1"], rest_minutes=0)
    reqs = [
        _req("m1", "A", "B", 1), _req("m2", "C", "D", 2),
        _req("m3", "E", "F", 3), _req("m4", "G", "H", 4),
        _req("m5", "I", "J", 5),
    ]
    assignments = {
        "m1": (datetime(2026, 8, 1, 9, 0), "G1"),   # A, B early
        "m2": (datetime(2026, 8, 1, 9, 30), "G1"),  # C, D early
        "m3": (datetime(2026, 8, 1, 14, 0), "G1"),  # rest are afternoon
        "m4": (datetime(2026, 8, 1, 14, 30), "G1"),
        "m5": (datetime(2026, 8, 1, 15, 0), "G1"),
    }
    out = _fairness(assignments, reqs, cfg)
    # early counts: A,B,C,D=1, E..J=0 -> median 0; nobody opens 3+ sessions.
    assert [f for f in out["flags"] if f["code"] == "early_outlier"] == []


def test_fairness_early_outlier_flags_repeat_opener_when_median_zero():
    # A opens the day three times while most teams never do -> a real outlier.
    cfg = _cfg(venues=["G1", "G2"], rest_minutes=0)
    reqs = [
        _req("m1", "A", "B", 1), _req("m2", "A", "C", 2), _req("m3", "A", "D", 3),
        _req("m4", "E", "F", 4), _req("m5", "G", "H", 5),
        _req("m6", "I", "J", 6), _req("m7", "K", "L", 7),
    ]
    assignments = {
        "m1": (datetime(2026, 8, 1, 9, 0), "G1"),
        "m2": (datetime(2026, 8, 2, 9, 0), "G1"),
        "m3": (datetime(2026, 8, 3, 9, 0), "G1"),
        "m4": (datetime(2026, 8, 1, 14, 0), "G1"),
        "m5": (datetime(2026, 8, 1, 14, 0), "G2"),
        "m6": (datetime(2026, 8, 1, 15, 0), "G1"),
        "m7": (datetime(2026, 8, 1, 15, 0), "G2"),
    }
    out = _fairness(assignments, reqs, cfg)
    flags = [f for f in out["flags"] if f["code"] == "early_outlier"]
    # early counts: A=3, B,C,D=1, E..L=0 -> median 0, only A opens 3+.
    assert [f["team_id"] for f in flags] == ["A"]
    assert flags[0]["value"] == 3 and flags[0]["median"] == 0


# ---------------------------------------------------------- preview response
@pytest.mark.django_db
def test_preview_fairness_block_resolves_names_and_persists_nothing():
    admin = User.objects.create_user(
        email="fair@test.local", password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Fair Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"S T{i}", "leaf_key": LEAF, "sport": "football",
                "players": []} for i in range(4)],
    )
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF, draw={"format": "by_category"},
        schedule=SCHEDULE, include_schedule=True,
    )
    assert not out["unscheduled"]
    fairness = out["fairness"]
    by_name = {e["name"]: e for e in fairness["teams"]}
    assert set(by_name) == {f"S T{i}" for i in range(4)}
    names = {str(tm.id): tm.name for tm in Team.objects.filter(tournament=t)}
    for entry in fairness["teams"]:
        assert names[entry["team_id"]] == entry["name"]
        assert entry["early"] + entry["late"] <= 3      # 3 matches each
        assert entry["venues"] >= 1 and entry["max_per_day"] >= 1
        assert entry["rest_min"] is not None            # everyone plays 3
    assert isinstance(fairness["flags"], list)
    # legacy §5.2 keys still present
    assert set(fairness["rest_min_by_team"]) <= set(names)
    assert fairness["days_used"] >= 1
    # rest_min_by_team agrees with the per-team entries
    for tid, rest in fairness["rest_min_by_team"].items():
        assert _team(fairness["teams"], tid)["rest_min"] == rest
    assert Match.objects.count() == 0                    # still a pure simulate


@pytest.mark.django_db
def test_preview_without_schedule_keeps_fairness_empty():
    admin = User.objects.create_user(
        email="fair2@test.local", password="FixtureDemo2026!", is_active=True,
    )
    admin.email_verified_at = timezone.now()
    admin.save(update_fields=["email_verified_at"])
    t = create_tournament(user=admin, name="Fair Cup 2")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"S T{i}", "leaf_key": LEAF, "sport": "football",
                "players": []} for i in range(2)],
    )
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF, draw={"format": "by_category"},
        include_schedule=False,
    )
    assert out["fairness"] == {}
