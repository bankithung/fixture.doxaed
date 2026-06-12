"""Control room, increment 4 — public standings
(`GET /api/public/tournaments/{slug}/{id}/standings/`, spec 2026-06-12 §2.d).
AllowAny + read-only; same (slug, UUID) + public-status gating as the public
schedule; body reuses compute_standings verbatim ({groups:[{group_label,
rows}]} — team aggregates only, public-safe)."""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.teams.models import Institution
from apps.teams.services.registration import register_school
from apps.tournaments.models import TournamentStatus
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


def _setup(status: str = TournamentStatus.LIVE):
    admin = _verified(f"pubst-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Standings Cup")
    register_school(
        tournament=t,
        school_name="St. Mary School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    inst = Institution.objects.get(tournament=t)
    inst.contact_email = "secret-contact@test.local"
    inst.save(update_fields=["contact_email"])
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    tz = ZoneInfo(t.time_zone)
    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    for i, m in enumerate(matches):
        m.scheduled_at = datetime(2026, 8, 1 + i, 9, 0, tzinfo=tz)
        m.save(update_fields=["scheduled_at"])
    t.status = status
    t.save(update_fields=["status"])
    return admin, t, matches


def _get(t, slug=None):
    return APIClient().get(
        f"/api/public/tournaments/{slug or t.slug}/{t.id}/standings/"
    )


def test_public_standings_reflect_completed_results():
    _admin, t, matches = _setup()
    m = matches[0]
    m.home_score, m.away_score = 2, 0
    m.status = MatchStatus.COMPLETED
    m.save(update_fields=["home_score", "away_score", "status"])

    r = _get(t)
    assert r.status_code == 200, r.content
    groups = r.json()["groups"]
    assert len(groups) == 1
    rows = groups[0]["rows"]
    assert rows[0]["name"] == m.home_team.name  # the winner tops the table
    assert rows[0]["Pts"] == 3 and rows[0]["GD"] == 2
    assert {"team_id", "name", "school", "P", "W", "D", "L",
            "GF", "GA", "GD", "Pts"} <= set(rows[0])


def test_public_standings_have_no_pii():
    _admin, t, matches = _setup()
    m = matches[0]
    m.home_score, m.away_score = 1, 0
    m.status = MatchStatus.COMPLETED
    m.save(update_fields=["home_score", "away_score", "status"])
    raw = _get(t).content.decode()
    assert "secret-contact@test.local" not in raw
    assert "St. Mary School" in raw  # school name IS public


@pytest.mark.parametrize(
    "status",
    [
        TournamentStatus.REGISTRATION_OPEN,
        TournamentStatus.SCHEDULED,
        TournamentStatus.LIVE,
        TournamentStatus.COMPLETED,
    ],
)
def test_public_standings_visible_in_public_statuses(status):
    _admin, t, _matches = _setup(status=status)
    assert _get(t).status_code == 200


@pytest.mark.parametrize(
    "status",
    [
        TournamentStatus.DRAFT,
        TournamentStatus.PUBLISHED,
        TournamentStatus.ARCHIVED,
    ],
)
def test_public_standings_hidden_in_private_statuses(status):
    _admin, t, _matches = _setup(status=status)
    assert _get(t).status_code == 404


def test_wrong_slug_is_404():
    _admin, t, _matches = _setup()
    assert _get(t, slug="some-other-slug").status_code == 404
