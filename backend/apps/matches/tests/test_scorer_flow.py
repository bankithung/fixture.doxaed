"""TDD — the literal owner flow: an invited match_scorer can actually score.

Regression for the audit BLOCKER: previously only the seed command set
match.scorer_id, so an invited tournament match_scorer could not score via API.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.services.generate import generate_round_robin
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


def _verified(email: str) -> User:
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _tournament_with_match(admin):
    t = create_tournament(user=admin, name="Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    generate_round_robin(tournament=t, group_size=2)
    return t, Match.objects.filter(tournament=t).first()


def _make_scorer(t, email="scorer@test.local"):
    scorer = _verified(email)
    TournamentMembership.objects.create(
        user=scorer, tournament=t, role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    return scorer


def test_invited_match_scorer_can_score():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    scorer = _make_scorer(t)
    client = APIClient()
    client.force_authenticate(user=scorer)

    r = client.post(
        f"/api/matches/{m.id}/score/", {"home_score": 2, "away_score": 0}, format="json"
    )
    assert r.status_code == 200, r.content
    assert r.json()["status"] == "completed"


def test_non_member_cannot_score():
    admin = _verified("admin@test.local")
    _t, m = _tournament_with_match(admin)
    outsider = _verified("outsider@test.local")
    client = APIClient()
    client.force_authenticate(user=outsider)

    r = client.post(
        f"/api/matches/{m.id}/score/", {"home_score": 1, "away_score": 0}, format="json"
    )
    assert r.status_code in (403, 404)


def test_manager_assigns_scorer_to_match():
    admin = _verified("admin@test.local")
    t, m = _tournament_with_match(admin)
    scorer = _make_scorer(t)
    client = APIClient()
    client.force_authenticate(user=admin)

    r = client.post(
        f"/api/matches/{m.id}/scorer/", {"user_id": str(scorer.id)}, format="json"
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert m.scorer_id == scorer.id
