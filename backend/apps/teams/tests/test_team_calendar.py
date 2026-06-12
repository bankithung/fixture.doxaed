"""Trust layer, increment H(2) — per-team iCal feeds.

`POST /api/tournaments/{id}/teams/{team_id}/calendar-link/` (authenticated:
tournament manager OR the team institution's registered contact) mints a
signed `django.core.signing` token; `GET /api/public/teams/{id}/calendar.ics
?token=` (AllowAny) serves VEVENTs — UID = match id, DTSTART converted
tournament TZ → UTC, SUMMARY "A vs B — Competition", LOCATION venue. No
token / tampered token / another team's token → 403."""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match
from apps.teams.models import Institution, Team
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
    suffix = uuid.uuid4().hex[:8]
    admin = _verified(f"cal-admin-{suffix}@test.local")
    contact = _verified(f"cal-contact-{suffix}@test.local")
    t = create_tournament(user=admin, name="Calendar Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    inst = Institution.objects.get(tournament=t)
    inst.contact_email = contact.email
    inst.save(update_fields=["contact_email"])
    from apps.fixtures.services.generate import generate_round_robin

    generate_round_robin(tournament=t, group_size=4)
    tz = ZoneInfo(t.time_zone)
    matches = list(Match.objects.filter(tournament=t).order_by("match_no"))
    for i, m in enumerate(matches):
        m.scheduled_at = datetime(2026, 8, 1 + i, 9, 0, tzinfo=tz)
        m.venue = "Main Ground"
        m.save(update_fields=["scheduled_at", "venue"])
    team = Team.objects.filter(tournament=t, name="Team 1").get()
    return admin, contact, t, team, matches


def _mint(user, t, team):
    return _client(user).post(
        f"/api/tournaments/{t.id}/teams/{team.id}/calendar-link/"
    )


def _ics(team, token: str):
    return APIClient().get(
        f"/api/public/teams/{team.id}/calendar.ics", {"token": token}
    )


def test_manager_mints_link_and_feed_serves_vevents():
    admin, _contact, t, team, matches = _setup()
    r = _mint(admin, t, team)
    assert r.status_code == 200, r.content
    token = r.json()["token"]
    assert token
    assert f"/api/public/teams/{team.id}/calendar.ics?token=" in r.json()["url"]

    f = _ics(team, token)
    assert f.status_code == 200, f.content
    assert f["Content-Type"].startswith("text/calendar")
    body = f.content.decode("utf-8")
    assert "BEGIN:VCALENDAR" in body and "END:VCALENDAR" in body

    mine = [
        m for m in matches
        if team.id in (m.home_team_id, m.away_team_id)
    ]
    assert body.count("BEGIN:VEVENT") == len(mine) == 3
    first = mine[0]
    assert f"UID:{first.id}" in body
    # 2026-08-01 09:00 Asia/Kolkata (+05:30) → 03:30 UTC.
    assert "DTSTART:20260801T033000Z" in body
    assert "SUMMARY:Team 1 vs " in body
    assert "LOCATION:Main Ground" in body


def test_feed_requires_token():
    admin, _contact, t, team, _matches = _setup()
    _mint(admin, t, team)
    r = APIClient().get(f"/api/public/teams/{team.id}/calendar.ics")
    assert r.status_code == 403


def test_tampered_token_is_403():
    admin, _contact, t, team, _matches = _setup()
    token = _mint(admin, t, team).json()["token"]
    assert _ics(team, token[:-2] + "xx").status_code == 403


def test_token_is_bound_to_its_team():
    admin, _contact, t, team, _matches = _setup()
    other = Team.objects.filter(tournament=t, name="Team 2").get()
    token = _mint(admin, t, team).json()["token"]
    assert _ics(other, token).status_code == 403
    assert _ics(team, token).status_code == 200


def test_institution_contact_may_mint():
    _admin, contact, t, team, _matches = _setup()
    assert _mint(contact, t, team).status_code == 200


def test_non_manager_member_is_403_and_outsider_404():
    _admin, _contact, t, team, _matches = _setup()
    scorer = _verified(f"cal-scorer-{uuid.uuid4().hex[:8]}@test.local")
    TournamentMembership.objects.create(
        user=scorer, tournament=t,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    assert _mint(scorer, t, team).status_code == 403

    outsider = _verified(f"cal-out-{uuid.uuid4().hex[:8]}@test.local")
    assert _mint(outsider, t, team).status_code == 404  # no existence leak

    assert APIClient().post(
        f"/api/tournaments/{t.id}/teams/{team.id}/calendar-link/"
    ).status_code in (401, 403)
