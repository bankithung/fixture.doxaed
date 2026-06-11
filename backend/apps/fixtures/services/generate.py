"""Fixture generation — pairings/brackets per competition (category leaf).

Three formats (grouped round-robin, round-robin per category, single
elimination with byes, plus groups→knockout), all leaf-aware (spec 2026-06-10
§5 P3): pass ``leaf_key`` to generate ONE competition's draw independently;
idempotency is scoped per leaf so generating Football U15 never blocks
generating Table Tennis later. Produces `matches.Match` rows in SCHEDULED
state carrying ``sport`` + ``leaf_key``; the scheduler (scheduler.py) then
assigns times/venues. The full data-driven constraint scheduler layers on top.
"""
from __future__ import annotations

import hashlib

from django.db import transaction

from apps.matches.models import Match, MatchStatus
from apps.teams.models import Team, TeamStatus
from apps.tournaments.services.sports import leaf_label, sport_for_leaf

_GROUP_LABELS = [chr(ord("A") + i) for i in range(26)]


def _round_robin(teams: list, *, legs: int = 1) -> list[tuple]:
    """Circle method → list of (round_no, home, away), each pair once.

    ``legs=2`` (redesign spec §4.2 double round-robin): append a mirrored
    second cycle — the same pairings with home/away swapped ("inverted"
    symmetry) and round_no continuing after the first cycle."""
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
    if legs == 2:
        rounds = n - 1
        pairings += [(r + rounds, away, home) for r, home, away in list(pairings)]
    return pairings


def _small_group_max(tournament) -> int:
    """rules.small_group_double_rr.max_size (0 = off): groups at/under this
    size auto-play double round-robin so every team in e.g. a 3-team group
    still gets a meaningful number of matches (spec §2.6/§4.2). A
    participant-facing rule, so it lives under the invariant-7 freeze."""
    cfg = (tournament.rules or {}).get("small_group_double_rr") or {}
    try:
        return max(0, int(cfg.get("max_size") or 0))
    except (TypeError, ValueError):
        return 0


def _legs_for_group(group_len: int, legs: int, small_max: int) -> int:
    return 2 if legs == 2 or (small_max and group_len <= small_max) else 1


def _registered_teams(tournament, leaf_key: str | None = None) -> list[Team]:
    qs = Team.objects.filter(
        tournament=tournament, status=TeamStatus.REGISTERED, deleted_at__isnull=True
    )
    if leaf_key:
        qs = qs.filter(leaf_key=leaf_key)
    return list(qs.order_by("leaf_key", "pool", "seed", "name"))


def _opening_pairs_circle(count: int) -> list[tuple[int, int]]:
    """Round-1 position pairs of the circle method for `count` teams (a bye
    slot is appended for odd counts, so a pair index may be == count)."""
    n = count + (count % 2)
    return [(i, n - 1 - i) for i in range(n // 2)]


def _opening_pairs_bracket(count: int) -> list[tuple[int, int]]:
    """Round-1 TEAM-INDEX pairs of a seeded bracket for `count` entrants
    (indices >= count are byes)."""
    size = 1
    while size < count:
        size *= 2
    order = _bracket_order(size)
    return [(order[p] - 1, order[p + 1] - 1) for p in range(0, size, 2)]


def _separate_institutions(
    teams: list[Team], opening_pairs: list[tuple[int, int]] | None = None
) -> list[Team]:
    """Spread same-institution teams across the seeding order so they don't
    meet in the opening round (owner W2-D: "same schools should not be
    playing against each other on the first matches") and land in different
    round-robin pools. Groups by institution, deals one team per institution
    per pass (largest contingents first), then repairs any same-institution
    OPENING pair (the format's actual round-1 pairing, passed in) by swapping
    with a later pair's slot when both pairs stay clean. Deterministic; takes
    precedence over raw seed order within a competition (the trade-off school
    tournaments here want; manual re-pairing stays possible, invariant 10)."""
    if len(teams) < 3:
        return list(teams)
    groups: dict[object, list[Team]] = {}
    for tm in teams:
        groups.setdefault(tm.institution_id or tm.id, []).append(tm)
    if len(groups) == len(teams):
        return list(teams)  # all distinct institutions — nothing to spread
    pools = sorted(groups.values(), key=len, reverse=True)
    out: list[Team] = []
    while any(pools):
        for g in pools:
            if g:
                out.append(g.pop(0))

    pairs = opening_pairs or [(i, i + 1) for i in range(0, len(out) - 1, 2)]

    def inst(arr: list[Team], pos: int):
        return arr[pos].institution_id if pos < len(arr) else None

    def conflicts(arr: list[Team]) -> int:
        return sum(
            1 for i, j in pairs
            if inst(arr, i) is not None and inst(arr, i) == inst(arr, j)
        )

    for pi, (i, j) in enumerate(pairs):
        if j >= len(out) or i >= len(out):
            continue  # bye slot
        if not inst(out, i) or inst(out, i) != inst(out, j):
            continue
        fixed = False
        # Search EVERY other pair (a conflict in the LAST pair used to be
        # unfixable — review W2-F); the swap condition keeps the donor pair
        # separated, so earlier repairs can't be undone.
        for pj in range(len(pairs)):
            if pj == pi:
                continue
            a, b = pairs[pj]
            for k, other in ((a, b), (b, a)):
                if k >= len(out):
                    continue
                # swap out[j] <-> out[k]: both pairs must end separated
                if inst(out, k) != inst(out, i) and (
                    other >= len(out)
                    or out[j].institution_id != inst(out, other)
                ):
                    out[j], out[k] = out[k], out[j]
                    fixed = True
                    break
            if fixed:
                break

    # Never make things worse: if the reshuffle still pairs more same-school
    # opening matches than the caller's own order (possible when one school
    # dominates), keep the input order — it also preserves explicit seeding.
    if opening_pairs is not None and conflicts(out) >= 1 \
            and conflicts(out) >= conflicts(list(teams)):
        return list(teams)
    return out


def _next_match_no(tournament) -> int:
    """Continue numbering after existing LIVE rows (soft-deleted ones excluded
    — they used to inflate the count and leave gaps)."""
    return Match.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).count()


def generate_round_robin(
    *, tournament, group_size: int = 5, leaf_key: str | None = None,
    legs: int = 1,
) -> list[Match]:
    """Split registered teams into groups of ``group_size`` and round-robin each
    group. With ``leaf_key``, only that competition's teams are drawn and the
    idempotency check is scoped to it; otherwise the legacy whole-tournament
    behavior applies. Group membership lives on Match.group_label — Team.pool
    (the registered category) is never touched. ``legs=2`` doubles every
    group's cycle (mirrored, spec §4.2); rules.small_group_double_rr doubles
    only the groups at/under its max_size."""
    existing_scope = Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    if leaf_key:
        existing_scope = existing_scope.filter(leaf_key=leaf_key)
    existing = list(existing_scope)
    if existing:
        return existing  # idempotent — this scope is already generated

    teams = _registered_teams(tournament, leaf_key)
    if len(teams) < 2:
        raise ValueError("Need at least 2 registered teams to generate fixtures.")
    # Spread institutions across pools; per-group circle pairing is repaired
    # again below once group membership is known.
    teams = _separate_institutions(teams)

    sports_cfg = tournament.sports or []
    sport = sport_for_leaf(sports_cfg, leaf_key or "")
    prefix = f"{leaf_label(sports_cfg, leaf_key)} — " if leaf_key else ""

    org = tournament.organization
    small_max = _small_group_max(tournament)
    to_create: list[Match] = []
    match_no = _next_match_no(tournament)
    with transaction.atomic():
        groups = [teams[i : i + group_size] for i in range(0, len(teams), group_size)]
        for gi, group in enumerate(groups):
            group = _separate_institutions(
                group, _opening_pairs_circle(len(group))
            )
            label = f"{prefix}Group {_GROUP_LABELS[gi]}"[:80]
            ih = hashlib.sha256(
                ",".join(sorted(str(t.id) for t in group)).encode()
            ).hexdigest()
            group_legs = _legs_for_group(len(group), legs, small_max)
            for round_no, home, away in _round_robin(group, legs=group_legs):
                match_no += 1
                to_create.append(
                    Match(
                        organization=org,
                        tournament=tournament,
                        stage="group",
                        group_label=label,
                        sport=sport,
                        leaf_key=leaf_key or "",
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


def generate_round_robin_by_category(
    *, tournament, leaf_key: str | None = None, legs: int = 1,
) -> list[Match]:
    """Round-robin WITHIN each competition (category leaf): a team only plays
    others registered into the SAME leaf. Buckets key on the structural
    ``Team.leaf_key`` (falling back to the legacy ``pool`` label); idempotency
    is PER BUCKET, so each competition generates independently — pass
    ``leaf_key`` to draw exactly one. Buckets with <2 teams are skipped.
    ``legs=2`` doubles each bucket's cycle (mirrored, spec §4.2);
    rules.small_group_double_rr doubles only buckets at/under its max_size."""
    teams = _registered_teams(tournament, leaf_key)
    if leaf_key and len(teams) < 2:
        raise ValueError("Need at least 2 registered teams in this category.")
    if len(teams) < 2:
        raise ValueError("Need at least 2 registered teams to generate fixtures.")

    from collections import OrderedDict

    pools: OrderedDict[str, list] = OrderedDict()
    for tm in teams:
        pools.setdefault(tm.leaf_key or tm.pool or "General", []).append(tm)

    # Per-bucket idempotency: a bucket that already has matches is skipped
    # (legacy "" leaf buckets share one scope keyed by group_label).
    existing = list(
        Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    )
    done_leafs = {m.leaf_key for m in existing if m.leaf_key}
    done_labels = {m.group_label for m in existing if not m.leaf_key}

    sports_cfg = tournament.sports or []
    org = tournament.organization
    small_max = _small_group_max(tournament)
    to_create: list[Match] = []
    skipped_existing: list[Match] = []
    match_no = _next_match_no(tournament)
    with transaction.atomic():
        for bucket, group in pools.items():
            is_leaf = bool(group[0].leaf_key)
            label = (leaf_label(sports_cfg, bucket) if is_leaf else bucket)[:80]
            if (is_leaf and bucket in done_leafs) or (
                not is_leaf and label in done_labels
            ):
                skipped_existing.extend(
                    m for m in existing
                    if (m.leaf_key == bucket if is_leaf else m.group_label == label)
                )
                continue
            if len(group) < 2:
                continue  # a category with a single team has no matches
            group = _separate_institutions(
                group, _opening_pairs_circle(len(group))
            )
            sport_key = (
                sport_for_leaf(sports_cfg, bucket) or group[0].sport
                if is_leaf
                else group[0].sport
            )
            ih = hashlib.sha256(
                ",".join(sorted(str(t.id) for t in group)).encode()
            ).hexdigest()
            group_legs = _legs_for_group(len(group), legs, small_max)
            for round_no, home, away in _round_robin(group, legs=group_legs):
                match_no += 1
                to_create.append(
                    Match(
                        organization=org,
                        tournament=tournament,
                        stage="group",
                        group_label=label,
                        sport=sport_key,
                        leaf_key=bucket if is_leaf else "",
                        round_no=round_no,
                        match_no=match_no,
                        home_team=home,
                        away_team=away,
                        status=MatchStatus.SCHEDULED,
                        inputs_hash=ih,
                    )
                )
        if not to_create and not skipped_existing:
            raise ValueError("No category has 2+ teams to schedule.")
        Match.objects.bulk_create(to_create)
    return [*skipped_existing, *to_create]


def _bracket_order(size: int) -> list[int]:
    """Standard seeded bracket positions (1-indexed seeds) — e.g. size 8 →
    [1, 8, 4, 5, 2, 7, 3, 6]: seed 1 meets seed 2 only in the final."""
    order = [1]
    while len(order) < size:
        n = len(order) * 2
        order = [x for s in order for x in (s, n + 1 - s)]
    return order


def generate_single_elimination(
    *, tournament, teams, stage: str = "knockout",
    leaf_key: str = "", sport: str = "", third_place: bool = False,
) -> list[Match]:
    """Generate a single-elimination bracket from ``teams`` (any count ≥ 2).

    Non-power-of-2 counts get BYES: the bracket is padded to the next power of
    two and the top seeds skip round 1 (standard seeding — 1 meets 2 only in
    the final). Round 1 pairs concrete teams; later rounds carry typed
    winner_of pointers (invariant #9) that apps.fixtures.services.advance
    resolves on completion; bye teams enter round 2 as typed team pointers.
    Idempotent per (stage, leaf): an existing bracket in scope is returned.

    ``third_place`` (redesign spec §4.4): when the bracket has two semifinals,
    emit one extra match at the final's round_no, numbered BEFORE the final,
    sourced from `loser_of` pointers — the first generator to emit the
    pointer type advance.py already resolves. A bye straight into the final
    (3 teams) has a single semi, so its loser is 3rd automatically — no
    playoff is emitted."""
    n = len(teams)
    if n < 2:
        raise ValueError("single elimination requires at least 2 teams")

    existing = list(
        Match.objects.filter(
            tournament=tournament, stage=stage, leaf_key=leaf_key or "",
            deleted_at__isnull=True,
        )
    )
    if existing:
        return existing

    if not sport and leaf_key:
        sport = sport_for_leaf(tournament.sports or [], leaf_key)

    # Same-institution teams don't meet in round 1 where avoidable (W2-D).
    teams = _separate_institutions(list(teams), _opening_pairs_bracket(n))

    size = 1
    while size < n:
        size *= 2
    entrants = [teams[s - 1] if s <= n else None for s in _bracket_order(size)]

    org = tournament.organization
    created: list[Match] = []
    match_no = _next_match_no(tournament)
    common = {
        "organization": org, "tournament": tournament, "stage": stage,
        "sport": sport, "leaf_key": leaf_key or "",
        "status": MatchStatus.SCHEDULED,
    }

    with transaction.atomic():
        # Round 1: pairs with two teams play; a pair with a bye forwards its
        # team straight to round 2 as a concrete slot.
        slots: list[dict] = []  # {"match": Match} or {"team": Team}
        round1: list[Match] = []
        for i in range(0, size, 2):
            home, away = entrants[i], entrants[i + 1]
            if home is not None and away is not None:
                match_no += 1
                round1.append(
                    Match(
                        round_no=1, match_no=match_no,
                        home_team=home, away_team=away,
                        home_source={"type": "team", "team_id": str(home.id)},
                        away_source={"type": "team", "team_id": str(away.id)},
                        **common,
                    )
                )
                slots.append({"match": round1[-1]})
            else:
                slots.append({"team": home or away})  # bye → advances directly
        Match.objects.bulk_create(round1)
        created.extend(round1)

        def _side(slot: dict) -> tuple:
            """(team_id, source) for a bracket slot."""
            if "team" in slot:
                tm = slot["team"]
                return tm.id, {"type": "team", "team_id": str(tm.id)}
            return None, {"type": "winner_of", "match_id": str(slot["match"].id)}

        round_no = 2
        while len(slots) > 1:
            nxt_matches: list[Match] = []
            nxt_slots: list[dict] = []
            if third_place and len(slots) == 2 \
                    and all("match" in s for s in slots):
                # 3rd-place playoff between the semifinal losers, placed
                # before the final in match order (spec §4.4).
                match_no += 1
                nxt_matches.append(
                    Match(
                        round_no=round_no, match_no=match_no,
                        group_label="3rd Place",
                        home_source={
                            "type": "loser_of",
                            "match_id": str(slots[0]["match"].id),
                        },
                        away_source={
                            "type": "loser_of",
                            "match_id": str(slots[1]["match"].id),
                        },
                        **common,
                    )
                )
            for i in range(0, len(slots), 2):
                match_no += 1
                home_id, home_src = _side(slots[i])
                away_id, away_src = _side(slots[i + 1])
                nxt_matches.append(
                    Match(
                        round_no=round_no, match_no=match_no,
                        home_team_id=home_id, away_team_id=away_id,
                        home_source=home_src, away_source=away_src,
                        **common,
                    )
                )
                nxt_slots.append({"match": nxt_matches[-1]})
            Match.objects.bulk_create(nxt_matches)
            created.extend(nxt_matches)
            slots = nxt_slots
            round_no += 1

    return created


def _cross_seed(quals: list[list[str]]) -> list[str]:
    """Strength-ordered seed list for groups→knockout that the seeded bracket
    (1 meets the lowest seed, 2 the next-lowest, …) turns into CROSS-GROUP
    round-1 pairs. Layered: all group winners (seeds 1..n in group order),
    then all runners-up, then thirds, … Within the winners-vs-lowest-layer
    pairing this meets w_i with the runner-up of a DIFFERENT group for even
    group counts; a final repair pass swaps within a layer to fix the
    leftover same-group pair odd group counts produce.

    (The previous interleaved list [w0, r1, w1, r0] read as strength order
    placed w0 vs r0 and w1 vs r1 in the semis — same-group rematches, the
    opposite of the intended FIFA-style crossing.)
    """
    n = len(quals)
    k = max(len(q) for q in quals)
    layers: list[list[str]] = [
        [q[p] for q in quals if p < len(q)] for p in range(k)
    ]
    seeds: list[str] = [tid for layer in layers for tid in layer]

    group_of = {tid: gi for gi, q in enumerate(quals) for tid in q}
    pairs = _opening_pairs_bracket(len(seeds))

    def same_group(i: int, j: int) -> bool:
        return (
            i < len(seeds) and j < len(seeds)
            and group_of[seeds[i]] == group_of[seeds[j]]
        )

    for i, j in pairs:
        if not same_group(i, j):
            continue
        # Swap seeds[j] with another same-layer seed whose pair stays clean.
        for a, b in pairs:
            for cand, partner in ((a, b), (b, a)):
                if cand in (i, j) or cand >= len(seeds):
                    continue
                seeds[j], seeds[cand] = seeds[cand], seeds[j]
                if not same_group(i, j) and not same_group(cand, partner):
                    break
                seeds[j], seeds[cand] = seeds[cand], seeds[j]  # undo
            else:
                continue
            break
    return seeds


def generate_knockout_from_groups(
    *, tournament, advance_per_group: int = 2, leaf_key: str | None = None,
    third_place: bool = False,
) -> list[Match]:
    """Advance the top ``advance_per_group`` of each group into a single-
    elimination bracket (FIFA-style groups → knockout), cross-seeding winners
    against other groups' runners-up. Leaf-aware: with ``leaf_key`` only that
    competition's groups feed its own bracket. Idempotent per leaf scope."""
    from apps.matches.services.standings import compute_standings

    if advance_per_group < 1:
        raise ValueError("advance_per_group must be at least 1.")

    ko_scope = Match.objects.filter(
        tournament=tournament, stage="knockout", deleted_at__isnull=True
    )
    if leaf_key:
        ko_scope = ko_scope.filter(leaf_key=leaf_key)
    existing = list(ko_scope)
    if existing:
        return existing

    group_scope = Match.objects.filter(
        tournament=tournament, stage="group", deleted_at__isnull=True
    )
    if leaf_key:
        group_scope = group_scope.filter(leaf_key=leaf_key)
    groups = sorted(
        g for g in group_scope.values_list("group_label", flat=True).distinct() if g
    )
    if not groups:
        raise ValueError("No group stage to advance from.")

    quals: list[list[str]] = []
    for g in groups:
        rows = compute_standings(tournament, group_label=g)
        ids = [r["team_id"] for r in rows[:advance_per_group]]
        if len(ids) < advance_per_group:
            raise ValueError(
                f"Group {g} hasn't finished enough matches to advance "
                f"{advance_per_group} team(s)."
            )
        quals.append(ids)

    if len(groups) == 1:
        # A single group (e.g. one category leaf) → its top teams seed the
        # bracket directly in standings order.
        seed_ids = quals[0]
        if len(seed_ids) < 2:
            raise ValueError("Need at least 2 advancing teams for a knockout.")
    else:
        seed_ids = _cross_seed(quals)

    teams = [Team.objects.get(id=tid) for tid in seed_ids]
    return generate_single_elimination(
        tournament=tournament, teams=teams, stage="knockout",
        leaf_key=leaf_key or "", third_place=third_place,
    )
