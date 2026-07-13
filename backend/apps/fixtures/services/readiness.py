"""Fixture-readiness checklist (fixture-engine redesign spec §5.1).

Server-computed — the FE never replicates this logic. Global checks (calendar,
venues, constraints review) plus one block per competition (category leaf)
with fix deep-link keys the hub turns into actions. Statuses: ``ok`` /
``warn`` (informational, never gates) / ``fail`` (gates the dry-run CTA).

Amendments honored: §9 A6 (a 1-team leaf fails with "add entries or cancel" —
no auto-champion in v1), §9 A8 (``seeding=seeded`` and ``keep_apart
key=seed_pot`` both FAIL while any team in scope lacks a seed), §9 A10
(``constraints_reviewed_at`` goes stale — warn — when settings change after
the review).
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from django.utils.translation import gettext as _


def _check(check_id: str, status: str, hint: str = "", fix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {"id": check_id, "status": status}
    if hint:
        out["hint"] = hint
    if fix:
        out["fix"] = fix
    return out


def _parse_reviewed_at(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def _latest_settings_change_at(tournament) -> datetime | None:
    """Most recent rules/constraints/calendar change — the §9 A10 staleness
    signal (constraint edits flow through ``tournament_settings_updated``)."""
    from apps.audit.models import AuditEvent

    return (
        AuditEvent.objects.filter(
            event_type="tournament_settings_updated",
            target_type="tournament",
            target_id=tournament.id,
        )
        .order_by("-created_at")
        .values_list("created_at", flat=True)
        .first()
    )


def _reviewed_check(reviewed_at_raw: Any, changed_at: datetime | None) -> dict:
    reviewed_at = _parse_reviewed_at(reviewed_at_raw)
    if reviewed_at is None:
        return _check(
            "constraints_reviewed", "warn",
            _("Constraints have not been marked reviewed."), "constraints",
        )
    if changed_at is not None and changed_at > reviewed_at:
        return _check(
            "constraints_reviewed", "warn",
            _("Constraints changed after the last review — review again."),
            "constraints",
        )
    return _check("constraints_reviewed", "ok")


def _estimate_leaf_matches(tournament, leaf_key: str, n: int) -> int:
    """Coarse match-count estimate for one leaf with ``n`` teams — the
    capacity warning only (generation stays authoritative). Walks the
    effective stage plan: full round robins per balanced group, then
    knockout entrants from the prior stage's group count."""
    from apps.fixtures.services.draw_config import (
        effective_draw_config,
        effective_stages,
    )
    from apps.fixtures.services.generate import balanced_group_sizes

    if n < 2:
        return 0
    cfg = effective_draw_config(tournament, leaf_key)
    total = 0
    entrants = n
    prev_groups = 1
    for st in effective_stages(tournament, leaf_key, cfg):
        kind = str(st.get("type") or "")
        if kind == "round_robin":
            g = int(st.get("group_size") or 0) or entrants
            sizes = balanced_group_sizes(entrants, g)
            total += sum(s * (s - 1) // 2 for s in sizes)
            prev_groups = len(sizes)
        elif kind == "knockout":
            frm = st.get("from") or {}
            if frm:
                entrants = (
                    int(frm.get("advance_per_group") or 1) * prev_groups
                    + int(frm.get("advance_best_thirds") or 0)
                )
            k = max(entrants, 2)
            total += (k - 1) + (1 if st.get("third_place") else 0)
        elif kind == "double_elimination":
            total += max(2 * entrants - 2, 1)
        else:  # swiss and anything unknown — coarse
            total += entrants
    return total


def _capacity_check(tournament, teams_by_leaf: dict[str, list]) -> dict | None:
    """Demand vs supply feasibility estimate (audit 2026-07-13: a 2.3x
    oversubscribed tournament read fully "Ready"). Coarse on purpose — it
    warns, never gates. None when the calendar isn't set yet."""
    from datetime import date as _date
    from datetime import datetime as _dt

    from apps.fixtures.models import Venue
    from apps.fixtures.services.draw_config import effective_draw_config
    from apps.tournaments.services.sports import iter_leaves

    cal = ((tournament.draw_config or {}).get("*") or {}).get("calendar") or {}

    def _d(v: Any) -> _date | None:
        try:
            return _date.fromisoformat(str(v)[:10]) if v else None
        except ValueError:
            return None

    def _minutes(frm: Any, to: Any) -> int:
        try:
            a = _dt.strptime(str(frm), "%H:%M")
            b = _dt.strptime(str(to), "%H:%M")
        except ValueError:
            return 0
        return max(int((b - a).total_seconds() // 60), 0)

    ds, de = _d(cal.get("date_start")), _d(cal.get("date_end"))
    day_minutes = _minutes(cal.get("daily_start"), cal.get("daily_end"))
    if ds is None or day_minutes <= 0:
        return None
    days = ((de or ds) - ds).days + 1

    # Tournament-wide daily breaks shrink every day; ceremonies one day each.
    break_minutes = 0
    ceremony_minutes = 0
    capacity_caps: dict[str, int] = {}
    for c in tournament.constraints or []:
        if not isinstance(c, dict) or not c.get("hard", True):
            continue
        p = c.get("params") or {}
        ctype = c.get("type")
        if ctype == "recurring_blackout_window" and not p.get("days") \
                and str(c.get("scope") or "all") == "all":
            break_minutes += _minutes(p.get("from"), p.get("to"))
        elif ctype == "ceremony_block" and not p.get("venues"):
            ceremony_minutes += _minutes(p.get("from"), p.get("to"))
        elif ctype == "official_capacity":
            scope = str(c.get("scope") or "")
            if scope.startswith("sport:"):
                capacity_caps[scope[6:]] = int(p.get("count") or 0)

    net_day = max(day_minutes - break_minutes, 0)
    venues = list(
        Venue.objects.filter(
            organization=tournament.organization, deleted_at__isnull=True
        ).values("count", "sports")
    )
    if not venues:
        return None
    courts_total = sum(max(1, int(v["count"] or 1)) for v in venues)

    def _courts_for(sport: str) -> int:
        n = sum(
            max(1, int(v["count"] or 1))
            for v in venues
            if not v["sports"] or sport in v["sports"]
        )
        return n or courts_total

    # Demand per sport (estimated matches x duration).
    demand: dict[str, int] = {}
    slot_fallback = int(cal.get("slot_minutes") or 30)
    for leaf in iter_leaves(tournament.sports):
        leaf_key = leaf["leaf_key"]
        n = len(teams_by_leaf.get(leaf_key, []))
        est = _estimate_leaf_matches(tournament, leaf_key, n)
        if not est:
            continue
        dur = int(
            effective_draw_config(tournament, leaf_key).get(
                "match_duration_minutes"
            ) or slot_fallback
        )
        sport = leaf.get("sport_key") or leaf_key.split(".")[0]
        demand[sport] = demand.get(sport, 0) + est * dur
    if not demand:
        return None

    worst: tuple[float, str, int, int] | None = None
    for sport, need in demand.items():
        concurrency = _courts_for(sport)
        cap = capacity_caps.get(sport)
        if cap:
            concurrency = min(concurrency, cap)
        have = max((net_day * days - ceremony_minutes) * concurrency, 1)
        ratio = need / have
        if worst is None or ratio > worst[0]:
            worst = (ratio, sport, need, have)
    total_need = sum(demand.values())
    total_have = max((net_day * days - ceremony_minutes) * courts_total, 1)
    if worst and worst[0] > 1.0:
        _ratio, sport, need, have = worst
        return _check(
            "capacity", "warn",
            _(
                "Too tight: %(sport)s needs about %(need)d minutes of play "
                "but only about %(have)d minutes of court time exist. Add "
                "days or courts, or trim the format."
            ) % {"sport": sport, "need": need, "have": have},
            "settings",
        )
    if total_need > total_have:
        return _check(
            "capacity", "warn",
            _(
                "Too tight: about %(need)d minutes of matches vs about "
                "%(have)d minutes of court time. Add days or courts, or "
                "trim formats."
            ) % {"need": total_need, "have": total_have},
            "settings",
        )
    return _check("capacity", "ok")


def fixture_readiness(tournament) -> dict[str, Any]:
    """The §5.1 response body: ``{"global": {...}, "competitions": [...]}``."""
    from apps.fixtures.models import Venue
    from apps.fixtures.services.draw_config import effective_draw_config
    from apps.fixtures.services.generate import (
        compute_inputs_hash,
        pairing_scope_constraints,
    )
    from apps.matches.models import Match
    from apps.teams.models import Team, TeamStatus
    from apps.tournaments.services.sports import iter_leaves, leaf_label

    stored_cfg = tournament.draw_config or {}
    changed_at = _latest_settings_change_at(tournament)

    # ----------------------------------------------------------------- global
    # Step 1 keys off the CANONICAL global-setup stores the Step-1 wizard
    # writes: draw_config["*"].calendar dates + workspace Venue records.
    # Legacy ``Tournament.scheduling_config`` (persisted by old ad-hoc
    # schedule runs — dates + free-text venue names) deliberately does NOT
    # satisfy these checks; it remains a fallback for the scheduler engine
    # only (services/preview.py, repair.py).
    wizard_calendar = (stored_cfg.get("*") or {}).get("calendar") or {}
    if wizard_calendar.get("date_start"):
        calendar = _check("calendar_set", "ok")
    else:
        calendar = _check(
            "calendar_set", "fail",
            _("No tournament calendar yet — set the date range."), "settings",
        )
    has_venues = Venue.objects.filter(
        organization=tournament.organization, deleted_at__isnull=True
    ).exists()
    venues = (
        _check("venues_defined", "ok")
        if has_venues
        else _check(
            "venues_defined", "fail",
            _("No venues defined — add at least one."), "venues",
        )
    )
    global_checks = [
        calendar,
        venues,
        _reviewed_check(
            (stored_cfg.get("*") or {}).get("constraints_reviewed_at"), changed_at
        ),
    ]

    # ----------------------------------------------------------- competitions
    teams_by_leaf: dict[str, list] = {}
    for tm in Team.objects.filter(
        tournament=tournament, status=TeamStatus.REGISTERED, deleted_at__isnull=True
    ):
        teams_by_leaf.setdefault(tm.leaf_key or "", []).append(tm)
    hashes_by_leaf: dict[str, set[str]] = {}
    for leaf_key, ih in Match.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).values_list("leaf_key", "inputs_hash"):
        hashes_by_leaf.setdefault(leaf_key or "", set()).add(ih or "")

    competitions: list[dict[str, Any]] = []
    for leaf in iter_leaves(tournament.sports):
        leaf_key = leaf["leaf_key"]
        cfg = effective_draw_config(tournament, leaf_key)
        leaf_teams = teams_by_leaf.get(leaf_key, [])
        checks: list[dict[str, Any]] = []

        # enough_teams (§9 A6: prompt/cancel only — no auto-champion in v1)
        n = len(leaf_teams)
        if n >= 2:
            checks.append(_check(
                "enough_teams", "ok",
                _("%(count)d registered teams") % {"count": n},
            ))
        else:
            checks.append(_check(
                "enough_teams", "fail",
                _(
                    "%(count)d registered team(s) — minimum 2 "
                    "(add entries or cancel this competition)"
                ) % {"count": n},
                "teams",
            ))

        # format_chosen — ok once a format is explicitly stored anywhere in the
        # layering (leaf / sport / "*" / legacy rules); the default still
        # resolves. The sport layer is how the format board saves "all of a
        # sport plays X" — omitting it left per-sport picks reading as "no
        # format chosen" on the Ready-to-go cards (owner bug 2026-06-26).
        # A multi-stage plan is an explicit choice too: the format board stores
        # it under `stages`, not `format`, so a multi-stage pick must NOT warn
        # "no format chosen" / fall back to League (owner bug 2026-06-30).
        sport_key = leaf.get("sport_key") or leaf_key.split(".")[0]
        layers = (
            stored_cfg.get(leaf_key),
            stored_cfg.get(f"sport:{sport_key}"),
            stored_cfg.get("*"),
            tournament.rules,
        )
        stages = next(
            (layer["stages"] for layer in layers if (layer or {}).get("stages")),
            None,
        )
        if stages:
            checks.append(_check(
                "format_chosen", "ok",
                _("%(count)d stages") % {"count": len(stages)},
            ))
        elif any("format" in (layer or {}) for layer in layers):
            checks.append(_check("format_chosen", "ok", str(cfg.get("format"))))
        else:
            checks.append(_check(
                "format_chosen", "warn",
                _("No format chosen — the default (round robin) will be used."),
                "format",
            ))

        # seeds_set (§9 A8: seeded method OR a seed_pot keep-apart both fail
        # while any team in scope lacks a seed)
        needs_seeds = cfg.get("seeding") == "seeded" or any(
            (c.get("params") or {}).get("key") == "seed_pot"
            for c in pairing_scope_constraints(tournament, leaf_key)
        )
        missing = sorted(tm.name for tm in leaf_teams if tm.seed is None)
        if needs_seeds and missing:
            checks.append(_check(
                "seeds_set", "fail",
                _("Seeding requires seeds but %(count)d team(s) have none.")
                % {"count": len(missing)},
                "seeds",
            ))
        else:
            checks.append(_check("seeds_set", "ok"))

        checks.append(dict(calendar))
        checks.append(_reviewed_check(cfg.get("constraints_reviewed_at"), changed_at))

        # already_generated — informational (invariant 10): an existing draw
        # whose stored inputs_hash differs from the v2 recompute warns with a
        # diff deep-link; v1 hashes correctly read as changed (spec D9).
        stored_hashes = hashes_by_leaf.get(leaf_key)
        if not stored_hashes:
            checks.append(_check(
                "already_generated", "ok", _("No existing draw")))
        elif stored_hashes == {compute_inputs_hash(tournament, leaf_key)}:
            checks.append(_check(
                "already_generated", "ok",
                _("Draw generated — inputs unchanged"),
            ))
        else:
            checks.append(_check(
                "already_generated", "warn",
                _("A draw exists but its inputs have changed since."),
                "diff",
            ))

        gating = checks[:5]  # already_generated is informational
        competitions.append({
            "leaf_key": leaf_key,
            "label": leaf_label(tournament.sports, leaf_key),
            "ready": all(c["status"] != "fail" for c in checks),
            "summary": f"{sum(1 for c in gating if c['status'] == 'ok')}/{len(gating)}",
            "checks": checks,
        })

    cap = _capacity_check(tournament, teams_by_leaf)
    if cap is not None:
        global_checks.append(cap)

    return {"global": {"checks": global_checks}, "competitions": competitions}
