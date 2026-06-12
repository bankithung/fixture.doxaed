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
import json
import random
from dataclasses import dataclass

from django.db import transaction

from apps.matches.models import Match, MatchStatus
from apps.teams.models import Team, TeamStatus
from apps.tournaments.services.sports import leaf_label, sport_for_leaf

_GROUP_LABELS = [chr(ord("A") + i) for i in range(26)]


@dataclass
class MatchPlan:
    """One planned match from the pure pairing core (redesign spec §4.1) —
    exactly what the persistence wrapper (or the preview endpoint) needs,
    with no DB identity. ``ref`` is the plan's stable handle within a run;
    cross-plan bracket pointers use ``{"type": "winner_of"|"loser_of",
    "ref": <plan ref>}`` and the wrapper rewrites them into real match-id
    pointers on persist."""

    stage: str
    round_no: int
    group_label: str = ""
    leaf_key: str = ""
    sport: str = ""
    home_team_id: object | None = None
    away_team_id: object | None = None
    home_source: dict | None = None
    away_source: dict | None = None
    inputs_hash: str = ""
    ref: int = 0


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


def _new_seed() -> int:
    """A fresh RNG seed for a random draw — persisted so the draw is
    replayable and disputable (redesign spec §4.3, tenet 3)."""
    return random.SystemRandom().randrange(1, 2**31)


def _seed_order(teams: list, *, seeding: str, seed: int | None) -> list:
    """Order entrants per the seeding method (spec §4.3).

    - ``registration`` (default) and ``snake`` keep the registration order
      (seed field, then name) — snake is a GROUP-DISTRIBUTION rule, not an
      entrant order (and for knockouts the standard seeded bracket already IS
      the snake placement, so it aliases to registration order there).
    - ``random``: ``random.Random(seed)`` shuffle (caller resolves the seed).
    - ``seeded``: strict ``Team.seed`` order; every team must carry one.
    """
    if seeding == "random":
        out = list(teams)
        random.Random(seed).shuffle(out)
        return out
    if seeding == "seeded":
        missing = sorted(t.name for t in teams if t.seed is None)
        if missing:
            raise ValueError(
                "seeding is 'seeded' but these teams have no seed: "
                + ", ".join(missing)
            )
        return sorted(teams, key=lambda t: (t.seed, t.name))
    if seeding not in ("", "registration", "snake"):
        raise ValueError(f"unknown seeding method: {seeding!r}")
    return list(teams)


def _snake_groups(teams: list, group_size: int) -> list[list]:
    """Serpentine distribution (A,B,C,C,B,A,…) of a seed-ordered list into
    ceil(n/group_size) groups — replaces plain chunking when
    ``seeding="snake"`` (spec §4.3)."""
    n_groups = max(1, -(-len(teams) // group_size))
    groups: list[list] = [[] for _ in range(n_groups)]
    idx, step = 0, 1
    for tm in teams:
        groups[idx].append(tm)
        if not 0 <= idx + step < n_groups:
            step = -step  # bounce at the rails (the edge group repeats)
        else:
            idx += step
    return groups


def _persist_draw_seed(tournament, leaf_key: str | None, seed: int) -> None:
    """Store a freshly-generated RNG seed in ``draw_config`` (under the leaf,
    or "*" for whole-tournament runs) so the draw can be reproduced (§4.3)."""
    stored = dict(tournament.draw_config or {})
    layer = dict(stored.get(leaf_key or "*") or {})
    layer["seed"] = seed
    stored[leaf_key or "*"] = layer
    tournament.draw_config = stored
    tournament.save(update_fields=["draw_config", "updated_at"])


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


def _separate_by_key(
    teams: list[Team],
    opening_pairs: list[tuple[int, int]] | None = None,
    key_map: dict | None = None,
) -> list[Team]:
    """Spread same-KEY teams across the seeding order so they don't meet in
    the opening round and land in different round-robin pools (redesign spec
    §4.6 — the generalization of the owner W2-D school rule to the
    ``keep_apart_until_round`` key grammar).

    ``key_map`` maps team.id -> separation key; ``None`` values are EXCLUDED
    from the constraint (§9 A8 — e.g. an institution that never answered the
    district question). Without a key_map the institution is the key (the
    built-in school pass). Groups by key, deals one team per key bucket per
    pass (largest contingents first), then repairs any same-key OPENING pair
    (the format's actual round-1 pairing, passed in) by swapping with a later
    pair's slot when both pairs stay clean. Deterministic; best-effort — it
    never raises and never makes the input order worse."""
    if len(teams) < 3:
        return list(teams)

    def bucket(tm: Team) -> object:
        """Grouping key — excluded teams stay unique (their own id)."""
        if key_map is not None:
            v = key_map.get(tm.id)
            return ("k", v) if v is not None else ("u", tm.id)
        return tm.institution_id or tm.id

    def ckey(tm: Team) -> object | None:
        """Conflict key — None never conflicts."""
        if key_map is not None:
            return key_map.get(tm.id)
        return tm.institution_id

    groups: dict[object, list[Team]] = {}
    for tm in teams:
        groups.setdefault(bucket(tm), []).append(tm)
    if len(groups) == len(teams):
        return list(teams)  # all distinct keys — nothing to spread
    pools = sorted(groups.values(), key=len, reverse=True)
    out: list[Team] = []
    while any(pools):
        for g in pools:
            if g:
                out.append(g.pop(0))

    pairs = opening_pairs or [(i, i + 1) for i in range(0, len(out) - 1, 2)]

    def inst(arr: list[Team], pos: int) -> object | None:
        return ckey(arr[pos]) if pos < len(arr) else None

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
                    or ckey(out[j]) != inst(out, other)
                ):
                    out[j], out[k] = out[k], out[j]
                    fixed = True
                    break
            if fixed:
                break

    # Never make things worse: if the reshuffle still pairs more same-key
    # opening matches than the caller's own order (possible when one key
    # dominates), keep the input order — it also preserves explicit seeding.
    if opening_pairs is not None and conflicts(out) >= 1 \
            and conflicts(out) >= conflicts(list(teams)):
        return list(teams)
    return out


def _separate_institutions(
    teams: list[Team], opening_pairs: list[tuple[int, int]] | None = None
) -> list[Team]:
    """The built-in school pass (owner W2-D: "same schools should not be
    playing against each other on the first matches") — always on, no stored
    record needed. ``_separate_by_key`` with the institution as the key."""
    return _separate_by_key(teams, opening_pairs)


def _keep_apart_key_map(
    tournament, teams: list[Team], key: str, warnings: list,
) -> dict | None:
    """Resolve one ``keep_apart_until_round`` key into team.id -> separation
    key (spec §4.6 grammar): ``school`` -> institution, ``district`` -> the
    Stage-1 institution answer (attributes["district"], falling back to
    region), ``seed_pot`` -> Team.seed quartile (1-4), ``tag:<k>`` ->
    institution attribute ``k``. ``None`` values exclude the team from the
    constraint; missing data emits a NAMED warning (§9 A8), never an error."""
    from apps.teams.models import Institution

    key = str(key or "").strip()
    if key == "school":
        return {t.id: (t.institution_id or t.id) for t in teams}
    if key == "district":
        inst_ids = {t.institution_id for t in teams if t.institution_id}
        by_inst: dict[object, str] = {}
        for inst in Institution.objects.filter(id__in=inst_ids):
            district = (inst.attributes or {}).get("district") or inst.region
            if district:
                by_inst[inst.id] = str(district).strip().lower()
        out = {t.id: by_inst.get(t.institution_id) for t in teams}
        missing = sorted(t.name for t in teams if out[t.id] is None)
        if missing:
            warnings.append(
                {"code": "keep_apart_missing_district", "teams": missing}
            )
        return out
    if key == "seed_pot":
        seeded = sorted(
            (t for t in teams if t.seed is not None),
            key=lambda t: (t.seed, t.name),
        )
        out = dict.fromkeys((t.id for t in teams), None)
        for idx, t in enumerate(seeded):
            out[t.id] = 1 + (4 * idx) // len(seeded)
        missing = sorted(t.name for t in teams if t.seed is None)
        if missing:
            warnings.append({"code": "keep_apart_missing_seed", "teams": missing})
        return out
    if key.startswith("tag:"):
        tag = key[4:].strip()
        inst_ids = {t.institution_id for t in teams if t.institution_id}
        attr = {
            inst.id: (inst.attributes or {}).get(tag)
            for inst in Institution.objects.filter(id__in=inst_ids)
        }
        return {
            t.id: (
                str(attr[t.institution_id]).strip().lower()
                if t.institution_id in attr
                and attr[t.institution_id] not in (None, "")
                else None
            )
            for t in teams
        }
    warnings.append({"code": "keep_apart_unknown_key", "key": key})
    return None


def _keep_apart_separators(
    tournament, teams: list[Team], leaf_key: str, sport: str, warnings: list,
) -> list[tuple[dict, dict]]:
    """Stored ``keep_apart_until_round`` records in scope for this draw,
    resolved into (record, key_map) pairs the pure plan_* core applies after
    seeding. ``school`` records are skipped — the built-in pass already
    separates institutions."""
    from apps.fixtures.services.constraints import scope_matches

    out: list[tuple[dict, dict]] = []
    for c in tournament.constraints or []:
        if not isinstance(c, dict) or c.get("type") != "keep_apart_until_round":
            continue
        if not scope_matches(c.get("scope"), sport=sport or "",
                             leaf_key=leaf_key or ""):
            continue
        key = str((c.get("params") or {}).get("key") or "school")
        if key == "school":
            continue  # built-in
        key_map = _keep_apart_key_map(tournament, teams, key, warnings)
        if key_map:
            out.append((c, key_map))
    return out


def _warn_keep_apart_conflicts(
    record: dict, key_map: dict, teams: list[Team],
    pairs: list[tuple[int, int]], warnings: list,
) -> None:
    """Best-effort contract (§4.6): a record whose opening pairs still
    conflict after the repair pass is demoted to soft FOR THIS RUN via a
    named warning listing the surviving same-key pairs."""
    conflict_pairs = []
    for i, j in pairs:
        if i < len(teams) and j < len(teams):
            ka, kb = key_map.get(teams[i].id), key_map.get(teams[j].id)
            if ka is not None and ka == kb:
                conflict_pairs.append(sorted([teams[i].name, teams[j].name]))
    if conflict_pairs:
        warnings.append({
            "code": "keep_apart_relaxed",
            "key": (record.get("params") or {}).get("key"),
            "scope": record.get("scope", "all"),
            "pairs": sorted(conflict_pairs),
        })


def _next_match_no(tournament) -> int:
    """Continue numbering after existing LIVE rows (soft-deleted ones excluded
    — they used to inflate the count and leave gaps)."""
    return Match.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).count()


def _group_hash(group: list) -> str:
    """Per-group inputs_hash (invariant 10): sha256 of the sorted team ids."""
    return hashlib.sha256(
        ",".join(sorted(str(t.id) for t in group)).encode()
    ).hexdigest()


# Bookkeeping keys excluded from the v2 inputs hash: the replay seed is
# persisted BY generation (hashing it would flip "inputs changed" the moment
# a previewed random draw is accepted), the reviewed-at stamp is process
# state, and the wizard-saved calendar is slot-time data (§2.5 — it hashes
# into scheduling staleness, never the draw), not a generation input.
_HASH_EXCLUDED_KEYS = ("seed", "constraints_reviewed_at", "calendar")


def pairing_scope_constraints(
    tournament, leaf_key: str | None, sport: str = "",
) -> list[dict]:
    """The stored constraint records the PAIRING layer consumes for one draw
    scope (redesign §2.5) — today that is ``keep_apart_until_round`` in scope.
    Slot-time records never enter the draw hash."""
    from apps.fixtures.services.constraints import scope_matches

    if not sport and leaf_key:
        sport = sport_for_leaf(tournament.sports or [], leaf_key)
    return [
        c for c in tournament.constraints or []
        if isinstance(c, dict)
        and c.get("type") == "keep_apart_until_round"
        and scope_matches(c.get("scope"), sport=sport, leaf_key=leaf_key or "")
    ]


def compute_inputs_hash(tournament, leaf_key: str | None = None) -> str:
    """inputs_hash v2 (redesign spec §2.5, invariant 10) for one draw scope:

        sha256(sorted team ids + canonical effective draw config
               + canonical pairing-scope constraint records)

    Computed from STORED tournament state (no request overrides) so preview,
    the accept endpoints' ``expected_inputs_hash`` guard and the readiness
    staleness check all agree. Matches stamped with a v1 (team-ids-only)
    hash read as "inputs changed" — correct per spec D9."""
    from apps.fixtures.services.draw_config import effective_draw_config

    cfg = {
        k: v
        for k, v in effective_draw_config(tournament, leaf_key).items()
        if k not in _HASH_EXCLUDED_KEYS
    }
    payload = json.dumps(
        {
            "teams": sorted(
                str(t.id) for t in _registered_teams(tournament, leaf_key)
            ),
            "draw_config": cfg,
            "pairing_constraints": pairing_scope_constraints(tournament, leaf_key),
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ----------------------------------------------------------- pure pairing core
# (redesign spec §4.1) plan_* functions decide WHO plays WHOM with ZERO DB
# access; generate_* below are thin persistence wrappers. The preview endpoint
# calls plan_* directly.

def _plan_pool(
    group: list, *, label: str, leaf_key: str, sport: str, legs: int,
    small_group_max: int, start_ref: int,
    separators: list[tuple[dict, dict]] | None = None,
    warnings: list | None = None,
) -> list[MatchPlan]:
    """Circle-method plans for ONE round-robin pool (opening-pair repair,
    inputs_hash, small-group leg doubling). ``separators`` are the stored
    keep-apart records (record, key_map) applied after the built-in school
    pass (§4.6) — surviving conflicts emit a named warning."""
    pairs = _opening_pairs_circle(len(group))
    group = _separate_institutions(group, pairs)
    for _record, key_map in separators or []:
        group = _separate_by_key(group, pairs, key_map)
    for record, key_map in separators or []:
        _warn_keep_apart_conflicts(
            record, key_map, group, pairs,
            warnings if warnings is not None else [],
        )
    ih = _group_hash(group)
    group_legs = _legs_for_group(len(group), legs, small_group_max)
    plans: list[MatchPlan] = []
    for round_no, home, away in _round_robin(group, legs=group_legs):
        plans.append(
            MatchPlan(
                stage="group", group_label=label, round_no=round_no,
                leaf_key=leaf_key, sport=sport,
                home_team_id=home.id, away_team_id=away.id,
                inputs_hash=ih, ref=start_ref + len(plans),
            )
        )
    return plans


def plan_round_robin(
    teams: list, *, group_size: int = 5, leaf_key: str = "", sport: str = "",
    label_prefix: str = "", legs: int = 1, seeding: str = "registration",
    seed: int | None = None, small_group_max: int = 0,
    separators: list[tuple[dict, dict]] | None = None,
    warnings: list | None = None,
) -> list[MatchPlan]:
    """Pure pairing core for the grouped round-robin: seed order, institution
    spread, chunk/snake grouping, per-group circle pairing. Zero DB writes."""
    if len(teams) < 2:
        raise ValueError("Need at least 2 registered teams to generate fixtures.")
    teams = _seed_order(list(teams), seeding=seeding, seed=seed)
    # Constraint-repair pass AFTER seeding (§4.3): spread institutions across
    # pools — then the stored keep-apart keys (§4.6, applied last so the
    # explicit records win); each pool's circle pairing is repaired again in
    # _plan_pool once group membership is known.
    teams = _separate_institutions(teams)
    for _record, key_map in separators or []:
        teams = _separate_by_key(teams, None, key_map)
    if seeding == "snake":
        groups = _snake_groups(teams, group_size)
    else:
        groups = [
            teams[i : i + group_size] for i in range(0, len(teams), group_size)
        ]
    plans: list[MatchPlan] = []
    for gi, group in enumerate(groups):
        label = f"{label_prefix}Group {_GROUP_LABELS[gi]}"[:80]
        plans.extend(
            _plan_pool(
                group, label=label, leaf_key=leaf_key, sport=sport, legs=legs,
                small_group_max=small_group_max, start_ref=len(plans),
                separators=separators, warnings=warnings,
            )
        )
    return plans


def plan_round_robin_pool(
    teams: list, *, label: str, leaf_key: str = "", sport: str = "",
    legs: int = 1, seeding: str = "registration", seed: int | None = None,
    small_group_max: int = 0, start_ref: int = 0,
    separators: list[tuple[dict, dict]] | None = None,
    warnings: list | None = None,
) -> list[MatchPlan]:
    """Pure pairing core for ONE category bucket (by-category round-robin):
    seed order within the bucket, opening-pair repair, circle pairing. Zero
    DB writes."""
    teams = _seed_order(list(teams), seeding=seeding, seed=seed)
    return _plan_pool(
        teams, label=label, leaf_key=leaf_key, sport=sport, legs=legs,
        small_group_max=small_group_max, start_ref=start_ref,
        separators=separators, warnings=warnings,
    )


def plan_single_elimination(
    teams: list, *, stage: str = "knockout", leaf_key: str = "",
    sport: str = "", third_place: bool = False,
    seeding: str = "registration", seed: int | None = None,
    separators: list[tuple[dict, dict]] | None = None,
    warnings: list | None = None,
) -> list[MatchPlan]:
    """Pure pairing core for a single-elimination bracket (byes, winner_of /
    loser_of pointers as plan refs, optional 3rd-place playoff — §4.4). Zero
    DB writes."""
    n = len(teams)
    if n < 2:
        raise ValueError("single elimination requires at least 2 teams")

    teams = _seed_order(list(teams), seeding=seeding, seed=seed)
    # Constraint repair AFTER seeding (§4.3): same-institution teams don't
    # meet in round 1 where avoidable (W2-D), then the stored keep-apart
    # keys (§4.6) — surviving conflicts emit a named warning, never an error.
    pairs = _opening_pairs_bracket(n)
    teams = _separate_institutions(list(teams), pairs)
    for _record, key_map in separators or []:
        teams = _separate_by_key(teams, pairs, key_map)
    for record, key_map in separators or []:
        _warn_keep_apart_conflicts(
            record, key_map, teams, pairs,
            warnings if warnings is not None else [],
        )

    size = 1
    while size < n:
        size *= 2
    entrants = [teams[s - 1] if s <= n else None for s in _bracket_order(size)]

    common = {"stage": stage, "leaf_key": leaf_key, "sport": sport}
    plans: list[MatchPlan] = []
    # Round 1: pairs with two teams play; a pair with a bye forwards its team
    # straight to round 2 as a concrete slot.
    slots: list[dict] = []  # {"plan": ref} or {"team": Team}
    for i in range(0, size, 2):
        home, away = entrants[i], entrants[i + 1]
        if home is not None and away is not None:
            plans.append(
                MatchPlan(
                    round_no=1,
                    home_team_id=home.id, away_team_id=away.id,
                    home_source={"type": "team", "team_id": str(home.id)},
                    away_source={"type": "team", "team_id": str(away.id)},
                    ref=len(plans), **common,
                )
            )
            slots.append({"plan": plans[-1].ref})
        else:
            slots.append({"team": home or away})  # bye → advances directly

    def _side(slot: dict) -> tuple:
        """(team_id, source) for a bracket slot."""
        if "team" in slot:
            tm = slot["team"]
            return tm.id, {"type": "team", "team_id": str(tm.id)}
        return None, {"type": "winner_of", "ref": slot["plan"]}

    round_no = 2
    while len(slots) > 1:
        nxt_slots: list[dict] = []
        if third_place and len(slots) == 2 \
                and all("plan" in s for s in slots):
            # 3rd-place playoff between the semifinal losers, placed before
            # the final in match order (spec §4.4).
            plans.append(
                MatchPlan(
                    round_no=round_no, group_label="3rd Place",
                    home_source={"type": "loser_of", "ref": slots[0]["plan"]},
                    away_source={"type": "loser_of", "ref": slots[1]["plan"]},
                    ref=len(plans), **common,
                )
            )
        for i in range(0, len(slots), 2):
            home_id, home_src = _side(slots[i])
            away_id, away_src = _side(slots[i + 1])
            plans.append(
                MatchPlan(
                    round_no=round_no,
                    home_team_id=home_id, away_team_id=away_id,
                    home_source=home_src, away_source=away_src,
                    ref=len(plans), **common,
                )
            )
            nxt_slots.append({"plan": plans[-1].ref})
        slots = nxt_slots
        round_no += 1
    return plans


def _plate_label(sports_cfg, leaf_key: str | None) -> str:
    """``"<leaf> — Plate"`` (increment M) — the same label grammar the grouped
    round-robin prefix uses; plain ``"Plate"`` for whole-tournament draws."""
    if leaf_key:
        return f"{leaf_label(sports_cfg, leaf_key)} — Plate"[:80]
    return "Plate"


def plan_plate(
    sources: list[dict], *, leaf_key: str = "", sport: str = "",
    label: str = "Plate", start_ref: int = 0,
) -> list[MatchPlan]:
    """Pure pairing core for the consolation plate (increment M): a single-
    elimination bracket whose ENTRANTS are ``loser_of`` pointers at the main
    bracket's round-1 matches (plan refs or real match ids — advance.py
    resolves either as results land, invariant 9). Non-power-of-2 source
    counts get byes: the spare pointer forwards straight to round 2 untouched.
    Zero DB writes."""
    n = len(sources)
    if n < 2:
        raise ValueError("plate requires at least 2 round-1 loser sources")
    size = 1
    while size < n:
        size *= 2
    entrants = [sources[s - 1] if s <= n else None for s in _bracket_order(size)]

    common = {"stage": "plate", "group_label": label,
              "leaf_key": leaf_key, "sport": sport}
    plans: list[MatchPlan] = []
    # {"plan": ref} or {"src": <loser_of pointer>} (a bye forwards the pointer)
    slots: list[dict] = []
    for i in range(0, size, 2):
        home, away = entrants[i], entrants[i + 1]
        if home is not None and away is not None:
            plans.append(
                MatchPlan(
                    round_no=1, home_source=home, away_source=away,
                    ref=start_ref + len(plans), **common,
                )
            )
            slots.append({"plan": plans[-1].ref})
        else:
            slots.append({"src": home or away})

    def _side(slot: dict) -> dict:
        if "src" in slot:
            return slot["src"]
        return {"type": "winner_of", "ref": slot["plan"]}

    round_no = 2
    while len(slots) > 1:
        nxt_slots: list[dict] = []
        for i in range(0, len(slots), 2):
            plans.append(
                MatchPlan(
                    round_no=round_no,
                    home_source=_side(slots[i]), away_source=_side(slots[i + 1]),
                    ref=start_ref + len(plans), **common,
                )
            )
            nxt_slots.append({"plan": plans[-1].ref})
        slots = nxt_slots
        round_no += 1
    return plans


def plan_plate_for_plans(
    main_plans: list[MatchPlan], *, leaf_key: str = "", sport: str = "",
    label: str = "Plate", warnings: list | None = None,
) -> list[MatchPlan]:
    """Plate plans over a freshly-planned main bracket (the fresh-generation
    and preview paths): sources are plan REFS at the round-1 plans pairing two
    concrete teams — a bye pair emits no round-1 plan, so its loser slot never
    exists. Under 2 sources the plate is skipped with a named warning (i18n
    code — §9 A5), never an error."""
    sources = [
        {"type": "loser_of", "ref": p.ref}
        for p in main_plans
        if p.round_no == 1 and p.stage != "plate"
        and p.home_team_id is not None and p.away_team_id is not None
    ]
    if len(sources) < 2:
        if warnings is not None:
            warnings.append({
                "code": "plate_skipped_insufficient_sources",
                "leaf_key": leaf_key, "sources": len(sources),
            })
        return []
    return plan_plate(
        sources, leaf_key=leaf_key, sport=sport, label=label,
        start_ref=len(main_plans),
    )


def generate_plate(
    *, tournament, leaf_key: str = "", main_stage: str = "knockout",
    warnings: list | None = None,
) -> list[Match]:
    """Consolation plate over an EXISTING main bracket (increment M): a
    second-chance single-elimination for the round-1 losers, filled by
    advance.py through ``loser_of`` pointers as results land. Idempotent per
    (stage="plate", leaf). Round-1 byes in the main bracket mean that pair's
    loser slot is empty, so the plate draws only over round-1 matches pairing
    two concrete teams; under 2 sources it is skipped with a named warning.
    Results that already landed backfill immediately."""
    existing = list(
        Match.objects.filter(
            tournament=tournament, stage="plate", leaf_key=leaf_key or "",
            deleted_at__isnull=True,
        )
    )
    if existing:
        return existing

    warnings = [] if warnings is None else warnings
    r1 = list(
        Match.objects.filter(
            tournament=tournament, stage=main_stage, leaf_key=leaf_key or "",
            round_no=1, deleted_at__isnull=True,
            home_team__isnull=False, away_team__isnull=False,
        ).order_by("match_no")
    )
    sources = [{"type": "loser_of", "match_id": str(m.id)} for m in r1]
    if len(sources) < 2:
        warnings.append({
            "code": "plate_skipped_insufficient_sources",
            "leaf_key": leaf_key or "", "sources": len(sources),
        })
        return []

    plans = plan_plate(
        sources, leaf_key=leaf_key or "", sport=r1[0].sport,
        label=_plate_label(tournament.sports or [], leaf_key or None),
    )
    ih = compute_inputs_hash(tournament, leaf_key or None)  # v2 hash (§2.5)
    for p in plans:
        p.inputs_hash = ih
    with transaction.atomic():
        created = _persist_plans(tournament, plans)
    # Retro-fit: advance_from_match re-resolves dependents, so round-1
    # results that landed BEFORE the plate existed fill it right away.
    from apps.fixtures.services.advance import advance_from_match

    final = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)
    for m in r1:
        if m.status in final:
            advance_from_match(m.id)
    return created


def _resolve_source(src: dict | None, matches: list[Match]) -> dict | None:
    """Rewrite a plan-ref bracket pointer into a real match-id pointer
    (invariant 9 typed references). Refs always point at earlier plans, so
    the target Match instance already exists (UUIDs are client-side)."""
    if src and "ref" in src:
        return {"type": src["type"], "match_id": str(matches[src["ref"]].id)}
    return src


def _persist_plans(tournament, plans: list[MatchPlan]) -> list[Match]:
    """Persistence wrapper for the pure pairing core: plans → Match rows with
    match_no continuation, SCHEDULED status and ref→match_id pointer rewrite —
    exactly as the legacy inline creation did. The caller wraps this in a
    transaction and has already enforced idempotency."""
    org = tournament.organization
    match_no = _next_match_no(tournament)
    matches: list[Match] = []
    for p in plans:
        match_no += 1
        m = Match(
            organization=org, tournament=tournament, stage=p.stage,
            group_label=p.group_label, sport=p.sport, leaf_key=p.leaf_key,
            round_no=p.round_no, match_no=match_no,
            home_team_id=p.home_team_id, away_team_id=p.away_team_id,
            status=MatchStatus.SCHEDULED, inputs_hash=p.inputs_hash,
        )
        home_src = _resolve_source(p.home_source, matches)
        away_src = _resolve_source(p.away_source, matches)
        if home_src is not None:
            m.home_source = home_src
        if away_src is not None:
            m.away_source = away_src
        matches.append(m)
    Match.objects.bulk_create(matches)
    return matches


def generate_round_robin(
    *, tournament, group_size: int = 5, leaf_key: str | None = None,
    legs: int = 1, seeding: str = "registration", seed: int | None = None,
    warnings: list | None = None,
) -> list[Match]:
    """Split registered teams into groups of ``group_size`` and round-robin each
    group. With ``leaf_key``, only that competition's teams are drawn and the
    idempotency check is scoped to it; otherwise the legacy whole-tournament
    behavior applies. Group membership lives on Match.group_label — Team.pool
    (the registered category) is never touched. ``legs=2`` doubles every
    group's cycle (mirrored, spec §4.2); rules.small_group_double_rr doubles
    only the groups at/under its max_size. Thin persistence wrapper over
    ``plan_round_robin`` (spec §4.1)."""
    existing_scope = Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    if leaf_key:
        existing_scope = existing_scope.filter(leaf_key=leaf_key)
    existing = list(existing_scope)
    if existing:
        return existing  # idempotent — this scope is already generated

    teams = _registered_teams(tournament, leaf_key)
    if len(teams) < 2:
        raise ValueError("Need at least 2 registered teams to generate fixtures.")
    warnings = [] if warnings is None else warnings
    generated_seed: int | None = None
    if seeding == "random" and seed is None:
        seed = generated_seed = _new_seed()

    sports_cfg = tournament.sports or []
    sport = sport_for_leaf(sports_cfg, leaf_key or "")
    plans = plan_round_robin(
        teams,
        group_size=group_size,
        leaf_key=leaf_key or "",
        sport=sport,
        label_prefix=f"{leaf_label(sports_cfg, leaf_key)} — " if leaf_key else "",
        legs=legs, seeding=seeding, seed=seed,
        small_group_max=_small_group_max(tournament),
        separators=_keep_apart_separators(
            tournament, teams, leaf_key or "", sport, warnings,
        ),
        warnings=warnings,
    )
    ih = compute_inputs_hash(tournament, leaf_key)  # v2 hash (§2.5)
    for p in plans:
        p.inputs_hash = ih
    with transaction.atomic():
        created = _persist_plans(tournament, plans)
        if generated_seed is not None:
            _persist_draw_seed(tournament, leaf_key, generated_seed)
    return created


def _plan_by_category(
    tournament, leaf_key: str | None, *, legs: int = 1,
    seeding: str = "registration", seed: int | None = None,
    warnings: list | None = None,
) -> tuple[list[MatchPlan], list[Match]]:
    """The pure planning core of ``generate_round_robin_by_category`` (also
    the preview endpoint's path — spec §5.2): bucket registered teams per
    competition, skip buckets that already have matches (per-bucket
    idempotency), plan the rest. Returns ``(plans, skipped_existing)``.
    Read-only — zero writes."""
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
    small_max = _small_group_max(tournament)
    warnings = [] if warnings is None else warnings
    plans: list[MatchPlan] = []
    skipped_existing: list[Match] = []
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
        sport_key = (
            sport_for_leaf(sports_cfg, bucket) or group[0].sport
            if is_leaf
            else group[0].sport
        )
        before = len(plans)
        plans.extend(
            plan_round_robin_pool(
                group, label=label, leaf_key=bucket if is_leaf else "",
                sport=sport_key, legs=legs, seeding=seeding, seed=seed,
                small_group_max=small_max, start_ref=len(plans),
                separators=_keep_apart_separators(
                    tournament, group, bucket if is_leaf else "", sport_key,
                    warnings,
                ),
                warnings=warnings,
            )
        )
        if is_leaf:
            # v2 hash (§2.5) per competition scope; legacy ""-leaf buckets
            # keep the plan's team-ids hash (no leaf scope to key on).
            ih = compute_inputs_hash(tournament, bucket)
            for p in plans[before:]:
                p.inputs_hash = ih
    return plans, skipped_existing


def generate_round_robin_by_category(
    *, tournament, leaf_key: str | None = None, legs: int = 1,
    seeding: str = "registration", seed: int | None = None,
    warnings: list | None = None,
) -> list[Match]:
    """Round-robin WITHIN each competition (category leaf): a team only plays
    others registered into the SAME leaf. Buckets key on the structural
    ``Team.leaf_key`` (falling back to the legacy ``pool`` label); idempotency
    is PER BUCKET, so each competition generates independently — pass
    ``leaf_key`` to draw exactly one. Buckets with <2 teams are skipped.
    ``legs=2`` doubles each bucket's cycle (mirrored, spec §4.2);
    rules.small_group_double_rr doubles only buckets at/under its max_size.
    Thin persistence wrapper over ``_plan_by_category`` (spec §4.1)."""
    warnings = [] if warnings is None else warnings
    generated_seed: int | None = None
    if seeding == "random" and seed is None:
        seed = generated_seed = _new_seed()
    plans, skipped_existing = _plan_by_category(
        tournament, leaf_key, legs=legs, seeding=seeding, seed=seed,
        warnings=warnings,
    )
    if not plans and not skipped_existing:
        raise ValueError("No category has 2+ teams to schedule.")
    with transaction.atomic():
        created = _persist_plans(tournament, plans)
        if generated_seed is not None and created:
            _persist_draw_seed(tournament, leaf_key, generated_seed)
    return [*skipped_existing, *created]


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
    plate: bool = False, seeding: str = "registration", seed: int | None = None,
    warnings: list | None = None,
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
    playoff is emitted.

    ``plate`` (increment M): also draw a consolation single-elimination over
    the round-1 losers — ``stage="plate"`` matches sourced from ``loser_of``
    pointers, skipped with a named warning when fewer than 2 round-1 pairs
    hold two concrete teams. Idempotent per (stage, leaf), so a plate can be
    retro-fitted onto an existing bracket.

    Thin persistence wrapper over ``plan_single_elimination`` (spec §4.1)."""
    if len(teams) < 2:
        raise ValueError("single elimination requires at least 2 teams")

    existing = list(
        Match.objects.filter(
            tournament=tournament, stage=stage, leaf_key=leaf_key or "",
            deleted_at__isnull=True,
        )
    )
    if existing:
        if plate:
            return [*existing, *generate_plate(
                tournament=tournament, leaf_key=leaf_key, main_stage=stage,
                warnings=warnings,
            )]
        return existing

    if not sport and leaf_key:
        sport = sport_for_leaf(tournament.sports or [], leaf_key)

    warnings = [] if warnings is None else warnings
    generated_seed: int | None = None
    if seeding == "random" and seed is None:
        seed = generated_seed = _new_seed()
    plans = plan_single_elimination(
        list(teams), stage=stage, leaf_key=leaf_key or "", sport=sport,
        third_place=third_place, seeding=seeding, seed=seed,
        separators=_keep_apart_separators(
            tournament, list(teams), leaf_key or "", sport, warnings,
        ),
        warnings=warnings,
    )
    if plate:
        plans = plans + plan_plate_for_plans(
            plans, leaf_key=leaf_key or "", sport=sport,
            label=_plate_label(tournament.sports or [], leaf_key or None),
            warnings=warnings,
        )
    ih = compute_inputs_hash(tournament, leaf_key or None)  # v2 hash (§2.5)
    for p in plans:
        p.inputs_hash = ih
    with transaction.atomic():
        created = _persist_plans(tournament, plans)
        if generated_seed is not None:
            _persist_draw_seed(tournament, leaf_key, generated_seed)
    return created


def _norm_rates(row: dict) -> tuple[float, float, float]:
    """Per-game (points, GD, GF) rates from a standings row — cross-group
    comparisons normalize by matches played because group sizes may differ
    (increment N): 3 points over 2 games outranks 4 points over 3."""
    p = row["P"] or 1
    return (row["Pts"] / p, row["GD"] / p, row["GF"] / p)


def _cross_seed(
    quals: list[list[str]], extra: list[tuple[str, int]] | None = None,
) -> list[str]:
    """Strength-ordered seed list for groups→knockout that the seeded bracket
    (1 meets the lowest seed, 2 the next-lowest, …) turns into CROSS-GROUP
    round-1 pairs. Layered: all group winners (seeds 1..n in group order),
    then all runners-up, then thirds, … Within the winners-vs-lowest-layer
    pairing this meets w_i with the runner-up of a DIFFERENT group for even
    group counts; a final repair pass swaps within a layer to fix the
    leftover same-group pair odd group counts produce.

    ``extra`` (increment N): best-next-placed qualifiers as ``(team_id,
    group_index)``, already strength-ordered — appended as the bottom layer
    and covered by the same-group repair pass.

    (The previous interleaved list [w0, r1, w1, r0] read as strength order
    placed w0 vs r0 and w1 vs r1 in the semis — same-group rematches, the
    opposite of the intended FIFA-style crossing.)
    """
    k = max(len(q) for q in quals)
    layers: list[list[str]] = [
        [q[p] for q in quals if p < len(q)] for p in range(k)
    ]
    if extra:
        layers.append([tid for tid, _gi in extra])
    seeds: list[str] = [tid for layer in layers for tid in layer]

    group_of = {tid: gi for gi, q in enumerate(quals) for tid in q}
    group_of.update(dict(extra or []))
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


def plan_knockout_qualifiers(
    tournament, *, advance_per_group: int = 2, leaf_key: str | None = None,
    advance_best_thirds: int = 0, warnings: list | None = None,
) -> list[Team]:
    """Standings-ordered qualifier list for groups→knockout (shared with the
    preview endpoint — spec §5.2): top ``advance_per_group`` per group,
    cross-seeded across groups. Read-only; raises ValueError while groups
    are unfinished.

    ``advance_best_thirds`` (increment N): also qualify the best N
    NEXT-PLACED teams — position ``advance_per_group + 1`` in each group —
    ranked cross-group by per-game points/GD/GF (``_norm_rates``; group sizes
    may differ) and appended as the bottom seed layer before cross-seeding.
    Unequal group sizes emit a named normalization warning."""
    from apps.matches.services.standings import compute_standings

    if advance_per_group < 1:
        raise ValueError("advance_per_group must be at least 1.")
    if advance_best_thirds < 0:
        raise ValueError("advance_best_thirds must be 0 or more.")
    warnings = [] if warnings is None else warnings

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
    sizes: dict[str, int] = {}
    candidates: list[tuple[tuple, str, int]] = []  # (rank key, team_id, group)
    for gi, g in enumerate(groups):
        rows = compute_standings(tournament, group_label=g)
        sizes[g] = len(rows)
        ids = [r["team_id"] for r in rows[:advance_per_group]]
        if len(ids) < advance_per_group:
            raise ValueError(
                f"Group {g} hasn't finished enough matches to advance "
                f"{advance_per_group} team(s)."
            )
        quals.append(ids)
        if advance_best_thirds and len(rows) > advance_per_group:
            row = rows[advance_per_group]  # position advance_per_group + 1
            ppg, gdpg, gfpg = _norm_rates(row)
            candidates.append(
                ((-ppg, -gdpg, -gfpg, row["name"]), row["team_id"], gi)
            )

    extra: list[tuple[str, int]] = []
    if advance_best_thirds:
        if len(candidates) < advance_best_thirds:
            raise ValueError(
                f"advance_best_thirds is {advance_best_thirds} but only "
                f"{len(candidates)} group(s) have a team at position "
                f"{advance_per_group + 1}."
            )
        if len(set(sizes.values())) > 1:
            warnings.append({
                "code": "best_thirds_unequal_groups", "group_sizes": sizes,
            })
        candidates.sort(key=lambda c: c[0])
        extra = [(tid, gi) for _key, tid, gi in candidates[:advance_best_thirds]]

    if len(groups) == 1:
        # A single group (e.g. one category leaf) → its top teams seed the
        # bracket directly in standings order.
        seed_ids = quals[0] + [tid for tid, _gi in extra]
        if len(seed_ids) < 2:
            raise ValueError("Need at least 2 advancing teams for a knockout.")
    else:
        seed_ids = _cross_seed(quals, extra=extra)
    return [Team.objects.get(id=tid) for tid in seed_ids]


def generate_knockout_from_groups(
    *, tournament, advance_per_group: int = 2, leaf_key: str | None = None,
    third_place: bool = False, plate: bool = False,
    advance_best_thirds: int = 0, warnings: list | None = None,
) -> list[Match]:
    """Advance the top ``advance_per_group`` of each group into a single-
    elimination bracket (FIFA-style groups → knockout), cross-seeding winners
    against other groups' runners-up. Leaf-aware: with ``leaf_key`` only that
    competition's groups feed its own bracket. Idempotent per leaf scope.
    ``plate`` (increment M) adds the round-1 losers' consolation bracket;
    ``advance_best_thirds`` (increment N) appends the best N next-placed
    teams to the qualifier pool (per-game normalized ranking)."""
    ko_scope = Match.objects.filter(
        tournament=tournament, stage="knockout", deleted_at__isnull=True
    )
    if leaf_key:
        ko_scope = ko_scope.filter(leaf_key=leaf_key)
    existing = list(ko_scope)
    if existing:
        if plate:
            return [*existing, *generate_plate(
                tournament=tournament, leaf_key=leaf_key or "",
                warnings=warnings,
            )]
        return existing

    teams = plan_knockout_qualifiers(
        tournament, advance_per_group=advance_per_group, leaf_key=leaf_key,
        advance_best_thirds=advance_best_thirds, warnings=warnings,
    )
    return generate_single_elimination(
        tournament=tournament, teams=teams, stage="knockout",
        leaf_key=leaf_key or "", third_place=third_place, plate=plate,
        warnings=warnings,
    )
