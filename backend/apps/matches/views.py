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

from apps.matches.models import (
    Lineup,
    Match,
    MatchEvent,
    MatchEventType,
    MatchIncident,
    MatchOfficial,
    MatchStatus,
)
from apps.matches.serializers import (
    AssignOfficialSerializer,
    ConfirmLineupSerializer,
    DelayMatchSerializer,
    FileIncidentSerializer,
    LineupSerializer,
    MatchIncidentSerializer,
    MatchOfficialSerializer,
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
from apps.matches.services.officials import (
    assign_official,
    official_clashes,
    remove_official,
)
from apps.matches.services.scoring import assign_scorer, record_score
from apps.matches.services.standings import compute_standings
from apps.matches.services.state import transition_match
from apps.tournaments.models import (
    Tournament,
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.permissions import can_access_module, can_manage_tournament
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


def _is_active_referee(user, tournament) -> bool:
    return TournamentMembership.objects.filter(
        user=user,
        tournament=tournament,
        role=TournamentMembershipRole.REFEREE,
        status=TournamentMembershipStatus.ACTIVE,
    ).exists()


def _can_transition(user, match: Match) -> bool:
    """State-machine gate (control room spec 2026-06-12 §2.e, owner decision
    2026-06-12): the scoring gate, plus an active REFEREE may transition the
    matches they are ASSIGNED to (Match.scorer) — start/half-time/complete
    from the touchline. Walkover/replay are additionally manager-gated in
    the view."""
    if _can_score(user, match):
        return True
    return match.scorer_id == user.id and _is_active_referee(
        user, match.tournament
    )


def _can_record_events(user, match: Match) -> bool:
    """Event/VOID gate (owner decision 2026-06-12): the scoring gate, except
    an active REFEREE never qualifies through assignment alone — referees
    run the state machine on their matches (see _can_transition) but do not
    write or void the event log. An explicit per-member scoring-console
    grant (module layer) stays the escape hatch."""
    if not _can_score(user, match):
        return False
    if can_manage_tournament(user, match.tournament):
        return True
    if not _is_active_referee(user, match.tournament):
        return True
    from apps.permissions.services.resolver import effective_tournament_modules

    return "match.scoring_console" in effective_tournament_modules(
        user, match.tournament
    )




class TournamentMatchListView(GenericAPIView):
    """Tournament-wide match list — the all-days source for the operations
    Matches board. Rows are enriched (leaf_label + scorer + officials) the same
    way as the control-room day view, so the board can show + filter crew."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        from apps.tournaments.services.sports import leaf_label

        t = _accessible_tournament_or_404(request.user, tournament_id)
        qs = (
            Match.objects.filter(tournament=t, deleted_at__isnull=True)
            .select_related("home_team", "away_team", "tournament", "scorer")
            .prefetch_related("officials__user")
            .order_by("group_label", "match_no")
        )
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

        return Response([row(m) for m in qs])


class TournamentLeadersView(GenericAPIView):
    """`GET /api/tournaments/{id}/leaders/` — the ops leaderboards (owner
    ask: best players, teams, scorers visible in the app). Same payload as
    the public endpoint; see services/leaders.py."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        from apps.matches.services.leaders import compute_leaders

        t = _accessible_tournament_or_404(request.user, tournament_id)
        full = request.query_params.get("full") in ("1", "true")
        return Response(compute_leaders(t, full=full))


class TournamentSuspensionsView(GenericAPIView):
    """`GET /api/tournaments/{id}/suspensions/` — card-derived bans (PRD 5.8):
    who is serving, why, and how much remains. Derived from the event log on
    demand, like standings."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        from apps.matches.services.discipline import compute_suspensions

        t = _accessible_tournament_or_404(request.user, tournament_id)
        return Response({"suspensions": compute_suspensions(t)})


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
        raw = request.data.get("user_id")
        target = None
        if raw:  # null/empty clears the seat (a seat could not be vacated before)
            target = User.objects.filter(id=raw).first()
            if target is None:
                raise DRFValidationError({"detail": "user_not_found"})
        try:
            assign_scorer(match=match, user=target, by=request.user, request=request)
        except ValidationError as e:
            raise DRFValidationError({"detail": getattr(e, "message", "invalid_assignment")})
        match.refresh_from_db()
        return Response(MatchSerializer(match).data)


def _officials_payload(match: Match) -> list[dict]:
    return MatchOfficialSerializer(
        match.officials.select_related("user").all(), many=True
    ).data


class AssignOfficialsView(GenericAPIView):
    """Assign / remove a match official (referee, assistant, fourth, umpire).

    `POST /api/matches/{id}/officials/` body {user_id, role, event_id?} → assign;
    `DELETE` body {official_id} → remove. Gate: a manager OR the
    `match.assign_officials` module (admin / co-organizer / game-coordinator).
    Returns the match's full officials list; POST also flags a soft
    double-booking warning when the person clashes with another assignment.
    """

    permission_classes = [IsAuthenticated]

    def _gate(self, request, match):
        if not can_access_module(
            request.user, match.tournament, "match.assign_officials"
        ):
            raise PermissionDenied("not_allowed_to_assign_officials")

    def post(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        self._gate(request, match)
        ser = AssignOfficialSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        target = User.objects.filter(id=ser.validated_data["user_id"]).first()
        if target is None:
            raise DRFValidationError({"detail": "user_not_found"})
        try:
            assign_official(
                match=match,
                user=target,
                role=ser.validated_data["role"],
                by=request.user,
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except ValidationError as e:
            raise DRFValidationError(
                {"detail": getattr(e, "message", "invalid_assignment")}
            )
        clashes = official_clashes(user=target, match=match)
        return Response(
            {
                "officials": _officials_payload(match),
                "warning": (
                    {"code": "official_double_booked", "count": len(clashes)}
                    if clashes
                    else None
                ),
            }
        )

    def delete(self, request, match_id):
        match = _match_or_404(request.user, match_id)
        self._gate(request, match)
        official_id = request.data.get("official_id")
        if not official_id:
            raise DRFValidationError({"detail": "official_id_required"})
        remove_official(
            match=match, official_id=official_id, by=request.user, request=request
        )
        return Response({"officials": _officials_payload(match)})


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
        if not _can_record_events(request.user, match):
            raise PermissionDenied("not_allowed_to_score")
        ser = RecordEventSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        if ser.validated_data["event_type"] == MatchEventType.VOID:
            return self._void(request, match, ser.validated_data)
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

    def _void(self, request, match, data):
        """Undo (P7a): append a VOID reversing the event at ``voids_seq``.
        Append-only per invariant 4 — recompute_score derives the corrected
        score; the original row stays in the immutable log."""
        from apps.matches.services.events import void_match_event

        # Idempotency first (invariant 3): a replayed event_id returns the
        # recorded state before any already-voided guard can 400 it.
        if data.get("event_id") is not None:
            prior = MatchEvent.objects.filter(event_id=data["event_id"]).first()
            if prior is not None:
                match.refresh_from_db()
                return Response(MatchSerializer(match).data, status=201)
        seq = data.get("voids_seq")
        if not seq:
            raise DRFValidationError({"detail": "voids_seq_required"})
        target = MatchEvent.objects.filter(match=match, sequence_no=seq).first()
        if target is None:
            raise DRFValidationError({"detail": "event_not_found"})
        if target.event_type == MatchEventType.VOID:
            raise DRFValidationError({"detail": "cannot_void_a_void"})
        if MatchEvent.objects.filter(
            match=match, event_type=MatchEventType.VOID, voids=target
        ).exists():
            raise DRFValidationError({"detail": "already_voided"})
        try:
            void_match_event(
                match=match, target_event=target, by=request.user,
                event_id=data.get("event_id"), request=request,
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
            MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.HALF_TIME,
            MatchStatus.COMPLETED,
        ):
            # SCHEDULED is allowed for the paper-score path: the board's
            # quick result records pens first, then the level score completes.
            raise DRFValidationError({"detail": "shootout_wrong_state"})
        if (
            match.home_score is not None
            and match.away_score is not None
            and match.home_score != match.away_score
        ):
            raise DRFValidationError({"detail": "shootout_only_when_level"})

        ser = RecordShootoutSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        from apps.audit.models import ActorRole, AuditEvent
        from apps.audit.services import emit_audit

        # Idempotency pre-check (invariant 3): a replayed event_id must not
        # re-write pens or re-fire advancement — return the recorded state.
        event_id = ser.validated_data.get("event_id")
        if event_id is not None:
            prior = AuditEvent.objects.filter(
                idempotency_key=event_id, event_type="match_shootout_recorded"
            ).first()
            if prior is not None:
                match.refresh_from_db()
                return Response(MatchSerializer(match).data)

        with transaction.atomic():
            before = {"home_pens": match.home_pens, "away_pens": match.away_pens}
            match.home_pens = ser.validated_data["home_pens"]
            match.away_pens = ser.validated_data["away_pens"]
            match.save(update_fields=["home_pens", "away_pens", "updated_at"])
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
                idempotency_key=event_id,
                request=request,
            )
            # An already-completed drawn match was a stalled bracket — the
            # shootout result now resolves winner_id, so ripple it (invariant 9).
            if match.status == MatchStatus.COMPLETED:
                mid = match.id
                transaction.on_commit(lambda: _fire_advancement(mid))
            from apps.live.publish import publish_tournament_tick

            tid, mid2 = match.tournament_id, match.id
            transaction.on_commit(lambda: publish_tournament_tick(tid, mid2, "score"))
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


class MatchDelayView(GenericAPIView):
    """`POST /api/matches/{id}/delay/` — delay cascade (repair seam,
    increment C). Body `{minutes (1..480), cascade?=true, force?,
    event_id?}`. Gate: the schedule_editor module. Shifts the match by
    +minutes; with cascade, later same-venue movable matches are pushed just
    enough (scheduled_at order) to restore venue non-overlap + rest gaps —
    live/completed/locked matches never move (fixed obstacles). Everything
    moved is re-validated; hard violations 409 with the structured payload
    unless force. ONE `match_delay_cascade` audit row carries the full
    {match_id, old, new} list; idempotent on event_id."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        from apps.audit.models import AuditEvent
        from apps.fixtures.services.repair import RepairConflict, delay_match
        from apps.tournaments.permissions import can_access_module

        match = _match_or_404(request.user, match_id)
        if not can_access_module(
            request.user, match.tournament, "tournament.schedule_editor"
        ):
            raise PermissionDenied("not_schedule_editor")
        ser = DelayMatchSerializer(data=request.data)
        ser.is_valid(raise_exception=True)

        event_id = ser.validated_data.get("event_id")
        if event_id:
            prior = AuditEvent.objects.filter(
                idempotency_key=event_id, event_type="match_delay_cascade"
            ).first()
            if prior is not None:  # replay (invariant 3) — do NOT shift again
                payload = prior.payload_after or {}
                return Response({
                    "moved": payload.get("moved", []),
                    "violations": payload.get("violations", []),
                })

        try:
            moved, violations = delay_match(
                match=match,
                by=request.user,
                minutes=ser.validated_data["minutes"],
                cascade=ser.validated_data.get("cascade", True),
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
            code = getattr(e, "message", "invalid_delay")
            if code == "match_not_movable":
                return Response(
                    {"detail": code, "status": match.status}, status=409
                )
            if code == "match_locked":
                return Response({"detail": code}, status=409)
            raise DRFValidationError({"detail": code}) from e
        return Response({"moved": moved, "violations": violations})


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
        from django.db import transaction

        from apps.live.publish import publish_tournament_tick

        match.locked_at = dj_tz.now() if locked else None
        match.save(update_fields=["locked_at", "updated_at"])
        tid, mid = match.tournament_id, match.id
        transaction.on_commit(lambda: publish_tournament_tick(tid, mid, "schedule"))
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


class MatchCallView(GenericAPIView):
    """`POST/DELETE /api/matches/{id}/call/` — mark / unmark a match as
    called to its venue (control room, spec 2026-06-12 §2.b). `called_at` is
    an operational annotation of `scheduled`, NOT a lifecycle state (PRD §5.5
    note, decision 72) — the state machine is untouched, and kickoff clears
    it (see transition_match). Gate: the schedule_editor module (mirrors
    MatchLockView). Idempotent (a repeat call/un-call is a no-op); only legal
    while the match is `scheduled` (409 otherwise); audited
    (`match_called`/`match_call_cleared`)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, match_id):
        return self._set(request, match_id, called=True)

    def delete(self, request, match_id):
        return self._set(request, match_id, called=False)

    def _set(self, request, match_id, *, called: bool):
        from django.utils import timezone as dj_tz

        from apps.audit.models import ActorRole
        from apps.audit.services import emit_audit
        from apps.tournaments.permissions import can_access_module

        match = _match_or_404(request.user, match_id)
        if not can_access_module(
            request.user, match.tournament, "tournament.schedule_editor"
        ):
            raise PermissionDenied("not_schedule_editor")
        if match.status != MatchStatus.SCHEDULED:
            return Response(
                {"detail": "match_not_callable", "status": match.status},
                status=409,
            )
        if bool(match.called_at) == called:  # idempotent no-op
            return Response({"match": MatchSerializer(match).data})
        before = {
            "called_at": match.called_at.isoformat() if match.called_at else None
        }
        from django.db import transaction

        from apps.live.publish import publish_tournament_tick

        match.called_at = dj_tz.now() if called else None
        match.save(update_fields=["called_at", "updated_at"])
        tid, mid = match.tournament_id, match.id
        transaction.on_commit(lambda: publish_tournament_tick(tid, mid, "called"))
        emit_audit(
            actor_user=request.user,
            actor_role=ActorRole.ADMIN,
            event_type="match_called" if called else "match_call_cleared",
            target_type="match",
            target_id=match.id,
            organization_id=match.organization_id,
            tournament_id=match.tournament_id,
            match_id=match.id,
            payload_before=before,
            payload_after={
                "called_at": match.called_at.isoformat() if match.called_at else None
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
        if not _can_transition(request.user, match):
            raise PermissionDenied("not_allowed_to_transition")
        ser = TransitionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        to_status = ser.validated_data["to_status"]
        # Owner decision 2026-06-12 (spec §2.e): awarding a walkover and
        # replaying an abandoned match are MANAGER verbs, not scorer verbs.
        # Postpone/cancel are scheduling decisions — same manager gate.
        # Abandoning stays a referee/scorer verb (they are on the pitch).
        replay = (
            match.status == MatchStatus.ABANDONED
            and to_status == MatchStatus.SCHEDULED
        )
        manager_only = to_status in (
            MatchStatus.WALKOVER, MatchStatus.POSTPONED, MatchStatus.CANCELLED
        )
        if (manager_only or replay) and not can_manage_tournament(
            request.user, match.tournament
        ):
            raise PermissionDenied("manager_only_transition")
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
