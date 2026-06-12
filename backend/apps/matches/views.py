from __future__ import annotations

import csv

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.http import HttpResponse
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.matches.models import Lineup, Match, MatchEvent, MatchIncident
from apps.matches.serializers import (
    ConfirmLineupSerializer,
    FileIncidentSerializer,
    LineupSerializer,
    MatchIncidentSerializer,
    MatchSerializer,
    RecordEventSerializer,
    RecordScoreSerializer,
    RecordSetScoreSerializer,
    RecordShootoutSerializer,
    RescheduleMatchSerializer,
    SetLineupSerializer,
    TransitionSerializer,
)
from apps.matches.services.events import record_match_event
from apps.matches.services.incidents import file_incident
from apps.matches.services.lineups import confirm_lineup, set_lineup
from apps.matches.services.scoring import assign_scorer, record_score
from apps.matches.services.standings import compute_standings
from apps.matches.services.state import transition_match
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments

User = get_user_model()


def _csv_safe(value) -> str:
    """Neutralize CSV formula injection (Excel executes cells starting with =,+,-,@)."""
    s = "" if value is None else str(value)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


def _accessible_tournament_or_404(user, tournament_id) -> Tournament:
    if not accessible_tournaments(user).filter(id=tournament_id).exists():
        raise NotFound("tournament_not_found")
    return Tournament.objects.select_related("organization").get(id=tournament_id)


def _match_or_404(user, match_id) -> Match:
    match = (
        Match.objects.filter(id=match_id, deleted_at__isnull=True)
        .select_related("tournament", "tournament__organization")
        .first()
    )
    if match is None or not accessible_tournaments(user).filter(
        id=match.tournament_id
    ).exists():
        raise NotFound("match_not_found")
    return match


def _can_score(user, match: Match) -> bool:
    """A match can be scored by a tournament manager, the per-match assigned
    scorer, or any active match_scorer member of the tournament."""
    if can_manage_tournament(user, match.tournament):
        return True
    if match.scorer_id == user.id:
        return True
    if TournamentMembership.objects.filter(
        user=user,
        tournament=match.tournament,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    ).exists():
        return True
    # Module layer: a per-member grant of the scoring console also qualifies
    # (spec 2026-06-10 P5).
    from apps.permissions.services.resolver import effective_tournament_modules

    return "match.scoring_console" in effective_tournament_modules(
        user, match.tournament
    )




class TournamentMatchListView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _accessible_tournament_or_404(request.user, tournament_id)
        qs = (
            Match.objects.filter(tournament=t, deleted_at__isnull=True)
            .select_related("home_team", "away_team", "tournament")
            .order_by("group_label", "match_no")
        )
        return Response(MatchSerializer(qs, many=True).data)


class TournamentStandingsView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _accessible_tournament_or_404(request.user, tournament_id)
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


class AssignScorerView(GenericAPIView):
    """`POST /api/matches/{id}/scorer/` — a manager assigns a scorer to a match.
    Body: {"user_id": "<uuid>"}. The target must be a tournament member."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not can_manage_tournament(request.user, match.tournament):
            raise PermissionDenied("not_tournament_manager")
        target = User.objects.filter(id=request.data.get("user_id")).first()
        if target is None:
            raise DRFValidationError({"detail": "user_not_found"})
        try:
            assign_scorer(match=match, user=target, by=request.user, request=request)
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid_assignment")})
        match.refresh_from_db()
        return Response(MatchSerializer(match).data)


class RecordScoreView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_score")

        from apps.matches.services.set_scoring import (
            record_set_result,
            rules_for_match,
        )

        rules = rules_for_match(match)
        # Set/game-based sports (Volleyball, TT, Sepak Takraw) submit per-set
        # scores — and ONLY per-set scores: a bare goal-style total would
        # complete the match with point-like numbers and empty set_scores.
        if "set_scores" in request.data:
            if rules is None:
                raise DRFValidationError({"detail": "not_a_set_based_sport"})
            ser = RecordSetScoreSerializer(data=request.data)
            ser.is_valid(raise_exception=True)
            try:
                record_set_result(
                    match=match,
                    set_scores=ser.validated_data["set_scores"],
                    rules=rules,
                    by=request.user,
                    event_id=ser.validated_data.get("event_id"),
                    request=request,
                )
            except ValidationError as e:
                raise DRFValidationError(
                    {"detail": getattr(e, "message", "invalid_set_scores")}
                )
            match.refresh_from_db()
            return Response(MatchSerializer(match).data)

        if rules is not None:
            raise DRFValidationError({"detail": "set_scores_required"})
        ser = RecordScoreSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            record_score(
                match=match,
                home_score=ser.validated_data["home_score"],
                away_score=ser.validated_data["away_score"],
                by=request.user,
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid_score")})
        match.refresh_from_db()
        return Response(MatchSerializer(match).data)


class RecordMatchEventView(GenericAPIView):
    """`POST /api/matches/{id}/events/` — append a live event (goal/card/etc.).
    Scores derive from the event log (invariant #4)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_score")
        ser = RecordEventSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        side = ser.validated_data.get("side")
        team = (
            match.home_team if side == "home"
            else match.away_team if side == "away"
            else None
        )
        player = None
        player_id = ser.validated_data.get("player_id")
        if player_id:
            from apps.teams.models import Player

            player = Player.objects.filter(
                id=player_id, tournament=match.tournament, deleted_at__isnull=True
            ).first()
            if player is None:
                raise DRFValidationError({"detail": "player_not_found"})
            if player.team_id not in (match.home_team_id, match.away_team_id):
                raise DRFValidationError({"detail": "player_not_on_team"})
            if team is not None and player.team_id != team.id:
                raise DRFValidationError({"detail": "player_not_on_team"})
            if team is None:
                team = player.team
        related_player = None
        related_player_id = ser.validated_data.get("related_player_id")
        if related_player_id:
            from apps.teams.models import Player

            related_player = Player.objects.filter(
                id=related_player_id, tournament=match.tournament, deleted_at__isnull=True
            ).first()
            if related_player is None:
                raise DRFValidationError({"detail": "related_player_not_found"})
            if related_player.team_id not in (match.home_team_id, match.away_team_id):
                raise DRFValidationError({"detail": "related_player_not_on_team"})
        try:
            record_match_event(
                match=match,
                event_type=ser.validated_data["event_type"],
                team=team,
                player=player,
                related_player=related_player,
                minute=ser.validated_data.get("minute"),
                by=request.user,
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError(
                {"detail": getattr(e, "message", "invalid_event")}
            ) from e
        match.refresh_from_db()
        return Response(MatchSerializer(match).data, status=201)


class RecordShootoutView(GenericAPIView):
    """`POST /api/matches/{id}/shootout/` — record a penalty-shootout result
    for a LEVEL knockout match (rules.match.penalties). Recordable while LIVE
    (then complete normally) or on an already-COMPLETED drawn match, where it
    self-heals a stalled bracket by re-firing advancement."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        from django.db import transaction

        from apps.matches.models import MatchStatus
        from apps.matches.services.state import _fire_advancement
        from apps.tournaments.services.rules import merge_rules

        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_score")
        if match.stage == "group" or not match.stage:
            raise DRFValidationError({"detail": "shootout_knockout_only"})
        match_rules = merge_rules(getattr(match.tournament, "rules", None))["match"]
        if not match_rules.get("penalties"):
            raise DRFValidationError({"detail": "penalties_disabled_by_rules"})
        if match.status not in (
            MatchStatus.LIVE, MatchStatus.HALF_TIME, MatchStatus.COMPLETED
        ):
            raise DRFValidationError({"detail": "shootout_wrong_state"})
        if (
            match.home_score is not None
            and match.away_score is not None
            and match.home_score != match.away_score
        ):
            raise DRFValidationError({"detail": "shootout_only_when_level"})

        ser = RecordShootoutSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        before = {"home_pens": match.home_pens, "away_pens": match.away_pens}
        match.home_pens = ser.validated_data["home_pens"]
        match.away_pens = ser.validated_data["away_pens"]
        match.save(update_fields=["home_pens", "away_pens", "updated_at"])

        from apps.audit.models import ActorRole
        from apps.audit.services import emit_audit

        emit_audit(
            actor_user=request.user,
            actor_role=ActorRole.ADMIN,
            event_type="match_shootout_recorded",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            payload_before=before,
            payload_after={
                "home_pens": match.home_pens, "away_pens": match.away_pens
            },
            idempotency_key=ser.validated_data.get("event_id"),
            request=request,
        )
        # An already-completed drawn match was a stalled bracket — the
        # shootout result now resolves winner_id, so ripple it (invariant 9).
        if match.status == MatchStatus.COMPLETED:
            mid = match.id
            transaction.on_commit(lambda: _fire_advancement(mid))
        return Response(MatchSerializer(match).data)


class MatchScheduleView(GenericAPIView):
    """`PATCH /api/matches/{id}/schedule/` — control-room manual reslot
    (repair seam, increment A). Gate: the schedule_editor module (same as
    ScheduleFixturesView). Only `scheduled`/`postponed` matches move; the
    change is validated against the scheduler's constraint machinery (other
    leaves' bookings + shared-player links count) — hard conflicts 409 with
    the structured violations payload unless force=true (then applied, the
    violations ride along as warnings). Idempotent on event_id; audited
    (`match_rescheduled`, before/after slot)."""

    permission_classes = [IsAuthenticated]

    def patch(self, request, match_id):
        from datetime import datetime as _datetime

        from apps.audit.models import AuditEvent
        from apps.fixtures.services.repair import RepairConflict, reschedule_match
        from apps.tournaments.permissions import can_access_module

        match = _match_or_404(request.user, match_id)
        if not can_access_module(
            request.user, match.tournament, "tournament.schedule_editor"
        ):
            raise PermissionDenied("not_schedule_editor")
        ser = RescheduleMatchSerializer(data=request.data)
        ser.is_valid(raise_exception=True)

        event_id = ser.validated_data.get("event_id")
        if event_id:
            prior = AuditEvent.objects.filter(
                idempotency_key=event_id, event_type="match_rescheduled"
            ).first()
            if prior is not None:  # replay (invariant 3)
                return Response({
                    "match": MatchSerializer(match).data,
                    "violations": (prior.payload_after or {}).get("violations", []),
                })

        scheduled_at = None
        raw = ser.validated_data.get("scheduled_at")
        if raw is not None:
            try:
                scheduled_at = _datetime.fromisoformat(
                    str(raw).replace("Z", "+00:00")
                )
            except ValueError as e:
                raise DRFValidationError(
                    {"detail": "invalid_scheduled_at"}
                ) from e

        try:
            violations = reschedule_match(
                match=match,
                by=request.user,
                scheduled_at=scheduled_at,
                venue=ser.validated_data.get("venue"),
                force=bool(ser.validated_data.get("force")),
                event_id=event_id,
                request=request,
            )
        except RepairConflict as e:
            return Response(
                {"detail": "schedule_conflicts", "violations": e.violations},
                status=409,
            )
        except ValidationError as e:
            code = getattr(e, "message", "invalid_reschedule")
            if code == "match_not_movable":
                return Response(
                    {"detail": code, "status": match.status}, status=409
                )
            raise DRFValidationError({"detail": code}) from e
        match.refresh_from_db()
        return Response(
            {"match": MatchSerializer(match).data, "violations": violations}
        )


class MatchLockView(GenericAPIView):
    """`POST/DELETE /api/matches/{id}/lock/` — pin / release a match's slot
    (repair seam, increment B). A locked match is never reassigned by a
    scheduler re-run; its (venue, time, teams) stays on the calendar as a
    fixed busy booking. Gate: the schedule_editor module. Idempotent (a
    second lock/unlock is a no-op); audited (`match_locked`/`match_unlocked`)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        return self._set(request, match_id, locked=True)

    def delete(self, request, match_id):
        return self._set(request, match_id, locked=False)

    def _set(self, request, match_id, *, locked: bool):
        from django.utils import timezone as dj_tz

        from apps.audit.models import ActorRole
        from apps.audit.services import emit_audit
        from apps.tournaments.permissions import can_access_module

        match = _match_or_404(request.user, match_id)
        if not can_access_module(
            request.user, match.tournament, "tournament.schedule_editor"
        ):
            raise PermissionDenied("not_schedule_editor")
        if bool(match.locked_at) == locked:  # idempotent no-op
            return Response({"match": MatchSerializer(match).data})
        before = {
            "locked_at": match.locked_at.isoformat() if match.locked_at else None
        }
        match.locked_at = dj_tz.now() if locked else None
        match.save(update_fields=["locked_at", "updated_at"])
        emit_audit(
            actor_user=request.user,
            actor_role=ActorRole.ADMIN,
            event_type="match_locked" if locked else "match_unlocked",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            tournament_id=match.tournament_id,
            match_id=match.id,
            payload_before=before,
            payload_after={
                "locked_at": match.locked_at.isoformat() if match.locked_at else None
            },
            request=request,
        )
        return Response({"match": MatchSerializer(match).data})


class TransitionMatchView(GenericAPIView):
    """`POST /api/matches/{id}/transition/` — move the match through its state
    machine (start/half-time/complete/etc.)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_transition")
        ser = TransitionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            transition_match(
                match=match,
                to_status=ser.validated_data["to_status"],
                by=request.user,
                reason=ser.validated_data.get("reason", ""),
                request=request,
                winner_team_id=ser.validated_data.get("winner_team_id"),
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "illegal_transition")})
        match.refresh_from_db()
        return Response(MatchSerializer(match).data)


class MatchEventsExportView(GenericAPIView):
    """`GET /api/matches/{id}/events/export/` — full event timeline as CSV."""

    permission_classes = [IsAuthenticated]

    def get(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        events = (
            MatchEvent.objects.filter(match=match)
            .select_related(
                "team", "player", "player__person",
                "related_player", "related_player__person",
            )
            .order_by("sequence_no")
        )
        resp = HttpResponse(content_type="text/csv")
        resp["Content-Disposition"] = (
            f'attachment; filename="match-{match_id}-timeline.csv"'
        )
        writer = csv.writer(resp)
        writer.writerow(
            ["seq", "minute", "period", "type", "team", "player", "related_player"]
        )
        for e in events:
            writer.writerow(
                [
                    e.sequence_no,
                    e.minute if e.minute is not None else "",
                    _csv_safe(e.period),
                    _csv_safe(e.event_type),
                    _csv_safe(e.team.name if e.team else ""),
                    _csv_safe(
                        e.player.person.full_name
                        if e.player and e.player.person
                        else ""
                    ),
                    _csv_safe(
                        e.related_player.person.full_name
                        if e.related_player and e.related_player.person
                        else ""
                    ),
                ]
            )
        return resp


def _team_in_match_or_400(match: Match, team_id):
    if team_id is None:
        raise DRFValidationError({"detail": "team_id_required"})
    if team_id not in (match.home_team_id, match.away_team_id):
        raise DRFValidationError({"detail": "team_not_in_match"})
    team = match.home_team if team_id == match.home_team_id else match.away_team
    if team is None:
        raise DRFValidationError({"detail": "team_not_found"})
    return team


class MatchLineupView(GenericAPIView):
    """`GET/POST /api/matches/{id}/lineups/` — read both teams' lineups (any
    match viewer) or set a team's lineup (manager/scorer/referee)."""

    permission_classes = [IsAuthenticated]

    def get(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        lineups = (
            Lineup.objects.filter(match=match, deleted_at__isnull=True)
            .select_related("team")
            .prefetch_related("entries", "entries__player", "entries__player__person")
            .order_by("created_at")
        )
        return Response({"lineups": LineupSerializer(lineups, many=True).data})

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_set_lineup")
        ser = SetLineupSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        team = _team_in_match_or_400(match, ser.validated_data["team_id"])

        existing = Lineup.objects.filter(
            match=match, team=team, deleted_at__isnull=True
        ).exists()
        try:
            lineup = set_lineup(
                match=match,
                team=team,
                entries=ser.validated_data["entries"],
                by=request.user,
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid_lineup")})
        lineup = (
            Lineup.objects.select_related("team")
            .prefetch_related("entries", "entries__player", "entries__player__person")
            .get(pk=lineup.pk)
        )
        status = 200 if existing else 201
        return Response(LineupSerializer(lineup).data, status=status)


class ConfirmLineupView(GenericAPIView):
    """`POST /api/matches/{id}/lineups/confirm/` — referee/manager confirms a
    team's lineup before kickoff."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_confirm_lineup")
        ser = ConfirmLineupSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        team = _team_in_match_or_400(match, ser.validated_data["team_id"])
        try:
            lineup = confirm_lineup(
                match=match,
                team=team,
                by=request.user,
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid_confirm")})
        lineup = (
            Lineup.objects.select_related("team")
            .prefetch_related("entries", "entries__player", "entries__player__person")
            .get(pk=lineup.pk)
        )
        return Response(LineupSerializer(lineup).data)


class MatchIncidentView(GenericAPIView):
    """`GET/POST /api/matches/{id}/incidents/` — list incident reports (any
    match viewer) or file one (manager/scorer/referee). Append-only."""

    permission_classes = [IsAuthenticated]

    def get(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        qs = MatchIncident.objects.filter(match=match).order_by("-created_at")
        return Response(MatchIncidentSerializer(qs, many=True).data)

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        if not _can_score(request.user, match):
            raise PermissionDenied("not_allowed_to_file_incident")
        ser = FileIncidentSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        player = None
        player_id = ser.validated_data.get("player_id")
        if player_id:
            from apps.teams.models import Player

            player = Player.objects.filter(
                id=player_id, tournament=match.tournament, deleted_at__isnull=True
            ).first()
            if player is None:
                raise DRFValidationError({"detail": "player_not_found"})
        try:
            incident = file_incident(
                match=match,
                kind=ser.validated_data["kind"],
                description=ser.validated_data["description"],
                by=request.user,
                minute=ser.validated_data.get("minute"),
                player=player,
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid_incident")})
        return Response(MatchIncidentSerializer(incident).data, status=201)
