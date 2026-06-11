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

    sched = tournament.scheduling_config or {}
    stored_cfg = tournament.draw_config or {}
    changed_at = _latest_settings_change_at(tournament)

    # ----------------------------------------------------------------- global
    if sched.get("date_start"):
        calendar = _check("calendar_set", "ok")
    else:
        calendar = _check(
            "calendar_set", "fail",
            _("No tournament calendar yet — set the date range."), "settings",
        )
    has_venues = bool(sched.get("venues")) or Venue.objects.filter(
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

        # format_chosen — ok once a format is explicitly stored anywhere in
        # the layering (leaf / "*" / legacy rules); the default still resolves.
        explicit = any(
            "format" in (layer or {})
            for layer in (
                stored_cfg.get(leaf_key),
                stored_cfg.get("*"),
                tournament.rules,
            )
        )
        if explicit:
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

    return {"global": {"checks": global_checks}, "competitions": competitions}
