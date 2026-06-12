"""Control-room repair seam, increment C — delay cascade
(`POST /api/matches/{id}/delay/`): schedule_editor-gated, shifts a match by
+minutes and (cascade=true) pushes later same-venue matches just enough to
restore venue non-overlap + rest gaps, in scheduled_at order. Fixed obstacles
(live/completed/locked) never move; everything moved is re-validated through
the increment-A machinery — hard violations 409 unless force. ONE
match_delay_cascade audit row carries the full {match_id, old, new} list.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
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


def _setup(max_per_day: int = 2, rest_minutes: int = 60):
    """6-team round-robin; three pairwise-disjoint matches (T1/T2, T3/T4,
    T5/T6) parked back-to-back on venue G on day 1; everything else far away
    on later days so only the day-1 chain is in play."""
    admin = _verified(f"delay-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Delay Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(6)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=6)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-31",
        "venues": ["G", "G2"], "slot_minutes": 90,
        "rest_minutes": rest_minutes, "max_per_team_per_day": max_per_day,
    }
    t.save(update_fields=["scheduling_config"])
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
    m3 = by_names("Team 5", "Team 6")
    chain = [m1, m2, m3]
    hours = [9, 11, 13]
    for m, h in zip(chain, hours, strict=True):
        m.scheduled_at = datetime(2026, 8, 1, h, 0, tzinfo=tz)
        m.venue = "G"
        m.save(update_fields=["scheduled_at", "venue"])
    rest_day = 10
    for m in matches:
        if m.id in {c.id for c in chain}:
            continue
        m.scheduled_at = datetime(2026, 8, rest_day, 9, 0, tzinfo=tz)
        m.venue = "G2"
        m.save(update_fields=["scheduled_at", "venue"])
        rest_day += 1
    return admin, t, tz, chain, by_names


def _local(m: Match, tz) -> tuple[int, int, int]:
    """(day, hour, minute) of the stored slot in tournament time."""
    loc = m.scheduled_at.astimezone(tz)
    return (loc.day, loc.hour, loc.minute)


# ---------------------------------------------------------------- happy path
def test_delay_without_conflicts_moves_only_the_target():
    admin, _t, tz, (m1, m2, _m3), _ = _setup()
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 30}, format="json"
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["violations"] == []
    assert [e["match_id"] for e in body["moved"]] == [str(m1.id)]
    m1.refresh_from_db()
    m2.refresh_from_db()
    assert _local(m1, tz) == (1, 9, 30)
    assert _local(m2, tz) == (1, 11, 0)  # untouched — 90' match ends 11:00... no overlap


def test_cascade_pushes_chain_just_enough_in_order():
    # 90' matches at 9:00 / 11:00 / 13:00. +150' → target 11:30-13:00;
    # m2 must clear 13:00; m3 must clear m2's new end 14:30.
    admin, _t, tz, (m1, m2, m3), _ = _setup()
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 150}, format="json"
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["violations"] == []
    moved = {e["match_id"]: e for e in body["moved"]}
    assert set(moved) == {str(m1.id), str(m2.id), str(m3.id)}
    for m in (m1, m2, m3):
        m.refresh_from_db()
    assert _local(m1, tz) == (1, 11, 30)
    assert _local(m2, tz) == (1, 13, 0)   # just enough: m1 ends 13:00
    assert _local(m3, tz) == (1, 14, 30)  # just enough: m2 ends 14:30
    # one audit row with the full old/new list
    ev = AuditEvent.objects.get(
        event_type="match_delay_cascade", target_id=m1.id
    )
    audited = {e["match_id"] for e in ev.payload_after["moved"]}
    assert audited == {str(m1.id), str(m2.id), str(m3.id)}
    hit = next(
        e for e in ev.payload_after["moved"] if e["match_id"] == str(m2.id)
    )
    assert hit["old"] != hit["new"]


def test_cascade_respects_rest_gap_for_shared_team():
    # m_b shares Team 1 with the target; venue non-overlap alone would put it
    # at the target's new end, but the 60' rest gap pushes it further.
    admin, _t, tz, (m1, m2, m3), by_names = _setup()
    m_b = by_names("Team 1", "Team 3")
    m_b.scheduled_at = datetime(2026, 8, 1, 13, 0, tzinfo=tz)
    m_b.venue = "G"
    m_b.save(update_fields=["scheduled_at", "venue"])
    # park the other chain matches away so only m1 -> m_b interacts
    for m, day in ((m2, 25), (m3, 26)):
        m.scheduled_at = datetime(2026, 8, day, 9, 0, tzinfo=tz)
        m.save(update_fields=["scheduled_at"])

    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 180}, format="json"
    )
    assert r.status_code == 200, r.content
    m1.refresh_from_db()
    m_b.refresh_from_db()
    assert _local(m1, tz) == (1, 12, 0)   # ends 13:30
    assert _local(m_b, tz) == (1, 14, 30)  # 13:30 + 60' rest, not 13:30


# ------------------------------------------------------------ fixed obstacles
def test_locked_obstacle_overlapped_by_target_is_a_hard_409():
    admin, _t, tz, (m1, m2, _m3), _ = _setup()
    m2.locked_at = timezone.now()
    m2.save(update_fields=["locked_at"])
    # +150' → target 11:30-13:00 overlaps locked m2 (11:00-12:30)
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 150}, format="json"
    )
    assert r.status_code == 409, r.content
    body = r.json()
    assert body["detail"] == "schedule_conflicts"
    assert any(v["code"] == "venue_double_booked" for v in body["violations"])
    m1.refresh_from_db()
    m2.refresh_from_db()
    assert _local(m1, tz) == (1, 9, 0)   # nothing applied
    assert _local(m2, tz) == (1, 11, 0)  # the locked slot never moved

    # force applies anyway; the locked obstacle still never moves
    r2 = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 150, "force": True},
        format="json",
    )
    assert r2.status_code == 200, r2.content
    assert any(
        v["code"] == "venue_double_booked" for v in r2.json()["violations"]
    )
    m1.refresh_from_db()
    m2.refresh_from_db()
    assert _local(m1, tz) == (1, 11, 30)
    assert _local(m2, tz) == (1, 11, 0)


def test_cascade_pushes_movable_matches_past_a_live_obstacle():
    # Live m2 at 12:00-13:30 is a fixed obstacle. +90' → target 10:30-12:00;
    # the movable 10:30 match must clear the target (12:00) AND skip past the
    # live block to 13:30 — never stack on top of it.
    admin, _t, tz, (m1, m2, m3), by_names = _setup()
    m2.status = MatchStatus.LIVE
    m2.scheduled_at = datetime(2026, 8, 1, 12, 0, tzinfo=tz)
    m2.save(update_fields=["status", "scheduled_at"])
    mover = by_names("Team 2", "Team 5")  # shares no team with the live block
    mover.scheduled_at = datetime(2026, 8, 1, 10, 30, tzinfo=tz)
    mover.venue = "G"
    mover.save(update_fields=["scheduled_at", "venue"])
    m3.scheduled_at = datetime(2026, 8, 27, 9, 0, tzinfo=tz)
    m3.save(update_fields=["scheduled_at"])

    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 90}, format="json"
    )
    assert r.status_code == 200, r.content
    m1.refresh_from_db()
    mover.refresh_from_db()
    m2.refresh_from_db()
    assert _local(m1, tz) == (1, 10, 30)   # ends 12:00
    assert _local(m2, tz) == (1, 12, 0)    # live: never moved
    assert _local(mover, tz) == (1, 13, 30)  # past the live block, not 12:00


def test_cascade_false_leaves_conflicts_in_place_and_409s():
    admin, _t, tz, (m1, m2, _m3), _ = _setup()
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/",
        {"minutes": 150, "cascade": False},
        format="json",
    )
    assert r.status_code == 409, r.content
    assert any(
        v["code"] == "venue_double_booked" for v in r.json()["violations"]
    )
    r2 = _client(admin).post(
        f"/api/matches/{m1.id}/delay/",
        {"minutes": 150, "cascade": False, "force": True},
        format="json",
    )
    assert r2.status_code == 200, r2.content
    assert [e["match_id"] for e in r2.json()["moved"]] == [str(m1.id)]
    m2.refresh_from_db()
    assert _local(m2, tz) == (1, 11, 0)  # never cascaded


def test_cross_venue_shared_team_conflict_is_validated_not_pushed():
    # The cascade is same-venue; a G2 match sharing Team 1 inside the rest
    # gap after the delay surfaces as a hard violation instead of moving.
    admin, _t, tz, (m1, m2, m3), by_names = _setup()
    other = by_names("Team 1", "Team 4")
    other.scheduled_at = datetime(2026, 8, 1, 12, 0, tzinfo=tz)
    other.venue = "G2"
    other.save(update_fields=["scheduled_at", "venue"])
    for m, day in ((m2, 25), (m3, 26)):
        m.scheduled_at = datetime(2026, 8, day, 9, 0, tzinfo=tz)
        m.save(update_fields=["scheduled_at"])

    # +90' → m1 ends 12:00 on G; `other` starts 12:00 on G2 with 0' rest
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 90}, format="json"
    )
    assert r.status_code == 409, r.content
    assert any(
        v["code"] == "insufficient_rest" for v in r.json()["violations"]
    )
    other.refresh_from_db()
    assert _local(other, tz) == (1, 12, 0)  # not auto-pushed across venues


# ----------------------------------------------------------------- guards
@pytest.mark.parametrize(
    "status",
    [
        MatchStatus.LIVE, MatchStatus.HALF_TIME, MatchStatus.COMPLETED,
        MatchStatus.WALKOVER, MatchStatus.CANCELLED, MatchStatus.ABANDONED,
    ],
)
def test_in_flight_and_finished_targets_are_not_delayable(status):
    admin, _t, _tz, (m1, _m2, _m3), _ = _setup()
    m1.status = status
    m1.save(update_fields=["status"])
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 30}, format="json"
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "match_not_movable"


def test_postponed_target_is_delayable():
    admin, _t, tz, (m1, _m2, _m3), _ = _setup()
    m1.status = MatchStatus.POSTPONED
    m1.save(update_fields=["status"])
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 30}, format="json"
    )
    assert r.status_code == 200, r.content
    m1.refresh_from_db()
    assert _local(m1, tz) == (1, 9, 30)


def test_locked_target_is_not_delayable():
    admin, _t, _tz, (m1, _m2, _m3), _ = _setup()
    m1.locked_at = timezone.now()
    m1.save(update_fields=["locked_at"])
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 30}, format="json"
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "match_locked"


def test_unscheduled_target_is_rejected():
    admin, _t, _tz, (m1, _m2, _m3), _ = _setup()
    m1.scheduled_at = None
    m1.save(update_fields=["scheduled_at"])
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 30}, format="json"
    )
    assert r.status_code == 400


@pytest.mark.parametrize("minutes", [0, 481, -5])
def test_minutes_out_of_range_rejected(minutes):
    admin, _t, _tz, (m1, _m2, _m3), _ = _setup()
    r = _client(admin).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": minutes}, format="json"
    )
    assert r.status_code == 400


# ------------------------------------------------------------- permissions
def test_outsider_404_and_non_schedule_editor_403():
    _admin, t, _tz, (m1, _m2, _m3), _ = _setup()
    outsider = _verified("delay-out@test.local")
    assert _client(outsider).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 30}, format="json"
    ).status_code == 404

    tm = _verified("delay-tm@test.local")
    TournamentMembership.objects.create(
        user=tm, tournament=t, role=TournamentMembershipRole.TEAM_MANAGER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _client(tm).post(
        f"/api/matches/{m1.id}/delay/", {"minutes": 30}, format="json"
    ).status_code == 403


# ------------------------------------------------------------- idempotency
def test_idempotent_on_event_id():
    admin, _t, tz, (m1, _m2, _m3), _ = _setup()
    eid = str(uuid.uuid4())
    payload = {"minutes": 30, "event_id": eid}
    c = _client(admin)
    r1 = c.post(f"/api/matches/{m1.id}/delay/", payload, format="json")
    assert r1.status_code == 200, r1.content
    r2 = c.post(f"/api/matches/{m1.id}/delay/", payload, format="json")
    assert r2.status_code == 200, r2.content
    assert r2.json()["moved"] == r1.json()["moved"]
    m1.refresh_from_db()
    assert _local(m1, tz) == (1, 9, 30)  # +30 once, not twice
    assert AuditEvent.objects.filter(
        event_type="match_delay_cascade", target_id=m1.id
    ).count() == 1
