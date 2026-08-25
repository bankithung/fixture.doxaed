"""Medal tally configuration: the points ladder, the category groups, the
host's hand-set placings.

Spec: docs/superpowers/specs/2026-08-25-results-medal-tally-design.md.

Awards config lives in ``Tournament.awards`` and NOT in ``Tournament.rules``,
which freezes at ``registration_open`` (invariant 7) and never thaws. A points
ladder the host cannot change on the morning of the meet is the opposite of
what was asked for, and a ladder decides a trophy rather than a result, so the
freeze is not the right gate for it. Everything here is therefore editable for
the life of the tournament, audited on every write.

Nothing in this module knows what a sport, an age band or a gender is. A
competition is named by a leaf key or a leaf-key PREFIX and matched
segment-aligned by ``sports.leaf_matches_prefix`` — the same resolver per-court
reservations, ``competition_priority`` and ``phased_finish`` use — so "weight
the sepak takraw medals double" and "the U-14 boys champion" are both authored
data, not code.
"""
from __future__ import annotations

import copy
import re
from typing import Any

#: The ladder the owner asked for: 5 / 3 / 2 (2026-08-25). It is a LIST rather
#: than a ``{place: points}`` map so a meet that scores the top six needs no
#: schema change — it adds two rows.
DEFAULT_LADDER: list[dict] = [
    {"place": 1, "points": 5, "label": "Gold"},
    {"place": 2, "points": 3, "label": "Silver"},
    {"place": 3, "points": 2, "label": "Bronze"},
]

DEFAULT_AWARDS: dict[str, Any] = {
    # The whole feature is opt-in: a tournament that never authored a ladder
    # gets no Results tab rather than an empty grid.
    "enabled": False,
    "ladder": DEFAULT_LADDER,
    # Per-competition ladders: [{"match": <leaf key or prefix>, "ladder": [...]}].
    # Most specific match wins, exactly like every other prefix rule.
    "by_competition": [],
    # What happens to bronze when a knockout has NO third-place playoff.
    # "shared" = both losing semi-finalists take 3rd (the racket-sport norm);
    # "none" = the competition awards no bronze at all.
    "bronze": "shared",
    # Category groups a champion is named for. An empty `include` means EVERY
    # competition, which is how "Overall" is expressed without a special case.
    "groups": [],
    # Placings the host set by hand. These REPLACE the derived placing for
    # their (leaf_key, place) — the escape hatch for an event the fixture never
    # saw (an athletics final) and for a mis-scored result on the day.
    "overrides": [],
}

_BRONZE_MODES = ("shared", "none")
_DECIDE_MODES = ("points", "golds")
#: Ordinal labels for places the ladder did not name.
_ORDINALS = {1: "1st", 2: "2nd", 3: "3rd"}


def place_label(place: int, ladder: list[dict] | None = None) -> str:
    """The word for a place — the ladder's own label when it named one."""
    for row in ladder or []:
        if int(row.get("place", 0)) == place and (row.get("label") or "").strip():
            return str(row["label"]).strip()
    return _ORDINALS.get(place, f"{place}th")


def _slug(value: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")
    return out[:48]


def _clean_ladder(raw: Any, *, where: str) -> list[dict]:
    """Validate one points ladder: unique places from 1 up, non-negative
    points. Ordered by place, so every reader can trust the first row is the
    winner without sorting again."""
    if not isinstance(raw, list):
        raise ValueError(f"{where}_must_be_a_list")
    out: list[dict] = []
    seen: set[int] = set()
    for row in raw:
        if not isinstance(row, dict):
            raise ValueError(f"{where}_row_must_be_an_object")
        try:
            place = int(row.get("place"))
        except (TypeError, ValueError):
            raise ValueError(f"{where}_place_must_be_a_number") from None
        if place < 1 or place > 50:
            raise ValueError(f"{where}_place_out_of_range")
        if place in seen:
            raise ValueError(f"{where}_duplicate_place")
        seen.add(place)
        try:
            points = float(row.get("points", 0))
        except (TypeError, ValueError):
            raise ValueError(f"{where}_points_must_be_a_number") from None
        if points < 0:
            raise ValueError(f"{where}_points_must_not_be_negative")
        # An integer ladder stays integer on the wire: 5 not 5.0, because the
        # tally prints these and "5.0 points" reads like a bug.
        out.append({
            "place": place,
            "points": int(points) if float(points).is_integer() else round(points, 2),
            "label": str(row.get("label") or "").strip()[:32],
        })
    return sorted(out, key=lambda r: r["place"])


def _clean_groups(raw: Any) -> list[dict]:
    if not isinstance(raw, list):
        raise ValueError("groups_must_be_a_list")
    out: list[dict] = []
    keys: set[str] = set()
    for g in raw:
        if not isinstance(g, dict):
            raise ValueError("group_must_be_an_object")
        label = str(g.get("label") or "").strip()[:60]
        if not label:
            raise ValueError("group_label_required")
        key = _slug(str(g.get("key") or "") or label) or f"g{len(out) + 1}"
        # A duplicate key would make two groups the same anchor and the second
        # unreachable, so it is suffixed rather than rejected: the host is
        # typing labels, not keys.
        base, n = key, 2
        while key in keys:
            key = f"{base}_{n}"
            n += 1
        keys.add(key)
        include = g.get("include") or []
        if not isinstance(include, list) or not all(isinstance(p, str) for p in include):
            raise ValueError("group_include_must_be_a_list_of_prefixes")
        decide = str(g.get("decide") or "points")
        if decide not in _DECIDE_MODES:
            raise ValueError("group_decide_unknown")
        out.append({
            "key": key,
            "label": label,
            "include": [p.strip() for p in include if p.strip()][:64],
            "decide": decide,
        })
    return out


def _clean_overrides(raw: Any) -> list[dict]:
    if not isinstance(raw, list):
        raise ValueError("overrides_must_be_a_list")
    out: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for o in raw:
        if not isinstance(o, dict):
            raise ValueError("override_must_be_an_object")
        leaf = str(o.get("leaf_key") or "").strip()
        if not leaf:
            raise ValueError("override_leaf_key_required")
        try:
            place = int(o.get("place"))
        except (TypeError, ValueError):
            raise ValueError("override_place_must_be_a_number") from None
        if place < 1 or place > 50:
            raise ValueError("override_place_out_of_range")
        team_id = str(o.get("team_id") or "").strip()
        label = str(o.get("label") or "").strip()[:120]
        if not team_id and not label:
            # An override names a winner. Without either half it would silently
            # delete the derived placing instead, which is a different verb.
            raise ValueError("override_needs_a_team_or_a_name")
        if (leaf, place) in seen:
            raise ValueError("override_duplicate_place")
        seen.add((leaf, place))
        out.append({
            "leaf_key": leaf,
            "place": place,
            "team_id": team_id,
            "label": label,
            "note": str(o.get("note") or "").strip()[:200],
            "by": str(o.get("by") or "")[:64],
            "at": str(o.get("at") or "")[:40],
        })
    return out


def merge_awards(partial: Any, base: Any = None) -> dict:
    """Validate a partial awards config over ``base`` (or the defaults).

    Unknown keys are REJECTED rather than stored, so the schema cannot drift
    the way an open JSONB blob does.
    """
    out = copy.deepcopy(DEFAULT_AWARDS)
    for source in (base, partial):
        if source is None:
            continue
        if not isinstance(source, dict):
            raise ValueError("awards_must_be_an_object")
        unknown = set(source) - set(DEFAULT_AWARDS)
        if unknown:
            raise ValueError(f"unknown_awards_keys:{','.join(sorted(unknown))}")
        if "enabled" in source:
            out["enabled"] = bool(source["enabled"])
        if "ladder" in source:
            out["ladder"] = _clean_ladder(source["ladder"], where="ladder")
            if not out["ladder"]:
                raise ValueError("ladder_must_have_a_place")
        if "bronze" in source:
            mode = str(source["bronze"] or "shared")
            if mode not in _BRONZE_MODES:
                raise ValueError("bronze_mode_unknown")
            out["bronze"] = mode
        if "by_competition" in source:
            rows = source["by_competition"]
            if not isinstance(rows, list):
                raise ValueError("by_competition_must_be_a_list")
            cleaned = []
            for row in rows:
                if not isinstance(row, dict):
                    raise ValueError("by_competition_row_must_be_an_object")
                match = str(row.get("match") or "").strip()
                if not match:
                    raise ValueError("by_competition_match_required")
                cleaned.append({
                    "match": match,
                    "ladder": _clean_ladder(row.get("ladder"), where="by_competition"),
                })
            out["by_competition"] = cleaned
        if "groups" in source:
            out["groups"] = _clean_groups(source["groups"])
        if "overrides" in source:
            out["overrides"] = _clean_overrides(source["overrides"])
    return out


def effective_awards(tournament) -> dict:
    """The config a reader should use, defaults filled in.

    Never raises: a tournament carrying a config an older build wrote must
    still render a tally, so anything unparseable falls back to the defaults
    rather than 500-ing the public page.
    """
    try:
        return merge_awards(getattr(tournament, "awards", None) or {})
    except ValueError:
        return copy.deepcopy(DEFAULT_AWARDS)


def ladder_for(awards: dict, leaf_key: str) -> list[dict]:
    """The points ladder one competition is scored by.

    The MOST SPECIFIC ``by_competition`` entry wins regardless of list order,
    so a host can weight a whole sport and then override one category inside it
    without minding which they typed first.
    """
    from apps.tournaments.services.sports import leaf_matches_prefix

    best: tuple[int, list[dict]] | None = None
    for row in awards.get("by_competition") or []:
        prefix = row.get("match") or ""
        if leaf_key and leaf_matches_prefix(prefix, leaf_key):
            depth = prefix.count(".")
            if best is None or depth > best[0]:
                best = (depth, row.get("ladder") or [])
    if best is not None and best[1]:
        return best[1]
    return awards.get("ladder") or DEFAULT_LADDER


def points_for(awards: dict, leaf_key: str, place: int):
    """What a placing is worth in one competition (0 when it does not score)."""
    for row in ladder_for(awards, leaf_key):
        if int(row.get("place", 0)) == place:
            return row.get("points", 0)
    return 0


def scoring_places(awards: dict, leaf_key: str) -> int:
    """How deep the ladder goes for a competition — how many placings a
    derivation needs to bother resolving."""
    ladder = ladder_for(awards, leaf_key)
    return max((int(r.get("place", 0)) for r in ladder), default=0)


def group_leaves(group: dict, leaf_keys: list[str]) -> list[str]:
    """The competitions one group covers. An empty ``include`` is EVERY
    competition — that is what "Overall" means, and a special-cased key would
    make it un-renameable."""
    from apps.tournaments.services.sports import leaf_matches_prefix

    include = group.get("include") or []
    if not include:
        return list(leaf_keys)
    return [
        k for k in leaf_keys
        if any(leaf_matches_prefix(p, k) for p in include)
    ]


def suggest_groups(sports: list[dict] | None) -> list[dict]:
    """Groups a host would probably want, read off their own category tree.

    One group per (age band, gender) pair that appears anywhere, spanning
    SPORTS — "U-14 Boys" covers both the table tennis and the sepak takraw
    U-14 boys competitions, which is exactly how the reference medal sheet
    bands its columns — plus an Overall. It is a starting point the host edits,
    never a rule: nothing downstream re-derives it.
    """
    from apps.tournaments.services.sports import iter_leaves

    leaves = iter_leaves(sports)
    # (age segment, gender segment) -> the leaf-key prefixes that reach it.
    buckets: dict[tuple[str, str], list[str]] = {}
    order: list[tuple[str, str]] = []
    genders = {"boys", "girls", "men", "women", "male", "female", "mixed"}
    for leaf in leaves:
        parts = leaf["leaf_key"].split(".")
        path = leaf.get("path") or []
        if len(parts) < 3 or len(path) < 2:
            continue
        gender_at = next(
            (i for i, seg in enumerate(parts[1:], start=1) if seg.lower() in genders),
            None,
        )
        if gender_at is None or gender_at < 2 or len(path) < gender_at:
            continue
        age_name = path[gender_at - 2]
        gender_name = path[gender_at - 1]
        key = (str(age_name), str(gender_name))
        prefix = ".".join(parts[: gender_at + 1])
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        if prefix not in buckets[key]:
            buckets[key].append(prefix)
    out = [
        {
            "key": _slug(f"{age} {gender}"),
            "label": f"{age} {gender}",
            "include": buckets[(age, gender)],
            "decide": "points",
        }
        for (age, gender) in order
    ]
    out.append({
        "key": "overall", "label": "Overall Champion",
        "include": [], "decide": "points",
    })
    return _clean_groups(out)


def update_awards(*, tournament, awards, by=None, event_id=None, request=None):
    """Persist an awards config (manager only). Idempotent on ``event_id``
    (invariant 3), audited, and deliberately NOT gated on the rules freeze."""
    from django.db import transaction
    from django.utils import timezone

    from apps.audit.models import ActorRole, AuditEvent
    from apps.audit.services import emit_audit

    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="tournament_awards_updated"
        ).first()
        if prior is not None:
            return tournament  # replay

    before = copy.deepcopy(getattr(tournament, "awards", None) or {})
    merged = merge_awards(awards, base=tournament.awards or {})
    with transaction.atomic():
        tournament.awards = merged
        tournament.last_manual_edit_at = timezone.now()
        tournament.save(update_fields=["awards", "last_manual_edit_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_awards_updated",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            idempotency_key=event_id,
            payload_before={"awards": before},
            payload_after={"awards": merged},
            request=request,
        )
    return tournament
