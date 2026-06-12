"""Trust layer, increment H(1) — public tournament schedule.

`GET /api/public/tournaments/{slug}/{id}/schedule/` is AllowAny + read-only:
day/time/venue/teams/leaf for every match, no PII beyond team/school names,
and ONLY while the tournament status is public (registration_open,
scheduled, live, completed). Resolution is the (slug, UUID) pair — a wrong
slug 404s (invariant 1)."""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match
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


def _setup(status: str = TournamentStatus.REGISTRATION_OPEN):
    admin = _verified(f"public-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Public Cup")
    register_school(
        tournament=t,
        school_name="St. Mary School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    inst = Institution.objects.get(tournament=t)
    inst.contact_email = "secret-contact@test.local"
    inst.contact_phone = "9999999999"
    inst.save(update_fields=["contact_email", "contact_phone"])
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    tz = ZoneInfo(t.time_zone)
    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    for i, m in enumerate(matches):
        m.scheduled_at = datetime(2026, 8, 1 + i, 9, 0, tzinfo=tz)
        m.venue = "Main Ground"
        m.save(update_fields=["scheduled_at", "venue"])
    t.status = status
    t.save(update_fields=["status"])
    return admin, t, matches


def _get(t, slug=None):
    return APIClient().get(
        f"/api/public/tournaments/{slug or t.slug}/{t.id}/schedule/"
    )


def test_public_schedule_lists_matches_for_open_tournament():
    _admin, t, matches = _setup()
    r = _get(t)
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["tournament"]["name"] == "Public Cup"
    assert body["tournament"]["time_zone"] == t.time_zone
    assert len(body["matches"]) == len(matches)
    first = body["matches"][0]
    assert first["home"]["name"].startswith("Team")
    assert first["away"]["name"].startswith("Team")
    assert first["venue"] == "Main Ground"
    assert first["day"] == "2026-08-01"
    assert first["scheduled_at"]
    assert "leaf_key" in first and "leaf_label" in first
    # Sorted by slot — flat group-by-day rendering needs chronological order.
    days = [m["day"] for m in body["matches"]]
    assert days == sorted(days)


def test_public_schedule_has_no_pii():
    _admin, t, _matches = _setup()
    raw = _get(t).content.decode()
    assert "secret-contact@test.local" not in raw
    assert "9999999999" not in raw
    assert "St. Mary School" in raw  # school name IS public


@pytest.mark.parametrize(
    "status",
    [
        TournamentStatus.SCHEDULED,
        TournamentStatus.LIVE,
        TournamentStatus.COMPLETED,
    ],
)
def test_public_schedule_visible_in_public_statuses(status):
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
def test_public_schedule_hidden_in_private_statuses(status):
    _admin, t, _matches = _setup(status=status)
    assert _get(t).status_code == 404


def test_wrong_slug_is_404():
    _admin, t, _matches = _setup()
    assert _get(t, slug="some-other-slug").status_code == 404
