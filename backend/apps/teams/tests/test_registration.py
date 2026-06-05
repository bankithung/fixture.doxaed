"""TDD — register a school's teams + players (v1Teams.md §2, §5.1 self-register).

One school can submit multiple teams, each with players (name, jersey, position,
dob_year). Jersey numbers are unique within a team; a Person is created per
player. Submissions are idempotent on a client event_id (invariant 3).
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.utils import timezone

from apps.teams.models import Person, Player, Team, TeamStatus
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _payload(school: str, n_teams: int = 2, n_players: int = 3) -> dict:
    return {
        "school_name": school,
        "teams": [
            {
                "name": f"{school} Team {i + 1}",
                "players": [
                    {
                        "full_name": f"{school} Player {i + 1}-{j + 1}",
                        "jersey_no": j + 1,
                        "position": "ST",
                        "dob_year": 2008,
                    }
                    for j in range(n_players)
                ],
            }
            for i in range(n_teams)
        ],
    }


def test_register_school_creates_teams_and_players():
    admin = _verified()
    t = create_tournament(user=admin, name="Kohima Cup")

    teams = register_school(tournament=t, submitted_by=admin, **_payload("Mount Hermon", 2, 3))

    assert len(teams) == 2
    assert Team.objects.filter(tournament=t).count() == 2
    assert Player.objects.filter(tournament=t).count() == 6
    assert Person.objects.count() == 6
    for team in Team.objects.filter(tournament=t):
        assert team.status == TeamStatus.REGISTERED
        assert team.school == "Mount Hermon"
        assert team.organization_id == t.organization_id
        assert team.players.count() == 3


def test_register_school_enforces_jersey_unique_per_team():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    payload = {
        "school_name": "Don Bosco",
        "teams": [
            {
                "name": "Don Bosco A",
                "players": [
                    {"full_name": "A", "jersey_no": 7},
                    {"full_name": "B", "jersey_no": 7},
                ],
            }
        ],
    }
    with pytest.raises(IntegrityError):
        register_school(tournament=t, **payload)


def test_register_school_idempotent_on_event_id():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    eid = uuid.uuid4()

    register_school(tournament=t, event_id=eid, **_payload("Carmel", 1, 2))
    register_school(tournament=t, event_id=eid, **_payload("Carmel", 1, 2))

    assert Team.objects.filter(tournament=t).count() == 1
