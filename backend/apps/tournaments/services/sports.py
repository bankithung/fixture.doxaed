"""Sports & category-hierarchy registry (spec 2026-06-10 §3).

``Tournament.sports`` is a JSONB list of sports, each carrying a recursive
category tree of arbitrary depth:

    {key, name, custom, scoring?, scheduling?,
     nodes: [{key, name, children: [node, ...]}, ...],
     categories: [...]}   # legacy 2-level projection, derived at write

A **leaf** is a path with no children — one competition (one draw, one set of
rules). Its identity is the dot-joined key path ``sport.node...node`` (e.g.
``football.u15.girls.5v5``), carried by generated-form option values,
``Team.leaf_key`` and ``Match.leaf_key``. Node keys are slugs minted at first
write; clients that round-trip ``key`` keep identity stable across renames.

Legacy shapes are coerced on write AND read: ``categories: [{name,
subcategories: [str]}]`` and plain-string categories become nodes, so the
existing 2-level SportsTab keeps working unchanged until the recursive editor
ships. ``categories`` is re-derived from ``nodes`` on every write so older
readers (serializer, FE types) see a consistent projection.
"""
from __future__ import annotations

import re
from typing import Any

# Path separator for leaf keys. Node keys themselves never contain dots.
LEAF_SEP = "."
# Sanity bound; deeper levels are silently ignored (UI offers far fewer).
MAX_DEPTH = 6

# What a category node IS (W2-B): drives downstream logic — a "format" node
# (1v1, 5v5…) carries team-size rules the generated team form enforces; an
# "age_group" node carries an age rule (operator + numbers).
NODE_KINDS = ("age_group", "gender", "format", "level", "custom")

# "1v1" / "5 v 5" / "3vs3" style names ⇒ players-per-side auto-detection.
_NVN = re.compile(r"^\s*(\d{1,2})\s*[vV][sS]?\s*(\d{1,2})\s*$")

# Age-rule operators (owner 2026-06-10: "under 15/16 … allow the user to
# select any type of operators"). Numbers only, never free text — rules must
# stay comparable (and future player-eligibility checks need integers).
AGE_OPS = ("under", "over", "between")
_AGE_UNDER = re.compile(r"^\s*(?:u\s*-?\s*|under\s+)(\d{1,2})\s*$", re.IGNORECASE)
_AGE_OVER = re.compile(r"^\s*(?:over\s+)?(\d{1,2})\s*\+\s*$", re.IGNORECASE)
# Accepts a hyphen or en dash between the two ages in typed names.
_AGE_BETWEEN = re.compile(r"^\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*$")  # noqa: RUF001


def sport_key(name: str) -> str:
    """Stable slug key for a sport name (catalog code or custom)."""
    s = "".join(c if c.isalnum() else "_" for c in (name or "").lower())
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_")[:40]


def node_key(name: str) -> str:
    """Slug key for a category node — like sport_key but dot-free by
    construction (dots are the leaf-path separator)."""
    return sport_key(name)


def _clean_format(raw: Any, name: str) -> dict | None:
    """Per-node team-size rules ({players_per_side, squad_min, squad_max}),
    auto-seeded from "NvN" names (1v1 ⇒ players_per_side 1) when not given
    explicitly (W2-B). Invalid/unknown keys dropped; None when empty."""
    out: dict = {}
    if isinstance(raw, dict):
        for k in ("players_per_side", "squad_min", "squad_max"):
            v = raw.get(k)
            if isinstance(v, (int, float)) and v is not True and int(v) > 0:
                out[k] = int(v)
    if "players_per_side" not in out:
        m = _NVN.match(name)
        if m:
            out["players_per_side"] = int(m.group(1))
    if out.get("squad_min") and out.get("squad_max") \
            and out["squad_min"] > out["squad_max"]:
        out.pop("squad_min")
    return out or None


def _clean_age(raw: Any, name: str) -> dict | None:
    """Per-node age rule ({op: under|over|between, age | min+max}),
    auto-seeded from the name when not given explicitly ("U15"/"Under 15" →
    under 15, "16+"/"Over 16" → over 16, "12-14" → between). Invalid shapes
    are dropped; None when nothing valid remains (W2: age groups carry
    NUMBERS, not just labels)."""
    out: dict = {}
    if isinstance(raw, dict) and raw.get("op") in AGE_OPS:
        def _i(v: Any) -> int | None:
            return int(v) if isinstance(v, (int, float)) and v is not True \
                and int(v) > 0 else None
        if raw["op"] == "between":
            mn, mx = _i(raw.get("min")), _i(raw.get("max"))
            if mn and mx and mn <= mx:
                out = {"op": "between", "min": mn, "max": mx}
        else:
            age = _i(raw.get("age"))
            if age:
                out = {"op": raw["op"], "age": age}
    if not out:
        if m := _AGE_UNDER.match(name):
            out = {"op": "under", "age": int(m.group(1))}
        elif m := _AGE_OVER.match(name):
            out = {"op": "over", "age": int(m.group(1))}
        elif m := _AGE_BETWEEN.match(name):
            lo, hi = int(m.group(1)), int(m.group(2))
            if lo <= hi:
                out = {"op": "between", "min": lo, "max": hi}
    return out or None


def age_rule_label(age: dict | None) -> str:
    """Human label for an age rule: 'under 15', '16+', '12-14' ('' if none)."""
    if not isinstance(age, dict):
        return ""
    if age.get("op") == "under" and age.get("age"):
        return f"under {age['age']}"
    if age.get("op") == "over" and age.get("age"):
        return f"{age['age']}+"
    if age.get("op") == "between" and age.get("min") and age.get("max"):
        return f"{age['min']}-{age['max']}"
    return ""


def _normalize_nodes(raw: Any, depth: int = 0) -> list[dict]:
    """Recursively normalize a node list. Accepts the canonical shape
    ({key, name, kind?, format?, age?, children}), the legacy dict shape
    ({name, subcategories}) and plain strings. Blank names and duplicate keys
    (per level) are dropped."""
    if not isinstance(raw, list) or depth >= MAX_DEPTH:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for n in raw:
        if isinstance(n, str):
            name, key_raw, children_raw = n.strip(), "", []
            kind_raw, format_raw, age_raw = "", None, None
        elif isinstance(n, dict):
            name = str(n.get("name") or "").strip()
            key_raw = str(n.get("key") or "")
            children_raw = n.get("children")
            if children_raw is None:
                children_raw = n.get("subcategories") or []
            kind_raw = str(n.get("kind") or "")
            format_raw = n.get("format")
            age_raw = n.get("age")
        else:
            continue
        if not name:
            continue
        key = node_key(key_raw) or node_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        entry: dict = {
            "key": key,
            "name": name[:80],
            "children": _normalize_nodes(children_raw, depth + 1),
        }
        fmt = _clean_format(format_raw, name)
        age = _clean_age(age_raw, name)
        kind = kind_raw if kind_raw in NODE_KINDS else ""
        if not kind and fmt and "players_per_side" in fmt and _NVN.match(name):
            kind = "format"  # NvN names self-describe
        if not kind and age:
            kind = "age_group"  # "U15" / "16+" names self-describe
        if kind:
            entry["kind"] = kind
        if fmt:
            entry["format"] = fmt
        if age:
            entry["age"] = age
        out.append(entry)
    return out


def _legacy_categories(nodes: list[dict]) -> list[dict]:
    """2-level projection for older readers: top-level node names + their
    children's names. Depth ≥3 is visible only through leaf labels/keys."""
    return [
        {
            "name": n["name"],
            "subcategories": [c["name"] for c in n.get("children") or []],
        }
        for n in nodes
    ]


_SCORING_KEYS = ("type", "best_of", "points", "win_by", "cap", "deciding")
_DECIDING_KEYS = ("points", "win_by", "cap")
_SCHEDULING_KEYS = ("duration_minutes", "venue_type")


def _clean_scoring(raw: Any) -> dict | None:
    """Per-sport scoring override ({type:'sets'|'goals', best_of, points,
    win_by, cap, deciding:{points, win_by, cap}}). Unknown keys dropped,
    numbers coerced; None when nothing valid remains."""
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    for k in _SCORING_KEYS:
        if k not in raw:
            continue
        v = raw[k]
        if k == "type":
            if v in ("sets", "goals"):
                out[k] = v
        elif k == "deciding":
            if isinstance(v, dict):
                d = {dk: int(v[dk]) for dk in _DECIDING_KEYS
                     if dk in v and isinstance(v[dk], (int, float)) and v[dk] is not True}
                if "cap" in v and v["cap"] is None:
                    d["cap"] = None
                if d:
                    out[k] = d
        elif v is None and k == "cap":
            out[k] = None
        elif isinstance(v, (int, float)) and v is not True:
            out[k] = int(v)
    return out or None


def _clean_scheduling(raw: Any) -> dict | None:
    """Per-sport scheduling hints ({duration_minutes, venue_type})."""
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    v = raw.get("duration_minutes")
    if isinstance(v, (int, float)) and v is not True and int(v) > 0:
        out["duration_minutes"] = int(v)
    vt = raw.get("venue_type")
    if isinstance(vt, str) and vt.strip():
        out["venue_type"] = vt.strip()[:40]
    return out or None


def normalize_sports(raw: Any) -> list[dict]:
    """Normalize a client-supplied sports list to the canonical stored shape.
    Tolerates the legacy 2-level shape; preserves per-sport ``scoring`` and
    ``scheduling`` config (previously stripped — see spec 2026-06-10 B3)."""
    if not isinstance(raw, list):
        raise ValueError("sports_must_be_list")
    cleaned: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        key = sport_key(str(item.get("key") or "")) or sport_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        nodes_raw = item.get("nodes")
        if nodes_raw is None:
            nodes_raw = item.get("categories") or []
        nodes = _normalize_nodes(nodes_raw)
        entry: dict = {
            "key": key,
            "name": name[:80],
            "custom": bool(item.get("custom")),
            "nodes": nodes,
            "categories": _legacy_categories(nodes),
        }
        scoring = _clean_scoring(item.get("scoring"))
        if scoring:
            entry["scoring"] = scoring
        scheduling = _clean_scheduling(item.get("scheduling"))
        if scheduling:
            entry["scheduling"] = scheduling
        cleaned.append(entry)
    return cleaned


def _sport_nodes(sport: dict) -> list[dict]:
    """A sport entry's node tree, coercing legacy stored shapes on read (rows
    written before the recursive registry only have ``categories``)."""
    nodes = sport.get("nodes")
    if nodes is None:
        nodes = _normalize_nodes(sport.get("categories") or [])
    return nodes or []


def sport_nodes(sport: dict) -> list[dict]:
    """Public read accessor for a sport's node tree (legacy shapes coerced) —
    the form generator walks this to emit one branching question per level."""
    return _sport_nodes(sport)


def _walk_leaves(
    out: list[dict], skey: str, sname: str,
    node: dict, key_path: list[str], name_path: list[str],
) -> None:
    kp = [*key_path, node["key"]]
    np = [*name_path, node["name"]]
    children = node.get("children") or []
    if not children:
        out.append({
            "sport_key": skey, "sport_name": sname,
            "leaf_key": LEAF_SEP.join([skey, *kp]),
            "path": np, "label": " · ".join(np),
        })
        return
    for c in children:
        _walk_leaves(out, skey, sname, c, kp, np)


def iter_leaves(sports: list[dict] | None) -> list[dict]:
    """Flatten every sport's category tree into leaf records:

        {sport_key, sport_name, leaf_key, path: [node names], label}

    ``label`` joins the path with " · " (the sport name is NOT included — the
    consumer decides whether to prefix it). A sport with no categories yields
    one sport-level leaf (leaf_key == sport key, empty path, label == sport
    name): the sport itself is a single competition.
    """
    out: list[dict] = []
    for s in sports or []:
        skey = str(s.get("key") or "")
        sname = str(s.get("name") or skey)
        if not skey:
            continue
        nodes = _sport_nodes(s)
        if not nodes:
            out.append({
                "sport_key": skey, "sport_name": sname,
                "leaf_key": skey, "path": [], "label": sname,
            })
            continue
        for n in nodes:
            _walk_leaves(out, skey, sname, n, [], [])
    return out


def sport_for_leaf(sports: list[dict] | None, leaf_key: str) -> str:
    """The sport key a leaf belongs to ('' when the leaf isn't recognized).
    Leaf keys are sport-prefixed by construction, so this is a prefix check
    validated against the configured sports (replaces the broken name-matching
    _sport_for_pool — spec 2026-06-10 B1)."""
    if not leaf_key:
        return ""
    head = leaf_key.split(LEAF_SEP, 1)[0]
    for s in sports or []:
        if s.get("key") == head:
            return head
    return ""


def find_leaf(sports: list[dict] | None, leaf_key: str) -> dict | None:
    """The full leaf record for a leaf key, or None."""
    for leaf in iter_leaves(sports):
        if leaf["leaf_key"] == leaf_key:
            return leaf
    return None


def leaf_label(sports: list[dict] | None, leaf_key: str, *, with_sport: bool = True) -> str:
    """Display label for a leaf key ('Football · U15 · Girls'), falling back to
    the raw key when the leaf is no longer configured."""
    leaf = find_leaf(sports, leaf_key)
    if leaf is None:
        return leaf_key
    if not leaf["path"]:
        return leaf["sport_name"]
    body = leaf["label"]
    return f"{leaf['sport_name']} · {body}" if with_sport else body


def _leaf_path_nodes(sports: list[dict] | None, leaf_key: str) -> list[dict]:
    """The node objects along a leaf's path (shallow → deep), [] if unknown."""
    parts = (leaf_key or "").split(LEAF_SEP)
    if len(parts) < 2:
        return []
    for s in sports or []:
        if s.get("key") != parts[0]:
            continue
        path_nodes: list[dict] = []
        nodes = _sport_nodes(s)
        for part in parts[1:]:
            node = next((n for n in nodes if n.get("key") == part), None)
            if node is None:
                break
            path_nodes.append(node)
            nodes = node.get("children") or []
        return path_nodes
    return []


def leaf_age_rule(sports: list[dict] | None, leaf_key: str) -> dict | None:
    """The age rule governing one competition: nearest node on the path
    carrying an ``age`` config wins (so football.u15.girls inherits U15's
    'under 15'). None when the path has no age rule."""
    for node in reversed(_leaf_path_nodes(sports, leaf_key)):
        if node.get("age"):
            return dict(node["age"])
    return None


def leaf_roster_rules(sports: list[dict] | None, leaf_key: str) -> dict:
    """Team-size rules for one competition (W2-B): walk the leaf's node path
    from DEEPEST to shallowest and take the nearest node carrying a
    ``format`` (so ``football.u15.girls.5v5`` inherits the 5v5 node's rules).

    Returns {players_per_side, squad_min, squad_max} where any value may be
    None. Defaults when players_per_side is known: a squad of exactly that
    size (squad_min == squad_max == players_per_side) — the generated team
    form starts strict and the admin widens it for substitutes in the
    builder (owner 2026-06-10)."""
    fmt: dict = {}
    for node in reversed(_leaf_path_nodes(sports, leaf_key)):
        if node.get("format"):
            fmt = dict(node["format"])
            break
    pps = fmt.get("players_per_side")
    mn = fmt.get("squad_min") or pps
    mx = fmt.get("squad_max") or pps
    # Consistency clamps (review W2-F): a lone contradicting bound used to
    # produce min_items > max_items on the generated form — every roster
    # size rejected, the category unsubmittable. A squad can never be
    # smaller than the on-field side, and max honors a larger explicit min.
    if mx is not None and pps and mx < pps:
        mx = pps
    if mn is not None and mx is not None and mn > mx:
        mx = mn
    return {"players_per_side": pps, "squad_min": mn, "squad_max": mx}


def sports_inputs_hash(sports: list[dict] | None) -> str:
    """Stable fingerprint of the sports config — generated artifacts (the
    registration forms) stamp it at build time so staleness is detectable
    after category edits (invariant 10)."""
    import hashlib
    import json

    return hashlib.sha256(
        json.dumps(sports or [], sort_keys=True).encode("utf-8")
    ).hexdigest()


def guard_leaf_removal(tournament, new_sports: list[dict] | None) -> None:
    """Refuse a sports-tree replacement that would ORPHAN registered data (H4).

    A leaf key is stable across renames (the registry mints once), so renames,
    reorders, format edits and NEW leaves always pass; only REMOVING a leaf
    that teams or matches already reference is blocked. Raises ValueError
    "leaf_in_use:<key,key>" so the API can name exactly what is stuck.
    """
    from apps.matches.models import Match
    from apps.teams.models import Team

    current = {leaf["leaf_key"] for leaf in iter_leaves(tournament.sports or [])}
    incoming = {leaf["leaf_key"] for leaf in iter_leaves(new_sports or [])}
    removed = current - incoming
    if not removed:
        return

    used = set(
        Team.objects.filter(
            tournament=tournament, deleted_at__isnull=True, leaf_key__in=removed
        ).values_list("leaf_key", flat=True)
    ) | set(
        Match.objects.filter(
            tournament=tournament, leaf_key__in=removed
        ).values_list("leaf_key", flat=True)
    )
    if used:
        raise ValueError("leaf_in_use:" + ",".join(sorted(used)))
