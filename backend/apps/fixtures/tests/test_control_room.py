"""Control room, increment 2 — day-view aggregate
(`GET /api/tournaments/{id}/control-room/?day=`): member-gated (404 idiom),
one query over the schedule, grouped by tournament-TZ day then venue, plus a
cross-venue "next up" queue (spec 2026-06-12 §2.a)."""
from __future__ import annotations

import datetime as _dt
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

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


#: The fixture's two match days, anchored to the RUN — not to a literal date.
#: They were hardcoded to 2026-08-01/02, which meant the suite quietly stopped
#: testing what it claimed the moment the calendar passed them: "all matches
#: are in the future" became "all matches are in the past", and the
#: default-day test started asserting the wrong branch. Relative dates keep the
#: scenario true forever.
DAY_1 = _dt.date.today() + _dt.timedelta(days=1)
DAY_2 = DAY_1 + _dt.timedelta(days=1)
DAY_1_S = DAY_1.isoformat()
DAY_2_S = DAY_2.isoformat()


def _setup():
    """6 round-robin matches over 2 days × 2 venues (3 per day), starting
    TOMORROW so the whole fixture is always in the future."""
    admin = _verified(f"cr-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Control Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    tz = ZoneInfo(t.time_zone)
    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    assert len(matches) == 6
    for i, m in enumerate(matches):
        day = DAY_1 if i < 3 else DAY_2  # 3 matches per day
        m.scheduled_at = datetime(
            day.year, day.month, day.day, 9 + (i % 3) * 2, 0, tzinfo=tz
        )
        m.venue = "Kohima Ground" if i % 2 == 0 else "MP Hall"
        m.save(update_fields=["scheduled_at", "venue"])
    return admin, t, matches


def _get(user, t, day: str | None = None):
    url = f"/api/tournaments/{t.id}/control-room/"
    if day:
        url += f"?day={day}"
    return _client(user).get(url)


def test_aggregate_shape_days_venues_queue():
    admin, t, matches = _setup()
    r = _get(admin, t, day=DAY_1_S)
    assert r.status_code == 200, r.content
    body = r.json()

    assert body["tournament"]["id"] == str(t.id)
    assert body["tournament"]["slug"] == t.slug
    assert body["tournament"]["time_zone"] == t.time_zone

    assert [d["date"] for d in body["days"]] == [DAY_1_S, DAY_2_S]
    assert body["days"][0]["counts"] == {"total": 3, "completed": 0, "live": 0}
    assert body["day"] == DAY_1_S

    # Venue lanes: alphabetical, only the selected day's matches.
    assert [v["venue"] for v in body["venues"]] == ["Kohima Ground", "MP Hall"]
    day_match_ids = {
        str(m.id) for m in matches if m.scheduled_at.astimezone(ZoneInfo(t.time_zone)).date() == DAY_1
    }
    seen = {m["id"] for v in body["venues"] for m in v["matches"]}
    assert seen == day_match_ids

    # Rows = MatchSerializer + control-room extras.
    row = body["venues"][0]["matches"][0]
    for key in ("status", "home_team", "away_team", "home_score", "away_score",
                "home_pens", "away_pens", "set_scores", "scoring", "locked_at",
                "called_at", "current_period", "venue", "leaf_key",
                "leaf_label", "scorer"):
        assert key in row
    assert row["scorer"] is None

    # Queue: cross-venue, scheduled_at asc for the selected day.
    queue_ids = [m["id"] for m in body["queue"]]
    expected = [
        str(m.id)
        for m in sorted(
            (m for m in matches if m.scheduled_at.astimezone(ZoneInfo(t.time_zone)).date() == DAY_1),
            key=lambda m: m.scheduled_at,
        )
    ]
    assert queue_ids == expected


def test_day_counts_track_status_and_queue_drops_finished():
    admin, t, matches = _setup()
    first, second, _third = (m for m in matches if m.scheduled_at.astimezone(ZoneInfo(t.time_zone)).date() == DAY_1)
    first.status = MatchStatus.COMPLETED
    first.save(update_fields=["status"])
    second.status = MatchStatus.LIVE
    second.save(update_fields=["status"])

    body = _get(admin, t, day=DAY_1_S).json()
    assert body["days"][0]["counts"] == {"total": 3, "completed": 1, "live": 1}
    queue_ids = [m["id"] for m in body["queue"]]
    assert str(first.id) not in queue_ids  # finished — out of the queue
    assert str(second.id) in queue_ids  # live still counts as not-finished


def test_default_day_falls_to_next_day_with_matches():
    admin, t, _matches = _setup()
    # All matches are in the future relative to "today" → first day wins.
    body = _get(admin, t).json()
    assert body["day"] == DAY_1_S


def test_scorer_and_called_surface_on_rows():
    admin, t, matches = _setup()
    m = matches[0]
    m.scorer = admin
    m.save(update_fields=["scorer"])
    c = _client(admin)
    assert c.post(f"/api/matches/{m.id}/call/", {}, format="json").status_code == 200

    body = _get(admin, t, day=DAY_1_S).json()
    row = next(
        r for v in body["venues"] for r in v["matches"] if r["id"] == str(m.id)
    )
    assert row["called_at"] is not None
    assert row["scorer"] == {"id": str(admin.id), "name": admin.name or admin.email}


def test_invalid_day_is_400():
    admin, t, _matches = _setup()
    r = _get(admin, t, day="not-a-date")
    assert r.status_code == 400
    assert "invalid_day" in r.content.decode()


def test_unassigned_venue_lane_sorts_last():
    admin, t, matches = _setup()
    m = next(m for m in matches if m.scheduled_at.astimezone(ZoneInfo(t.time_zone)).date() == DAY_1)
    m.venue = ""
    m.save(update_fields=["venue"])
    body = _get(admin, t, day=DAY_1_S).json()
    assert [v["venue"] for v in body["venues"]][-1] == ""  # FE renders "Unassigned"


@pytest.mark.parametrize("role", TournamentMembershipRole.values)
def test_any_active_member_may_read(role):
    _admin, t, _matches = _setup()
    member = _verified(f"cr-{role}-{uuid.uuid4().hex[:8]}@test.local")
    TournamentMembership.objects.create(
        user=member, tournament=t, role=role,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _get(member, t).status_code == 200


def test_cross_org_isolation_404():
    _admin, t, _matches = _setup()
    outsider = _verified(f"cr-out-{uuid.uuid4().hex[:8]}@test.local")
    create_tournament(user=outsider, name="Other Org Cup")  # own workspace
    r = _get(outsider, t)
    assert r.status_code == 404  # no existence leak

    anon = APIClient().get(f"/api/tournaments/{t.id}/control-room/")
    assert anon.status_code in (401, 403)
