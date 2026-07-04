"""The dashboard analytics rollup: /api/me/overview/ aggregates."""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user() -> User:
    u = User.objects.create_user(
        email=f"ov-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def test_overview_aggregates_across_tournaments():
    admin = _user()
    now = timezone.now()

    t1 = create_tournament(user=admin, name="Cup A")
    a1, b1 = register_school(
        tournament=t1, school_name="S1",
        teams=[{"name": "A", "players": [{"full_name": "P1"}]},
               {"name": "B", "players": []}],
    )
    t2 = create_tournament(user=admin, name="Cup B")
    a2, b2 = register_school(
        tournament=t2, school_name="S2",
        teams=[{"name": "C", "players": []}, {"name": "D", "players": []}],
    )

    # One completed (2-1), one live, one scheduled tomorrow.
    m1 = Match.objects.create(
        organization=t1.organization, tournament=t1, home_team=a1, away_team=b1,
        match_no=1, scheduled_at=now - timedelta(days=1),
    )
    Match.objects.filter(pk=m1.pk).update(
        status=MatchStatus.COMPLETED, home_score=2, away_score=1, ended_at=now,
    )
    m2 = Match.objects.create(
        organization=t2.organization, tournament=t2, home_team=a2, away_team=b2,
        match_no=1, scheduled_at=now,
    )
    Match.objects.filter(pk=m2.pk).update(status=MatchStatus.LIVE)
    Match.objects.create(
        organization=t2.organization, tournament=t2, home_team=a2, away_team=b2,
        match_no=2, scheduled_at=now + timedelta(days=1),
    )

    c = APIClient()
    c.force_authenticate(user=admin)
    r = c.get("/api/me/overview/")
    assert r.status_code == 200

    totals = r.data["totals"]
    assert totals["tournaments"] == 2
    assert totals["matches"] == 3
    assert totals["matches_completed"] == 1
    assert totals["matches_live"] == 1
    assert totals["matches_next7"] == 1
    assert totals["teams"] == 4
    assert totals["players"] == 1
    assert totals["institutions"] == 2
    assert totals["goals"] == 3

    # Status mix covers both draft tournaments.
    mix = {row["status"]: row["count"] for row in r.data["tournament_status"]}
    assert sum(mix.values()) == 2

    # The per-day series buckets all three matches.
    series_total = sum(
        d["completed"] + d["live"] + d["scheduled"]
        for d in r.data["matches_per_day"]
    )
    assert series_total == 3

    # Progress rows exist for both tournaments; the live one sorts first.
    progress = r.data["progress"]
    assert {p["name"] for p in progress} == {"Cup A", "Cup B"}
    assert progress[0]["name"] == "Cup B"
    assert progress[0]["live"] == 1

    # Recent results carry the completed match with its score.
    results = r.data["recent_results"]
    assert len(results) == 1
    assert results[0]["home_score"] == 2
    assert results[0]["away_score"] == 1
    assert results[0]["tournament_name"] == "Cup A"

    # Sports mix names football (default sport).
    assert any(s["key"] == "football" for s in r.data["sports"])


def test_overview_is_scoped_to_accessible_tournaments():
    # Invariant 2: user B sees nothing of user A's data — zeroes, not a leak.
    owner = _user()
    t = create_tournament(user=owner, name="Private Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        match_no=1, scheduled_at=timezone.now(),
    )

    outsider = _user()
    c = APIClient()
    c.force_authenticate(user=outsider)
    r = c.get("/api/me/overview/")
    assert r.status_code == 200
    assert r.data["totals"]["tournaments"] == 0
    assert r.data["totals"]["matches"] == 0
    assert r.data["progress"] == []
    assert r.data["recent_results"] == []


def test_overview_requires_auth():
    r = APIClient().get("/api/me/overview/")
    assert r.status_code in (401, 403)
