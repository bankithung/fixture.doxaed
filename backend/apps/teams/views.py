from __future__ import annotations

from django.db import IntegrityError
from django.db.models import Count, F, Q
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.teams.models import Institution, RegistrationLink, Team
from apps.teams.serializers import (
    InstitutionInSerializer,
    SchoolRegistrationSerializer,
)
from apps.teams.services.registration import (
    create_registration_link,
    get_or_create_institution,
    register_school,
    resolve_registration_link,
)
from apps.teams.throttling import RegistrationRateThrottle
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


class RegistrationLinkCreateView(GenericAPIView):
    """`POST /api/tournaments/{id}/registration-link/` — organizer mints a
    shareable link schools use to self-register. Token returned once."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        tournament = (
            Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
            .select_related("organization")
            .first()
        )
        if tournament is None or not accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists():
            raise NotFound("tournament_not_found")
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        link, token = create_registration_link(
            tournament=tournament, created_by=request.user,
            label=request.data.get("label", ""),
        )
        return Response(
            {"token": token, "path": f"/register/{token}", "tournament_id": str(tournament.id)},
            status=201,
        )


class PublicRegistrationView(GenericAPIView):
    """`GET/POST /api/register/{token}/` — AllowAny. GET returns tournament
    context; POST registers a school's teams + players via the link."""

    permission_classes = [AllowAny]
    throttle_classes = [RegistrationRateThrottle]
    serializer_class = SchoolRegistrationSerializer

    def get(self, request, token):
        link = resolve_registration_link(token)
        if link is None:
            raise NotFound("invalid_link")
        return Response(
            {"tournament_name": link.tournament.name, "tournament_id": str(link.tournament_id)}
        )

    def post(self, request, token):
        link = resolve_registration_link(token)
        if link is None:
            raise NotFound("invalid_link")
        ser = SchoolRegistrationSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            teams = register_school(
                tournament=link.tournament,
                school_name=ser.validated_data["school_name"],
                teams=ser.validated_data["teams"],
                channel="self",
                event_id=ser.validated_data.get("event_id"),
                request=request,
            )
        except IntegrityError:
            raise DRFValidationError(
                {"detail": "duplicate_team_name_or_jersey_in_submission"}
            )
        RegistrationLink.objects.filter(pk=link.pk).update(
            submission_count=F("submission_count") + 1
        )
        return Response(
            {"registered": len(teams), "teams": [t.name for t in teams]}, status=201
        )


class TournamentTeamsListView(GenericAPIView):
    """`GET` registered teams (access-scoped); `POST` admin direct-add of a team
    under an institution (Stage-2; manager-only)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        tournament = (
            Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
            .select_related("organization")
            .first()
        )
        if tournament is None or not accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists():
            raise NotFound("tournament_not_found")
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        institution_id = request.data.get("institution_id")
        name = (request.data.get("name") or "").strip()
        if not institution_id or not name:
            raise DRFValidationError({"detail": "institution_id and name are required"})
        try:
            teams = register_school(
                tournament=tournament,
                school_name="",
                teams=[{"name": name, "players": []}],
                submitted_by=request.user,
                channel="admin",
                event_id=request.data.get("event_id"),
                institution_id=institution_id,
                request=request,
            )
        except ValueError as e:
            raise DRFValidationError({"detail": str(e)})
        except IntegrityError:
            raise DRFValidationError({"detail": "duplicate_team_name"})
        return Response(
            {"registered": len(teams), "teams": [t.name for t in teams]}, status=201
        )

    def get(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        qs = (
            Team.objects.filter(tournament_id=tournament_id, deleted_at__isnull=True)
            .select_related("institution")
            .annotate(
                player_count=Count(
                    "players", filter=Q(players__deleted_at__isnull=True)
                )
            )
            .order_by("institution__name", "pool", "name")
        )
        institution_id = request.query_params.get("institution")
        if institution_id:
            qs = qs.filter(institution_id=institution_id)
        return Response(
            [
                {
                    "id": str(t.id),
                    "name": t.name,
                    "short_name": t.short_name,
                    "school": t.school,
                    "institution_id": str(t.institution_id) if t.institution_id else None,
                    "institution_name": t.institution.name if t.institution_id else t.school,
                    "pool": t.pool,
                    "status": t.status,
                    "player_count": t.player_count,
                }
                for t in qs
            ]
        )


def _institution_dict(i: Institution) -> dict:
    return {
        "id": str(i.id),
        "name": i.name,
        "short_name": i.short_name,
        "kind": i.kind,
        "region": i.region,
        "contact_name": i.contact_name,
        "contact_email": i.contact_email,
        "contact_phone": i.contact_phone,
        "status": i.status,
        "team_count": getattr(i, "team_count", 0),
    }


class InstitutionListCreateView(GenericAPIView):
    """`GET` registered institutions (the Stage-2 dropdown source; access-scoped).
    `POST` admin direct-add of an institution (Stage-1; manager-only)."""

    permission_classes = [IsAuthenticated]
    serializer_class = InstitutionInSerializer

    def get(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        qs = (
            Institution.objects.filter(
                tournament_id=tournament_id, deleted_at__isnull=True
            )
            .annotate(
                team_count=Count("teams", filter=Q(teams__deleted_at__isnull=True))
            )
            .order_by("name")
        )
        return Response([_institution_dict(i) for i in qs])

    def post(self, request, tournament_id):
        tournament = (
            Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
            .select_related("organization")
            .first()
        )
        if tournament is None or not accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists():
            raise NotFound("tournament_not_found")
        if not can_manage_tournament(request.user, tournament):
            raise PermissionDenied("not_tournament_manager")
        ser = InstitutionInSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d = ser.validated_data
        inst = get_or_create_institution(
            tournament=tournament, name=d["name"], kind=d.get("kind", "school"),
            created_by=request.user,
        )
        # apply the optional descriptive fields on create/edit
        changed = []
        for field in ("region", "short_name", "contact_name", "contact_email", "contact_phone"):
            if d.get(field):
                setattr(inst, field, d[field])
                changed.append(field)
        if changed:
            inst.save(update_fields=[*changed, "updated_at"])
        inst.team_count = inst.teams.filter(deleted_at__isnull=True).count()
        return Response(_institution_dict(inst), status=201)


class InstitutionDetailView(GenericAPIView):
    """`PATCH /api/tournaments/{id}/institutions/{iid}/` — edit / withdraw an
    institution (manager-only; reversible per the staged-flow design)."""

    permission_classes = [IsAuthenticated]
    serializer_class = InstitutionInSerializer

    def patch(self, request, tournament_id, institution_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        inst = Institution.objects.filter(
            id=institution_id, tournament_id=tournament_id, deleted_at__isnull=True
        ).select_related("tournament").first()
        if inst is None:
            raise NotFound("institution_not_found")
        if not can_manage_tournament(request.user, inst.tournament):
            raise PermissionDenied("not_tournament_manager")
        changed = []
        for field in ("name", "kind", "region", "short_name", "contact_name",
                      "contact_email", "contact_phone", "status"):
            if field in request.data:
                setattr(inst, field, request.data[field])
                changed.append(field)
        if changed:
            inst.save(update_fields=[*changed, "updated_at"])
        inst.team_count = inst.teams.filter(deleted_at__isnull=True).count()
        return Response(_institution_dict(inst))
