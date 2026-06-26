"""The assistant's tools — Gemini function declarations + their handlers.

Every handler routes through the SAME services the manual form uses
(``update_settings`` for constraints, ``update_draw_config`` for calendar +
formats, the ``Venue`` model for venues), so permissions, validation and the
rules-freeze gate behave identically. Handlers return
``{"ok": bool, "message": str, "changed": bool, ...}`` — ``message`` doubles as
the human receipt shown under the assistant's reply.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from django.utils import timezone

from apps.accounts.models import uuid7
from apps.fixtures.models import Venue
from apps.fixtures.services.draw_config import effective_draw_config, update_draw_config
from apps.tournaments.services.rules import update_settings
from apps.tournaments.services.sports import iter_leaves

from .context import FORMAT_LABELS, build_state, render_state

VALID_FORMATS = {"round_robin", "knockout", "groups_knockout", "swiss", "double_elim"}


# --------------------------------------------------------------------------- #
# resolution helpers (forgiving: accept leaf_key, label, sport key or name)
# --------------------------------------------------------------------------- #
def _lookups(tournament):
    leaves = iter_leaves(tournament.sports)
    by_leaf = {lf["leaf_key"]: lf for lf in leaves}
    by_label = {lf["label"].lower(): lf for lf in leaves}
    sports: dict[str, str] = {}
    for lf in leaves:
        sports.setdefault(lf["sport_key"], lf["sport_name"])
    sport_by_name = {name.lower(): key for key, name in sports.items()}
    return leaves, by_leaf, by_label, sports, sport_by_name


_ALL = {"all", "*", "everything", "whole tournament", "tournament", "every competition"}


def _resolve_draw_targets(tournament, scope: Any) -> list[str]:
    """-> one or more draw_config keys: ['*'] | ['sport:<key>'] | ['<leaf_key>',...].

    Forgiving: accepts 'all', a sport key/name, an exact leaf_key/label, OR an
    intermediate category path (e.g. 'table_tennis.u_14') which expands to all of
    its descendant leaves — the model sometimes references a category group, and
    the manual board only writes '*'/'sport:<k>'/leaf, so we fan out to leaves.
    """
    s = str(scope or "all").strip()
    low = s.lower()
    if low in _ALL:
        return ["*"]
    leaves, by_leaf, by_label, sports, sport_by_name = _lookups(tournament)
    if s in by_leaf:
        return [s]
    if low in by_label:
        return [by_label[low]["leaf_key"]]
    if s.startswith("sport:") and s[6:] in sports:
        return [s]
    if s in sports:
        return [f"sport:{s}"]
    if low in sport_by_name:
        return [f"sport:{sport_by_name[low]}"]
    # Intermediate category node (a strict prefix of >=1 leaf) -> its leaves.
    descendants = [
        lf["leaf_key"] for lf in leaves
        if lf["leaf_key"] == s or lf["leaf_key"].startswith(s + ".")
    ]
    if descendants:
        return descendants
    raise ValueError(f"unknown competition or sport '{scope}'")


def _resolve_sport_scope(tournament, scope: Any) -> str:
    """-> 'all' | 'sport:<key>' (for official_capacity)."""
    s = str(scope or "all").strip()
    low = s.lower()
    if low in _ALL:
        return "all"
    _, _, _, sports, sport_by_name = _lookups(tournament)
    if s.startswith("sport:") and s[6:] in sports:
        return s
    if s in sports:
        return f"sport:{s}"
    if low in sport_by_name:
        return f"sport:{sport_by_name[low]}"
    raise ValueError(f"unknown sport '{scope}'")


def _resolve_constraint_scope(tournament, scope: Any) -> str:
    """-> 'sport:<key>' | 'leaf:<leaf_key>' (for a session window)."""
    s = str(scope or "").strip()
    low = s.lower()
    _, by_leaf, by_label, sports, sport_by_name = _lookups(tournament)
    if s in by_leaf:
        return f"leaf:{s}"
    if low in by_label:
        return f"leaf:{by_label[low]['leaf_key']}"
    if s.startswith("sport:") and s[6:] in sports:
        return s
    if s in sports:
        return f"sport:{s}"
    if low in sport_by_name:
        return f"sport:{sport_by_name[low]}"
    raise ValueError(f"unknown competition or sport '{scope}'")


def _resolve_sport_keys(tournament, names: list) -> list[str]:
    _, _, _, sports, sport_by_name = _lookups(tournament)
    out: list[str] = []
    for n in names or []:
        s = str(n).strip()
        low = s.lower()
        if s in sports:
            out.append(s)
        elif low in sport_by_name:
            out.append(sport_by_name[low])
        elif s.startswith("sport:") and s[6:] in sports:
            out.append(s[6:])
    return list(dict.fromkeys(out))


def _resolve_leaf_keys(tournament, members: list) -> list[str]:
    leaves, by_leaf, by_label, sports, sport_by_name = _lookups(tournament)
    out: list[str] = []
    for m in members or []:
        s = str(m).strip()
        low = s.lower()
        if s in by_leaf:
            out.append(s)
        elif low in by_label:
            out.append(by_label[low]["leaf_key"])
        elif s in sports or low in sport_by_name:
            key = s if s in sports else sport_by_name[low]
            out += [lf["leaf_key"] for lf in leaves if lf["sport_key"] == key]
        elif s.startswith("sport:"):
            key = s[6:]
            out += [lf["leaf_key"] for lf in leaves if lf["sport_key"] == key]
    return list(dict.fromkeys(out))


# --------------------------------------------------------------------------- #
# constraint persistence (mirrors the wizard's freeze-amend behaviour)
# --------------------------------------------------------------------------- #
def _save_constraints(tournament, user, request, new_list):
    eid = uuid7()
    try:
        return update_settings(
            tournament=tournament, constraints=new_list, by=user,
            event_id=eid, request=request,
        )
    except PermissionError as exc:
        if str(exc) == "rules_frozen":
            return update_settings(
                tournament=tournament, constraints=new_list, by=user, amend=True,
                reason="AI setup assistant: scheduling constraints updated",
                event_id=eid, request=request,
            )
        raise


def _upsert(tournament, user, request, *, drop: Callable[[dict], bool], add: list[dict]):
    current = list(tournament.constraints or [])
    kept = [c for c in current if not drop(c)]
    _save_constraints(tournament, user, request, kept + list(add))


def _int(v, default=None):
    if v is None or v == "":
        return default
    return int(v)


# --------------------------------------------------------------------------- #
# handlers
# --------------------------------------------------------------------------- #
def h_set_schedule_window(t, u, r, a):
    cur = effective_draw_config(t).get("calendar") or {}
    cal = {
        "date_start": a.get("date_start") or cur.get("date_start"),
        "date_end": a.get("date_end") or cur.get("date_end"),
        "daily_start": a.get("daily_start") or cur.get("daily_start") or "09:00",
        "daily_end": a.get("daily_end") or cur.get("daily_end") or "18:00",
        "slot_minutes": _int(a.get("slot_minutes"), cur.get("slot_minutes") or 45),
    }
    update_draw_config(
        tournament=t, leaf_key="*", partial={"calendar": cal}, by=u,
        event_id=uuid7(), request=r,
    )
    return {
        "ok": True, "changed": True,
        "message": (
            f"Match days set to {cal['date_start']} - {cal['date_end']}, "
            f"daily {cal['daily_start']}-{cal['daily_end']}, {cal['slot_minutes']} min/match."
        ),
    }


def h_set_breaks(t, u, r, a):
    drop_keys: set[tuple] = set()
    add: list[dict] = []
    bits: list[str] = []
    if a.get("rest_minutes") is not None:
        m = _int(a.get("rest_minutes"), 0)
        drop_keys.add(("min_rest_minutes", "all"))
        if m > 0:
            add.append({"type": "min_rest_minutes", "scope": "all", "hard": True,
                        "params": {"minutes": m}})
        bits.append(f"{m} min rest between a team's matches")
    if a.get("max_matches_per_team_per_day") is not None:
        c = _int(a.get("max_matches_per_team_per_day"), 0)
        drop_keys.add(("max_matches_per_team_per_day", "all"))
        if c > 0:
            add.append({"type": "max_matches_per_team_per_day", "scope": "all",
                        "hard": True, "params": {"count": c}})
        bits.append(f"max {c} matches per team per day")
    if a.get("keep_sunday_morning_free") is not None:
        drop_keys.add(("recurring_blackout_window", "all"))
        if bool(a.get("keep_sunday_morning_free")):
            add.append({"type": "recurring_blackout_window", "scope": "all", "hard": True,
                        "params": {"days": ["sun"], "from": "00:00", "to": "13:00"}})
            bits.append("Sunday mornings kept free")
        else:
            bits.append("Sunday mornings open")
    if not drop_keys:
        return {"ok": False, "changed": False, "message": "No break settings were provided."}
    _upsert(t, u, r,
            drop=lambda c: (c.get("type"), c.get("scope", "all")) in drop_keys, add=add)
    return {"ok": True, "changed": True, "message": "Breaks updated: " + ", ".join(bits) + "."}


def h_set_days_off(t, u, r, a):
    dates = [str(d) for d in (a.get("dates") or [])]
    _upsert(
        t, u, r,
        drop=lambda c: c.get("type") == "blackout_dates" and c.get("scope", "all") == "all",
        add=[{"type": "blackout_dates", "scope": "all", "hard": True,
              "params": {"dates": dates}}] if dates else [],
    )
    return {"ok": True, "changed": True,
            "message": f"Days off set to: {', '.join(dates) if dates else 'none'}."}


def h_set_spare_days(t, u, r, a):
    dates = [str(d) for d in (a.get("dates") or [])]
    _upsert(
        t, u, r,
        drop=lambda c: c.get("type") == "reserve_days" and c.get("scope", "all") == "all",
        add=[{"type": "reserve_days", "scope": "all", "hard": True,
              "params": {"dates": dates}}] if dates else [],
    )
    return {"ok": True, "changed": True,
            "message": f"Spare (reserve) days set to: {', '.join(dates) if dates else 'none'}."}


def h_set_ceremony(t, u, r, a):
    which = str(a.get("which", "")).strip().lower()
    if which not in {"opening", "closing"}:
        return {"ok": False, "changed": False,
                "message": "Ceremony must be 'opening' or 'closing'."}
    date = str(a.get("date") or "").strip()
    if not date:
        return {"ok": False, "changed": False, "message": f"Give a date for the {which} ceremony."}
    frm = str(a.get("from") or "09:00")
    to = str(a.get("to") or "10:00")
    _upsert(
        t, u, r,
        drop=lambda c: (c.get("type") == "ceremony_block"
                        and c.get("scope", "all") == "all"
                        and (c.get("params") or {}).get("label") == which),
        add=[{"type": "ceremony_block", "scope": "all", "hard": True,
              "params": {"date": date, "from": frm, "to": to, "venues": None, "label": which}}],
    )
    return {"ok": True, "changed": True,
            "message": f"{which.title()} ceremony set for {date}, {frm}-{to}."}


def h_set_format(t, u, r, a):
    targets = _resolve_draw_targets(t, a.get("scope", "all"))
    fmt = str(a.get("format") or "").strip()
    if fmt not in VALID_FORMATS:
        opts = ", ".join(sorted(VALID_FORMATS))
        return {"ok": False, "changed": False,
                "message": f"Unknown format '{fmt}'. Use one of: {opts}."}
    partial: dict[str, Any] = {"format": fmt}
    if a.get("group_size") is not None:
        partial["group_size"] = _int(a.get("group_size"))
    if a.get("advance_per_group") is not None:
        partial["advance_per_group"] = _int(a.get("advance_per_group"))
    if a.get("balance_groups") is not None:
        partial["balance_groups"] = bool(a.get("balance_groups"))
    elif fmt == "groups_knockout":
        partial["balance_groups"] = True  # FIFA-style default for a fresh pick
    for target in targets:
        update_draw_config(tournament=t, leaf_key=target, partial=partial, by=u,
                           event_id=uuid7(), request=r)
    if targets == ["*"]:
        where = "the whole tournament"
    elif len(targets) == 1 and targets[0].startswith("sport:"):
        where = f"all {targets[0][6:]}"
    elif len(targets) == 1:
        where = targets[0]
    else:
        where = f"{len(targets)} competitions"
    return {"ok": True, "changed": True,
            "message": f"Format for {where} set to {FORMAT_LABELS.get(fmt, fmt)}."}


def h_add_or_update_venue(t, u, r, a):
    name = str(a.get("name") or "").strip()
    if not name:
        return {"ok": False, "changed": False, "message": "A venue needs a name."}
    courts = max(1, min(64, _int(a.get("courts"), 1)))
    vtype = str(a.get("venue_type") or "ground")
    sports = _resolve_sport_keys(t, a.get("sports") or [])
    frm, to = a.get("open_from"), a.get("until")
    windows = [{"from": str(frm), "to": str(to)}] if frm and to else []
    existing = Venue.objects.filter(
        organization=t.organization, name=name, deleted_at__isnull=True
    ).first()
    if existing:
        existing.venue_type = vtype
        existing.count = courts
        existing.sports = sports
        existing.windows = windows
        existing.save(update_fields=["venue_type", "count", "sports", "windows", "updated_at"])
        verb = "Updated"
    else:
        Venue.objects.create(
            organization=t.organization, name=name, venue_type=vtype,
            count=courts, sports=sports, windows=windows, created_by=u,
        )
        verb = "Added"
    used = f", used by {', '.join(sports)}" if sports else ""
    return {"ok": True, "changed": True,
            "message": f"{verb} venue '{name}': {courts} court(s){used}."}


def h_remove_venue(t, u, r, a):
    name = str(a.get("name") or "").strip()
    v = Venue.objects.filter(
        organization=t.organization, name=name, deleted_at__isnull=True
    ).first()
    if not v:
        return {"ok": False, "changed": False, "message": f"No venue named '{name}'."}
    v.deleted_at = timezone.now()
    v.save(update_fields=["deleted_at"])
    return {"ok": True, "changed": True, "message": f"Removed venue '{name}'."}


def h_add_clash_rule(t, u, r, a):
    keys = _resolve_leaf_keys(t, a.get("members") or [])
    if len(keys) < 2:
        return {"ok": False, "changed": False,
                "message": "A clash rule needs at least two competitions (or sports)."}
    gap = _int(a.get("gap_minutes"), 0)
    rec = {"type": "no_concurrent_competitions", "scope": "all", "hard": True,
           "params": {"members": keys, "gap_minutes": gap}}
    _upsert(
        t, u, r,
        drop=lambda c: (c.get("type") == "no_concurrent_competitions"
                        and set((c.get("params") or {}).get("members") or []) == set(keys)),
        add=[rec],
    )
    tail = f" (with a {gap} min gap)" if gap else ""
    msg = f"Clash rule added: {len(keys)} competitions can't run at the same time{tail}."
    return {"ok": True, "changed": True, "message": msg}


def h_set_concurrency_cap(t, u, r, a):
    target = _resolve_sport_scope(t, a.get("scope", "all"))
    count = _int(a.get("count"), 0)
    _upsert(
        t, u, r,
        drop=lambda c: c.get("type") == "official_capacity" and c.get("scope", "all") == target,
        add=([{"type": "official_capacity", "scope": target, "hard": True,
               "params": {"count": count}}] if count > 0 else []),
    )
    where = "the whole tournament" if target == "all" else f"all {target[6:]}"
    return {"ok": True, "changed": True,
            "message": (f"Concurrency cap for {where} set to {count} at a time."
                        if count > 0 else f"Concurrency cap for {where} removed.")}


def h_set_session_window(t, u, r, a):
    target = _resolve_constraint_scope(t, a.get("scope"))
    frm = str(a.get("from") or "").strip()
    to = str(a.get("to") or "").strip()
    if not frm or not to:
        return {"ok": False, "changed": False, "message": "Provide both a from and a to time."}
    days = [str(d).lower()[:3] for d in (a.get("days") or [])]
    rec = {"type": "category_session_window", "scope": target, "hard": False, "weight": 7,
           "params": {"days": days, "from": frm, "to": to}}
    _upsert(
        t, u, r,
        drop=lambda c: c.get("type") == "category_session_window" and c.get("scope") == target,
        add=[rec],
    )
    return {"ok": True, "changed": True,
            "message": f"Session window for {target} set to {frm}-{to}."}


def h_get_setup_state(t, u, r, a):
    return {"ok": True, "changed": False, "state": render_state(build_state(t)),
            "message": "Read the current setup."}


HANDLERS: dict[str, Callable] = {
    "set_schedule_window": h_set_schedule_window,
    "set_breaks": h_set_breaks,
    "set_days_off": h_set_days_off,
    "set_spare_days": h_set_spare_days,
    "set_ceremony": h_set_ceremony,
    "set_format": h_set_format,
    "add_or_update_venue": h_add_or_update_venue,
    "remove_venue": h_remove_venue,
    "add_clash_rule": h_add_clash_rule,
    "set_concurrency_cap": h_set_concurrency_cap,
    "set_session_window": h_set_session_window,
    "get_setup_state": h_get_setup_state,
}


def dispatch(name: str, args: dict, *, tournament, user, request) -> dict:
    handler = HANDLERS.get(name)
    if handler is None:
        return {"ok": False, "changed": False, "message": f"Unknown action '{name}'."}
    try:
        return handler(tournament, user, request, args or {})
    except (ValueError, KeyError, TypeError) as exc:
        return {"ok": False, "changed": False, "message": f"Could not apply: {exc}"}
    except PermissionError as exc:
        return {"ok": False, "changed": False, "message": f"Not allowed: {exc}"}


# --------------------------------------------------------------------------- #
# Gemini function declarations (the schema the model sees)
# --------------------------------------------------------------------------- #
_STR = {"type": "string"}
_INT = {"type": "integer"}
_BOOL = {"type": "boolean"}
_DATES = {"type": "array", "items": {"type": "string", "description": "ISO date YYYY-MM-DD"}}

TOOL_DECLARATIONS: list[dict] = [
    {
        "name": "set_schedule_window",
        "description": ("Set the first/last match day and the daily play window "
                        "+ minutes per match."),
        "parameters": {
            "type": "object",
            "properties": {
                "date_start": {**_STR, "description": "First match day, YYYY-MM-DD"},
                "date_end": {**_STR, "description": "Last match day, YYYY-MM-DD"},
                "daily_start": {**_STR, "description": "Earliest start each day, HH:MM 24h"},
                "daily_end": {**_STR, "description": "Latest a match may start, HH:MM"},
                "slot_minutes": {**_INT, "description": "Minutes per match incl. changeover"},
            },
            "required": ["date_start", "date_end"],
        },
    },
    {
        "name": "set_breaks",
        "description": (
            "Set rest between a team's matches, max matches per team per day, "
            "and whether Sunday mornings stay free. Send only the fields you "
            "want to change."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "rest_minutes": _INT,
                "max_matches_per_team_per_day": _INT,
                "keep_sunday_morning_free": _BOOL,
            },
        },
    },
    {
        "name": "set_days_off",
        "description": ("Set the full list of days with NO matches "
                        "(holidays/exams). Replaces the current list."),
        "parameters": {"type": "object", "properties": {"dates": _DATES}, "required": ["dates"]},
    },
    {
        "name": "set_spare_days",
        "description": ("Set reserve/buffer days matches can move to if a day is "
                        "rained out. Replaces the current list."),
        "parameters": {"type": "object", "properties": {"dates": _DATES}, "required": ["dates"]},
    },
    {
        "name": "set_ceremony",
        "description": "Set the opening or closing ceremony date/time (no matches run during it).",
        "parameters": {
            "type": "object",
            "properties": {
                "which": {"type": "string", "enum": ["opening", "closing"]},
                "date": {**_STR, "description": "YYYY-MM-DD"},
                "from": {**_STR, "description": "HH:MM"},
                "to": {**_STR, "description": "HH:MM"},
            },
            "required": ["which", "date"],
        },
    },
    {
        "name": "set_format",
        "description": ("Choose how a competition plays. scope = 'all' (whole "
                        "tournament), a sport_key, or a leaf_key from the state."),
        "parameters": {
            "type": "object",
            "properties": {
                "scope": {**_STR, "description": "'all', a sport_key, or a leaf_key"},
                "format": {"type": "string", "enum": sorted(VALID_FORMATS)},
                "group_size": {**_INT, "description": "Target teams per group (groups_knockout)"},
                "advance_per_group": {**_INT, "description": "Teams advancing per group"},
                "balance_groups": {**_BOOL, "description": "FIFA-style even group sizes"},
            },
            "required": ["scope", "format"],
        },
    },
    {
        "name": "add_or_update_venue",
        "description": ("Create or update a venue by name. courts = parallel "
                        "matches it can run. sports = sport_keys it is dedicated "
                        "to (empty = any)."),
        "parameters": {
            "type": "object",
            "properties": {
                "name": _STR,
                "venue_type": {"type": "string", "enum": ["ground", "court", "hall"]},
                "courts": _INT,
                "sports": {"type": "array", "items": _STR},
                "open_from": {**_STR, "description": "HH:MM, optional"},
                "until": {**_STR, "description": "HH:MM, optional"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "remove_venue",
        "description": "Delete a venue by name.",
        "parameters": {"type": "object", "properties": {"name": _STR}, "required": ["name"]},
    },
    {
        "name": "add_clash_rule",
        "description": ("Stop competitions from running at the same time (e.g. "
                        "girls in two sports). members = leaf_keys and/or "
                        "sport_keys."),
        "parameters": {
            "type": "object",
            "properties": {
                "members": {"type": "array", "items": _STR},
                "gap_minutes": _INT,
            },
            "required": ["members"],
        },
    },
    {
        "name": "set_concurrency_cap",
        "description": ("Cap how many matches run at once. scope = 'all' or a "
                        "sport_key (e.g. only 2 umpires)."),
        "parameters": {
            "type": "object",
            "properties": {"scope": _STR, "count": _INT},
            "required": ["scope", "count"],
        },
    },
    {
        "name": "set_session_window",
        "description": ("Pin a competition or sport to a daily time window "
                        "(e.g. U-14 in the mornings). scope = a leaf_key or "
                        "sport_key."),
        "parameters": {
            "type": "object",
            "properties": {
                "scope": _STR,
                "from": {**_STR, "description": "HH:MM"},
                "to": {**_STR, "description": "HH:MM"},
                "days": {"type": "array", "items": {"type": "string", "description": "mon..sun"}},
            },
            "required": ["scope", "from", "to"],
        },
    },
    {
        "name": "get_setup_state",
        "description": "Re-read the current setup (dates, venues, formats, competitions, rules).",
        "parameters": {"type": "object", "properties": {}},
    },
]
