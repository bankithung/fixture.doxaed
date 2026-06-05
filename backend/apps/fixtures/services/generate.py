"""Fixture generation — Phase A (structure) of v1Fixtures.md.

MVP: split registered teams into groups and generate a single round-robin per
group via the circle method (each pair plays once, home/away alternated by
round). Produces `matches.Match` rows in SCHEDULED state. Idempotent: if a
tournament already has matches, returns them unchanged. The full data-driven
constraint scheduler (v1Fixtures.md §3) layers on top later.
"""
from __future__ import annotations

import hashlib

from django.db import transaction

from apps.matches.models import Match, MatchStatus
from apps.teams.models import Team, TeamStatus

_GROUP_LABELS = [chr(ord("A") + i) for i in range(26)]


def _round_robin(teams: list) -> list[tuple]:
    """Circle method → list of (round_no, home, away), each pair once."""
    arr = list(teams)
    if len(arr) % 2:
        arr.append(None)  # bye marker
    n = len(arr)
    pairings: list[tuple] = []
    for r in range(n - 1):
        for i in range(n // 2):
            home, away = arr[i], arr[n - 1 - i]
            if home is None or away is None:
                continue
            # alternate home/away by round for fairness
            pairings.append((r + 1, home, away) if r % 2 == 0 else (r + 1, away, home))
        # rotate, keeping the first element fixed
        arr = [arr[0]] + [arr[-1]] + arr[1:-1]
    return pairings


def generate_round_robin(*, tournament, group_size: int = 5) -> list[Match]:
    """Group the tournament's registered teams and generate round-robin matches."""
    existing = list(
        Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    )
    if existing:
        return existing  # idempotent — already generated

    teams = list(
        Team.objects.filter(
            tournament=tournament, status=TeamStatus.REGISTERED, deleted_at__isnull=True
        ).order_by("seed", "name")
    )
    if len(teams) < 2:
        raise ValueError("Need at least 2 registered teams to generate fixtures.")

    org = tournament.organization
    to_create: list[Match] = []
    match_no = 0
    with transaction.atomic():
        groups = [teams[i : i + group_size] for i in range(0, len(teams), group_size)]
        for gi, group in enumerate(groups):
            label = f"Group {_GROUP_LABELS[gi]}"
            for team in group:
                if team.pool != label:
                    team.pool = label
                    team.save(update_fields=["pool", "updated_at"])
            ih = hashlib.sha256(
                ",".join(sorted(str(t.id) for t in group)).encode()
            ).hexdigest()
            for round_no, home, away in _round_robin(group):
                match_no += 1
                to_create.append(
                    Match(
                        organization=org,
                        tournament=tournament,
                        stage="group",
                        group_label=label,
                        round_no=round_no,
                        match_no=match_no,
                        home_team=home,
                        away_team=away,
                        status=MatchStatus.SCHEDULED,
                        inputs_hash=ih,
                    )
                )
        Match.objects.bulk_create(to_create)
    return to_create
