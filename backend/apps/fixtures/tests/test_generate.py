"""TDD — round-robin fixture generation (groups + circle method, idempotent)."""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import generate_round_robin
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str = "org@test.local") -> "User":
    user = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _register_n_teams(t, n: int):
    return register_school(
        tournament=t,
        school_name="Pool",
        teams=[{"name": f"Team {i + 1}", "players": []} for i in range(n)],
    )


def test_round_robin_4_teams_makes_6_unique_pairings():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    _register_n_teams(t, 4)

    matches = generate_round_robin(tournament=t, group_size=4)

    assert len(matches) == 6  # C(4,2)
    pairs = {
        frozenset([m.home_team_id, m.away_team_id])
        for m in Match.objects.filter(tournament=t)
    }
    assert len(pairs) == 6  # each pair exactly once


def test_round_robin_10_teams_splits_into_two_groups_of_5():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    _register_n_teams(t, 10)

    matches = generate_round_robin(tournament=t, group_size=5)

    assert len(matches) == 20  # 2 groups x C(5,2)=10
    labels = set(Match.objects.filter(tournament=t).values_list("group_label", flat=True))
    assert labels == {"Group A", "Group B"}


def test_generate_is_idempotent():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    _register_n_teams(t, 4)

    generate_round_robin(tournament=t, group_size=4)
    again = generate_round_robin(tournament=t, group_size=4)

    assert Match.objects.filter(tournament=t).count() == 6
    assert len(again) == 6
