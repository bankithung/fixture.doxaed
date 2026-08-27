"""The fixture EDIT workbench (owner ask, 2026-08-23).

A dedicated page where a host reshapes the drawn fixture BY HAND — swap two
matches' slots by dragging one row onto another, re-point a side through a
dropdown of the competition's registered teams, move a match to another
court or time — with every applied rule checked continuously and the whole
thing landing on the real fixture only when the host reviews and CONFIRMS.

The contract that shapes this module:

- **Nothing here touches the fixture until `apply_fixture_edits` runs.** The
  page holds edits as a DRAFT client-side; the server only ever answers
  "what would break?" (`validate_fixture_edits`) — the same
  `validate_schedule` the draw was built under, so the editor cannot be
  more permissive than the engine.
- **No free text.** Every editable value is chosen from a list the server
  supplies: teams scoped to the match's own competition leaf, courts that
  exist, times inside the tournament's configured windows.
- **Typed pointers stay typed (invariant 9).** A side fed by
  winner_of/loser_of/group_position is READ-ONLY — it says what it is
  waiting on, and only a genuinely direct side ("team"/"tbd") may be
  re-pointed. The bracket's shape is never hand-broken here.
- **Played matches are untouchable.** Only scheduled/postponed matches in
  scope, exactly like every other repair verb.
"""
from __future__ import annotations

import itertools
import uuid as _uuid
from datetime import datetime, timedelta
from typing import Any

from django.db import transaction

#: Side sources a manual team edit MAY re-point (invariant 9).
EDITABLE_SOURCE_TYPES = {"", "team", "tbd"}


def _movable_statuses() -> tuple[str, ...]:
    from apps.matches.models import MatchStatus

    return (MatchStatus.SCHEDULED, MatchStatus.POSTPONED)


def _tournament_tz(tournament):
    from zoneinfo import ZoneInfo


    return ZoneInfo(getattr(tournament, "time_zone", None) or "Asia/Kolkata")


def _serialize_match(
    m, crests: dict[str, str] | None = None,
    fixture_nos: dict[str, int] | None = None,
) -> dict[str, Any]:

    def src(side) -> dict[str, Any] | None:
        return dict(side) if side else None

    def side_editable(side_source) -> bool:
        t = str((side_source or {}).get("type") or "")
        if t not in EDITABLE_SOURCE_TYPES:
            return False
        # A resolved group_position slot is a POINTER result, but it is stored
        # as a plain team FK with a group_position source only until advance()
        # fills it; once filled the source stays group_position, so it reads
        # as read-only here — which is correct: the group decided it.
        return True

    return {
        "id": str(m.id),
        "match_no": m.match_no,
        # What the fixture CALLS this match (numbering.py) — the editor prints
        # this, not the tournament-wide `match_no`, so "Winner of M5" means the
        # same game here as on the public sheet.
        "fixture_no": (fixture_nos or {}).get(str(m.id)),
        "stage": m.stage,
        "stage_no": m.stage_no,
        "group_label": m.group_label,
        "round_no": m.round_no,
        "leaf_key": m.leaf_key,
        "sport": m.sport,
        "status": m.status,
        "scheduled_at": m.scheduled_at.isoformat() if m.scheduled_at else None,
        "court_id": str(m.court_id) if m.court_id else None,
        "venue": m.venue,
        "home_team": (
            {
                "id": str(m.home_team_id),
                "name": m.home_team.name,
                "short_name": getattr(m.home_team, "short_name", "") or "",
                # The school's badge - a signed capability URL like every
                # other fixture surface renders (crest resolver, one map).
                "crest": (crests or {}).get(str(m.home_team_id), ""),
            }
            if m.home_team_id else None
        ),
        "away_team": (
            {
                "id": str(m.away_team_id),
                "name": m.away_team.name,
                "short_name": getattr(m.away_team, "short_name", "") or "",
                "crest": (crests or {}).get(str(m.away_team_id), ""),
            }
            if m.away_team_id else None
        ),
        "home_source": src(m.home_source),
        "away_source": src(m.away_source),
        "home_editable": side_editable(m.home_source),
        "away_editable": side_editable(m.away_source),
        "editable": m.status in _movable_statuses(),
    }


def editable_fixture(tournament) -> dict[str, Any]:
    """Everything the edit page renders WITHOUT choosing free text."""
    from apps.fixtures.models import Court, Venue
    from apps.teams.models import Team
    from apps.tournaments.services.sports import iter_leaves

    matches = list(
        tournament.matches.filter(deleted_at__isnull=True)
        .select_related("home_team", "away_team", "court", "home_team__institution",
                        "away_team__institution")
        .order_by("stage_no", "round_no", "match_no")
    )
    from apps.teams.services.crest import crest_map

    crest_urls = crest_map(
        [tm for m in matches for tm in (m.home_team, m.away_team) if tm]
    )
    from apps.matches.services.numbering import number_rows

    fixture_nos = number_rows(matches)
    rows = [_serialize_match(m, crest_urls, fixture_nos) for m in matches]

    # Dropdown options: each competition leaf offers ITS OWN registered teams.
    teams_by_leaf: dict[str, list[dict[str, Any]]] = {}
    for t in Team.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).exclude(status__in=["withdrawn", "rejected", "disqualified"]).order_by("name"):
        teams_by_leaf.setdefault(t.leaf_key or "", []).append(
            {"id": str(t.id), "name": t.name}
        )

    courts = [
        {
            "id": str(c.id),
            "name": c.name,
            "venue_name": c.venue.name,
        }
        for c in Court.objects.filter(
            organization=tournament.organization, deleted_at__isnull=True
        )
        .select_related("venue")
        .order_by("venue__name", "index", "name")
    ]
    venues = list(
        Venue.objects.filter(
            organization=tournament.organization, deleted_at__isnull=True
        ).values_list("name", flat=True)
    )
    days = sorted(
        {r["scheduled_at"][:10] for r in rows if r["scheduled_at"]}
    )
    leaves = [
        {"leaf_key": lf.get("leaf_key"), "label": lf.get("label")}
        for lf in iter_leaves(tournament.sports or [])
        if lf.get("leaf_key")
    ]
    # Students per team, so the workbench's "show students" toggle can reveal
    # WHO each side fields without leaving the spreadsheet.
    players_by_team: dict[str, list[dict[str, Any]]] = {}
    from apps.teams.models import Player as _Player

    for p in (
        _Player.objects.filter(
            tournament=tournament, deleted_at__isnull=True
        ).select_related("person")
        .order_by("team_id", "jersey_no", "person__full_name")
    ):
        players_by_team.setdefault(str(p.team_id), []).append(
            {
                "id": str(p.id),
                "name": p.person.full_name,
                "jersey_no": p.jersey_no,
                "captain": p.captain,
            }
        )

    # Sport names for the workbench's bookmark tabs (a leaf label reads
    # "U-14 · Boys · Singles" — the SPORT name lives on the tournament's
    # sports list, not on any leaf).
    sports = [
        {"key": s.get("key"), "name": s.get("name") or s.get("key")}
        for s in (tournament.sports or [])
        if isinstance(s, dict) and s.get("key")
    ]
    return {
        "matches": rows,
        "sports": sports,
        "players_by_team": players_by_team,
        "teams_by_leaf": teams_by_leaf,
        "courts": courts,
        "venues": venues,
        "days": days,
        "leaves": leaves,
        "time_zone": tournament.time_zone,
    }


def _parse_edits(tournament, edits: dict[str, Any]) -> tuple[dict, dict]:
    """Split the draft into `{match_id: (naive-local start, venue-name)}` slot
    moves and `{match_id: {"home": id|None, "away": id|None}}` team sets,
    validating shape and SCOPE (the match must belong to this tournament and
    be movable). Raises ValidationError on anything malformed."""
    from django.core.exceptions import ValidationError

    from apps.matches.models import Match

    slots: dict[_uuid.UUID, tuple[datetime, str]] = {}
    teams: dict[_uuid.UUID, dict[str, Any]] = {}

    allowed = (
        Match.objects.filter(
            tournament=tournament, deleted_at__isnull=True
        ).select_related("court", "court__venue")
    )
    by_id = {str(m.id): m for m in allowed}

    tz = _tournament_tz(tournament)
    for raw in edits.get("slots") or []:
        mid = str(raw.get("match_id") or "")
        m = by_id.get(mid)
        if m is None:
            raise ValidationError("unknown_match")
        if m.status not in _movable_statuses():
            raise ValidationError("match_not_movable")
        try:
            start = datetime.fromisoformat(str(raw.get("start")))
        except (TypeError, ValueError):
            raise ValidationError("invalid_start") from None
        if start.tzinfo is not None:
            start = start.astimezone(tz).replace(tzinfo=None)
        court_id = raw.get("court_id")
        # Venue name comes FROM the court row — never typed by hand.
        venue_name = ""
        if court_id:
            from apps.fixtures.models import Court

            c = Court.objects.filter(
                organization=tournament.organization,
                id=court_id,
                deleted_at__isnull=True,
            ).first()
            if c is None:
                raise ValidationError("unknown_court")
            venue_name = c.name
        else:
            venue_name = str(raw.get("venue") or "")
            if venue_name:
                from apps.fixtures.models import Venue

                if not Venue.objects.filter(
                    organization=tournament.organization,
                    name=venue_name,
                    deleted_at__isnull=True,
                ).exists():
                    raise ValidationError("unknown_venue")
        slots[m.id] = (start, venue_name)

    for raw in edits.get("teams") or []:
        mid = str(raw.get("match_id") or "")
        m = by_id.get(mid)
        if m is None:
            raise ValidationError("unknown_match")
        if m.status not in _movable_statuses():
            raise ValidationError("match_not_movable")
        change: dict[str, Any] = {}
        for side in ("home", "away"):
            if side in raw:
                tid = raw.get(side)
                if tid is None:
                    change[side] = None
                else:
                    team = tournament.teams.filter(
                        id=tid, deleted_at__isnull=True
                    ).first()
                    if team is None:
                        raise ValidationError("team_not_in_tournament")
                    if (team.leaf_key or "") != (m.leaf_key or ""):
                        raise ValidationError("team_wrong_competition")
                    change[side] = team
        source_map = {"home": m.home_source, "away": m.away_source}
        for side in change:
            stype = str((source_map[side] or {}).get("type") or "")
            if stype not in EDITABLE_SOURCE_TYPES:
                raise ValidationError(f"side_not_editable_{side}")
        teams[m.id] = change
    return slots, teams


def _student_rest_violations(
    tournament,
    assignments: dict[str, tuple[datetime, str]],
    reqs,
    cfg,
    match_cache: dict[str, Any],
) -> list[dict[str, Any]]:
    """Per-STUDENT rest breaks across DIFFERENT teams (the hole the school
    and team-level rules cannot see: a girl fielded by her school's doubles
    pair AND her singles entry). A constraint record is NOT required - the
    workbench judges the actual rosters against the sport's own rest rule."""
    from apps.fixtures.services.repair import _duration_minutes
    from apps.teams.models import Player

    # Required rest per sport, from the tournament's min_rest_minutes records.
    rest_by_sport: dict[str, int] = {}
    global_rest = 5
    for c in tournament.constraints or []:
        if not isinstance(c, dict) or c.get("type") != "min_rest_minutes":
            continue
        minutes = int((c.get("params") or {}).get("minutes") or 0)
        scope = str(c.get("scope") or "")
        if scope.startswith("sport:"):
            rest_by_sport[scope.split(":", 1)[1]] = minutes
        elif scope == "all" or scope == "":
            global_rest = minutes

    dur_by_match = {
        r.id: timedelta(
            minutes=_duration_minutes(tournament, r.sport, cfg.slot_minutes)
        )
        for r in reqs
    }

    # person -> [(match_id, start, end)]
    by_person: dict[int, list[tuple[str, datetime, datetime]]] = {}
    rows = (
        Player.objects.filter(tournament=tournament, deleted_at__isnull=True)
        .select_related("person", "team")
    )
    for p in rows:
        tid = str(p.team_id)
        for mid, (start, _venue) in assignments.items():
            m = match_cache.get(mid)
            if m is None or tid not in (str(m.home_team_id), str(m.away_team_id)):
                continue
            end = start + dur_by_match.get(mid, timedelta(minutes=cfg.slot_minutes))
            by_person.setdefault(p.person_id, []).append((mid, start, end))

    out: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for pid, slots in by_person.items():
        if len(slots) < 2:
            continue
        from apps.teams.models import Person

        name = (
            Person.objects.filter(id=pid)
            .values_list("full_name", flat=True)
            .first()
            or "?"
        )
        ordered = sorted(slots, key=lambda x: x[1])
        for (a_mid, _a_start, a_end), (b_mid, b_s, _b_e) in itertools.pairwise(
            ordered
        ):
            if b_s >= a_end and (b_s - a_end).total_seconds() / 60 >= _rest_for(
                b_mid, rest_by_sport, global_rest, match_cache
            ):
                continue
            key = (*sorted([a_mid, b_mid]), pid)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "code": "insufficient_student_rest",
                "hard": True,
                "match_id": b_mid,
                "other_match_id": a_mid,
                "student": name,
                "gap_minutes": max(0, round((b_s - a_end).total_seconds() / 60)),
                "required_minutes": _rest_for(
                    b_mid, rest_by_sport, global_rest, match_cache
                ),
            })
    return out


def _rest_for(mid, rest_by_sport, global_rest, cache) -> int:
    m = cache.get(mid)
    sport = getattr(m, "sport", "") if m else ""
    return rest_by_sport.get(sport, global_rest)


def validate_fixture_edits(tournament, edits: dict[str, Any]) -> dict[str, Any]:
    """Run the FULL rule set over the proposed schedule and report what breaks.

    Returns ``{"violations": [...], "new_violations": [...]}`` — the same
    structured records `validate_schedule` emits (stable codes, JSON-safe).
    A violation carries ``"pre_existing": true`` when the CURRENT fixture
    already breaks that same rule, so the page can say "this move creates a
    new clash" instead of blaming the editor for an old one.
    """
    from apps.fixtures.services.repair import (
        _local,
        _validation_config,
        _violation_identity,
    )
    from apps.fixtures.services.scheduler import (
        build_schedule_inputs,
        validate_schedule,
    )
    from apps.matches.models import Match

    slots, teams = _parse_edits(tournament, edits or {})
    cfg = _validation_config(tournament)
    tz = _tournament_tz(tournament)
    reqs, preoccupied, linked = build_schedule_inputs(tournament, cfg)

    # Re-point the reqs' sides to the DRAFT teams so team-based rules
    # (overlaps, shared-player links, blackouts, keep-aparts) judge what the
    # host is ABOUT to field, not yesterday's pairing.
    by_id = {r.id: r for r in reqs}
    for mid, change in teams.items():
        r = by_id.get(str(mid))
        if r is None:
            continue
        if "home" in change:
            r.home = str(change["home"].id) if change["home"] else None
        if "away" in change:
            r.away = str(change["away"].id) if change["away"] else None

    current: dict[str, tuple[datetime, str]] = {}
    db_rows = Match.objects.filter(
        tournament=tournament,
        id__in=[r.id for r in reqs],
        deleted_at__isnull=True,
    ).select_related("court", "home_team", "away_team")
    # The student-rest helper reads matches by id; keep them at hand.
    match_cache = {str(m.id): m for m in db_rows}
    for m in db_rows:
        if m.scheduled_at is not None:
            current[str(m.id)] = (_local(m.scheduled_at, tz), m.venue)

    proposed = dict(current)
    for mid, (start, venue) in slots.items():
        proposed[str(mid)] = (start, venue)

    baseline = validate_schedule(
        dict(current), reqs, cfg, preoccupied=preoccupied, linked=linked
    )
    baseline_student = _student_rest_violations(
        tournament, current, reqs, cfg, match_cache
    )
    pre_existing = {_violation_identity(v) for v in baseline}
    # Same identity function for BOTH families so "already broken" is judged
    # one way.
    pre_existing |= {_violation_identity(v) for v in baseline_student}
    violations = validate_schedule(
        proposed, reqs, cfg, preoccupied=preoccupied, linked=linked
    ) + _student_rest_violations(
        tournament, proposed, reqs, cfg, match_cache
    )
    out = []
    for v in violations:
        rec = dict(v)
        rec["pre_existing"] = _violation_identity(v) in pre_existing
        out.append(rec)
    out.sort(key=lambda v: (not v.get("pre_existing", False), str(v.get("code"))))
    return {
        "violations": out,
        "new_violations": [v for v in out if not v.get("pre_existing", False)],
        "slot_count": len(slots),
        "team_count": len(teams),
    }


def apply_fixture_edits(
    *,
    tournament,
    edits: dict[str, Any],
    by,
    event_id: _uuid.UUID | str | None = None,
    request=None,
) -> dict[str, Any]:
    """Commit the reviewed draft onto the REAL fixture, atomically.

    Hard NEW violations refuse the apply (409 at the view) unless the caller
    passes ``force`` — the same semantics as every other repair verb. One
    audit row covers the batch; the pre-change fixture is snapshotted first
    so the whole edit is one undoable step (fixture-versions page)."""
    from django.core.exceptions import ValidationError

    from apps.audit.models import ActorRole, AuditEvent
    from apps.audit.services import emit_audit
    from apps.fixtures.models import FixtureSnapshot
    from apps.fixtures.services.courts import resolve_court
    from apps.fixtures.services.repair import _publish_schedule_ticks
    from apps.fixtures.services.snapshots import capture_quiet
    from apps.matches.models import Match

    force = bool(edits.pop("_force", False))
    report = validate_fixture_edits(tournament, edits)
    if report["new_violations"] and not force:
        raise ValidationError("new_violations")

    eid: _uuid.UUID | None = None
    if event_id:
        eid = _uuid.UUID(str(event_id)) if not isinstance(event_id, _uuid.UUID) else event_id
        prior = AuditEvent.objects.filter(
            idempotency_key=eid, event_type="fixture_manually_edited"
        ).first()
        if prior is not None:
            counts = (prior.payload_after or {}).get("counts") or {}
            return {"applied": False, "replayed": True, **counts}

    slots, teams = _parse_edits(tournament, edits or {})
    touched: list[Any] = []
    before_payload: list[dict[str, Any]] = []
    after_payload: list[dict[str, Any]] = []

    with transaction.atomic():
        capture_quiet(tournament, kind=FixtureSnapshot.Kind.MANUAL,
                      label="Before manual edit")

        for mid, (start, venue_name) in slots.items():
            m = Match.objects.select_for_update().get(pk=mid)
            before_payload.append({"id": str(m.id), "scheduled_at": (
                m.scheduled_at.isoformat() if m.scheduled_at else None),
                "venue": m.venue})
            naive_local = start.replace(tzinfo=None)
            tz = _tournament_tz(tournament)
            m.scheduled_at = naive_local.replace(tzinfo=tz)
            m.venue = venue_name
            m.court = resolve_court(m.organization, venue_name)
            m.save(update_fields=["scheduled_at", "venue", "court", "updated_at"])
            touched.append(m.id)
            after_payload.append({
                "id": str(m.id),
                "scheduled_at": m.scheduled_at.isoformat(),
                "venue": m.venue,
            })

        for mid, change in teams.items():
            m = Match.objects.select_for_update().get(pk=mid)
            before_payload.append({
                "id": str(m.id),
                "home_team": str(m.home_team_id) if m.home_team_id else None,
                "away_team": str(m.away_team_id) if m.away_team_id else None,
            })
            if "home" in change:
                m.home_team = change["home"]
                if change["home"] is not None:
                    m.home_source = {"type": "team", "team_id": str(change["home"].id)}
            if "away" in change:
                m.away_team = change["away"]
                if change["away"] is not None:
                    m.away_source = {"type": "team", "team_id": str(change["away"].id)}
            m.save(update_fields=[
                "home_team", "away_team", "home_source", "away_source", "updated_at",
            ])
            touched.append(m.id)
            after_payload.append({
                "id": str(m.id),
                "home_team": str(m.home_team_id) if m.home_team_id else None,
                "away_team": str(m.away_team_id) if m.away_team_id else None,
            })

        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="fixture_manually_edited",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            idempotency_key=eid,
            payload_after={
                "counts": {"slots": len(slots), "teams": len(teams)},
                "before": before_payload,
                "after": after_payload,
            },
            request=request,
        )

    if touched:
        _publish_schedule_ticks(tournament.id, touched)
    return {
        "applied": True,
        "replayed": False,
        "counts": {"slots": len(slots), "teams": len(teams)},
        "violations": report["violations"],
    }
