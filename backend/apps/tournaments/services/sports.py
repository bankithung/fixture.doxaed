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

from typing import Any

# Path separator for leaf keys. Node keys themselves never contain dots.
LEAF_SEP = "."
# Sanity bound; deeper levels are silently ignored (UI offers far fewer).
MAX_DEPTH = 6


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


def _normalize_nodes(raw: Any, depth: int = 0) -> list[dict]:
    """Recursively normalize a node list. Accepts the canonical shape
    ({key, name, children}), the legacy dict shape ({name, subcategories}) and
    plain strings. Blank names and duplicate keys (per level) are dropped."""
    if not isinstance(raw, list) or depth >= MAX_DEPTH:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for n in raw:
        if isinstance(n, str):
            name, key_raw, children_raw = n.strip(), "", []
        elif isinstance(n, dict):
            name = str(n.get("name") or "").strip()
            key_raw = str(n.get("key") or "")
            children_raw = n.get("children")
            if children_raw is None:
                children_raw = n.get("subcategories") or []
        else:
            continue
        if not name:
            continue
        key = node_key(key_raw) or node_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({
            "key": key,
            "name": name[:80],
            "children": _normalize_nodes(children_raw, depth + 1),
        })
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
            "path": np, "label": " — ".join(np),
        })
        return
    for c in children:
        _walk_leaves(out, skey, sname, c, kp, np)


def iter_leaves(sports: list[dict] | None) -> list[dict]:
    """Flatten every sport's category tree into leaf records:

        {sport_key, sport_name, leaf_key, path: [node names], label}

    ``label`` joins the path with " — " (the sport name is NOT included — the
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
    """Display label for a leaf key ('Football — U15 — Girls'), falling back to
    the raw key when the leaf is no longer configured."""
    leaf = find_leaf(sports, leaf_key)
    if leaf is None:
        return leaf_key
    if not leaf["path"]:
        return leaf["sport_name"]
    body = leaf["label"]
    return f"{leaf['sport_name']} — {body}" if with_sport else body


def sports_inputs_hash(sports: list[dict] | None) -> str:
    """Stable fingerprint of the sports config — generated artifacts (the
    registration forms) stamp it at build time so staleness is detectable
    after category edits (invariant 10)."""
    import hashlib
    import json

    return hashlib.sha256(
        json.dumps(sports or [], sort_keys=True).encode("utf-8")
    ).hexdigest()
