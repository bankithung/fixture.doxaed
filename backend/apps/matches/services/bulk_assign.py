"""Bulk crew assignment — assign one scorer/official to every match in a scope
(a court, a competition category/leaf, or a sport) in one action.

Loops the audited single-match services (`assign_scorer` / `assign_official`),
so every per-match guard still fires — membership check, append-only audit, the
soft double-booking warning. Per-match notifications are suppressed (``notify=
False``); the caller sends ONE summary instead of one email per match (prod SMTP
is real).

Scoping columns already exist on ``Match``: the ``court`` FK (2026-08-03 — the
court scope now keys on it, with a ``venue`` fallback for legacy NULL-court
rows), ``leaf_key`` and ``sport``. No migration is needed.
"""
from __future__ import annotations

import datetime as _dt
import logging
import uuid as _uuid

from django.core.exceptions import ValidationError
from django.db.models import F, Q

from apps.matches.models import Match
from apps.matches.services.officials import assign_official, official_clashes
from apps.matches.services.scoring import assign_scorer

_log = logging.getLogger(__name__)

VALID_SCOPES = ("court", "category", "sport")
# Mirrors MatchOfficialRole. `linesman` was missing, so sepak takraw crews
# (two linesmen at the diagonal corners) could not be bulk-assigned at all —
# added 2026-08-03. It is a read-only seat under the scoring gates, so it
# carries no permission risk.
OFFICIAL_ROLES = (
    "referee", "assistant", "fourth", "umpire", "commissioner", "linesman",
)


def _court_scope_q(key: str):
    """Court scope, keyed on the ``Match.court`` FK (indexed on
    ``("court","scheduled_at")``) rather than the denormalised ``venue``
    string.

    ``key`` is normally a Court UUID. Legacy rows written before the FK existed
    (and off-grid venue strings that have no Court row) still carry only
    ``venue``, so a UUID key ALSO matches ``court IS NULL AND venue ==
    <court.name>``. A non-UUID key is treated as the old venue string, which
    keeps every pre-FK caller working."""
    from apps.fixtures.models import Court

    try:
        court_id = _uuid.UUID(str(key))
    except (ValueError, AttributeError, TypeError):
        return Q(venue=key)  # legacy: the key IS the venue display string
    cond = Q(court_id=court_id)
    name = (
        Court.objects.filter(id=court_id).values_list("name", flat=True).first()
    )
    if name:
        cond |= Q(court__isnull=True, venue=name)
    return cond


def _matches_for(*, tournament, scope: str, key: str, day: _dt.date | None) -> list[Match]:
    """The tournament's matches in ``scope``==``key``, optionally on a single
    tournament-TZ ``day`` (invariant 14), in kickoff order."""
    qs = Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    if scope == "court":
        qs = qs.filter(_court_scope_q(key))
    elif scope == "category":
        qs = qs.filter(leaf_key=key)
    elif scope == "sport":
        qs = qs.filter(sport=key)
    else:  # pragma: no cover - guarded at the view
        raise ValidationError("invalid_scope")
    qs = qs.select_related("scorer", "court").prefetch_related("officials").order_by(
        F("scheduled_at").asc(nulls_last=True), "match_no"
    )
    matches = list(qs)
    if day is not None:
        from zoneinfo import ZoneInfo

        from django.utils import timezone as dj_tz

        try:
            tz = ZoneInfo(tournament.time_zone)
        except (KeyError, ValueError):
            tz = dj_tz.get_default_timezone()
        matches = [
            m
            for m in matches
            if m.scheduled_at is not None
            and dj_tz.localtime(m.scheduled_at, tz).date() == day
        ]
    return matches


def bulk_assign_crew(
    *,
    tournament,
    scope: str,
    key: str,
    day: _dt.date | None,
    role: str,
    user,
    only_unassigned: bool,
    by=None,
    request=None,
) -> dict:
    """Assign ``user`` as ``role`` (``"scorer"`` or an official role) to every
    match in the scope. ``only_unassigned`` skips matches that already carry a
    scorer (scorer role) or any official (official roles). Returns
    ``{"assigned","skipped","total","warnings"}``; ``warnings`` flags per-match
    double-bookings (soft, never blocking). Sends one summary notification."""
    matches = _matches_for(tournament=tournament, scope=scope, key=key, day=day)

    assigned = 0
    skipped = 0
    warnings: list[dict] = []
    for m in matches:
        if role == "scorer":
            if only_unassigned and m.scorer_id:
                skipped += 1
                continue
            assign_scorer(match=m, user=user, by=by, request=request, notify=False)
        else:
            if only_unassigned and m.officials.all():
                skipped += 1
                continue
            assign_official(
                match=m, user=user, role=role, by=by, request=request, notify=False
            )
            clashes = official_clashes(user=user, match=m)
            if clashes:
                warnings.append(
                    {
                        "match_id": str(m.id),
                        "code": "official_double_booked",
                        "count": len(clashes),
                    }
                )
        assigned += 1

    if assigned > 0 and (by is None or user.id != by.id):
        _notify_bulk(user=user, tournament=tournament, role=role, count=assigned)

    return {
        "assigned": assigned,
        "skipped": skipped,
        "total": len(matches),
        "warnings": warnings,
    }


def _notify_bulk(*, user, tournament, role: str, count: int) -> None:
    """One post-commit summary notification for the whole bulk (in-app + email
    per the user's prefs). Best-effort — never blocks the assignment."""
    from django.db import transaction

    verb = "score" if role == "scorer" else f"officiate ({role})"
    uid = user.id
    tid = tournament.id
    tname = tournament.name

    def _send() -> None:
        try:
            from django.contrib.auth import get_user_model

            from apps.notifications.services.dispatch import create_notification

            target = get_user_model().objects.filter(id=uid).first()
            if target is None:
                return
            create_notification(
                user=target,
                kind="match_assignment",
                title=f"You are assigned to {verb} {count} matches",
                body=f"{tname}. Open the officials board from this link.",
                url=f"/tournaments/{tid}/crew",
                tournament=tournament,
            )
        except Exception:  # pragma: no cover - notification must never block ops
            _log.exception("bulk assignment notification failed")

    transaction.on_commit(_send)
