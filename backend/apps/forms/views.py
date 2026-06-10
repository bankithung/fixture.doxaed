"""Builder + public API for the registration form engine.

Builder endpoints are organizer-only and tournament-scoped: access resolves via
``accessible_tournaments`` (404 on no-access, no existence leak — invariant #2)
and ``can_manage_tournament`` (403 for read-only members). The public submission
API (``PublicFormView``, ``PublicUploadView``) is ``AllowAny`` + throttled so
anyone with a form link or share token can submit.
"""
from __future__ import annotations

import csv
from typing import ClassVar

from django.http import HttpResponse
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.response import Response

from apps.forms.constants import (
    CHOICE_TYPES,
    FIELD_TYPES,
    FormPurpose,
    FormStatus,
    ResponseStatus,
)
from apps.forms.models import Form, FormFileUpload, FormResponse
from apps.forms.serializers import (
    FormCreateSerializer,
    FormResponseSerializer,
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
from apps.forms.services.links import (
    create_share_link,
    mint_institution_links,
    resolve_share_link,
)
from apps.forms.services.responses import submit_response
from apps.forms.services.validation import AnswerError
from apps.forms.throttling import PublicFormThrottle
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_access_module, can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


def _get_manageable_tournament(user, tournament_id):
    t = Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True).first()
    if t is None or not accessible_tournaments(user).filter(id=tournament_id).exists():
        raise NotFound("tournament_not_found")
    # Two-layer gate: manager OR the "forms" module (catalog default for
    # game_coordinator/team_manager; per-member grants on top).
    if not can_access_module(user, t, "forms"):
        raise PermissionDenied("not_tournament_manager")
    return t


def _get_manageable_form(user, form_id):
    f = Form.objects.filter(id=form_id, deleted_at__isnull=True).select_related(
        "tournament", "organization").first()
    if f is None or not accessible_tournaments(user).filter(id=f.tournament_id).exists():
        raise NotFound("form_not_found")
    if not can_access_module(user, f.tournament, "forms"):
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
            stage=ser.validated_data.get("stage", ""),
            source_form_id=ser.validated_data.get("source_form_id"),
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


_DATA_BOUND = {"single_choice", "multi_choice", "dropdown"}


def _resolve_data_sources(schema: dict, tournament) -> dict:
    """Populate options for data-bound choice fields (e.g. "select your
    institution") at fetch time, so the dropdown always reflects the CURRENT
    institutions rather than a snapshot. Returns a copy; never mutates the DB."""
    import copy as _copy

    def _is_inst(f):
        return (
            f.get("type") in _DATA_BOUND
            and (f.get("data_source") or {}).get("type") == "institution_list"
        )

    def _scan(fields):
        for f in fields:
            if _is_inst(f):
                return True
            if f.get("type") == "group" and _scan(f.get("fields", [])):
                return True
        return False

    sections = (schema or {}).get("sections", [])
    if not any(_scan(s.get("fields", [])) for s in sections):
        return schema

    from apps.teams.models import Institution

    insts = (
        Institution.objects.filter(tournament=tournament, deleted_at__isnull=True)
        .exclude(status__in=["withdrawn", "rejected"])
        .order_by("name")
    )
    options = [{"value": str(i.id), "label": i.name} for i in insts]

    resolved = _copy.deepcopy(schema)

    def _fill(fields):
        for f in fields:
            if _is_inst(f):
                f["options"] = options
            if f.get("type") == "group":
                _fill(f.get("fields", []))

    for s in resolved.get("sections", []):
        _fill(s.get("fields", []))
    return resolved


def _public_payload(form, link=None):
    data = {
        "form": {
            "id": str(form.id),
            "title": form.title,
            "description": form.description,
            "schema": _resolve_data_sources(form.schema, form.tournament),
            "confirmation_message": form.confirmation_message,
        },
        "tournament_name": form.tournament.name,
    }
    # A bound/prefilled per-institution Stage-2 link carries initial answers + the
    # institution it's fixed to, so the renderer pre-fills contact details and
    # locks the institution (no dropdown to pick the wrong school).
    if link is not None and (link.prefill or link.bound_entity):
        if link.prefill:
            data["prefill"] = link.prefill
        bound_iid = (link.bound_entity or {}).get("institution_id")
        if bound_iid:
            from apps.teams.models import Institution

            inst = Institution.objects.filter(id=bound_iid).first()
            # Lock the institution field by THIS form's binding key (forms vary).
            iid_key = (form.settings or {}).get("bindings", {}).get(
                "institution_id", "institution_id"
            )
            data["locked"] = [iid_key]
            data["bound"] = {
                "institution_id": bound_iid,
                "label": inst.name if inst is not None else "",
            }
    return data


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
        form, link = self._resolve(form_id, token)
        if not is_open(form):
            return Response({
                "closed": True,
                "tournament_name": form.tournament.name,
                "form_id": str(form.id),
                # Institution-registration forms back a public directory of
                # registrants that stays viewable after the stage advances and
                # the form closes — surface it so a closed link isn't a dead end.
                "has_directory": form.purpose == FormPurpose.ORGANIZATION_REGISTRATION,
            })
        return Response(_public_payload(form, link))

    def post(self, request, form_id=None, token=None):
        form, link = self._resolve(form_id, token)
        if not is_open(form):
            raise DRFValidationError({"detail": "registration_closed"})
        ser = PublicSubmitSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        answers = ser.validated_data["answers"]
        # A bound link is authoritative for its institution: stamp it server-side
        # so the submission always maps to the right school, whatever the client
        # sent for the (locked) institution field.
        if link is not None:
            bound_iid = (link.bound_entity or {}).get("institution_id")
            if bound_iid:
                iid_key = (form.settings or {}).get("bindings", {}).get(
                    "institution_id", "institution_id"
                )
                answers = {**answers, iid_key: bound_iid}
        try:
            resp = submit_response(
                form=form,
                answers=answers,
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


# --- Responses API (Increment 5) -------------------------------------------
# Organizer-only: list + CSV export, per-response status review, and Stage-2
# share-link minting for accepted respondents. All resolve via
# ``_get_manageable_form`` (cross-org 404, manager-only).


class FormResponsesView(GenericAPIView):
    """`GET /api/forms/{id}/responses/` — list submissions, or `?export=csv`."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def get(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        qs = FormResponse.objects.filter(
            form=form, deleted_at__isnull=True
        ).order_by("-created_at")
        if request.query_params.get("export") == "csv":
            return self._csv(form, qs)
        return Response(FormResponseSerializer(qs, many=True).data)

    def _csv(self, form, qs):
        resp = HttpResponse(content_type="text/csv")
        resp["Content-Disposition"] = f'attachment; filename="{form.slug}-responses.csv"'
        keys: list[str] = []
        for sec in form.schema.get("sections", []):
            for fld in sec.get("fields", []):
                if fld.get("type") != "section_text":
                    keys.append(fld["key"])
        writer = csv.writer(resp)
        writer.writerow(["title", "email", "phone", "status", "submitted_at", *keys])
        for r in qs:
            writer.writerow([
                r.title, r.respondent_email, r.respondent_phone, r.status,
                r.created_at.isoformat(),
                *[r.answers.get(k, "") for k in keys],
            ])
        return resp


class FormResponseDetailView(GenericAPIView):
    """`PATCH /api/forms/{id}/responses/{rid}/` — review status (accept/reject/...)."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def patch(self, request, form_id, response_id):
        form = _get_manageable_form(request.user, form_id)
        r = FormResponse.objects.filter(
            form=form, id=response_id, deleted_at__isnull=True
        ).first()
        if r is None:
            raise NotFound("response_not_found")
        new_status = request.data.get("status")
        if new_status not in ResponseStatus.values:
            raise DRFValidationError({"detail": "invalid_status"})
        r.status = new_status
        r.save(update_fields=["status"])
        return Response(FormResponseSerializer(r).data)


class FormSendStage2View(GenericAPIView):
    """`POST /api/forms/{id}:send-stage2/` — mint per-respondent share-links.

    For each *accepted* response on this (stage-1) form, mint a single-use
    share-link against the target ``team_registration`` form so the school can
    submit its roster. Returns the minted links so the UI can display/copy them
    (email enqueue is a follow-up; see plan NOTE on Task 5.2).
    """

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        target_id = request.data.get("target_form_id")
        target_form = Form.objects.filter(
            id=target_id, tournament=form.tournament, deleted_at__isnull=True
        ).first()
        if target_form is None:
            raise DRFValidationError({"detail": "target_form_not_found"})
        accepted = FormResponse.objects.filter(
            form=form, status=ResponseStatus.ACCEPTED, deleted_at__isnull=True
        )
        out = []
        for r in accepted:
            _link, token = create_share_link(
                form=target_form, created_by=request.user, label=r.title,
                bound_entity={"participant_response_id": str(r.id)}, max_submissions=1,
            )
            out.append({
                "response_id": str(r.id),
                "email": r.respondent_email,
                "path": f"/r/{token}",
            })
            # TODO(notify): enqueue email via apps/notifications using r.respondent_email
        return Response({"sent": len(out), "links": out}, status=201)


class InstitutionLinksView(GenericAPIView):
    """`POST /api/forms/{id}:institution-links/` — mint one bound, prefilled
    share-link per registered institution for this (team-registration) form.

    Each link locks the institution and prefills its Stage-1 identity/contact, so
    a school just confirms and adds teams. Idempotent: institutions that already
    have a link are returned without a fresh token (tokens are hashed at rest, so
    only newly-minted ones expose a path)."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, form_id):
        form = _get_manageable_form(request.user, form_id)
        minted = mint_institution_links(form=form, created_by=request.user)
        links = [
            {
                "institution_id": m["institution_id"],
                "name": m["name"],
                "minted": m["minted"],
                **({"path": f"/r/{m['token']}"} if m.get("token") else {}),
            }
            for m in minted
        ]
        new_count = sum(1 for m in minted if m["minted"])
        return Response({"minted": new_count, "total": len(links), "links": links},
                        status=201)


def _norm_option(o):
    if isinstance(o, dict):
        return {
            "value": o.get("value", o.get("label", "")),
            "label": o.get("label", o.get("value", "")),
        }
    return {"value": o, "label": o}


def _choice_fields(schema: dict) -> list[dict]:
    """Choice fields across sections + group children — the filterable columns."""
    out: list[dict] = []
    for sec in (schema or {}).get("sections", []):
        for fld in sec.get("fields", []):
            if fld.get("type") in CHOICE_TYPES:
                out.append(fld)
            if fld.get("type") == "group":
                for child in fld.get("fields", []):
                    if child.get("type") in CHOICE_TYPES:
                        out.append(child)
    return out


class PublicInstitutionDirectoryView(GenericAPIView):
    """`GET /api/forms/{form_id}/directory/` — AllowAny public directory of the
    institutions registered through an org-registration form, with filters
    derived dynamically from the form's own choice fields. Exposes only
    name/region/kind + the choice-field selections (never contact details)."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [AllowAny]
    throttle_classes: ClassVar[list] = [PublicFormThrottle]

    def get(self, request, form_id):
        from apps.teams.models import Institution

        form = (
            Form.objects.filter(id=form_id, deleted_at__isnull=True)
            .select_related("tournament")
            .first()
        )
        # Visible once published (open OR closed) so the directory still works
        # after the stage advances and the form auto-closes; drafts stay private.
        if form is None or form.status == FormStatus.DRAFT:
            raise NotFound("form_not_found")

        cfields = _choice_fields(form.schema or {})
        filters = [
            {
                "key": f["key"],
                "label": f.get("label", f["key"]),
                "options": [_norm_option(o) for o in (f.get("options") or [])],
            }
            for f in cfields
        ]
        choice_keys = {f["key"] for f in cfields}

        insts = list(
            Institution.objects.filter(
                tournament_id=form.tournament_id, deleted_at__isnull=True
            )
            .exclude(status__in=["withdrawn", "rejected"])
            .order_by("name")
        )
        resp_ids = [i.source_response_id for i in insts if i.source_response_id]
        answers = (
            {r.id: (r.answers or {}) for r in FormResponse.objects.filter(id__in=resp_ids)}
            if resp_ids
            else {}
        )
        entries = [
            {
                "name": i.name,
                "region": i.region,
                "kind": i.kind,
                "values": {
                    k: answers.get(i.source_response_id, {}).get(k)
                    for k in choice_keys
                    if i.source_response_id and k in answers.get(i.source_response_id, {})
                },
            }
            for i in insts
        ]
        return Response(
            {
                "tournament_name": form.tournament.name,
                "form_title": form.title,
                "filters": filters,
                "entries": entries,
                "count": len(entries),
            }
        )


class GenerateTeamFormView(GenericAPIView):
    """`POST /api/tournaments/{id}/forms/generate-team/` — auto-generate a draft
    team-registration form from the org-reg form's categories + registered
    institutions. Manager-only. Returns the new form for the admin to review."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, tournament_id):
        from apps.forms.services.generation import generate_team_form_template

        t = _get_manageable_tournament(request.user, tournament_id)
        form = generate_team_form_template(
            tournament=t, created_by=request.user, request=request
        )
        return Response(FormSerializer(form).data, status=201)


class GenerateInstitutionFormView(GenericAPIView):
    """`POST /api/tournaments/{id}/forms/generate-institution/` — auto-generate a
    draft institution-registration form from the tournament's chosen sports (with
    per-sport category questions). Manager-only. Returns the new form to review."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, tournament_id):
        from apps.forms.services.generation import generate_institution_form

        t = _get_manageable_tournament(request.user, tournament_id)
        form = generate_institution_form(
            tournament=t, created_by=request.user, request=request
        )
        return Response(FormSerializer(form).data, status=201)


class CopyableFormsView(GenericAPIView):
    """`GET /api/forms/copyable/` — built-in templates + every form the user can
    access (across their tournaments) that has content, for the "copy from" picker."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def get(self, request):
        from apps.forms.services.templates import template_summaries

        forms = (
            Form.objects.filter(
                tournament__in=accessible_tournaments(request.user),
                deleted_at__isnull=True,
            )
            .select_related("tournament")
            .order_by("-created_at")
        )
        form_rows = [
            {
                "id": str(f.id),
                "title": f.title,
                "purpose": f.purpose,
                "tournament_name": f.tournament.name,
                "field_count": sum(
                    len(s.get("fields", [])) for s in (f.schema or {}).get("sections", [])
                ),
                "is_template": False,
            }
            for f in forms
            if (f.schema or {}).get("sections")
        ]
        return Response({"templates": template_summaries(), "forms": form_rows})


class FormCopyFromView(GenericAPIView):
    """`POST /api/forms/{id}:copy-from/` — replace this form's schema (+ bindings)
    with a built-in template or another accessible form's schema. Manager-only on
    the target; the source must be a template id or a form the user can access."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, form_id):
        from apps.forms.services.schema import SchemaError, validate_schema
        from apps.forms.services.templates import get_template

        form = _get_manageable_form(request.user, form_id)
        template_id = request.data.get("template_id")
        source_form_id = request.data.get("source_form_id")

        if template_id:
            tpl = get_template(template_id)
            if tpl is None:
                raise NotFound("template_not_found")
            schema, settings = tpl["schema"], tpl.get("settings", {})
        elif source_form_id:
            src = (
                Form.objects.filter(id=source_form_id, deleted_at__isnull=True)
                .select_related("tournament")
                .first()
            )
            if src is None or not accessible_tournaments(request.user).filter(
                id=src.tournament_id
            ).exists():
                raise NotFound("source_form_not_found")
            schema, settings = src.schema, (src.settings or {})
        else:
            raise DRFValidationError({"detail": "template_id or source_form_id required"})

        try:
            if schema.get("sections"):
                validate_schema(schema)
        except SchemaError as e:
            raise DRFValidationError({"detail": str(e)}) from e

        form.schema = schema
        # Merge bindings so the copied form maps on submit, keep other settings.
        merged = {**(form.settings or {})}
        if settings.get("bindings"):
            merged["bindings"] = settings["bindings"]
        form.settings = merged
        form.save(update_fields=["schema", "settings", "updated_at"])
        return Response(FormSerializer(form).data)
