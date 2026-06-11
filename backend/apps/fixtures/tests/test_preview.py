"""TDD — dry-run preview + accept guard + draw delete (redesign spec §5.2/
§5.3, D6/D7/D10, §9 A1): a pure simulate that persists NOTHING, sharing
``build_schedule_inputs`` with the commit path (preoccupied + linked included)
so preview ≡ commit; the accept endpoints take ``expected_inputs_hash`` and
409 on drift; a guarded DELETE unblocks the wrong-draw-accepted path."""
from __future__ import annotations

import uuid
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.fixtures.services.generate import compute_inputs_hash
from apps.fixtures.services.preview import preview_fixtures
from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF_U15 = "football.u15"
LEAF_U17 = "football.u17"

SCHEDULE = {
    "date_start": "2026-08-01", "date_end": "2026-08-07",
    "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
    "venues": ["G"], "rest_minutes": 0, "max_per_team_per_day": 4,
}


def _verified(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _tournament(admin):
    t = create_tournament(user=admin, name="Cup")
    t.sports = normalize_sports([
        {"name": "Football", "nodes": [{"name": "U15"}, {"name": "U17"}]},
    ])
    t.save(update_fields=["sports"])
    return t


def _register(t, n, leaf=LEAF_U15, school="S"):
    return register_school(
        tournament=t, school_name=school,
        teams=[{"name": f"{school} T{i}", "leaf_key": leaf, "sport": "football",
                "players": []} for i in range(n)],
    )


# ----------------------------------------------------------------- pureness
def test_preview_persists_nothing():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 4)
    audits_before = AuditEvent.objects.count()
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF_U15,
        draw={"format": "by_category", "seeding": "random"},
        schedule=SCHEDULE, include_schedule=True,
    )
    assert out["seed"] is not None            # re-rollable, returned not stored
    assert out["matches"] and all(m["scheduled_at"] for m in out["matches"])
    assert Match.objects.count() == 0          # zero rows touched
    t.refresh_from_db()
    assert (t.draw_config or {}) == {}         # seed NOT persisted
    assert t.scheduling_config == {}           # config NOT persisted
    assert AuditEvent.objects.count() == audits_before  # no audit, no event_id


def test_preview_shape_refs_and_sources():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 4)
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF_U15,
        draw={"format": "knockout", "third_place": True},
        include_schedule=False,
    )
    refs = [m["ref"] for m in out["matches"]]
    assert refs == [f"p{i + 1}" for i in range(len(refs))]
    final = out["matches"][-1]
    assert final["home"]["source"]["type"] == "winner_of"
    assert final["home"]["source"]["ref"].startswith("p")  # plan-ref pointers
    third = next(m for m in out["matches"] if m["group_label"] == "3rd Place")
    assert third["home"]["source"]["type"] == "loser_of"
    semis = [m for m in out["matches"] if m["round_no"] == 1]
    assert all("team_id" in m["home"] and "team_id" in m["away"] for m in semis)
    assert out["soft_score"] is None           # include_schedule=False
    assert out["inputs_hash"] == compute_inputs_hash(t, LEAF_U15)


# ------------------------------------------------------------ preview ≡ commit
def test_preview_equals_commit_with_same_seed():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 5)
    out = preview_fixtures(
        tournament=t, leaf_key=LEAF_U15,
        draw={"format": "by_category", "seeding": "random"},
        schedule=SCHEDULE, include_schedule=True,
    )
    c = _client(admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_U15, "seeding": "random",
         "seed": out["seed"], "expected_inputs_hash": out["inputs_hash"]},
        format="json",
    )
    assert r.status_code == 201, r.content
    r2 = c.post(
        f"/api/tournaments/{t.id}/schedule/",
        {**SCHEDULE, "leaf_key": LEAF_U15,
         "expected_inputs_hash": out["inputs_hash"]},
        format="json",
    )
    assert r2.status_code == 200, r2.content

    tz = ZoneInfo(t.time_zone)
    persisted = {
        (
            m.round_no, str(m.home_team_id), str(m.away_team_id),
            timezone.localtime(m.scheduled_at, tz).replace(tzinfo=None).isoformat(),
            m.venue,
        )
        for m in Match.objects.filter(tournament=t, leaf_key=LEAF_U15)
    }
    previewed = {
        (
            m["round_no"], m["home"]["team_id"], m["away"]["team_id"],
            m["scheduled_at"], m["venue"],
        )
        for m in out["matches"]
    }
    assert previewed == persisted              # determinism, tenet 3 / D6


def test_preview_respects_other_leaf_bookings():
    """§9 A1: preoccupied bookings from OTHER competitions enter the preview
    exactly as they would the commit."""
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 2, leaf=LEAF_U15)
    _register(t, 2, leaf=LEAF_U17, school="X")
    c = _client(admin)
    assert c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_U15}, format="json",
    ).status_code == 201
    assert c.post(
        f"/api/tournaments/{t.id}/schedule/",
        {**SCHEDULE, "leaf_key": LEAF_U15}, format="json",
    ).status_code == 200
    booked = Match.objects.get(tournament=t, leaf_key=LEAF_U15)
    tz = ZoneInfo(t.time_zone)
    booked_start = timezone.localtime(booked.scheduled_at, tz).replace(tzinfo=None)

    out = preview_fixtures(
        tournament=t, leaf_key=LEAF_U17, draw={"format": "by_category"},
        schedule=SCHEDULE, include_schedule=True,
    )
    [m] = out["matches"]
    assert m["scheduled_at"] != booked_start.isoformat()
    # football = 100' — the preview must clear the existing interval
    from datetime import datetime, timedelta
    start = datetime.fromisoformat(m["scheduled_at"])
    assert start >= booked_start + timedelta(minutes=100) \
        or start + timedelta(minutes=100) <= booked_start


# ------------------------------------------------------- expected_inputs_hash
def test_accept_endpoints_409_on_inputs_drift():
    admin = _verified("a@test.local")
    t = _tournament(admin)
    _register(t, 3)
    stale = compute_inputs_hash(t, LEAF_U15)
    _register(t, 1, school="Late")             # state drifts after the preview
    c = _client(admin)
    r = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_U15,
         "expected_inputs_hash": stale},
        format="json",
    )
    assert r.status_code == 409
    body = r.json()
    assert body["detail"] == "inputs_changed"
    assert "fixture-readiness" in body["readiness"]     # fresh readiness pointer
    assert body["inputs_hash"] == compute_inputs_hash(t, LEAF_U15)
    assert Match.objects.count() == 0

    r2 = c.post(
        f"/api/tournaments/{t.id}/schedule/",
        {**SCHEDULE, "leaf_key": LEAF_U15, "expected_inputs_hash": stale},
        format="json",
    )
    assert r2.status_code == 409

    # the fresh hash goes through (and no hash at all keeps working — optional)
    ok = c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_U15,
         "expected_inputs_hash": compute_inputs_hash(t, LEAF_U15)},
        format="json",
    )
    assert ok.status_code == 201, ok.content


# ------------------------------------------------------------------ API gates
def test_preview_endpoint_gates_and_validation():
    admin = _verified("a@test.local")
    outsider = _verified("b@test.local")
    t = _tournament(admin)
    _register(t, 2)
    url = f"/api/tournaments/{t.id}/fixtures/preview/"
    body = {"leaf_key": LEAF_U15, "include_schedule": False}
    assert _client(outsider).post(url, body, format="json").status_code == 404
    scorer = _verified("c@test.local")
    TournamentMembership.objects.create(
        user=scorer, tournament=t, role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _client(scorer).post(url, body, format="json").status_code == 403
    r = _client(admin).post(url, body, format="json")
    assert r.status_code == 200, r.content
    # include_schedule without a calendar anywhere → 400 explained
    r2 = _client(admin).post(
        url, {"leaf_key": LEAF_U15, "include_schedule": True}, format="json",
    )
    assert r2.status_code == 400


# -------------------------------------------------------------------- delete
def _drawn(admin, *, schedule=False):
    t = _tournament(admin)
    _register(t, 3)
    _register(t, 2, leaf=LEAF_U17, school="X")
    c = _client(admin)
    for leaf in (LEAF_U15, LEAF_U17):
        assert c.post(
            f"/api/tournaments/{t.id}/generate-fixtures/",
            {"format": "by_category", "leaf_key": leaf}, format="json",
        ).status_code == 201
    return t, c


def test_delete_soft_deletes_one_leaf_and_audits():
    admin = _verified("a@test.local")
    t, c = _drawn(admin)
    eid = str(uuid.uuid4())
    r = c.delete(
        f"/api/tournaments/{t.id}/fixtures/?leaf_key={LEAF_U15}&event_id={eid}"
    )
    assert r.status_code == 200, r.content
    assert r.json()["deleted"] == 3
    assert Match.objects.filter(
        tournament=t, leaf_key=LEAF_U15, deleted_at__isnull=True
    ).count() == 0
    assert Match.objects.filter(
        tournament=t, leaf_key=LEAF_U17, deleted_at__isnull=True
    ).count() == 1                              # other leaf untouched
    assert AuditEvent.objects.filter(
        event_type="draw_deleted", idempotency_key=eid
    ).count() == 1
    # replay returns the same outcome without deleting more (invariant 3)
    again = c.delete(
        f"/api/tournaments/{t.id}/fixtures/?leaf_key={LEAF_U15}&event_id={eid}"
    )
    assert again.status_code == 200
    assert again.json()["deleted"] == 3
    # regenerate now works (the escape hatch D7)
    assert c.post(
        f"/api/tournaments/{t.id}/generate-fixtures/",
        {"format": "by_category", "leaf_key": LEAF_U15}, format="json",
    ).status_code == 201


def test_delete_blocked_once_any_match_left_scheduled_status():
    admin = _verified("a@test.local")
    t, c = _drawn(admin)
    m = Match.objects.filter(tournament=t, leaf_key=LEAF_U15).first()
    m.status = MatchStatus.LIVE
    m.save(update_fields=["status"])
    r = c.delete(
        f"/api/tournaments/{t.id}/fixtures/?leaf_key={LEAF_U15}"
        f"&event_id={uuid.uuid4()}"
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "draw_locked"
    assert Match.objects.filter(
        tournament=t, leaf_key=LEAF_U15, deleted_at__isnull=True
    ).count() == 3


def test_delete_permissions():
    admin = _verified("a@test.local")
    outsider = _verified("b@test.local")
    t, _c = _drawn(admin)
    url = f"/api/tournaments/{t.id}/fixtures/?leaf_key={LEAF_U15}"
    assert _client(outsider).delete(url).status_code == 404
    scorer = _verified("c@test.local")
    TournamentMembership.objects.create(
        user=scorer, tournament=t, role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _client(scorer).delete(url).status_code == 403
