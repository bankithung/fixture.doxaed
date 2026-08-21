"""`GET /api/public/tournaments/{slug}/{id}/rosters/` — every team's line-up
in ONE read.

The printed order of play has a second pass that names the PLAYERS, not only
the teams; a request per team would be hundreds on a real tournament, so the
whole tournament's rosters come back together. Same gate as the public
schedule (the (slug, UUID) pair + a public-facing status) and the same PII
posture: names and shirt numbers, nothing else.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams.models import Player, Team
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


def _setup(status: str = TournamentStatus.SCHEDULED):
    admin = _verified(f"rosters-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Roster Cup")
    register_school(
        tournament=t,
        school_name="St. Mary School",
        teams=[
            {
                "name": "Mary TT-1",
                "players": [
                    {"full_name": "Asen Jamir", "jersey_no": 7},
                    {"full_name": "Bendang Ao", "jersey_no": 3},
                ],
            },
            {"name": "Mary TT-2", "players": [{"full_name": "Chubala Imchen"}]},
        ],
    )
    t.status = status
    t.save(update_fields=["status"])
    return admin, t


def _get(t, slug=None):
    return APIClient().get(
        f"/api/public/tournaments/{slug or t.slug}/{t.id}/rosters/"
    )


def test_rosters_name_every_player_of_every_team():
    _admin, t = _setup()
    r = _get(t)
    assert r.status_code == 200, r.content
    teams = {row["name"]: row for row in r.json()["teams"]}
    assert set(teams) == {"Mary TT-1", "Mary TT-2"}
    # Shirt number first, then name — the order a team sheet is pinned up in.
    assert [p["name"] for p in teams["Mary TT-1"]["players"]] == [
        "Bendang Ao",
        "Asen Jamir",
    ]
    assert [p["jersey_no"] for p in teams["Mary TT-1"]["players"]] == [3, 7]
    assert [p["name"] for p in teams["Mary TT-2"]["players"]] == ["Chubala Imchen"]
    assert teams["Mary TT-1"]["school"] == "St. Mary School"


def test_rosters_are_names_only_no_contact_pii():
    _admin, t = _setup()
    body = _get(t).json()
    keys = {k for row in body["teams"] for p in row["players"] for k in p}
    assert keys == {"id", "name", "jersey_no", "captain"}


def test_a_withdrawn_player_is_not_listed():
    _admin, t = _setup()
    gone = Player.objects.get(person__full_name="Asen Jamir")
    gone.deleted_at = timezone.now()
    gone.save(update_fields=["deleted_at"])
    teams = {row["name"]: row for row in _get(t).json()["teams"]}
    assert [p["name"] for p in teams["Mary TT-1"]["players"]] == ["Bendang Ao"]


def test_a_team_with_no_roster_still_appears_with_an_empty_list():
    _admin, t = _setup()
    Player.objects.filter(team__name="Mary TT-2").delete()
    teams = {row["name"]: row for row in _get(t).json()["teams"]}
    assert teams["Mary TT-2"]["players"] == []
    assert Team.objects.filter(tournament=t, deleted_at__isnull=True).count() == 2


def test_wrong_slug_404s_and_a_draft_tournament_is_not_public():
    _admin, t = _setup()
    assert _get(t, slug="not-this-one").status_code == 404
    t.status = TournamentStatus.DRAFT
    t.save(update_fields=["status"])
    assert _get(t).status_code == 404
