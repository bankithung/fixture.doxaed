"""R3 FIFA-style auto group-sizing + pots.

``balance_groups`` sizes the group stage so every group is within one team of
the others (no orphan group), deriving the group COUNT from the target size —
10 teams at target 4 become (4, 3, 3) instead of the plain-chunk (4, 4, 2).
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.generate import (
    balanced_group_sizes,
    generate_round_robin,
)
from apps.matches.models import Match
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()


# ---------------------------------------------------------- pure size planning
@pytest.mark.parametrize(
    "n,target,expected",
    [
        (8, 4, [4, 4]),          # divisible → equal
        (10, 4, [4, 3, 3]),      # FIFA-style: 3 groups, balanced (not 4,4,2)
        (7, 4, [4, 3]),
        (5, 4, [3, 2]),
        (9, 4, [3, 3, 3]),       # avoid (4,4,1) orphan
        (6, 2, [2, 2, 2]),
        (2, 4, [2]),             # one tiny group
        (12, 4, [4, 4, 4]),
        (16, 4, [4, 4, 4, 4]),
    ],
)
def test_balanced_group_sizes(n, target, expected):
    assert balanced_group_sizes(n, target) == expected
    assert sum(balanced_group_sizes(n, target)) == n
    sizes = balanced_group_sizes(n, target)
    assert max(sizes) - min(sizes) <= 1            # within one
    assert all(s >= 1 for s in sizes)              # never empty


# ---------------------------------------------------------- end-to-end on teams
def _admin():
    u = User.objects.create_user(email="rb-grp@test.local",
                                 password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _group_sizes(tournament) -> list[int]:
    counts: dict[str, set] = {}
    for m in Match.objects.filter(tournament=tournament):
        g = counts.setdefault(m.group_label, set())
        g.add(m.home_team_id)
        g.add(m.away_team_id)
    return sorted((len(v) for v in counts.values()), reverse=True)


@pytest.mark.django_db
def test_generate_round_robin_balances_groups():
    admin = _admin()
    t = create_tournament(user=admin, name="Balanced Cup")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i}", "players": []} for i in range(10)])
    # Target size 4, balanced ⇒ (4, 3, 3) — three even groups, no orphan.
    generate_round_robin(tournament=t, group_size=4, balance_groups=True)
    assert _group_sizes(t) == [4, 3, 3]


@pytest.mark.django_db
def test_plain_chunking_unchanged_when_balance_off():
    admin = _admin()
    t = create_tournament(user=admin, name="Chunk Cup")
    register_school(tournament=t, school_name="S",
                    teams=[{"name": f"T{i}", "players": []} for i in range(10)])
    # Legacy chunk of 4 ⇒ (4, 4, 2): the back-compat default.
    generate_round_robin(tournament=t, group_size=4, balance_groups=False)
    assert _group_sizes(t) == [4, 4, 2]
