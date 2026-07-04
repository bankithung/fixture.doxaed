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

# The canonical Indian school convention (Kerala Sports Manual / CBSE):
# places 1-6 score 7-5-4-3-2-1, doubled for relays. A custom points ladder
# always wins — presets, never prisons.
DEFAULT_PLACE_POINTS: tuple[int, ...] = (7, 5, 4, 3, 2, 1)


def record_meet_event_result(
    *,
    season: Season,
    event_label: str,
    placements: list,
    by=None,
    relay: bool = False,
    place_points: tuple[int, ...] | list[int] | None = None,
    tournament=None,
    event_id: _uuid.UUID | None = None,
    request=None,
) -> list[HousePointEntry]:
    """MEET MODE (P4): one event's ordered placements become house points in
    a single write. ``placements`` = TeamGroup rows (or ids) in finishing
    order; place N earns place_points[N-1] (x2 for relays). Idempotent per
    (event_id, place) via derived uuid5 keys, so a replayed sports-day sheet
    never double-scores; entries land as source=result with the event label
    as the reason.
    """
    if not (event_label or "").strip():
        raise ValidationError("meet_event_label_required")
    ladder = [int(x) for x in (place_points or DEFAULT_PLACE_POINTS)]
    if not ladder or any(x < 0 for x in ladder):
        raise ValidationError("invalid_place_points")
    factor = 2 if relay else 1

    groups: list[TeamGroup] = []
    for item in placements:
        g = item if isinstance(item, TeamGroup) else TeamGroup.objects.filter(
            pk=item, season=season
        ).first()
        if g is None or g.season_id != season.id:
            raise ValidationError("group_not_in_season")
        groups.append(g)
    if len({g.id for g in groups}) != len(groups):
        raise ValidationError("duplicate_placement")

    entries: list[HousePointEntry] = []
    label = event_label.strip()
    with transaction.atomic():
        for place, group in enumerate(groups, start=1):
            if place > len(ladder):
                break  # places beyond the ladder score nothing
            pts = ladder[place - 1] * factor
            derived = (
                _uuid.uuid5(_uuid.NAMESPACE_URL, f"meet:{event_id}:{place}")
                if event_id is not None else None
            )
            entries.append(
                award_house_points(
                    season=season,
                    group=group,
                    points=pts,
                    reason=f"{label}: place {place}"[:200],
                    by=by,
                    source=HousePointSource.RESULT,
                    tournament=tournament,
                    event_id=derived,
                    request=request,
                )
            )
    return entries

