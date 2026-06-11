from __future__ import annotations

from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
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
    generate_knockout_from_groups,
    generate_round_robin,
    generate_round_robin_by_category,
    generate_single_elimination,
)
from apps.fixtures.services.preview import preview_fixtures, stored_venue_records
from apps.fixtures.services.readiness import fixture_readiness
from apps.fixtures.services.scheduler import apply_schedule
from apps.teams.models import Team, TeamStatus
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
                "format", "group_size", "advance_per_group", "third_place",
                "legs", "seeding", "seed",
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
            if fmt == "knockout":
                teams_qs = Team.objects.filter(
                    tournament=t, status=TeamStatus.REGISTERED, deleted_at__isnull=True
                )
                if leaf_key:
                    teams_qs = teams_qs.filter(leaf_key=leaf_key)
                teams = list(teams_qs.order_by("seed", "name"))
                matches = generate_single_elimination(
                    tournament=t, teams=teams, leaf_key=leaf_key,
                    third_place=bool(cfg.get("third_place")),
                    seeding=seeding, seed=seed, warnings=warnings,
                )
            elif fmt == "knockout_from_groups":
                matches = generate_knockout_from_groups(
                    tournament=t,
                    advance_per_group=int(cfg["advance_per_group"]),
                    leaf_key=leaf_key or None,
                    third_place=bool(cfg.get("third_place")),
                    warnings=warnings,
                )
            elif fmt == "by_category":
                matches = generate_round_robin_by_category(
                    tournament=t, leaf_key=leaf_key or None,
                    legs=int(cfg["legs"]),
                    seeding=seeding, seed=seed, warnings=warnings,
                )
            else:
                # "round_robin" and "groups_knockout" (the stored-config name)
                # both draw the group stage now; the knockout is advanced later
                # via format="knockout_from_groups" once groups complete.
                matches = generate_round_robin(
                    tournament=t,
                    group_size=int(cfg["group_size"]),
                    leaf_key=leaf_key or None,
                    legs=int(cfg["legs"]),
                    seeding=seeding, seed=seed, warnings=warnings,
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
    }


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
        v.save(update_fields=["name", "venue_type", "windows", "count",
                              "updated_at"])
        return Response(_venue_payload(v))

    def delete(self, request, tournament_id, venue_id):
        from django.utils import timezone as dj_tz

        v = self._venue(request, tournament_id, venue_id)
        v.deleted_at = dj_tz.now()
        v.save(update_fields=["deleted_at", "updated_at"])
        return Response(status=204)
