"""TDD — per-venue date unavailability (increment S).

``Venue.unavailable_dates`` (list of ISO dates) marks a venue's off-days:
``build_slots``/``validate_schedule`` exclude those dates for THAT venue
only, the venues API round-trips the field, and the repair-verb validation
honors it — moving a match onto a venue's off-day is the hard violation
``venue_unavailable``. The model field is authoritative everywhere (a date
added AFTER the original run still blocks repairs)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.models import Venue
from apps.fixtures.services.repair import RepairConflict, reschedule_match
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    build_slots,
    config_from_dict,
    validate_schedule,
)
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()

SAT, SUN = date(2026, 8, 1), date(2026, 8, 2)


def _cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=SAT, date_end=SUN,
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["A", "B"], rest_minutes=0, max_per_team_per_day=99,
    )
    base.update(over)
    return ScheduleConfig(**base)


def _verified(email):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ------------------------------------------------------------------ pure engine
def test_config_from_dict_parses_unavailable_dates():
    cfg = config_from_dict({
        "date_start": "2026-08-01", "date_end": "2026-08-02",
        "venues": [
            {"name": "A", "unavailable_dates": ["2026-08-01"]},
            "B",
        ],
    })
    assert cfg.venue_unavailable_dates == {"A": {SAT}}


def test_build_slots_excludes_off_days_for_that_venue_only():
    cfg = _cfg(venue_unavailable_dates={"A": {SAT}})
    slots = build_slots(cfg)
    assert not any(v == "A" and dt.date() == SAT for dt, v, _w in slots)
    assert any(v == "A" and dt.date() == SUN for dt, v, _w in slots)
    assert any(v == "B" and dt.date() == SAT for dt, v, _w in slots)  # B keeps it


def test_off_day_on_base_venue_blocks_every_sub_venue():
    cfg = _cfg(venues=["Hall"], venue_counts={"Hall": 2},
               venue_unavailable_dates={"Hall": {SAT}})
    slots = build_slots(cfg)
    assert slots and all(dt.date() == SUN for dt, _v, _w in slots)


def test_validate_schedule_flags_venue_unavailable():
    cfg = _cfg(venue_unavailable_dates={"A": {SAT}})
    reqs = [MatchSlotReq(id="m1", round_no=1, match_no=1, home="t1", away="t2")]
    violations = validate_schedule(
        {"m1": (datetime(2026, 8, 1, 9, 0), "A")}, reqs, cfg,
    )
    v = next(x for x in violations if x["code"] == "venue_unavailable")
    assert v["hard"] is True and v["match_id"] == "m1"
    assert v["venue"] == "A" and v["date"] == "2026-08-01"
    # same slot on B (no off-day) is clean
    assert validate_schedule(
        {"m1": (datetime(2026, 8, 1, 9, 0), "B")}, reqs, cfg,
    ) == []


def test_validate_schedule_resolves_sub_venue_to_base_off_day():
    cfg = _cfg(venues=["Hall"], venue_counts={"Hall": 2},
               venue_unavailable_dates={"Hall": {SAT}})
    reqs = [MatchSlotReq(id="m1", round_no=1, match_no=1, home="t1", away="t2")]
    violations = validate_schedule(
        {"m1": (datetime(2026, 8, 1, 9, 0), "Hall · T2")}, reqs, cfg,
    )
    assert any(x["code"] == "venue_unavailable" for x in violations)


# ----------------------------------------------------------------- API round-trip
@pytest.mark.django_db
def test_venues_api_round_trips_unavailable_dates():
    admin = _verified("v@test.local")
    t = create_tournament(user=admin, name="Cup")
    c = _client(admin)
    r = c.post(
        f"/api/tournaments/{t.id}/venues/",
        {"name": "Local Ground",
         "unavailable_dates": ["2026-08-02", "2026-08-01", "junk", "2026-08-02"]},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["unavailable_dates"] == ["2026-08-01", "2026-08-02"]
    vid = r.json()["id"]

    listed = c.get(f"/api/tournaments/{t.id}/venues/").json()["venues"]
    assert listed[0]["unavailable_dates"] == ["2026-08-01", "2026-08-02"]

    r2 = c.patch(
        f"/api/tournaments/{t.id}/venues/{vid}/",
        {"unavailable_dates": ["2026-08-03"]}, format="json",
    )
    assert r2.status_code == 200, r2.content
    assert r2.json()["unavailable_dates"] == ["2026-08-03"]
    v = Venue.objects.get(id=vid)
    assert v.unavailable_dates == ["2026-08-03"]
    # field default is an empty list
    plain = Venue.objects.create(organization=t.organization, name="Plain")
    assert plain.unavailable_dates == []


# --------------------------------------------------------- scheduling honors it
@pytest.mark.django_db
def test_stored_venue_pool_off_day_avoided_by_engine_run():
    admin = _verified("s@test.local")
    t = create_tournament(user=admin, name="Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(2)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=2)
    Venue.objects.create(
        organization=t.organization, name="G",
        unavailable_dates=["2026-08-01"],
    )
    c = _client(admin)
    r = c.post(
        f"/api/tournaments/{t.id}/schedule/",
        {"date_start": "2026-08-01", "date_end": "2026-08-02",
         "slot_minutes": 60, "rest_minutes": 0, "max_per_team_per_day": 4},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["scheduled"] == 1
    m = Match.objects.get(tournament=t)
    tz = ZoneInfo(t.time_zone)
    assert timezone.localtime(m.scheduled_at, tz).date() == SUN


# ----------------------------------------------------------- repair validation
def _scheduled_tournament(admin):
    t = create_tournament(user=admin, name="Repair Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(2)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=2)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-07",
        "venues": ["G"], "slot_minutes": 60,
        "rest_minutes": 0, "max_per_team_per_day": 4,
    }
    t.save(update_fields=["scheduling_config"])
    tz = ZoneInfo(t.time_zone)
    m = Match.objects.get(tournament=t)
    m.scheduled_at = datetime(2026, 8, 1, 9, 0, tzinfo=tz)
    m.venue = "G"
    m.save(update_fields=["scheduled_at", "venue"])
    return t, m


@pytest.mark.django_db
def test_repair_onto_off_day_is_hard_violation_even_when_added_after_run():
    admin = _verified("r@test.local")
    t, m = _scheduled_tournament(admin)
    # the off-day is added AFTER the run — the model field stays authoritative
    Venue.objects.create(
        organization=t.organization, name="G",
        unavailable_dates=["2026-08-03"],
    )
    tz = ZoneInfo(t.time_zone)
    with pytest.raises(RepairConflict) as exc:
        reschedule_match(
            match=m, by=admin,
            scheduled_at=datetime(2026, 8, 3, 9, 0, tzinfo=tz),
        )
    assert any(
        v["code"] == "venue_unavailable" for v in exc.value.violations
    )
    # a clean day passes
    assert reschedule_match(
        match=m, by=admin,
        scheduled_at=datetime(2026, 8, 4, 9, 0, tzinfo=tz),
    ) == []


@pytest.mark.django_db
def test_repair_api_409_with_venue_unavailable_unless_forced():
    admin = _verified("r2@test.local")
    t, m = _scheduled_tournament(admin)
    Venue.objects.create(
        organization=t.organization, name="G",
        unavailable_dates=["2026-08-03"],
    )
    c = _client(admin)
    url = f"/api/matches/{m.id}/schedule/"
    r = c.patch(url, {"scheduled_at": "2026-08-03T09:00:00"}, format="json")
    assert r.status_code == 409, r.content
    body = r.json()
    assert body["detail"] == "schedule_conflicts"
    assert any(v["code"] == "venue_unavailable" for v in body["violations"])
    m.refresh_from_db()
    assert timezone.localtime(m.scheduled_at, ZoneInfo(t.time_zone)).date() \
        == SAT  # unmoved

    forced = c.patch(
        url,
        {"scheduled_at": "2026-08-03T09:00:00", "force": True,
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert forced.status_code == 200, forced.content
    assert any(
        v["code"] == "venue_unavailable" for v in forced.json()["violations"]
    )
    m.refresh_from_db()
    assert timezone.localtime(m.scheduled_at, ZoneInfo(t.time_zone)).date() \
        == date(2026, 8, 3)
