"""Trust layer, increment F — unified schedule-change feed.

`GET /api/tournaments/{id}/schedule-changes/` flattens the EXISTING repair/
scheduler AuditEvent rows (no new model) into a reverse-chrono list of
per-match entries `{match_id, match_label, leaf_key, changed_at, actor,
kind, old, new, reason}`. Visible to any accessible tournament member;
tenant-isolated (404, no existence leak)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.repair import (
    delay_match,
    reschedule_match,
    shift_day,
    swap_slots,
)
from apps.fixtures.services.scheduler import apply_schedule
from apps.matches.models import Match
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


def _setup(n_teams: int = 4):
    admin = _verified(f"feed-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Feed Cup")
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


def _feed(user, t, query: str = "") -> list[dict]:
    r = _client(user).get(f"/api/tournaments/{t.id}/schedule-changes/{query}")
    assert r.status_code == 200, r.content
    return r.json()["results"]


# ------------------------------------------------------------------ rescheduled
def test_reschedule_appears_in_feed_with_old_new_and_label():
    admin, t, matches = _setup()
    m = matches[0]
    tz = ZoneInfo(t.time_zone)
    old_iso = m.scheduled_at.isoformat()
    new_dt = datetime(2026, 8, 25, 15, 0, tzinfo=tz)

    reschedule_match(match=m, by=admin, scheduled_at=new_dt, venue="G2")

    entries = _feed(admin, t)
    assert len(entries) == 1
    e = entries[0]
    assert e["kind"] == "rescheduled"
    assert e["match_id"] == str(m.id)
    assert e["old"] == {"scheduled_at": old_iso, "venue": "G"}
    assert e["new"]["venue"] == "G2"
    assert e["new"]["scheduled_at"] == new_dt.isoformat()
    assert "Team" in e["match_label"] and " vs " in e["match_label"]
    assert e["actor"]["email"] == admin.email
    assert e["changed_at"]
    assert e["reason"] == ""


def test_delay_cascade_expands_to_per_match_entries():
    admin, t, matches = _setup()
    m = matches[0]
    old = m.scheduled_at

    moved, _ = delay_match(match=m, by=admin, minutes=30)

    entries = [e for e in _feed(admin, t) if e["kind"] == "delayed"]
    assert len(entries) == len(moved) >= 1
    mine = next(e for e in entries if e["match_id"] == str(m.id))
    assert mine["old"]["scheduled_at"] == old.isoformat()
    assert mine["new"]["scheduled_at"] == (old + timedelta(minutes=30)).isoformat()


def test_swap_produces_two_crossed_entries():
    admin, t, matches = _setup()
    a, b = matches[0], matches[1]
    slot_a, slot_b = a.scheduled_at, b.scheduled_at

    swap_slots(tournament=t, match_a=a.id, match_b=b.id, by=admin)

    entries = [e for e in _feed(admin, t) if e["kind"] == "swapped"]
    assert {e["match_id"] for e in entries} == {str(a.id), str(b.id)}
    ea = next(e for e in entries if e["match_id"] == str(a.id))
    # Compare instants — the payload may serialize in UTC or tournament TZ.
    assert datetime.fromisoformat(ea["old"]["scheduled_at"]) == slot_a
    assert datetime.fromisoformat(ea["new"]["scheduled_at"]) == slot_b


def test_shift_day_entries_are_day_shifted():
    admin, t, _matches = _setup()
    from datetime import date

    moved, _, _ = shift_day(
        tournament=t, by=admin, from_date=date(2026, 8, 1),
        to_date=date(2026, 8, 20),
    )

    entries = [e for e in _feed(admin, t) if e["kind"] == "day_shifted"]
    assert len(entries) == len(moved) == 1
    e = entries[0]
    assert e["old"]["scheduled_at"].startswith("2026-08-01")
    assert e["new"]["scheduled_at"].startswith("2026-08-20")
    assert e["old"]["venue"] == e["new"]["venue"] == "G"


def test_engine_rerun_entries_carry_per_match_old_new():
    admin, t, _matches = _setup()
    apply_schedule(tournament=t, config=dict(t.scheduling_config), by=admin)

    entries = [e for e in _feed(admin, t) if e["kind"] == "engine_rerun"]
    changed = [e for e in entries if e["old"]["scheduled_at"]]
    assert changed, "a re-run over manually slotted matches must report moves"
    for e in changed:
        assert e["old"] != e["new"]
        assert e["new"]["scheduled_at"]


def test_lock_and_unlock_appear_in_feed():
    admin, t, matches = _setup()
    m = matches[0]
    c = _client(admin)
    assert c.post(f"/api/matches/{m.id}/lock/").status_code == 200
    assert c.delete(f"/api/matches/{m.id}/lock/").status_code == 200

    kinds = [e["kind"] for e in _feed(admin, t)]
    assert kinds[:2] == ["unlocked", "locked"]  # reverse-chrono


def test_since_filters_and_order_is_reverse_chrono():
    admin, t, matches = _setup()
    tz = ZoneInfo(t.time_zone)
    reschedule_match(
        match=matches[0], by=admin,
        scheduled_at=datetime(2026, 8, 25, 15, 0, tzinfo=tz),
    )
    cut = timezone.now()
    reschedule_match(
        match=matches[1], by=admin,
        scheduled_at=datetime(2026, 8, 26, 15, 0, tzinfo=tz),
    )

    entries = _feed(admin, t)
    assert [e["match_id"] for e in entries] == [
        str(matches[1].id), str(matches[0].id)
    ]
    from urllib.parse import quote

    later = _feed(admin, t, f"?since={quote(cut.isoformat())}")
    assert [e["match_id"] for e in later] == [str(matches[1].id)]


def test_leaf_key_filter():
    admin, t, matches = _setup()
    tz = ZoneInfo(t.time_zone)
    a, b = matches[0], matches[1]
    Match.objects.filter(id=a.id).update(leaf_key="football.u15")
    reschedule_match(
        match=Match.objects.get(id=a.id), by=admin,
        scheduled_at=datetime(2026, 8, 25, 15, 0, tzinfo=tz),
    )
    reschedule_match(
        match=b, by=admin,
        scheduled_at=datetime(2026, 8, 26, 15, 0, tzinfo=tz),
    )

    entries = _feed(admin, t, "?leaf_key=football.u15")
    assert [e["match_id"] for e in entries] == [str(a.id)]
    assert entries[0]["leaf_key"] == "football.u15"


def test_invalid_since_is_400():
    admin, t, _ = _setup()
    r = _client(admin).get(
        f"/api/tournaments/{t.id}/schedule-changes/?since=not-a-date"
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_since"


# ------------------------------------------------------------------ access
def test_any_active_member_can_view_feed():
    admin, t, matches = _setup()
    tz = ZoneInfo(t.time_zone)
    reschedule_match(
        match=matches[0], by=admin,
        scheduled_at=datetime(2026, 8, 25, 15, 0, tzinfo=tz),
    )
    scorer = _verified(f"scorer-{uuid.uuid4().hex[:8]}@test.local")
    TournamentMembership.objects.create(
        user=scorer, tournament=t,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert len(_feed(scorer, t)) == 1


def test_outsider_gets_404_not_403():
    _admin, t, _ = _setup()
    stranger = _verified(f"stranger-{uuid.uuid4().hex[:8]}@test.local")
    r = _client(stranger).get(f"/api/tournaments/{t.id}/schedule-changes/")
    assert r.status_code == 404


def test_anonymous_is_rejected():
    _, t, _ = _setup()
    r = APIClient().get(f"/api/tournaments/{t.id}/schedule-changes/")
    assert r.status_code in (401, 403)
