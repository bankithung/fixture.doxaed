from __future__ import annotations

from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.fixtures.models import Venue
from apps.fixtures.services.draw_config import (
    DEFAULT_DRAW_CONFIG,
    effective_draw_config,
    leaf_has_matches,
    update_draw_config,
)
from apps.fixtures.services.generate import (
    compute_inputs_hash,
    generate_for_leaf,
    generate_swiss_next_round,
)
from apps.fixtures.services.preview import (
    preview_all_fixtures,
    preview_fixtures,
    stored_venue_records,
)
from apps.fixtures.services.readiness import fixture_readiness
from apps.fixtures.services.scheduler import apply_schedule
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_access_module
from apps.tournaments.scope import accessible_tournaments


def _inputs_drift_409(request, tournament, leaf_key: str) -> Response | None:
    """Optimistic-concurrency guard on the Accept path (redesign §9 A1/D10):
    when the caller carries the previewed ``expected_inputs_hash`` and the
    stored inputs have drifted since (new registration, config edit), answer
    409 with the fresh hash + a readiness pointer instead of committing a
    draw that no longer matches what was previewed."""
    expected = str(request.data.get("expected_inputs_hash") or "")
    if not expected:
        return None
    current = compute_inputs_hash(tournament, leaf_key or None)
    if current == expected:
        return None
    return Response(
        {
            "detail": "inputs_changed",
            "inputs_hash": current,
            "leaf_key": leaf_key,
            "readiness": f"/api/tournaments/{tournament.id}/fixture-readiness/",
        },
        status=409,
    )


class GenerateFixturesView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.bracket_editor"):
            raise PermissionDenied("not_tournament_manager")
        # Optional competition scope (spec 2026-06-10): generate one category
        # leaf's draw independently; omit for the legacy whole-tournament run.
        leaf_key = str(request.data.get("leaf_key") or "")
        drifted = _inputs_drift_409(request, t, leaf_key)
        if drifted is not None:
            return drifted
        # Effective config layering (redesign spec §2.1/§4.5): defaults <
        # legacy rules keys < draw_config["*"] < draw_config[leaf] < explicit
        # request params. A bare body of {leaf_key} works once the wizard has
        # saved the format via the draw-config PATCH.
        overrides = {
            k: request.data.get(k)
            for k in (
                "format", "group_size", "advance_per_group",
                "advance_best_thirds", "third_place", "plate", "legs",
                "seeding", "knockout_seeding", "seed", "swiss_rounds",
            )
            if k in request.data
        }
        cfg = effective_draw_config(t, leaf_key or None, overrides=overrides)
        fmt = str(cfg.get("format") or "round_robin")
        seeding = str(cfg.get("seeding") or "registration")
        seed = int(cfg["seed"]) if cfg.get("seed") is not None else None
        # Pairing-layer warnings (redesign §4.6): keep-apart records that had
        # to relax (best-effort) or skipped teams missing the key datum.
        warnings: list[dict] = []
        try:
            matches = generate_for_leaf(
                tournament=t, leaf_key=leaf_key, cfg=cfg, warnings=warnings,
            )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        # The seed the draw used (random seeding persists a fresh one into
        # draw_config — the generators update `t` in place) so callers can
        # replay/dispute the draw (§4.3, tenet 3).
        seed_used = seed
        if seed_used is None and seeding == "random":
            seed_used = ((t.draw_config or {}).get(leaf_key or "*") or {}).get("seed")
        return Response(
            {
                "generated": len(matches), "format": fmt, "leaf_key": leaf_key,
                "seed": seed_used, "warnings": warnings,
            },
            status=201,
        )


class SwissNextRoundView(GenericAPIView):
    """`POST /api/tournaments/{id}/fixtures/next-round/` — materialize the
    NEXT Swiss round from current standings (increment P). Body `{leaf_key?,
    event_id?}`. Gate: bracket_editor. Pairs by standings order (points —
    byes credited as wins — then GD), never repeating a previous pairing
    (greedy with backtracking); odd counts sit one team out (no second bye
    while anyone has had none). Refuses with 400 `round_incomplete` while the
    current round has unfinished matches, `swiss_not_started` before round 1,
    `swiss_complete` once the configured `swiss_rounds` exist. Idempotent per
    round on `event_id` (invariant 3) — a replay answers from the
    `swiss_round_generated` audit row instead of pairing again."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        import uuid as _uuid

        from apps.audit.models import AuditEvent

        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.bracket_editor"):
            raise PermissionDenied("not_tournament_manager")

        leaf_key = str(request.data.get("leaf_key") or "")
        event_id = None
        raw_eid = request.data.get("event_id")
        if raw_eid:
            try:
                event_id = _uuid.UUID(str(raw_eid))
            except ValueError:
                raise DRFValidationError({"detail": "invalid_event_id"}) from None
            prior = AuditEvent.objects.filter(
                idempotency_key=event_id, event_type="swiss_round_generated"
            ).first()
            if prior is not None:  # replay (invariant 3) — do NOT pair again
                return Response(prior.payload_after or {})

        # Round count from the STORED effective config (the endpoint takes no
        # overrides — the wizard saves swiss_rounds via the draw-config PATCH).
        cfg = effective_draw_config(t, leaf_key or None)
        warnings: list[dict] = []
        try:
            matches = generate_swiss_next_round(
                tournament=t,
                leaf_key=leaf_key or None,
                swiss_rounds=(
                    int(cfg["swiss_rounds"])
                    if cfg.get("swiss_rounds") is not None else None
                ),
                by=request.user, event_id=event_id, request=request,
                warnings=warnings,
            )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        # Same shape as the audited payload, so replays answer identically.
        return Response(
            {
                "generated": len(matches),
                "round_no": matches[0].round_no if matches else None,
                "leaf_key": leaf_key,
                "matches": [str(m.id) for m in matches],
                "warnings": warnings,
            },
            status=201,
        )


class ScheduleFixturesView(GenericAPIView):
    """POST /api/tournaments/{id}/schedule/ — run the FET-style engine over the
    tournament's matches with the wizard's constraint payload; persist + explain."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.schedule_editor"):
            raise PermissionDenied("not_tournament_manager")
        payload = dict(request.data or {})
        # Optional competition scope: schedule one leaf around everything else.
        leaf_key = str(payload.pop("leaf_key", "") or "")
        drifted = _inputs_drift_409(request, t, leaf_key)
        if drifted is not None:
            return drifted
        payload.pop("expected_inputs_hash", None)
        # No venues in the payload → the workspace's stored Venue records
        # (with their types + availability windows) are the resource pool.
        if not payload.get("venues"):
            stored = stored_venue_records(t)
            if stored:
                payload["venues"] = stored
        try:
            result = apply_schedule(
                tournament=t, config=payload, by=request.user, request=request,
                leaf_key=leaf_key or None,
            )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        return Response(
            {
                "scheduled": len(result.assignments),
                "unscheduled": result.unscheduled,
                "soft_score": result.soft_score,
                "explanation": result.explanation,
                # Structured infeasibility (redesign §3): stable codes +
                # concrete relaxations, localized client-side (§9 A5).
                "violations": result.violations,
                "leaf_key": leaf_key,
            }
        )


class TournamentFixtureReadinessView(GenericAPIView):
    """`GET /api/tournaments/{id}/fixture-readiness/` — the server-computed
    per-leaf readiness checklist (redesign spec §5.1). Gate: any tournament
    member (read-only; the FE never replicates the checks)."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        return Response(fixture_readiness(t))


class PreviewFixturesView(GenericAPIView):
    """`POST /api/tournaments/{id}/fixtures/preview/` — pure simulate
    (redesign spec §5.2, D6): persists nothing, no `event_id` (read-only
    POST). Gate: bracket_editor. Body `{leaf_key?, draw?, schedule?,
    include_schedule}`."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.bracket_editor"):
            raise PermissionDenied("not_tournament_manager")
        draw = request.data.get("draw")
        schedule = request.data.get("schedule")
        try:
            data = preview_fixtures(
                tournament=t,
                leaf_key=str(request.data.get("leaf_key") or "") or None,
                draw=draw if isinstance(draw, dict) else None,
                schedule=schedule if isinstance(schedule, dict) else None,
                include_schedule=bool(request.data.get("include_schedule", True)),
            )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        return Response(data)


class PreviewAllFixturesView(GenericAPIView):
    """`POST /api/tournaments/{id}/fixtures/preview-all/` — ONE combined dry-run
    across EVERY competition (all sports + categories), scheduled together so
    shared courts + cross-sport clashes are coordinated globally. Persists
    nothing (read-only POST, no `event_id`). Gate: bracket_editor. Body
    `{schedule?, include_schedule}`."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.bracket_editor"):
            raise PermissionDenied("not_tournament_manager")
        schedule = request.data.get("schedule")
        try:
            data = preview_all_fixtures(
                tournament=t,
                schedule=schedule if isinstance(schedule, dict) else None,
                include_schedule=bool(request.data.get("include_schedule", True)),
            )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        return Response(data)


class PublishAllFixturesView(GenericAPIView):
    """`POST /api/tournaments/{id}/fixtures/publish-all/` — generate EVERY
    competition's draw (idempotent: existing draws are kept) then schedule them
    ALL together in one run. The whole request is one transaction
    (ATOMIC_REQUESTS), so it commits all-or-nothing. Gates: bracket_editor
    (generate) + schedule_editor (schedule). Body `{schedule?}`."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        from apps.tournaments.services.sports import iter_leaves

        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not (
            can_access_module(request.user, t, "tournament.bracket_editor")
            and can_access_module(request.user, t, "tournament.schedule_editor")
        ):
            raise PermissionDenied("not_tournament_manager")

        warnings: list[dict] = []
        drawn = 0
        try:
            for lf in iter_leaves(t.sports or []):
                cfg = effective_draw_config(t, lf["leaf_key"])
                try:
                    generate_for_leaf(
                        tournament=t, leaf_key=lf["leaf_key"], cfg=cfg,
                        warnings=warnings,
                    )
                    drawn += 1
                except ValueError:
                    # A competition with too few teams is skipped, not fatal —
                    # the rest of the tournament still publishes.
                    warnings.append(
                        {"code": "skipped_leaf", "leaf_key": lf["leaf_key"]}
                    )
            payload = dict(request.data.get("schedule") or {})
            if not payload.get("venues"):
                stored = stored_venue_records(t)
                if stored:
                    payload["venues"] = stored
            result = apply_schedule(
                tournament=t, config=payload, by=request.user,
                request=request, leaf_key=None,
            )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        return Response(
            {
                "competitions": drawn,
                "scheduled": len(result.assignments),
                "unscheduled": result.unscheduled,
                "warnings": warnings,
            },
            status=201,
        )


class TournamentFixturesView(GenericAPIView):
    """`DELETE /api/tournaments/{id}/fixtures/?leaf_key=…&event_id=…` — the
    accepted-the-wrong-draw escape hatch (redesign spec §5.3, D7).
    Soft-deletes the scope's matches ONLY while every one is still
    `scheduled` status (nothing live/completed); audited (`draw_deleted`),
    idempotent on `event_id`. Gate: bracket_editor."""

    permission_classes = [IsAuthenticated]

    def delete(self, request, tournament_id):
        import uuid as _uuid

        from django.db import transaction
        from django.utils import timezone as dj_tz

        from apps.audit.models import ActorRole, AuditEvent
        from apps.audit.services import emit_audit
        from apps.matches.models import Match, MatchStatus

        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.bracket_editor"):
            raise PermissionDenied("not_tournament_manager")

        leaf_key = str(request.query_params.get("leaf_key") or "")
        event_id = None
        raw_eid = request.query_params.get("event_id")
        if raw_eid:
            try:
                event_id = _uuid.UUID(str(raw_eid))
            except ValueError:
                raise DRFValidationError({"detail": "invalid_event_id"})
            prior = AuditEvent.objects.filter(
                idempotency_key=event_id, event_type="draw_deleted"
            ).first()
            if prior is not None:  # replay (invariant 3)
                payload = prior.payload_after or {}
                return Response({
                    "deleted": payload.get("deleted", 0),
                    "leaf_key": payload.get("leaf_key", leaf_key),
                })

        scope = Match.objects.filter(tournament=t, deleted_at__isnull=True)
        if leaf_key:
            scope = scope.filter(leaf_key=leaf_key)
        matches = list(scope)
        locked = [m for m in matches if m.status != MatchStatus.SCHEDULED]
        if locked:
            return Response(
                {
                    "detail": "draw_locked",
                    "leaf_key": leaf_key,
                    "matches": [str(m.id) for m in locked],
                },
                status=409,
            )
        with transaction.atomic():
            scope.update(deleted_at=dj_tz.now())
            emit_audit(
                actor_user=request.user,
                actor_role=ActorRole.ADMIN,
                event_type="draw_deleted",
                target_type="tournament",
                target_id=t.id,
                organization_id=t.organization_id,
                tournament_id=t.id,
                idempotency_key=event_id,
                payload_after={
                    "leaf_key": leaf_key,
                    "deleted": len(matches),
                    "match_ids": [str(m.id) for m in matches],
                },
                request=request,
            )
        return Response({"deleted": len(matches), "leaf_key": leaf_key})


class SwapFixtureSlotsView(GenericAPIView):
    """`POST /api/tournaments/{id}/fixtures/swap-slots/` — exchange
    scheduled_at+venue between two movable matches (repair seam, increment
    B). Body `{match_a, match_b, event_id?, force?}`. Gate: schedule_editor.
    Conflict-checked exactly like the manual reslot (hard → 409 with the
    structured violations unless force=true); ONE audit row
    (`match_slots_swapped`); idempotent on event_id — a replay answers from
    the audit log instead of swapping back."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        import uuid as _uuid

        from django.core.exceptions import ValidationError

        from apps.audit.models import AuditEvent
        from apps.fixtures.services.repair import RepairConflict, swap_slots
        from apps.matches.models import Match
        from apps.matches.serializers import MatchSerializer

        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.schedule_editor"):
            raise PermissionDenied("not_tournament_manager")

        ids = {}
        for key in ("match_a", "match_b"):
            try:
                ids[key] = _uuid.UUID(str(request.data.get(key) or ""))
            except ValueError:
                raise DRFValidationError({"detail": f"invalid_{key}"}) from None
        event_id = None
        raw_eid = request.data.get("event_id")
        if raw_eid:
            try:
                event_id = _uuid.UUID(str(raw_eid))
            except ValueError:
                raise DRFValidationError({"detail": "invalid_event_id"}) from None
            prior = AuditEvent.objects.filter(
                idempotency_key=event_id, event_type="match_slots_swapped"
            ).first()
            if prior is not None:  # replay (invariant 3) — do NOT swap back
                payload = prior.payload_after or {}
                fresh = {
                    str(m.id): m
                    for m in Match.objects.filter(
                        tournament=t, id__in=payload.get("matches", [])
                    )
                }
                serialized = [
                    MatchSerializer(fresh[mid]).data
                    for mid in payload.get("matches", [])
                    if mid in fresh
                ]
                return Response({
                    "match_a": serialized[0] if serialized else None,
                    "match_b": serialized[1] if len(serialized) > 1 else None,
                    "violations": payload.get("violations", []),
                })

        try:
            a, b, violations = swap_slots(
                tournament=t,
                match_a=ids["match_a"],
                match_b=ids["match_b"],
                by=request.user,
                force=bool(request.data.get("force")),
                event_id=event_id,
                request=request,
            )
        except RepairConflict as e:
            return Response(
                {"detail": "schedule_conflicts", "violations": e.violations},
                status=409,
            )
        except ValidationError as e:
            code = getattr(e, "message", "invalid_swap")
            if code == "match_not_movable":
                return Response({"detail": code}, status=409)
            raise DRFValidationError({"detail": code}) from e
        return Response({
            "match_a": MatchSerializer(a).data,
            "match_b": MatchSerializer(b).data,
            "violations": violations,
        })


class ShiftFixturesDayView(GenericAPIView):
    """`POST /api/tournaments/{id}/fixtures/shift-day/` — rain-day shift
    (repair seam, increment D). Body `{from_date, to_date?, leaf_key?,
    force?, event_id?}`. Gate: schedule_editor. Moves every movable
    (scheduled/postponed, not locked) match on from_date to to_date keeping
    time-of-day + venue; to_date omitted ⇒ first stored reserve day on/after
    from_date (error `reserve_day_unavailable` if none). A reserve to_date
    is ACTIVATED (scheduling_config["activated_reserve_days"]) so the grid
    and future runs keep the day. Hard violations 409 with the structured
    payload unless force; ONE `shift_day` audit row; idempotent on
    event_id."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        import uuid as _uuid
        from datetime import date as _date

        from django.core.exceptions import ValidationError

        from apps.audit.models import AuditEvent
        from apps.fixtures.services.repair import RepairConflict, shift_day

        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.schedule_editor"):
            raise PermissionDenied("not_tournament_manager")

        def _parse(key: str, required: bool) -> _date | None:
            raw = request.data.get(key)
            if raw in (None, ""):
                if required:
                    raise DRFValidationError({"detail": f"{key}_required"})
                return None
            try:
                return _date.fromisoformat(str(raw)[:10])
            except ValueError:
                raise DRFValidationError(
                    {"detail": f"invalid_{key}"}
                ) from None

        from_date = _parse("from_date", required=True)
        to_date = _parse("to_date", required=False)
        event_id = None
        raw_eid = request.data.get("event_id")
        if raw_eid:
            try:
                event_id = _uuid.UUID(str(raw_eid))
            except ValueError:
                raise DRFValidationError({"detail": "invalid_event_id"}) from None
            prior = AuditEvent.objects.filter(
                idempotency_key=event_id, event_type="shift_day"
            ).first()
            if prior is not None:  # replay (invariant 3) — do NOT shift again
                payload = prior.payload_after or {}
                return Response({
                    "moved": payload.get("moved", []),
                    "violations": payload.get("violations", []),
                    "to_date": payload.get("to_date"),
                })

        try:
            moved, violations, resolved_to = shift_day(
                tournament=t,
                by=request.user,
                from_date=from_date,
                to_date=to_date,
                leaf_key=str(request.data.get("leaf_key") or "") or None,
                force=bool(request.data.get("force")),
                event_id=event_id,
                request=request,
            )
        except RepairConflict as e:
            return Response(
                {"detail": "schedule_conflicts", "violations": e.violations},
                status=409,
            )
        except ValidationError as e:
            raise DRFValidationError(
                {"detail": getattr(e, "message", "invalid_shift")}
            ) from e
        return Response({
            "moved": moved,
            "violations": violations,
            "to_date": resolved_to.isoformat(),
        })


class TournamentScheduleChangesView(GenericAPIView):
    """`GET /api/tournaments/{id}/schedule-changes/?since=&leaf_key=` —
    unified slot-change feed (trust layer, increment F). Flattens the
    existing repair/scheduler audit rows (no new model) into reverse-chrono
    per-match entries `{match_id, match_label, leaf_key, changed_at, actor,
    kind, old, new, reason, batch_id}`. Visible to ANY accessible tournament
    member (404 idiom — no existence leak)."""

    _DEFAULT_LIMIT = 200
    _MAX_LIMIT = 1000

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        from datetime import datetime as _datetime

        from django.utils import timezone as dj_tz

        from apps.fixtures.services.schedule_changes import schedule_changes

        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.get(id=tournament_id)

        since = None
        raw_since = request.query_params.get("since")
        if raw_since:
            try:
                since = _datetime.fromisoformat(
                    str(raw_since).replace("Z", "+00:00")
                )
            except ValueError:
                raise DRFValidationError({"detail": "invalid_since"}) from None
            if dj_tz.is_naive(since):
                since = dj_tz.make_aware(since, dj_tz.get_default_timezone())

        try:
            limit = int(
                request.query_params.get("limit") or self._DEFAULT_LIMIT
            )
        except (TypeError, ValueError):
            limit = self._DEFAULT_LIMIT
        limit = max(1, min(limit, self._MAX_LIMIT))

        return Response({
            "results": schedule_changes(
                t,
                since=since,
                leaf_key=str(request.query_params.get("leaf_key") or "") or None,
                limit=limit,
            )
        })


class ControlRoomDayView(GenericAPIView):
    """`GET /api/tournaments/{id}/control-room/?day=YYYY-MM-DD` — the live-ops
    cockpit's day-view aggregate (control room, spec 2026-06-12 §2.a): ONE
    query over the schedule, grouped in Python by tournament-TZ day
    (invariant 14) then venue, plus a cross-venue "next up" queue. Read-only;
    ANY active member may read (404 idiom — no existence leak); writes stay
    gated per action. Day defaults to today (tournament TZ) when it has
    matches, else the next day with matches, else the last one. Delay
    visibility stays client-side via the schedule-changes feed."""

    _QUEUE_LIMIT = 10

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        from datetime import date as _date
        from zoneinfo import ZoneInfo

        from django.db.models import F as _F
        from django.utils import timezone as dj_tz

        from apps.matches.models import Match, MatchStatus
        from apps.matches.serializers import MatchSerializer
        from apps.tournaments.services.sports import leaf_label

        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.get(id=tournament_id)
        try:
            tz = ZoneInfo(t.time_zone)
        except (KeyError, ValueError):
            tz = dj_tz.get_default_timezone()

        day = None
        raw_day = request.query_params.get("day")
        if raw_day:
            try:
                day = _date.fromisoformat(str(raw_day))
            except ValueError:
                raise DRFValidationError({"detail": "invalid_day"}) from None

        matches = list(
            Match.objects.filter(tournament=t, deleted_at__isnull=True)
            .select_related("home_team", "away_team", "tournament", "scorer")
            .prefetch_related("officials__user")
            .order_by(_F("scheduled_at").asc(nulls_last=True), "match_no")
        )

        by_day: dict[_date, list[Match]] = {}
        for m in matches:
            if m.scheduled_at is None:
                continue  # not on the calendar — the fixtures hub covers these
            local_day = dj_tz.localtime(m.scheduled_at, tz).date()
            by_day.setdefault(local_day, []).append(m)

        finished = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)
        in_play = (MatchStatus.LIVE, MatchStatus.HALF_TIME)
        days = [
            {
                "date": d.isoformat(),
                "counts": {
                    "total": len(rows),
                    "completed": sum(1 for m in rows if m.status in finished),
                    "live": sum(1 for m in rows if m.status in in_play),
                },
            }
            for d, rows in sorted(by_day.items())
        ]

        if day is None and by_day:
            today = dj_tz.localtime(dj_tz.now(), tz).date()
            upcoming = sorted(d for d in by_day if d >= today)
            day = upcoming[0] if upcoming else max(by_day)

        day_rows = by_day.get(day, [])  # already in scheduled_at order

        labels: dict[str, str] = {}

        def row(m: Match) -> dict:
            if m.leaf_key and m.leaf_key not in labels:
                labels[m.leaf_key] = leaf_label(t.sports, m.leaf_key)
            data = MatchSerializer(m).data
            data["leaf_label"] = labels.get(m.leaf_key, "")
            data["scorer"] = (
                {"id": str(m.scorer.id), "name": m.scorer.name or m.scorer.email}
                if m.scorer is not None
                else None
            )
            data["officials"] = [
                {
                    "id": str(o.id),
                    "user_id": str(o.user_id),
                    "name": o.user.name or o.user.email,
                    "role": o.role,
                    "status": o.status,
                }
                for o in m.officials.all()
            ]
            return data

        lanes: dict[str, list[dict]] = {}
        for m in day_rows:
            lanes.setdefault(m.venue, []).append(row(m))

        terminal = (
            MatchStatus.COMPLETED, MatchStatus.WALKOVER,
            MatchStatus.CANCELLED, MatchStatus.ABANDONED,
        )
        queue = [
            row(m) for m in day_rows if m.status not in terminal
        ][: self._QUEUE_LIMIT]

        return Response({
            "tournament": {
                "id": str(t.id),
                "name": t.name,
                "slug": t.slug,
                "status": t.status,
                "time_zone": t.time_zone,
            },
            "days": days,
            "day": day.isoformat() if day else None,
            # Alphabetical lanes; the empty venue ("Unassigned" in the UI) last.
            "venues": [
                {"venue": v, "matches": rows}
                for v, rows in sorted(
                    lanes.items(), key=lambda kv: (kv[0] == "", kv[0])
                )
            ],
            "queue": queue,
        })


class TournamentDrawConfigView(GenericAPIView):
    """`GET/PATCH /api/tournaments/{id}/draw-config/` — per-competition draw
    configuration (redesign spec §2.1). GET: any tournament member. PATCH:
    bracket-editor verb; body `{leaf_key|"*", config, event_id}`; whitelist
    merge, idempotent on `event_id`, audited (`draw_config_updated`)."""

    permission_classes = [IsAuthenticated]

    def _tournament(self, request, tournament_id) -> Tournament:
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        return Tournament.objects.select_related("organization").get(id=tournament_id)

    def get(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        return Response(
            {"draw_config": t.draw_config or {}, "defaults": DEFAULT_DRAW_CONFIG}
        )

    def patch(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        if not can_access_module(request.user, t, "tournament.bracket_editor"):
            raise PermissionDenied("not_tournament_manager")
        leaf_key = str(request.data.get("leaf_key") or "*")
        try:
            t = update_draw_config(
                tournament=t,
                leaf_key=leaf_key,
                partial=request.data.get("config") or {},
                by=request.user,
                event_id=request.data.get("event_id"),
                request=request,
            )
        except ValueError as e:
            raise DRFValidationError({"detail": str(e)})
        return Response(
            {
                "leaf_key": leaf_key,
                "draw_config": t.draw_config or {},
                "effective": effective_draw_config(
                    t, None if leaf_key == "*" else leaf_key
                ),
                # Per-leaf freeze signal (§2.1): edits stay allowed once a draw
                # exists, but the UI shows the invariant-10 banner.
                "has_matches": leaf_has_matches(t, leaf_key),
            }
        )


def _venue_payload(v: Venue) -> dict:
    return {
        "id": str(v.id), "name": v.name, "venue_type": v.venue_type,
        "windows": v.windows or [], "count": v.count,
        "unavailable_dates": v.unavailable_dates or [],
        "sports": v.sports or [],
        "breaks": v.breaks or [],
    }


def _clean_sports(raw) -> list[str]:
    """Venue sport allow-list (owner ask 2026-06-25): a de-duped list of
    non-empty sport-key strings (empty = any sport may use the venue)."""
    out: list[str] = []
    for s in raw or []:
        key = str(s).strip()[:60]
        if key and key not in out:
            out.append(key)
    return out


def _clean_count(raw) -> int:
    """Venue ``count`` (courts/tables, redesign §2.3): integer >= 1."""
    try:
        return max(1, min(64, int(raw)))
    except (TypeError, ValueError):
        return 1


def _clean_windows(raw) -> list[dict]:
    """Keep only {"from": "HH:MM", "to": "HH:MM"} shaped entries."""
    out = []
    for w in raw if isinstance(raw, list) else []:
        if isinstance(w, dict) and w.get("from") and w.get("to"):
            out.append({"from": str(w["from"])[:5], "to": str(w["to"])[:5]})
    return out


def _clean_unavailable_dates(raw) -> list[str]:
    """Venue off-days (increment S): valid ISO dates only, deduped, sorted."""
    from datetime import date as _date

    out: set[str] = set()
    for v in raw if isinstance(raw, list) else []:
        try:
            out.add(_date.fromisoformat(str(v)[:10]).isoformat())
        except ValueError:
            continue
    return sorted(out)


class TournamentVenuesView(GenericAPIView):
    """`GET/POST /api/tournaments/{id}/venues/` — the workspace's venue pool
    (shared across its tournaments). GET: any member; POST: manager-only.
    The scheduler uses these (types + windows) when a run names no venues."""

    permission_classes = [IsAuthenticated]

    def _tournament(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        return Tournament.objects.select_related("organization").get(id=tournament_id)

    def get(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        venues = Venue.objects.filter(
            organization=t.organization, deleted_at__isnull=True
        ).order_by("name")
        return Response({"venues": [_venue_payload(v) for v in venues]})

    def post(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        if not can_access_module(request.user, t, "tournament.schedule_editor"):
            raise PermissionDenied("not_tournament_manager")
        name = str(request.data.get("name") or "").strip()[:120]
        if not name:
            raise DRFValidationError({"detail": "name_required"})
        if Venue.objects.filter(
            organization=t.organization, name=name, deleted_at__isnull=True
        ).exists():
            raise DRFValidationError({"detail": "venue_name_taken"})
        v = Venue.objects.create(
            organization=t.organization,
            name=name,
            venue_type=str(request.data.get("venue_type") or "").strip()[:40],
            windows=_clean_windows(request.data.get("windows")),
            count=_clean_count(request.data.get("count", 1)),
            unavailable_dates=_clean_unavailable_dates(
                request.data.get("unavailable_dates")
            ),
            sports=_clean_sports(request.data.get("sports")),
            breaks=_clean_windows(request.data.get("breaks")),
            created_by=request.user,
        )
        return Response(_venue_payload(v), status=201)


class TournamentVenueDetailView(GenericAPIView):
    """`PATCH/DELETE /api/tournaments/{id}/venues/{venue_id}/` — manager-only."""

    permission_classes = [IsAuthenticated]

    def _venue(self, request, tournament_id, venue_id) -> Venue:
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_access_module(request.user, t, "tournament.schedule_editor"):
            raise PermissionDenied("not_tournament_manager")
        v = Venue.objects.filter(
            id=venue_id, organization=t.organization, deleted_at__isnull=True
        ).first()
        if v is None:
            raise NotFound("venue_not_found")
        return v

    def patch(self, request, tournament_id, venue_id):
        v = self._venue(request, tournament_id, venue_id)
        if "name" in request.data:
            name = str(request.data["name"] or "").strip()[:120]
            if not name:
                raise DRFValidationError({"detail": "name_required"})
            clash = Venue.objects.filter(
                organization=v.organization, name=name, deleted_at__isnull=True
            ).exclude(id=v.id).exists()
            if clash:
                raise DRFValidationError({"detail": "venue_name_taken"})
            v.name = name
        if "venue_type" in request.data:
            v.venue_type = str(request.data["venue_type"] or "").strip()[:40]
        if "windows" in request.data:
            v.windows = _clean_windows(request.data["windows"])
        if "count" in request.data:
            v.count = _clean_count(request.data["count"])
        if "unavailable_dates" in request.data:
            v.unavailable_dates = _clean_unavailable_dates(
                request.data["unavailable_dates"]
            )
        if "sports" in request.data:
            v.sports = _clean_sports(request.data["sports"])
        if "breaks" in request.data:
            v.breaks = _clean_windows(request.data["breaks"])
        v.save(update_fields=["name", "venue_type", "windows", "count",
                              "unavailable_dates", "sports", "breaks",
                              "updated_at"])
        return Response(_venue_payload(v))

    def delete(self, request, tournament_id, venue_id):
        from django.utils import timezone as dj_tz

        v = self._venue(request, tournament_id, venue_id)
        v.deleted_at = dj_tz.now()
        v.save(update_fields=["deleted_at", "updated_at"])
        return Response(status=204)


class PublicTournamentScheduleView(GenericAPIView):
    """`GET /api/public/tournaments/{slug}/{id}/schedule/` — public read-only
    schedule (trust layer, increment H). AllowAny; resolves the (slug, UUID)
    pair (invariant 1 — wrong slug 404s) and answers ONLY while the
    tournament status is public-facing (registration_open / scheduled /
    live / completed). Flat match list with day/time/venue/teams/leaf — no
    PII beyond team/school names."""

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id):
        from zoneinfo import ZoneInfo

        from django.db.models import F as _F
        from django.utils import timezone as dj_tz

        from apps.matches.models import Match
        from apps.tournaments.models import TournamentStatus
        from apps.tournaments.services.sports import leaf_label

        public_statuses = (
            TournamentStatus.REGISTRATION_OPEN,
            TournamentStatus.SCHEDULED,
            TournamentStatus.LIVE,
            TournamentStatus.COMPLETED,
        )
        t = Tournament.objects.filter(
            id=tournament_id,
            slug=slug,
            deleted_at__isnull=True,
            status__in=public_statuses,
        ).first()
        if t is None:
            raise NotFound("tournament_not_found")
        try:
            tz = ZoneInfo(t.time_zone)
        except (KeyError, ValueError):
            tz = dj_tz.get_default_timezone()

        def side(team):
            if team is None:
                return None
            return {
                "id": str(team.id),
                "name": team.name,
                "short_name": team.short_name,
                "school": team.school,
            }

        labels: dict[str, str] = {}
        matches = []
        for m in (
            Match.objects.filter(tournament=t, deleted_at__isnull=True)
            .select_related("home_team", "away_team")
            .order_by(_F("scheduled_at").asc(nulls_last=True), "match_no")
        ):
            if m.leaf_key and m.leaf_key not in labels:
                labels[m.leaf_key] = leaf_label(t.sports, m.leaf_key)
            local = (
                dj_tz.localtime(m.scheduled_at, tz) if m.scheduled_at else None
            )
            matches.append({
                "id": str(m.id),
                "leaf_key": m.leaf_key,
                "leaf_label": labels.get(m.leaf_key, ""),
                "stage": m.stage,
                "group_label": m.group_label,
                "round_no": m.round_no,
                "match_no": m.match_no,
                "status": m.status,
                "day": local.date().isoformat() if local else None,
                "scheduled_at": (
                    m.scheduled_at.isoformat() if m.scheduled_at else None
                ),
                "venue": m.venue,
                "home": side(m.home_team),
                "away": side(m.away_team),
                "home_score": m.home_score,
                "away_score": m.away_score,
                # Live points (control room spec 2026-06-12 §2.d): shootout
                # result, sport + per-set scores (home/away_score = sets won
                # for set sports), and the period for the live pill. Team/
                # school names only — same PII posture as the rest of the row.
                "home_pens": m.home_pens,
                "away_pens": m.away_pens,
                "sport": m.sport,
                "set_scores": m.set_scores,
                "current_period": m.current_period,
            })
        return Response({
            "tournament": {
                "id": str(t.id),
                "slug": t.slug,
                "name": t.name,
                "status": t.status,
                "time_zone": t.time_zone,
            },
            "matches": matches,
        })


class PublicTournamentStandingsView(GenericAPIView):
    """`GET /api/public/tournaments/{slug}/{id}/standings/` — public
    read-only standings (control room spec 2026-06-12 §2.d). AllowAny; same
    (slug, UUID) + public-status gating as the public schedule. Body mirrors
    TournamentStandingsView — `{groups: [{group_label, rows}]}` via
    compute_standings verbatim (rows are team aggregates, public-safe)."""

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id):
        from apps.matches.models import Match
        from apps.matches.services.standings import compute_standings
        from apps.tournaments.models import TournamentStatus

        public_statuses = (
            TournamentStatus.REGISTRATION_OPEN,
            TournamentStatus.SCHEDULED,
            TournamentStatus.LIVE,
            TournamentStatus.COMPLETED,
        )
        t = Tournament.objects.filter(
            id=tournament_id,
            slug=slug,
            deleted_at__isnull=True,
            status__in=public_statuses,
        ).first()
        if t is None:
            raise NotFound("tournament_not_found")
        labels = sorted(
            set(
                Match.objects.filter(tournament=t, deleted_at__isnull=True)
                .values_list("group_label", flat=True)
            )
        )
        groups = [
            {"group_label": lbl, "rows": compute_standings(t, group_label=lbl)}
            for lbl in labels
        ]
        return Response({"groups": groups})
