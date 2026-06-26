"""Control-room repair seam, increment A — manual reslot API
(`PATCH /api/matches/{id}/schedule/`): schedule_editor-gated, movable-status
guard, idempotent on event_id, audited (match_rescheduled), and validated
against the SAME constraint machinery the scheduler uses (other leaves'
bookings + shared-player links count); hard conflicts 409 unless force=true.
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
from apps.teams.models import Person, Player
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


def _setup():
    """Tournament with a 4-team round-robin (6 matches), one match per day at
    09:00 on venue G — a deterministic baseline to move matches around in."""
    admin = _verified(f"repair-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Repair Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-15",
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


def _disjoint(matches):
    """(a, b) with no team in common — moving b never trips a's team rules."""
    a = matches[0]
    a_teams = {a.home_team_id, a.away_team_id}
    b = next(
        m for m in matches[1:]
        if not ({m.home_team_id, m.away_team_id} & a_teams)
    )
    return a, b


def _sharing(matches):
    """(a, b) sharing at least one team."""
    a = matches[0]
    a_teams = {a.home_team_id, a.away_team_id}
    b = next(
        m for m in matches[1:]
        if {m.home_team_id, m.away_team_id} & a_teams
    )
    return a, b


# --------------------------------------------------------------------- happy path
def test_reschedule_moves_time_and_venue_in_tournament_tz_and_audits():
    admin, t, matches = _setup()
    m = matches[0]
    r = _client(admin).patch(
        f"/api/matches/{m.id}/schedule/",
        {"scheduled_at": "2026-08-10T15:00", "venue": "G2"},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["match"]["id"] == str(m.id)
    assert body["match"]["venue"] == "G2"
    assert body["violations"] == []
    m.refresh_from_db()
    # naive input is tournament-local wall clock (invariant 14)
    local = m.scheduled_at.astimezone(ZoneInfo(t.time_zone))
    assert (local.year, local.month, local.day, local.hour) == (2026, 8, 10, 15)
    assert m.venue == "G2"

    ev = AuditEvent.objects.get(event_type="match_rescheduled", target_id=m.id)
    assert ev.payload_before["venue"] == "G"
    assert ev.payload_before["scheduled_at"].startswith("2026-08-01")
    assert ev.payload_after["venue"] == "G2"
    assert ev.payload_after["scheduled_at"].startswith("2026-08-10")


def test_venue_only_change_keeps_time():
    admin, _t, matches = _setup()
    m = matches[0]
    before = m.scheduled_at
    r = _client(admin).patch(
        f"/api/matches/{m.id}/schedule/", {"venue": "G2"}, format="json"
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert m.scheduled_at == before
    assert m.venue == "G2"


def test_empty_body_is_rejected():
    admin, _t, matches = _setup()
    r = _client(admin).patch(
        f"/api/matches/{matches[0].id}/schedule/", {}, format="json"
    )
    assert r.status_code == 400


# --------------------------------------------------------------------- permissions
def test_outsider_404_and_non_schedule_editor_403():
    _admin, t, matches = _setup()
    m = matches[0]
    outsider = _verified("out@test.local")
    assert _client(outsider).patch(
        f"/api/matches/{m.id}/schedule/", {"venue": "G2"}, format="json"
    ).status_code == 404

    tm = _verified("tm@test.local")
    TournamentMembership.objects.create(
        user=tm, tournament=t, role=TournamentMembershipRole.TEAM_MANAGER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _client(tm).patch(
        f"/api/matches/{m.id}/schedule/", {"venue": "G2"}, format="json"
    ).status_code == 403


# --------------------------------------------------------------------- status guard
@pytest.mark.parametrize(
    "status",
    [
        MatchStatus.LIVE, MatchStatus.HALF_TIME, MatchStatus.COMPLETED,
        MatchStatus.WALKOVER, MatchStatus.CANCELLED, MatchStatus.ABANDONED,
    ],
)
def test_in_flight_and_finished_matches_are_not_movable(status):
    admin, _t, matches = _setup()
    m = matches[0]
    m.status = status
    m.save(update_fields=["status"])
    r = _client(admin).patch(
        f"/api/matches/{m.id}/schedule/", {"venue": "G2"}, format="json"
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "match_not_movable"
    m.refresh_from_db()
    assert m.venue == "G"


def test_postponed_matches_are_movable():
    admin, _t, matches = _setup()
    m = matches[0]
    m.status = MatchStatus.POSTPONED
    m.save(update_fields=["status"])
    r = _client(admin).patch(
        f"/api/matches/{m.id}/schedule/",
        {"scheduled_at": "2026-08-12T10:00"},
        format="json",
    )
    assert r.status_code == 200, r.content


# --------------------------------------------------------------------- idempotency
def test_idempotent_on_event_id():
    admin, _t, matches = _setup()
    m = matches[0]
    eid = str(uuid.uuid4())
    payload = {"scheduled_at": "2026-08-11T10:00", "venue": "G2", "event_id": eid}
    c = _client(admin)
    r1 = c.patch(f"/api/matches/{m.id}/schedule/", payload, format="json")
    assert r1.status_code == 200, r1.content
    r2 = c.patch(f"/api/matches/{m.id}/schedule/", payload, format="json")
    assert r2.status_code == 200
    assert r2.json()["match"]["venue"] == "G2"
    assert AuditEvent.objects.filter(
        event_type="match_rescheduled", target_id=m.id
    ).count() == 1


# --------------------------------------------------------------------- conflicts
def test_venue_conflict_rejected_with_structured_violations():
    admin, _t, matches = _setup()
    a, b = _disjoint(matches)
    r = _client(admin).patch(
        f"/api/matches/{b.id}/schedule/",
        {"scheduled_at": "2026-08-01T09:00", "venue": "G"},  # a's exact slot
        format="json",
    )
    assert r.status_code == 409, r.content
    body = r.json()
    assert body["detail"] == "schedule_conflicts"
    codes = {v["code"] for v in body["violations"]}
    assert "venue_double_booked" in codes
    hit = next(v for v in body["violations"] if v["code"] == "venue_double_booked")
    assert {hit["match_id"], hit.get("other_match_id")} == {str(a.id), str(b.id)}
    assert hit["hard"] is True
    b.refresh_from_db()
    assert b.scheduled_at.astimezone(ZoneInfo(_t.time_zone)).day != 1  # not applied


def test_force_applies_anyway_and_reports_violations_as_warnings():
    admin, t, matches = _setup()
    _a, b = _disjoint(matches)
    r = _client(admin).patch(
        f"/api/matches/{b.id}/schedule/",
        {"scheduled_at": "2026-08-01T09:00", "venue": "G", "force": True},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert any(v["code"] == "venue_double_booked" for v in body["violations"])
    b.refresh_from_db()
    local = b.scheduled_at.astimezone(ZoneInfo(t.time_zone))
    assert (local.day, local.hour) == (1, 9)
    ev = AuditEvent.objects.get(event_type="match_rescheduled", target_id=b.id)
    assert ev.payload_after["forced"] is True


def test_live_matches_block_their_slot_via_preoccupied_bookings():
    admin, _t, matches = _setup()
    a, b = _disjoint(matches)
    a.status = MatchStatus.LIVE  # no longer a reschedulable req — a booking
    a.save(update_fields=["status"])
    r = _client(admin).patch(
        f"/api/matches/{b.id}/schedule/",
        {"scheduled_at": "2026-08-01T09:00", "venue": "G"},
        format="json",
    )
    assert r.status_code == 409, r.content
    assert any(
        v["code"] == "venue_double_booked" for v in r.json()["violations"]
    )


def test_max_per_team_per_day_violation_on_same_day_move():
    admin, _t, matches = _setup()
    a, b = _sharing(matches)
    shared = ({a.home_team_id, a.away_team_id}
              & {b.home_team_id, b.away_team_id}).pop()
    # same day as `a` but late enough on the other venue to avoid overlap/rest
    r = _client(admin).patch(
        f"/api/matches/{b.id}/schedule/",
        {"scheduled_at": "2026-08-01T14:00", "venue": "G2"},
        format="json",
    )
    assert r.status_code == 409, r.content
    codes = {v["code"] for v in r.json()["violations"]}
    assert "exceeds_max_per_day" in codes
    hit = next(
        v for v in r.json()["violations"] if v["code"] == "exceeds_max_per_day"
    )
    assert hit["team_id"] == str(shared)


def test_shared_player_conflict_across_linked_teams():
    admin, t, matches = _setup()
    a, b = _disjoint(matches)
    # one student rostered on a team in `a` AND a team in `b` (W2-D link)
    person = Person.objects.create(full_name="Shared Kid")
    Player.objects.create(
        organization=t.organization, tournament=t,
        team_id=a.home_team_id, person=person,
    )
    Player.objects.create(
        organization=t.organization, tournament=t,
        team_id=b.home_team_id, person=person,
    )
    # other venue, same kickoff as `a` — only the person-link conflicts
    r = _client(admin).patch(
        f"/api/matches/{b.id}/schedule/",
        {"scheduled_at": "2026-08-01T09:00", "venue": "G2"},
        format="json",
    )
    assert r.status_code == 409, r.content
    assert any(
        v["code"] == "shared_player_conflict" for v in r.json()["violations"]
    )


def _setup_courts():
    """A 2-court hall ('Hall', count=2). Two team-disjoint matches sit on its
    two courts at 09:00; a third disjoint match is free to move onto the hall —
    which would put 3 concurrent matches on a 2-court venue (capacity overflow),
    with NO team-rule interference so the court rule is tested in isolation."""
    admin = _verified(f"courts-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Courts Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(6)],
    )
    from apps.fixtures.services.generate import generate_round_robin
    from apps.fixtures.services.scheduler import court_venue_name

    generate_round_robin(tournament=t, group_size=6)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-15",
        "venues": [{"name": "Hall", "count": 2}], "slot_minutes": 90,
        "rest_minutes": 0, "max_per_team_per_day": 99,
    }
    t.save(update_fields=["scheduling_config"])
    tz = ZoneInfo(t.time_zone)

    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    disjoint, used = [], set()
    for m in matches:
        pair = {m.home_team_id, m.away_team_id}
        if pair & used:
            continue
        disjoint.append(m)
        used |= pair
        if len(disjoint) == 3:
            break
    at = datetime(2026, 8, 1, 9, 0, tzinfo=tz)
    disjoint[0].scheduled_at, disjoint[0].venue = at, court_venue_name("Hall", 1)
    disjoint[1].scheduled_at, disjoint[1].venue = at, court_venue_name("Hall", 2)
    disjoint[0].save(update_fields=["scheduled_at", "venue"])
    disjoint[1].save(update_fields=["scheduled_at", "venue"])
    return admin, t, disjoint


def test_court_capacity_overflow_409_and_force():
    admin, _t, disjoint = _setup_courts()
    from apps.fixtures.services.scheduler import court_venue_name

    mover = disjoint[2]
    # Move the third disjoint match onto a third court of the 2-court hall at the
    # same 09:00 slot — exceeds the hall's parallel-court capacity.
    payload = {"scheduled_at": "2026-08-01T09:00", "venue": court_venue_name("Hall", 3)}
    r = _client(admin).patch(
        f"/api/matches/{mover.id}/schedule/", payload, format="json"
    )
    assert r.status_code == 409, r.content
    body = r.json()
    assert body["detail"] == "schedule_conflicts"
    codes = {v["code"] for v in body["violations"]}
    assert "court_capacity_exceeded" in codes, body["violations"]
    cap = next(v for v in body["violations"] if v["code"] == "court_capacity_exceeded")
    assert cap["venue"] == "Hall" and cap["capacity"] == 2 and cap["hard"] is True
    mover.refresh_from_db()
    assert mover.scheduled_at is None  # not applied

    # force overrides and records the capacity conflict as a warning.
    r2 = _client(admin).patch(
        f"/api/matches/{mover.id}/schedule/",
        {**payload, "force": True},
        format="json",
    )
    assert r2.status_code == 200, r2.content
    assert any(
        v["code"] == "court_capacity_exceeded" for v in r2.json()["violations"]
    )
    mover.refresh_from_db()
    assert mover.scheduled_at is not None


def test_court_capacity_pre_existing_overflow_on_other_day_does_not_block():
    # Scoping contract: a pre-existing (force-persisted) overflow on the hall on
    # one day must NOT block an unrelated, legal move onto the hall on a DIFFERENT
    # day. The capacity scope clause carries a day guard for exactly this.
    admin, t, disjoint = _setup_courts()
    from apps.fixtures.services.scheduler import court_venue_name

    # Force a persisted 3-on-2-courts overflow on 2026-08-01.
    r = _client(admin).patch(
        f"/api/matches/{disjoint[2].id}/schedule/",
        {
            "scheduled_at": "2026-08-01T09:00",
            "venue": court_venue_name("Hall", 3),
            "force": True,
        },
        format="json",
    )
    assert r.status_code == 200, r.content

    other = (
        Match.objects.filter(tournament=t)
        .exclude(id__in=[d.id for d in disjoint])
        .order_by("match_no")
        .first()
    )
    r2 = _client(admin).patch(
        f"/api/matches/{other.id}/schedule/",
        {"scheduled_at": "2026-08-02T09:00", "venue": court_venue_name("Hall", 1)},
        format="json",
    )
    assert r2.status_code == 200, r2.content
    assert not any(
        v["code"] == "court_capacity_exceeded" for v in r2.json()["violations"]
    )


def test_court_assignment_within_capacity_is_clean():
    admin, _t, disjoint = _setup_courts()
    from apps.fixtures.services.scheduler import court_venue_name

    # A different time on a court is fine; assigning a specific court is just a
    # venue change and must not trip the capacity rule.
    r = _client(admin).patch(
        f"/api/matches/{disjoint[2].id}/schedule/",
        {"scheduled_at": "2026-08-02T09:00", "venue": court_venue_name("Hall", 1)},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["violations"] == []
    disjoint[2].refresh_from_db()
    assert disjoint[2].venue == court_venue_name("Hall", 1)


def test_clean_move_far_from_everything_has_no_violations():
    admin, _t, matches = _setup()
    r = _client(admin).patch(
        f"/api/matches/{matches[0].id}/schedule/",
        {"scheduled_at": "2026-08-14T09:00", "venue": "G2"},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["violations"] == []
