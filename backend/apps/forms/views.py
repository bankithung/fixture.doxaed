"""Builder + public API for the registration form engine.

Builder endpoints are organizer-only and tournament-scoped: access resolves via
``accessible_tournaments`` (404 on no-access, no existence leak — invariant #2)
and ``can_manage_tournament`` (403 for read-only members). The public submission
API (``PublicFormView``, ``PublicUploadView``) is ``AllowAny`` + throttled so
anyone with a form link or share token can submit.
"""
from __future__ import annotations

from typing import ClassVar

from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.response import Response

from apps.forms.constants import CHOICE_TYPES, FIELD_TYPES
from apps.forms.models import Form, FormFileUpload
from apps.forms.serializers import (
    FormCreateSerializer,
    FormSerializer,
    PublicSubmitSerializer,
)
from apps.forms.services.forms import (
    FormEditError,
    close_form,
    create_form,
    duplicate_form,
    is_open,
    publish_form,
    update_form,
)
from apps.forms.services.links import resolve_share_link
from apps.forms.services.responses import submit_response
from apps.forms.services.validation import AnswerError
from apps.forms.throttling import PublicFormThrottle
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


# --- Public submission API (Increment 4) -----------------------------------
# AllowAny + throttled: anyone with a form link or share token may submit.


def _public_payload(form):
    return {
        "form": {
            "id": str(form.id),
            "title": form.title,
            "description": form.description,
            "schema": form.schema,
            "confirmation_message": form.confirmation_message,
        },
        "tournament_name": form.tournament.name,
    }


class PublicFormView(GenericAPIView):
    """`GET/POST /api/forms/{id}/public/` and `/api/forms/r/{token}/`.

    GET returns the form schema (or ``{"closed": true}`` when not accepting
    submissions); POST validates + records a response. Resolves either by form
    id (open public form) or by an active share token.
    """

    permission_classes: ClassVar[list[type[BasePermission]]] = [AllowAny]
    throttle_classes: ClassVar[list] = [PublicFormThrottle]

    def _resolve(self, form_id=None, token=None):
        if token is not None:
            link = resolve_share_link(token)
            if link is None:
                raise NotFound("invalid_link")
            return link.form, link
        form = Form.objects.filter(
            id=form_id, deleted_at__isnull=True
        ).select_related("tournament").first()
        if form is None:
            raise NotFound("form_not_found")
        return form, None

    def get(self, request, form_id=None, token=None):
        form, _link = self._resolve(form_id, token)
        if not is_open(form):
            return Response({"closed": True, "tournament_name": form.tournament.name})
        return Response(_public_payload(form))

    def post(self, request, form_id=None, token=None):
        form, link = self._resolve(form_id, token)
        if not is_open(form):
            raise DRFValidationError({"detail": "registration_closed"})
        ser = PublicSubmitSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            resp = submit_response(
                form=form,
                answers=ser.validated_data["answers"],
                event_id=ser.validated_data.get("event_id"),
                share_link=link,
                upload_refs=ser.validated_data.get("upload_refs"),
                request=request,
            )
        except AnswerError as e:
            raise DRFValidationError({"errors": e.errors}) from e
        from apps.forms.services.mapping import map_response  # local import (Increment 5)

        map_response(resp)
        return Response(
            {"response_id": str(resp.id), "message": form.confirmation_message},
            status=201,
        )


class PublicUploadView(GenericAPIView):
    """`POST /api/forms/{id}/uploads/` — stage a file before submission.

    Returns an ``upload_ref`` the client later includes in ``upload_refs`` on the
    submission; ``submit_response`` then claims the unattached row. Validates
    size + content type. AllowAny + throttled.
    """

    permission_classes: ClassVar[list[type[BasePermission]]] = [AllowAny]
    throttle_classes: ClassVar[list] = [PublicFormThrottle]
    parser_classes: ClassVar[list] = [MultiPartParser, FormParser]
    MAX_BYTES = 10 * 1024 * 1024
    ALLOWED: ClassVar[set[str]] = {"application/pdf", "image/png", "image/jpeg"}

    def post(self, request, form_id):
        form = Form.objects.filter(id=form_id, deleted_at__isnull=True).first()
        if form is None or not is_open(form):
            raise NotFound("form_not_found")
        f = request.FILES.get("file")
        if f is None:
            raise DRFValidationError({"detail": "no_file"})
        if f.size > self.MAX_BYTES:
            raise DRFValidationError({"detail": "file_too_large"})
        if f.content_type not in self.ALLOWED:
            raise DRFValidationError({"detail": "unsupported_type"})
        up = FormFileUpload.objects.create(
            organization=form.organization,
            form=form,
            field_key=request.data.get("field_key", "")[:80],
            file=f,
            original_name=f.name[:255],
            content_type=f.content_type,
            size=f.size,
        )
        return Response({"upload_ref": str(up.upload_ref)}, status=201)
