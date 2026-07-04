"""House points — the season-level standings layer for institution operators
(P4; institutions-as-users: the sports day / inter-house spine).

One school year's results and judged awards (march past, drill, discipline
shields) accumulate into a single house table. The ledger is APPEND-ONLY
(mirroring the event-sourced scoring discipline): a correction appends a
compensating row, never edits. Points profiles are data (the Indian
7-5-4-3-2-1 convention ships as a preset with meet mode) — presets, never
prisons.
"""
from __future__ import annotations

import uuid as _uuid

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.teams.models import HousePointEntry, HousePointSource, Season, TeamGroup


def award_house_points(
    *,
    season: Season,
    group: TeamGroup,
    points: int,
    reason: str,
    by=None,
    source: str = HousePointSource.JUDGED,
    tournament=None,
    event_id: _uuid.UUID | None = None,
    request=None,
) -> HousePointEntry:
    """Append one ledger row (positive or compensating-negative), idempotent
    on the client event_id, audited. ``reason`` is mandatory — every point on
    the notice board must be explainable."""
    if not (reason or "").strip():
        raise ValidationError("house_points_reason_required")
    if group.season_id != season.id:
        raise ValidationError("group_not_in_season")
    if source not in HousePointSource.values:
        raise ValidationError("invalid_house_points_source")

    with transaction.atomic():
        if event_id is not None:
            prior = HousePointEntry.objects.filter(event_id=event_id).first()
            if prior is not None:
                return prior
        entry = HousePointEntry.objects.create(
            organization=season.organization,
            season=season,
            group=group,
            tournament=tournament,
            points=int(points),
            reason=reason.strip()[:200],
            source=source,
            awarded_by=by,
            event_id=event_id,
        )
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN if by is not None else ActorRole.SYSTEM,
            event_type="house_points_awarded",
            target_type="team_group",
            target_id=group.id,
            organization_id=season.organization_id,
            tournament_id=tournament.id if tournament is not None else None,
            idempotency_key=event_id,
            reason=entry.reason,
            payload_after={
                "season": str(season.id), "group": group.name,
                "points": entry.points, "source": entry.source,
            },
            request=request,
        )
    return entry


def season_house_table(season: Season) -> list[dict]:
    """The live house table: per-group point totals, ranked. Groups with no
    entries still appear at 0 — day zero shows the board, not a sentence."""
    totals: dict = {}
    for g in TeamGroup.objects.filter(season=season).order_by("name"):
        totals[g.id] = {
            "group_id": str(g.id),
            "name": g.name,
            "kind": g.kind,
            "colour": g.colour,
            "points": 0,
            "entries": 0,
        }
    from django.db.models import Count, Sum

    for agg in (
        HousePointEntry.objects.filter(season=season)
        .values("group_id")
        .annotate(total=Sum("points"), n=Count("id"))
    ):
        r = totals.get(agg["group_id"])
        if r is not None:
            r["points"] = agg["total"] or 0
            r["entries"] = agg["n"]
    rows = list(totals.values())
    rows.sort(key=lambda r: (-r["points"], r["name"]))
    return rows
