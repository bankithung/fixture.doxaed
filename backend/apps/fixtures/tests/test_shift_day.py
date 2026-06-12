"""Control-room repair seam, increment D — rain-day shift
(`POST /api/tournaments/{id}/fixtures/shift-day/`): moves every movable
(scheduled/postponed, not locked) match on from_date to to_date keeping each
match's time-of-day and venue. With to_date omitted the first stored reserve
day (constraint type=reserve_days) on/after from_date is used and ACTIVATED —
persisted on scheduling_config["activated_reserve_days"] so build_slots /
validation / future scheduler runs treat the day as available. Hard
violations 409 with the structured payload unless force; ONE shift_day audit
row with per-match before/after."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.fixtures.services.scheduler import (
    apply_schedule,
    build_slots,
    config_from_dict,
    merge_stored_constraints,
)
from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

RESERVE = [{"type": "reserve_days", "scope": "all", "hard": True,
            "params": {"dates": ["2026-08-09", "2026-08-20"]}}]


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _setup(constraints=None):
    """4-team round robin; the two disjoint pairs (T1/T2 @09:00, T3/T4
    @11:00, both venue G) sit on the rain day 2026-08-03; the other four
    matches are parked one-per-day from 2026-08-25."""
    admin = _verified(f"rain-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Rain Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-31",
        "venues": ["G", "G2"], "slot_minutes": 90,
        "rest_minutes": 60, "max_per_team_per_day": 2,
    }
    if constraints is not None:
        t.constraints = constraints
    t.save(update_fields=["scheduling_config", "constraints"])
    tz = ZoneInfo(t.time_zone)
    matches = list(
        Match.objects.filter(tournament=t)
        .select_related("home_team", "away_team")
        .order_by("match_no")
    )

    def by_names(a: str, b: str) -> Match:
        return next(
            m for m in matches
            if {m.home_team.name, m.away_team.name} == {a, b}
        )

    m1 = by_names("Team 1", "Team 2")
    m2 = by_names("Team 3", "Team 4")
    m1.scheduled_at = datetime(2026, 8, 3, 9, 0, tzinfo=tz)
    m2.scheduled_at = datetime(2026, 8, 3, 11, 0, tzinfo=tz)
    for m in (m1, m2):
        m.venue = "G"
        m.save(update_fields=["scheduled_at", "venue"])
    day = 25
    for m in matches:
        if m.id in (m1.id, m2.id):
            continue
        m.scheduled_at = datetime(2026, 8, day, 9, 0, tzinfo=tz)
        m.venue = "G2"
        m.save(update_fields=["scheduled_at", "venue"])
        day += 1
    return admin, t, tz, m1, m2, by_names


def _shift(admin, t, payload):
    return _client(admin).post(
        f"/api/tournaments/{t.id}/fixtures/shift-day/", payload, format="json"
    )


def _loc(m: Match, tz):
    return m.scheduled_at.astimezone(tz)


# ----------------------------------------------------------------- happy path
def test_shift_keeps_time_of_day_and_venue_and_audits_once():
    admin, t, tz, m1, m2, _ = _setup()
    r = _shift(admin, t, {"from_date": "2026-08-03", "to_date": "2026-08-15"})
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["to_date"] == "2026-08-15"
    assert body["violations"] == []
    assert {e["match_id"] for e in body["moved"]} == {str(m1.id), str(m2.id)}
    m1.refresh_from_db()
    m2.refresh_from_db()
    l1, l2 = _loc(m1, tz), _loc(m2, tz)
    assert (l1.day, l1.hour, l1.minute) == (15, 9, 0)
    assert (l2.day, l2.hour, l2.minute) == (15, 11, 0)
    assert m1.venue == "G" and m2.venue == "G"

    ev = AuditEvent.objects.get(event_type="shift_day", target_id=t.id)
    assert ev.payload_after["from_date"] == "2026-08-03"
    assert ev.payload_after["to_date"] == "2026-08-15"
    moved = {e["match_id"]: e for e in ev.payload_after["moved"]}
    assert moved[str(m1.id)]["old"] != moved[str(m1.id)]["new"]


def test_live_and_locked_matches_stay_behind():
    admin, t, tz, m1, m2, by_names = _setup()
    m2.status = MatchStatus.LIVE
    m2.save(update_fields=["status"])
    m3 = by_names("Team 2", "Team 3")
    m3.scheduled_at = datetime(2026, 8, 3, 13, 0, tzinfo=tz)
    m3.venue = "G"
    m3.locked_at = timezone.now()
    m3.save(update_fields=["scheduled_at", "venue", "locked_at"])

    r = _shift(admin, t, {"from_date": "2026-08-03", "to_date": "2026-08-15"})
    assert r.status_code == 200, r.content
    assert [e["match_id"] for e in r.json()["moved"]] == [str(m1.id)]
    for m in (m1, m2, m3):
        m.refresh_from_db()
    assert _loc(m1, tz).day == 15
    assert _loc(m2, tz).day == 3   # live: never moved
    assert _loc(m3, tz).day == 3   # locked: never moved


def test_postponed_matches_move_too():
    admin, t, tz, m1, _m2, _ = _setup()
    m1.status = MatchStatus.POSTPONED
    m1.save(update_fields=["status"])
    r = _shift(admin, t, {"from_date": "2026-08-03", "to_date": "2026-08-15"})
    assert r.status_code == 200, r.content
    m1.refresh_from_db()
    assert _loc(m1, tz).day == 15
    assert m1.status == MatchStatus.POSTPONED  # status untouched here


def test_leaf_key_scopes_the_move():
    admin, t, tz, m1, m2, _ = _setup()
    m1.leaf_key = "football.u15.boys"
    m1.save(update_fields=["leaf_key"])
    m2.leaf_key = "football.u17.boys"
    m2.save(update_fields=["leaf_key"])
    r = _shift(admin, t, {
        "from_date": "2026-08-03", "to_date": "2026-08-15",
        "leaf_key": "football.u15.boys",
    })
    assert r.status_code == 200, r.content
    assert [e["match_id"] for e in r.json()["moved"]] == [str(m1.id)]
    m2.refresh_from_db()
    assert _loc(m2, tz).day == 3


# ----------------------------------------------------------- reserve-day pick
def test_omitted_to_date_picks_first_reserve_day_and_activates_it():
    admin, t, tz, m1, _m2, _ = _setup(constraints=RESERVE)
    r = _shift(admin, t, {"from_date": "2026-08-03"})
    assert r.status_code == 200, r.content
    assert r.json()["to_date"] == "2026-08-09"
    m1.refresh_from_db()
    l1 = _loc(m1, tz)
    assert (l1.day, l1.hour) == (9, 9)
    t.refresh_from_db()
    assert t.scheduling_config["activated_reserve_days"] == ["2026-08-09"]
    ev = AuditEvent.objects.get(event_type="shift_day", target_id=t.id)
    assert ev.payload_after["activated_reserve_day"] is True


def test_explicit_reserve_to_date_is_also_activated():
    admin, t, _tz, _m1, _m2, _ = _setup(constraints=RESERVE)
    r = _shift(admin, t, {"from_date": "2026-08-03", "to_date": "2026-08-20"})
    assert r.status_code == 200, r.content
    t.refresh_from_db()
    assert t.scheduling_config["activated_reserve_days"] == ["2026-08-20"]


def test_no_reserve_day_available_is_an_error():
    admin, t, _tz, _m1, _m2, _ = _setup()  # no reserve_days stored
    r = _shift(admin, t, {"from_date": "2026-08-03"})
    assert r.status_code == 400, r.content
    detail = r.json()["detail"]
    assert "reserve_day_unavailable" in (
        detail if isinstance(detail, list) else [detail]
    )


def test_second_rain_day_skips_the_already_activated_reserve():
    admin, t, _tz, _m1, _m2, _ = _setup(constraints=RESERVE)
    assert _shift(admin, t, {"from_date": "2026-08-03"}).json()["to_date"] \
        == "2026-08-09"
    # rain again on the activated reserve day → next reserve, not itself
    r = _shift(admin, t, {"from_date": "2026-08-09"})
    assert r.status_code == 200, r.content
    assert r.json()["to_date"] == "2026-08-20"
    t.refresh_from_db()
    assert t.scheduling_config["activated_reserve_days"] == [
        "2026-08-09", "2026-08-20",
    ]


# ------------------------------------------------- activation reaches the grid
def test_activated_reserve_day_joins_the_slot_grid():
    cfg = config_from_dict({
        "date_start": "2026-08-09", "date_end": "2026-08-09",
        "venues": ["G"], "slot_minutes": 90,
    })
    merge_stored_constraints(cfg, RESERVE)
    assert build_slots(cfg) == []  # reserve day: excluded by default

    cfg2 = config_from_dict({
        "date_start": "2026-08-09", "date_end": "2026-08-09",
        "venues": ["G"], "slot_minutes": 90,
        "activated_reserve_days": ["2026-08-09"],
    })
    merge_stored_constraints(cfg2, RESERVE)
    assert any(s[0].date() == date(2026, 8, 9) for s in build_slots(cfg2))


def test_scheduler_rerun_keeps_the_activated_day_and_the_activation():
    admin, t, _tz, _m1, _m2, _ = _setup(constraints=RESERVE)
    r = _shift(admin, t, {"from_date": "2026-08-03"})
    assert r.status_code == 200, r.content
    t.refresh_from_db()  # the view's instance persisted the activation
    # re-run the engine over ONLY the activated reserve day with a payload
    # that does not mention activation — the stored set must carry it.
    res = apply_schedule(
        tournament=t,
        config={
            "date_start": "2026-08-09", "date_end": "2026-08-09",
            "venues": ["G", "G2"], "slot_minutes": 90,
            "rest_minutes": 0, "max_per_team_per_day": 9,
        },
        by=admin,
    )
    assert len(res.assignments) == 6, res.explanation  # day is usable
    assert res.unscheduled == []
    t.refresh_from_db()
    assert t.scheduling_config["activated_reserve_days"] == ["2026-08-09"]


# ------------------------------------------------------------------ conflicts
def test_conflict_on_target_day_409_unless_forced():
    admin, t, tz, m1, _m2, by_names = _setup()
    blocker = by_names("Team 2", "Team 4")
    blocker.scheduled_at = datetime(2026, 8, 15, 9, 0, tzinfo=tz)  # m1's slot
    blocker.venue = "G"
    blocker.save(update_fields=["scheduled_at", "venue"])

    r = _shift(admin, t, {"from_date": "2026-08-03", "to_date": "2026-08-15"})
    assert r.status_code == 409, r.content
    body = r.json()
    assert body["detail"] == "schedule_conflicts"
    codes = {v["code"] for v in body["violations"]}
    assert "venue_double_booked" in codes
    m1.refresh_from_db()
    assert _loc(m1, tz).day == 3  # nothing applied

    r2 = _shift(admin, t, {
        "from_date": "2026-08-03", "to_date": "2026-08-15", "force": True,
    })
    assert r2.status_code == 200, r2.content
    assert any(
        v["code"] == "venue_double_booked" for v in r2.json()["violations"]
    )
    m1.refresh_from_db()
    assert _loc(m1, tz).day == 15


def test_team_blackout_on_target_day_blocks():
    admin, t, _tz, m1, _m2, _ = _setup()
    t.constraints = [{
        "type": "team_unavailable", "scope": "all", "hard": True,
        "params": {"team_id": str(m1.home_team_id), "dates": ["2026-08-15"]},
    }]
    t.save(update_fields=["constraints"])
    r = _shift(admin, t, {"from_date": "2026-08-03", "to_date": "2026-08-15"})
    assert r.status_code == 409, r.content
    assert any(v["code"] == "team_blackout" for v in r.json()["violations"])


# ------------------------------------------------------------------- guards
def test_empty_day_is_rejected():
    admin, t, _tz, _m1, _m2, _ = _setup()
    r = _shift(admin, t, {"from_date": "2026-08-04", "to_date": "2026-08-15"})
    assert r.status_code == 400


def test_invalid_dates_rejected():
    admin, t, _tz, _m1, _m2, _ = _setup()
    assert _shift(admin, t, {"from_date": "not-a-date"}).status_code == 400
    assert _shift(
        admin, t, {"from_date": "2026-08-03", "to_date": "2026-08-03"}
    ).status_code == 400  # no-op shift


def test_permissions():
    _admin, t, _tz, _m1, _m2, _ = _setup()
    outsider = _verified("rain-out@test.local")
    assert _shift(outsider, t, {
        "from_date": "2026-08-03", "to_date": "2026-08-15",
    }).status_code == 404
    tm = _verified("rain-tm@test.local")
    TournamentMembership.objects.create(
        user=tm, tournament=t, role=TournamentMembershipRole.TEAM_MANAGER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _shift(tm, t, {
        "from_date": "2026-08-03", "to_date": "2026-08-15",
    }).status_code == 403


def test_idempotent_on_event_id():
    admin, t, _tz, _m1, _m2, _ = _setup()
    eid = str(uuid.uuid4())
    payload = {
        "from_date": "2026-08-03", "to_date": "2026-08-15", "event_id": eid,
    }
    r1 = _shift(admin, t, payload)
    assert r1.status_code == 200, r1.content
    r2 = _shift(admin, t, payload)
    assert r2.status_code == 200, r2.content
    assert r2.json()["moved"] == r1.json()["moved"]
    assert r2.json()["to_date"] == "2026-08-15"
    assert AuditEvent.objects.filter(
        event_type="shift_day", target_id=t.id
    ).count() == 1
