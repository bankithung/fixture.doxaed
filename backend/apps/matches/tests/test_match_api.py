"""TDD — tournament API: generate fixtures, list matches, score, standings, isolation."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> User:
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _setup(admin):
    t = create_tournament(user=admin, name="Cup")
    register_school(
        tournament=t,
        school_name="School",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(4)],
    )
    return t


def test_generate_list_score_and_standings_flow():
    admin = _verified("admin@test.local")
    t = _setup(admin)
    client = APIClient()
    client.force_authenticate(user=admin)

    g = client.post(
        f"/api/tournaments/{t.id}/generate-fixtures/", {"group_size": 4}, format="json"
    )
    assert g.status_code == 201, g.content
    assert g.json()["generated"] == 6

    ml = client.get(f"/api/tournaments/{t.id}/matches/")
    assert ml.status_code == 200
    assert len(ml.json()) == 6
    first = ml.json()[0]
    # The list is enriched for the operations Matches board (additive fields):
    # competition leaf label + assigned scorer/officials always present.
    assert "leaf_label" in first
    assert first["scorer"] is None
    assert first["officials"] == []

    s = client.post(
        f"/api/matches/{first['id']}/score/", {"home_score": 3, "away_score": 1}, format="json"
    )
    assert s.status_code == 200, s.content
    assert s.json()["status"] == "completed"
    assert s.json()["home_score"] == 3

    st = client.get(f"/api/tournaments/{t.id}/standings/")
    assert st.status_code == 200
    assert any(grp["rows"] for grp in st.json()["groups"])


def test_generate_knockout_bracket():
    admin = _verified("admin@test.local")
    t = _setup(admin)  # 4 registered teams
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        f"/api/tournaments/{t.id}/generate-fixtures/", {"format": "knockout"}, format="json"
    )
    assert r.status_code == 201, r.content
    assert r.json()["generated"] == 3  # 4 teams single-elim = 2 semis + final


def test_outsider_cannot_list_matches():
    admin = _verified("admin@test.local")
    t = _setup(admin)
    outsider = _verified("outsider@test.local")
    client = APIClient()
    client.force_authenticate(user=outsider)

    assert client.get(f"/api/tournaments/{t.id}/matches/").status_code == 404


def test_outsider_cannot_generate_fixtures():
    admin = _verified("admin@test.local")
    t = _setup(admin)
    outsider = _verified("outsider@test.local")
    client = APIClient()
    client.force_authenticate(user=outsider)

    r = client.post(f"/api/tournaments/{t.id}/generate-fixtures/", {}, format="json")
    assert r.status_code == 404
