"""Builder API for the registration form engine.

All builder endpoints are organizer-only and tournament-scoped: access resolves
via ``accessible_tournaments`` (404 on no-access, no existence leak — invariant
#2) and ``can_manage_tournament`` (403 for read-only members). The public
submission API lives in Increment 4.
"""
from __future__ import annotations

from typing import ClassVar

from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response

from apps.forms.constants import CHOICE_TYPES, FIELD_TYPES
from apps.forms.models import Form
from apps.forms.serializers import FormCreateSerializer, FormSerializer
from apps.forms.services.forms import (
    FormEditError,
    close_form,
    create_form,
    duplicate_form,
    publish_form,
    update_form,
)
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


def _get_manageable_tournament(user, tournament_id):
    t = Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True).first()
    if t is None or not accessible_tournaments(user).filter(id=tournament_id).exists():
        raise NotFound("tournament_not_found")
    if not can_manage_tournament(user, t):
        raise PermissionDenied("not_tournament_manager")
    return t


def _get_manageable_form(user, form_id):
    f = Form.objects.filter(id=form_id, deleted_at__isnull=True).select_related(
        "tournament", "organization").first()
    if f is None or not accessible_tournaments(user).filter(id=f.tournament_id).exists():
        raise NotFound("form_not_found")
    if not can_manage_tournament(user, f.tournament):
        raise PermissionDenied("not_tournament_manager")
    return f


class TournamentFormsView(GenericAPIView):
    """`GET/POST /api/tournaments/{id}/forms/` — list (access-scoped) + create."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def get(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        qs = Form.objects.filter(
            tournament_id=tournament_id, deleted_at__isnull=True
        ).order_by("-created_at")
        return Response(FormSerializer(qs, many=True).data)

    def post(self, request, tournament_id):
        t = _get_manageable_tournament(request.user, tournament_id)
        ser = FormCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        form = create_form(
            tournament=t, title=ser.validated_data["title"],
            purpose=ser.validated_data["purpose"],
            schema=ser.validated_data.get("schema"),
            created_by=request.user, request=request,
        )
        return Response(FormSerializer(form).data, status=201)


class FormDetailView(GenericAPIView):
    """`GET/PATCH/DELETE /api/forms/{id}/` — read, partial-update, soft-delete."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def get(self, request, form_id):
        return Response(FormSerializer(_get_manageable_form(request.user, form_id)).data)

    def patch(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        ser = FormSerializer(form, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        update_form(form, ser.validated_data, user=request.user, request=request)
        return Response(FormSerializer(form).data)

    def delete(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        form.deleted_at = timezone.now()
        form.save(update_fields=["deleted_at"])
        return Response(status=204)


class FormPublishView(GenericAPIView):
    """`POST /api/forms/{id}:publish/` — draft -> open."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        try:
            form = publish_form(form, user=request.user, request=request)
        except FormEditError as e:
            raise DRFValidationError({"detail": str(e)}) from e
        return Response(FormSerializer(form).data)


class FormCloseView(GenericAPIView):
    """`POST /api/forms/{id}:close/` — open -> closed."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, form_id):
        form = close_form(_get_manageable_form(request.user, form_id),
                          user=request.user, request=request)
        return Response(FormSerializer(form).data)


class FormDuplicateView(GenericAPIView):
    """`POST /api/forms/{id}:duplicate/` — clone schema into a new draft form."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, form_id):
        src = _get_manageable_form(request.user, form_id)
        return Response(FormSerializer(duplicate_form(src, user=request.user)).data, status=201)


class FieldTypesView(GenericAPIView):
    """`GET /api/forms/field-types/` — the field-type catalog for the builder UI."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def get(self, request):
        return Response([
            {"type": ft, "has_options": ft in CHOICE_TYPES} for ft in sorted(FIELD_TYPES)
        ])
