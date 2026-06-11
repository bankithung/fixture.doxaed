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
    generate_knockout_from_groups,
    generate_round_robin,
    generate_round_robin_by_category,
    generate_single_elimination,
)
from apps.fixtures.services.scheduler import apply_schedule
from apps.teams.models import Team, TeamStatus
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_access_module
from apps.tournaments.scope import accessible_tournaments


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
        # Effective config layering (redesign spec §2.1/§4.5): defaults <
        # legacy rules keys < draw_config["*"] < draw_config[leaf] < explicit
        # request params. A bare body of {leaf_key} works once the wizard has
        # saved the format via the draw-config PATCH.
        overrides = {
            k: request.data.get(k)
            for k in ("format", "group_size", "advance_per_group", "third_place")
            if k in request.data
        }
        cfg = effective_draw_config(t, leaf_key or None, overrides=overrides)
        fmt = str(cfg.get("format") or "round_robin")
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
                )
            elif fmt == "knockout_from_groups":
                matches = generate_knockout_from_groups(
                    tournament=t,
                    advance_per_group=int(cfg["advance_per_group"]),
                    leaf_key=leaf_key or None,
                    third_place=bool(cfg.get("third_place")),
                )
            elif fmt == "by_category":
                matches = generate_round_robin_by_category(
                    tournament=t, leaf_key=leaf_key or None
                )
            else:
                # "round_robin" and "groups_knockout" (the stored-config name)
                # both draw the group stage now; the knockout is advanced later
                # via format="knockout_from_groups" once groups complete.
                matches = generate_round_robin(
                    tournament=t,
                    group_size=int(cfg["group_size"]),
                    leaf_key=leaf_key or None,
                )
        except (ValueError, TypeError) as e:
            raise DRFValidationError({"detail": str(e)})
        return Response(
            {"generated": len(matches), "format": fmt, "leaf_key": leaf_key},
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
        # No venues in the payload → the workspace's stored Venue records
        # (with their types + availability windows) are the resource pool.
        if not payload.get("venues"):
            stored = [
                {"name": v.name, "venue_type": v.venue_type, "windows": v.windows}
                for v in Venue.objects.filter(
                    organization=t.organization, deleted_at__isnull=True
                ).order_by("name")
            ]
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
                "leaf_key": leaf_key,
            }
        )


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
        "windows": v.windows or [],
    }


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
        v.save(update_fields=["name", "venue_type", "windows", "updated_at"])
        return Response(_venue_payload(v))

    def delete(self, request, tournament_id, venue_id):
        from django.utils import timezone as dj_tz

        v = self._venue(request, tournament_id, venue_id)
        v.deleted_at = dj_tz.now()
        v.save(update_fields=["deleted_at", "updated_at"])
        return Response(status=204)
