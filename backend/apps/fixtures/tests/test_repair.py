"""Control-room repair seam, increment B — swap-slots + regenerate-the-rest.

Swap (`POST /api/tournaments/{id}/fixtures/swap-slots/`) exchanges
scheduled_at+venue between two movable matches with increment-A conflict
semantics (409 + structured violations unless force). Locked matches
(`Match.locked_at`) are excluded from scheduler reassignment but stay on the
calendar as fixed busy bookings — they survive any re-run."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.fixtures.services.scheduler import (
    apply_schedule,
    build_schedule_inputs,
    config_from_dict,
)
from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


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


def _setup(n_teams: int = 4):
    admin = _verified(f"swap-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Swap Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(n_teams)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=n_teams)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-31",
        "venues": ["G", "G2"], "slot_minutes": 90,
        "rest_minutes": 60, "max_per_team_per_day": 1,
    }
    t.save(update_fields=["scheduling_config"])
    tz = ZoneInfo(t.time_zone)
    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    for i, m in enumerate(matches):
        m.scheduled_at = datetime(2026, 8, 1 + i, 9, 0, tzinfo=tz)
        m.venue = "G"
        m.save(update_fields=["scheduled_at", "venue"])
    return admin, t, matches


def _by_names(t, matches, name_a: str, name_b: str) -> Match:
    return next(
        m for m in matches
        if {m.home_team.name, m.away_team.name} == {name_a, name_b}
    )


# ------------------------------------------------------------------- swap-slots
def test_swap_exchanges_slots_and_audits():
    admin, t, matches = _setup()
    a, b = matches[0], matches[1]
    slot_a = (a.scheduled_at, a.venue)
    slot_b = (b.scheduled_at, b.venue)
    b.venue = "G2"
    b.save(update_fields=["venue"])
    slot_b = (slot_b[0], "G2")

    r = _client(admin).post(
        f"/api/tournaments/{t.id}/fixtures/swap-slots/",
        {"match_a": str(a.id), "match_b": str(b.id)},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["violations"] == []
    a.refresh_from_db()
    b.refresh_from_db()
    assert (a.scheduled_at, a.venue) == slot_b
    assert (b.scheduled_at, b.venue) == slot_a
    ev = AuditEvent.objects.get(
        event_type="match_slots_swapped", target_id=t.id
    )
    assert set(ev.payload_after["matches"]) == {str(a.id), str(b.id)}


def test_swap_replay_on_event_id_does_not_swap_back():
    admin, t, matches = _setup()
    a, b = matches[0], matches[1]
    eid = str(uuid.uuid4())
    payload = {"match_a": str(a.id), "match_b": str(b.id), "event_id": eid}
    c = _client(admin)
    r1 = c.post(
        f"/api/tournaments/{t.id}/fixtures/swap-slots/", payload, format="json"
    )
    assert r1.status_code == 200, r1.content
    a.refresh_from_db()
    after_first = a.scheduled_at
    r2 = c.post(
        f"/api/tournaments/{t.id}/fixtures/swap-slots/", payload, format="json"
    )
    assert r2.status_code == 200, r2.content
    a.refresh_from_db()
    assert a.scheduled_at == after_first  # replay, not a second swap
    assert AuditEvent.objects.filter(
        event_type="match_slots_swapped", target_id=t.id
    ).count() == 1


def test_swap_requires_both_movable_and_same_tournament():
    admin, t, matches = _setup()
    a, b = matches[0], matches[1]
    a.status = MatchStatus.LIVE
    a.save(update_fields=["status"])
    c = _client(admin)
    r = c.post(
        f"/api/tournaments/{t.id}/fixtures/swap-slots/",
        {"match_a": str(a.id), "match_b": str(b.id)},
        format="json",
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "match_not_movable"

    other_admin = _verified("swap-other@test.local")
    t2 = create_tournament(user=other_admin, name="Other Cup")
    register_school(tournament=t2, school_name="X", teams=[
        {"name": "X1", "players": []}, {"name": "X2", "players": []},
    ])
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t2, group_size=2)
    foreign = Match.objects.filter(tournament=t2).first()
    r2 = c.post(
        f"/api/tournaments/{t.id}/fixtures/swap-slots/",
        {"match_a": str(b.id), "match_b": str(foreign.id)},
        format="json",
    )
    assert r2.status_code == 400
    assert r2.json()["detail"][0] == "match_not_found" \
        or r2.json()["detail"] == "match_not_found"


def test_swap_permissions():
    _admin, t, matches = _setup()
    outsider = _verified("swap-out@test.local")
    r = _client(outsider).post(
        f"/api/tournaments/{t.id}/fixtures/swap-slots/",
        {"match_a": str(matches[0].id), "match_b": str(matches[1].id)},
        format="json",
    )
    assert r.status_code == 404


def test_swap_conflict_rejected_unless_forced():
    # 6 teams so a third match can share a team with `a` but not with `b`:
    # a=T1/T2, b=T3/T4, c=T1/T5. Swapping a<->b drops `a` onto c's day —
    # T1 then plays twice that day (cap 1) within the rest gap.
    admin, t, matches = _setup(n_teams=6)
    tz = ZoneInfo(t.time_zone)
    a = _by_names(t, matches, "Team 1", "Team 2")
    b = _by_names(t, matches, "Team 3", "Team 4")
    c = _by_names(t, matches, "Team 1", "Team 5")
    a.scheduled_at = datetime(2026, 8, 1, 9, 0, tzinfo=tz)
    a.venue = "G"
    a.save(update_fields=["scheduled_at", "venue"])
    b.scheduled_at = datetime(2026, 8, 2, 9, 0, tzinfo=tz)
    b.venue = "G"
    b.save(update_fields=["scheduled_at", "venue"])
    c.scheduled_at = datetime(2026, 8, 2, 10, 0, tzinfo=tz)
    c.venue = "G2"
    c.save(update_fields=["scheduled_at", "venue"])

    client = _client(admin)
    r = client.post(
        f"/api/tournaments/{t.id}/fixtures/swap-slots/",
        {"match_a": str(a.id), "match_b": str(b.id)},
        format="json",
    )
    assert r.status_code == 409, r.content
    codes = {v["code"] for v in r.json()["violations"]}
    assert "exceeds_max_per_day" in codes
    a.refresh_from_db()
    assert a.scheduled_at.astimezone(tz).day == 1  # not applied

    r2 = client.post(
        f"/api/tournaments/{t.id}/fixtures/swap-slots/",
        {"match_a": str(a.id), "match_b": str(b.id), "force": True},
        format="json",
    )
    assert r2.status_code == 200, r2.content
    assert any(
        v["code"] == "exceeds_max_per_day" for v in r2.json()["violations"]
    )
    a.refresh_from_db()
    b.refresh_from_db()
    assert a.scheduled_at.astimezone(tz).day == 2
    assert b.scheduled_at.astimezone(tz).day == 1


# ------------------------------------------------------- regenerate-the-rest
def test_build_schedule_inputs_excludes_locked_but_books_their_slot():
    _admin, t, matches = _setup()
    locked = matches[0]
    locked.locked_at = timezone.now()
    locked.save(update_fields=["locked_at"])
    cfg = config_from_dict(t.scheduling_config)
    reqs, preoccupied, _linked = build_schedule_inputs(t, cfg)
    req_ids = {r.id for r in reqs}
    assert str(locked.id) not in req_ids  # never reassigned
    assert {str(m.id) for m in matches[1:]} == req_ids
    tz = ZoneInfo(t.time_zone)
    local = locked.scheduled_at.astimezone(tz).replace(tzinfo=None)
    booked = [p for p in preoccupied if p[1] == local and p[0] == "G"]
    assert booked, "locked slot must stay on the calendar as a fixed booking"
    assert set(booked[0][3]) == {
        str(locked.home_team_id), str(locked.away_team_id)
    }


def test_locked_match_survives_rerun_and_blocks_slot_and_teams():
    admin, t, matches = _setup()
    tz = ZoneInfo(t.time_zone)
    locked = matches[0]
    locked.locked_at = timezone.now()
    locked.save(update_fields=["locked_at"])
    pinned_at = locked.scheduled_at  # 2026-08-01 09:00 G
    locked_teams = {str(locked.home_team_id), str(locked.away_team_id)}

    # Re-run the engine over ONE day with everything in play: the locked
    # match must keep its slot, and nothing may overlap it (venue or teams).
    res = apply_schedule(
        tournament=t,
        config={
            "date_start": "2026-08-01", "date_end": "2026-08-01",
            "venues": ["G", "G2"], "slot_minutes": 90,
            "rest_minutes": 0, "max_per_team_per_day": 9,
        },
        by=admin,
    )
    assert str(locked.id) not in res.assignments
    locked.refresh_from_db()
    assert locked.scheduled_at == pinned_at
    assert locked.venue == "G"

    locked_start = pinned_at.astimezone(tz).replace(tzinfo=None)
    locked_end = locked_start + timedelta(minutes=90)
    for mid, (dt, venue) in res.assignments.items():
        end = dt + timedelta(minutes=90)
        overlaps = dt < locked_end and locked_start < end
        if venue == "G":
            assert not overlaps, f"{mid} double-books the locked venue slot"
        m = Match.objects.get(id=mid)
        if {str(m.home_team_id), str(m.away_team_id)} & locked_teams:
            assert not overlaps, f"{mid} double-books a locked match's team"
