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


def _sport_for_pool(tournament, pool: str) -> str:
    """Map a pool (category) back to its sport key via the tournament's sports
    config, so per-sport (set-based) scoring knows which rules apply. '' if the
    category isn't tied to a configured sport (→ goal-based default)."""
    for s in tournament.sports or []:
        if pool in (s.get("categories") or []):
            return str(s.get("key") or "")
    return ""


def generate_round_robin_by_category(*, tournament) -> list[Match]:
    """Round-robin WITHIN each category bucket: a team only plays others in the
    SAME pool (e.g. U-14 vs U-14), honoring the category each team registered
    under — instead of re-grouping by size. Pools with <2 teams are skipped.
    Idempotent: returns existing matches if any."""
    existing = list(
        Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    )
    if existing:
        return existing

    teams = list(
        Team.objects.filter(
            tournament=tournament, status=TeamStatus.REGISTERED, deleted_at__isnull=True
        ).order_by("pool", "seed", "name")
    )
    if len(teams) < 2:
        raise ValueError("Need at least 2 registered teams to generate fixtures.")

    # Bucket by the team's existing pool (its category); blanks fall into "General".
    from collections import OrderedDict

    pools: "OrderedDict[str, list]" = OrderedDict()
    for tm in teams:
        pools.setdefault(tm.pool or "General", []).append(tm)

    org = tournament.organization
    to_create: list[Match] = []
    match_no = 0
    with transaction.atomic():
        for label, group in pools.items():
            if len(group) < 2:
                continue  # a category with a single team has no matches
            sport_key = _sport_for_pool(tournament, label)
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
                        sport=sport_key,
                        round_no=round_no,
                        match_no=match_no,
                        home_team=home,
                        away_team=away,
                        status=MatchStatus.SCHEDULED,
                        inputs_hash=ih,
                    )
                )
        if not to_create:
            raise ValueError("No category has 2+ teams to schedule.")
        Match.objects.bulk_create(to_create)
    return to_create


def generate_single_elimination(*, tournament, teams, stage: str = "knockout") -> list[Match]:
    """Generate a single-elimination bracket from `teams` (a power-of-2 count).

    Round 1 pairs concrete teams; later rounds carry typed winner_of pointers
    (invariant #9) that apps.fixtures.services.advance resolves on completion.
    """
    n = len(teams)
    if n < 2 or (n & (n - 1)) != 0:
        raise ValueError("single elimination requires a power-of-2 team count (>= 2)")

    org = tournament.organization
    created: list[Match] = []
    # Continue match numbering after any existing (e.g. group-stage) matches.
    match_no = Match.objects.filter(tournament=tournament).count()

    with transaction.atomic():
        round_matches: list[Match] = []
        for i in range(0, n, 2):
            match_no += 1
            home, away = teams[i], teams[i + 1]
            round_matches.append(
                Match(
                    organization=org, tournament=tournament, stage=stage,
                    round_no=1, match_no=match_no,
                    home_team=home, away_team=away,
                    home_source={"type": "team", "team_id": str(home.id)},
                    away_source={"type": "team", "team_id": str(away.id)},
                    status=MatchStatus.SCHEDULED,
                )
            )
        Match.objects.bulk_create(round_matches)
        created.extend(round_matches)

        prev = round_matches
        round_no = 2
        while len(prev) > 1:
            nxt: list[Match] = []
            for i in range(0, len(prev), 2):
                match_no += 1
                nxt.append(
                    Match(
                        organization=org, tournament=tournament, stage=stage,
                        round_no=round_no, match_no=match_no,
                        home_source={"type": "winner_of", "match_id": str(prev[i].id)},
                        away_source={"type": "winner_of", "match_id": str(prev[i + 1].id)},
                        status=MatchStatus.SCHEDULED,
                    )
                )
            Match.objects.bulk_create(nxt)
            created.extend(nxt)
            prev = nxt
            round_no += 1

    return created


def generate_knockout_from_groups(*, tournament, advance_per_group: int = 2) -> list[Match]:
    """Advance the top `advance_per_group` of each group into a single-elimination
    bracket (FIFA-style groups → knockout). Cross-seeds winners vs other groups'
    runners-up. Idempotent: returns the existing knockout if already generated.
    """
    from apps.matches.services.standings import compute_standings

    existing = list(
        Match.objects.filter(
            tournament=tournament, stage="knockout", deleted_at__isnull=True
        )
    )
    if existing:
        return existing

    groups = sorted(
        g
        for g in Match.objects.filter(
            tournament=tournament, stage="group", deleted_at__isnull=True
        )
        .values_list("group_label", flat=True)
        .distinct()
        if g
    )
    if not groups:
        raise ValueError("No group stage to advance from.")

    quals: list[list[str]] = []
    for g in groups:
        rows = compute_standings(tournament, group_label=g)
        ids = [r["team_id"] for r in rows[:advance_per_group]]
        if len(ids) < 2:
            raise ValueError(f"Group {g} hasn't finished enough matches to advance teams.")
        quals.append(ids)

    n = len(groups)
    # Cross-seed: group i winner vs the next group's runner-up.
    seed_ids: list[str] = []
    for i in range(n):
        seed_ids.append(quals[i][0])
        seed_ids.append(quals[(i + 1) % n][1])

    teams = [Team.objects.get(id=tid) for tid in seed_ids]
    return generate_single_elimination(tournament=tournament, teams=teams, stage="knockout")
