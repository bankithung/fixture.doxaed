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

from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import FileResponse, HttpResponse
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
    ContactAdminSerializer,
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
from apps.tournaments.permissions import can_access_module
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
        ).select_related("tournament").order_by("-created_at")
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
        # Opening Stage-2: email every registered institution its access
        # code + the form link (idempotent — existing codes are kept).
        if form.purpose == FormPurpose.TEAM_REGISTRATION:
            from apps.teams.services.access import issue_team_access_codes

            issue_team_access_codes(
                tournament=form.tournament, form=form,
                only_missing=True, request=request, actor=request.user,
            )
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


def _schema_option_images(schema) -> dict[str, str]:
    """Map option value -> per-option image (the logos set per choice in the
    builder) across every choice field in a schema, nested groups included."""
    out: dict[str, str] = {}

    def walk(fields):
        for f in fields or []:
            if f.get("type") in CHOICE_TYPES:
                for o in f.get("options") or []:
                    if (
                        isinstance(o, dict)
                        and o.get("image")
                        and o.get("value") is not None
                    ):
                        out.setdefault(str(o["value"]), o["image"])
            if f.get("type") == "group":
                walk(f.get("fields"))

    for s in (schema or {}).get("sections", []):
        walk(s.get("fields"))
    return out


def _match_option_image(answers: dict, images: dict[str, str]) -> str | None:
    """First per-option image among a response's answers (e.g. the selected
    school's logo)."""
    if not images:
        return None
    for v in (answers or {}).values():
        if isinstance(v, str) and v in images:
            return images[v]
        if isinstance(v, list):
            for x in v:
                if isinstance(x, str) and x in images:
                    return images[x]
    return None


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

    insts = list(
        Institution.objects.filter(tournament=tournament, deleted_at__isnull=True)
        .exclude(status__in=["withdrawn", "rejected"])
        .order_by("name")
    )
    # Each school's logo (the per-option image the admin set on the Stage-1
    # school question) so the institution dropdown shows it — resolved from the
    # org form's option images matched to each institution's submission.
    org_form = (
        Form.objects.filter(
            tournament=tournament,
            purpose=FormPurpose.ORGANIZATION_REGISTRATION,
            deleted_at__isnull=True,
        )
        .order_by("created_at")
        .first()
    )
    images = _schema_option_images(org_form.schema) if org_form else {}
    # The institution name is the Stage-1 dropdown's VALUE (a slug like
    # "amazing_school"); resolve it to that option's human label ("AMAZING
    # SCHOOL") so the institution picker reads properly. Display-only.
    name_label_map: dict[str, str] = {}
    if org_form:
        nfk = (org_form.settings or {}).get("bindings", {}).get("institution_name")
        if nfk:
            for f in _choice_fields(org_form.schema or {}):
                if f.get("key") == nfk:
                    for o in f.get("options") or []:
                        no = _norm_option(o)
                        name_label_map[str(no["value"])] = no["label"]
    logos: dict = {}
    if images:
        resp_ids = [i.source_response_id for i in insts if i.source_response_id]
        ans = (
            {r.id: (r.answers or {}) for r in FormResponse.objects.filter(id__in=resp_ids)}
            if resp_ids
            else {}
        )
        for i in insts:
            lg = _match_option_image(ans.get(i.source_response_id), images)
            if lg:
                logos[i.id] = lg
    # `leaves` = the competitions the institution registered at Stage 1; the
    # team form scopes its sport/category questions to them client-side
    # (competition keys are already public via the directory — no PII here).
    # Protection is DEFAULT-CLOSED (C10): every institution requires
    # authorization (code token, bound link, or manager) before its teams can
    # be submitted or edited — a school without an issued code used to be
    # writable by anyone picking it in the dropdown. `has_code` lets the
    # renderer distinguish "enter your code" from "no code issued yet, ask
    # the organizer".
    options = [
        {
            "value": str(i.id),
            "label": name_label_map.get(i.name, i.name),
            "leaves": (i.attributes or {}).get("leaves") or [],
            "requires_code": True,
            "has_code": bool(i.team_code_hash),
            **({"image": logos[i.id]} if i.id in logos else {}),
        }
        for i in insts
    ]

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


def _competition_field_keys(form) -> list[str]:
    """Keys of the choice fields whose options ARE competition keys (the
    sport question + each category-chain level of a generated team form).

    Detected structurally: a field counts when it sits in a section that has
    an institution_list dropdown AND every option value lies in the sports
    catalog's prefix space — so the public renderer can scope those questions
    to the selected institution's registered competitions without the admin
    regenerating the form."""
    sports = getattr(form.tournament, "sports", None) or []
    if not sports:
        return []
    from apps.tournaments.services.sports import iter_leaves

    space: set[str] = set()
    for lf in iter_leaves(sports):
        parts = lf["leaf_key"].split(".")
        for i in range(1, len(parts) + 1):
            space.add(".".join(parts[:i]))
    if not space:
        return []

    def _opt_val(o) -> str:
        return str(o.get("value")) if isinstance(o, dict) else str(o)

    out: list[str] = []
    for s in (form.schema or {}).get("sections", []):
        fields = s.get("fields", [])
        if not any(
            (f.get("data_source") or {}).get("type") == "institution_list"
            for f in fields
        ):
            continue
        for f in fields:
            if f.get("type") not in ("multi_choice", "single_choice", "dropdown"):
                continue
            opts = [_opt_val(o) for o in f.get("options") or []]
            if opts and all(v in space for v in opts):
                out.append(f["key"])
    return out


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
        "competition_fields": _competition_field_keys(form),
    }
    # Team forms: the (group, team-name field) pairs, so the renderer can
    # flag duplicate team names within a competition AS THE USER TYPES
    # (the submit endpoint enforces the same rule server-side).
    if form.purpose == FormPurpose.TEAM_REGISTRATION:
        data["team_groups"] = [
            {"group": cg.get("group"), "field": cg.get("team_name")}
            for cg in ((form.settings or {}).get("bindings", {}).get("category_groups") or [])
            if cg.get("group") and cg.get("team_name")
        ]
    # A bound/prefilled per-institution Stage-2 link carries initial answers + the
    # institution it's fixed to, so the renderer pre-fills contact details and
    # locks the institution (no dropdown to pick the wrong school).
    if link is not None and (link.prefill or link.bound_entity):
        if link.prefill:
            data["prefill"] = link.prefill
            from apps.forms.services.uploads import file_meta_for

            data["file_meta"] = file_meta_for(form, link.prefill)
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


class TeamAccessView(GenericAPIView):
    """`POST /api/forms/{form_id}/team-access/` — exchange (institution,
    access code) for a short-lived signed token + the institution's previous
    submission for editing. AllowAny, but: per-IP throttle, per-institution
    failure lockout, constant-time hash check, and the response only carries
    data the code-holder is entitled to (their own previous answers)."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [AllowAny]

    def get_throttles(self):
        from apps.forms.throttling import TeamAccessThrottle

        return [TeamAccessThrottle()]

    def post(self, request, form_id):
        from apps.teams.models import Institution
        from apps.teams.services.access import (
            make_access_token,
            verify_team_code,
        )

        form = (
            Form.objects.filter(id=form_id, deleted_at__isnull=True)
            .select_related("tournament")
            .first()
        )
        if form is None or form.purpose != FormPurpose.TEAM_REGISTRATION or not is_open(form):
            raise NotFound("form_not_found")
        inst = Institution.objects.filter(
            id=str(request.data.get("institution_id") or ""),
            tournament=form.tournament,
            deleted_at__isnull=True,
        ).first()
        if inst is None:
            raise NotFound("institution_not_found")
        # An authenticated manager needs no code — they get the same prefill so
        # the admin "Add team" page arrives with the school's details filled.
        manager = (
            request.user.is_authenticated
            and can_access_module(request.user, form.tournament, "forms")
        )
        if not manager:
            ok, err = verify_team_code(inst, str(request.data.get("code") or ""))
            if not ok:
                # Same 403 shape for both cases; `locked` lets the UI explain.
                return Response({"detail": err}, status=403)
        # Prefill, revealed only AFTER the code verifies:
        #  - the institution's Stage-1 contact details (so even a FIRST team
        #    registration arrives with contact person/email/phone filled), then
        #  - the school's most recent team submission overlaid on top (editing).
        bindings = (form.settings or {}).get("bindings", {})
        iid_key = bindings.get("institution_id", "institution_id")
        prefill: dict = {iid_key: str(inst.id)}
        for role, attr in (
            ("contact_name", "contact_name"),
            ("contact_email", "contact_email"),
            ("contact_phone", "contact_phone"),
        ):
            key = bindings.get(role, role)
            val = getattr(inst, attr, "")
            if val:
                prefill[key] = val
        prior = (
            FormResponse.objects.filter(form=form, **{f"answers__{iid_key}": str(inst.id)})
            .order_by("-created_at")
            .first()
        )
        if prior is not None:
            prefill = {**prefill, **(prior.answers or {})}
        from apps.forms.services.uploads import file_meta_for

        return Response({
            "access_token": make_access_token(inst, form),
            "expires_in": 2 * 60 * 60,
            "editing": prior is not None,
            "prefill": prefill,
            # Names + signed view URLs for any files in the prior submission, so
            # the renderer shows them as thumbnails/links, not bare "Uploaded file".
            "file_meta": file_meta_for(form, prefill),
        })


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
        # A valid share link (active, unexpired, under its submission cap —
        # resolve_share_link enforced all three) grants access even after the
        # form closed: admin-minted links are explicit, expiring grants
        # (e.g. "fix your school's details" after Stage 1 closed).
        if not is_open(form) and link is None:
            return Response({
                "closed": True,
                "tournament_name": form.tournament.name,
                "form_id": str(form.id),
                # Institution-registration forms back a public directory of
                # registrants that stays viewable after the stage advances and
                # the form closes — surface it so a closed link isn't a dead end.
                "has_directory": form.purpose == FormPurpose.ORGANIZATION_REGISTRATION,
            })
        payload = _public_payload(form, link)
        # An authenticated manager loading the form is an admin entry path:
        # the renderer skips the access-code gate (no credentials for the
        # organizer's own tournament).
        payload["can_manage"] = bool(
            request.user.is_authenticated
            and can_access_module(request.user, form.tournament, "forms")
        )
        return Response(payload)

    def post(self, request, form_id=None, token=None):
        form, link = self._resolve(form_id, token)
        if not is_open(form) and link is None:
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
        from apps.forms.services.mapping import (  # local import (Increment 5)
            map_response,
            supersede_team_registration,
            team_registration_field_errors,
        )

        # Team forms — access-code gate + duplicate-name validation, both
        # BEFORE any response is recorded. Replays of an already-recorded
        # submission skip everything (their teams exist).
        event_id = ser.validated_data.get("event_id")
        is_replay = (
            event_id is not None
            and FormResponse.objects.filter(form=form, event_id=event_id).exists()
        )
        authorized_inst_id: str | None = None
        if form.purpose == FormPurpose.TEAM_REGISTRATION and not is_replay:
            from apps.teams.models import Institution
            from apps.teams.services.access import read_access_token

            iid_key = (form.settings or {}).get("bindings", {}).get(
                "institution_id", "institution_id"
            )
            inst = None
            try:
                inst_id = str(answers.get(iid_key) or "")
                if inst_id:
                    inst = Institution.objects.filter(
                        id=inst_id, tournament=form.tournament
                    ).first()
            except (ValueError, DjangoValidationError):
                inst = None
            # An authenticated tournament MANAGER needs no code — they own the
            # tournament and use the same form as a "proper" admin entry page.
            manager = (
                request.user.is_authenticated
                and can_access_module(request.user, form.tournament, "forms")
            )
            if inst is not None and not manager:
                # DEFAULT-CLOSED (C10): every institution is protected — only
                # a valid signed token (from /team-access/), a per-institution
                # bound link (its own secret), or a manager may submit or
                # update its teams. An institution with no issued code simply
                # cannot be written publicly until the organizer sends one.
                bound_ok = (
                    link is not None
                    and (link.bound_entity or {}).get("institution_id") == str(inst.id)
                )
                if not bound_ok:
                    payload = read_access_token(
                        str(ser.validated_data.get("access_token") or "")
                    )
                    if (
                        not payload
                        or payload.get("i") != str(inst.id)
                        or payload.get("f") != str(form.id)
                    ):
                        raise DRFValidationError({"detail": "team_access_required"})
                authorized_inst_id = str(inst.id)
            elif inst is not None and manager:
                # A manager's full-form submission for a school REPLACES that
                # school's set (same authoritative semantics as the code path).
                authorized_inst_id = str(inst.id)
            errs = team_registration_field_errors(
                form, answers, exclude_institution_id=authorized_inst_id
            )
            if errs:
                raise DRFValidationError({"errors": errs})
        try:
            resp = submit_response(
                form=form,
                answers=answers,
                event_id=event_id,
                share_link=link,
                upload_refs=ser.validated_data.get("upload_refs"),
                file_labels=ser.validated_data.get("file_labels"),
                request=request,
            )
        except AnswerError as e:
            raise DRFValidationError({"errors": e.errors}) from e
        # A code-authorized (re)submission REPLACES the institution's previous
        # team registration instead of stacking a duplicate set.
        if authorized_inst_id is not None:
            supersede_team_registration(
                form, authorized_inst_id, exclude_response_id=resp.id, request=request
            )
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


class ServeUploadView(GenericAPIView):
    """`GET /api/forms/uploads/{upload_ref}/` — stream a stored form upload.

    Capability-based: a valid signed ``?t=`` token authorizes anyone (the URL is
    minted only into payloads the viewer is already entitled to — admin roster
    detail, public-form prefill), and an authenticated tournament manager is
    allowed too. ``?dl=1`` forces a download instead of inline display. A
    missing file and an unauthorized request both 404 (no existence leak).
    """

    permission_classes: ClassVar[list[type[BasePermission]]] = [AllowAny]

    def get(self, request, upload_ref):
        from apps.forms.services.uploads import verify_upload_token

        up = (
            FormFileUpload.objects.select_related("form", "form__tournament")
            .filter(upload_ref=upload_ref)
            .first()
        )
        if up is None:
            raise NotFound("file_not_found")
        authorized = verify_upload_token(
            request.query_params.get("t") or ""
        ) == str(up.upload_ref)
        if not authorized and request.user.is_authenticated:
            authorized = (
                accessible_tournaments(request.user)
                .filter(id=up.form.tournament_id)
                .exists()
                and can_access_module(request.user, up.form.tournament, "forms")
            )
        if not authorized:
            raise NotFound("file_not_found")
        return FileResponse(
            up.file.open("rb"),
            as_attachment=bool(request.query_params.get("dl")),
            filename=up.original_name,
            content_type=up.content_type or "application/octet-stream",
        )


def _organiser_emails(form) -> list[str]:
    """Active admins/co-organizers of the form's tournament, deduped — falling
    back to the tournament/form creator so a message is never silently dropped
    when no explicit role membership has been added yet."""
    from apps.tournaments.models import (
        TournamentMembershipRole as Role,
    )
    from apps.tournaments.models import (
        TournamentMembershipStatus as Status,
    )

    emails: list[str] = []
    seen: set[str] = set()

    def add(user) -> None:
        e = (getattr(user, "email", "") or "").strip() if user else ""
        if e and e.lower() not in seen:
            seen.add(e.lower())
            emails.append(e)

    members = form.tournament.memberships.filter(
        role__in=[Role.ADMIN, Role.CO_ORGANIZER], status=Status.ACTIVE
    ).select_related("user")
    for m in members:
        add(m.user)
    if not emails:
        add(form.tournament.created_by)
        add(form.created_by)
    return emails


class ContactAdminView(GenericAPIView):
    """`POST /api/forms/{id}/contact/` — a public visitor messages the organisers.

    Emails the tournament's active admins/co-organizers (sender set as reply-to)
    so anyone hitting an issue can reach a human. AllowAny + throttled; never
    leaks whether/which organisers exist."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [AllowAny]
    throttle_classes: ClassVar[list] = [PublicFormThrottle]

    def post(self, request, form_id):
        form = (
            Form.objects.filter(id=form_id, deleted_at__isnull=True)
            .select_related("tournament")
            .first()
        )
        if form is None or form.status == FormStatus.DRAFT:
            raise NotFound("form_not_found")
        ser = ContactAdminSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        d = ser.validated_data

        recipients = _organiser_emails(form)
        if recipients:
            from django.core.mail import EmailMessage

            EmailMessage(
                subject=f"[{form.tournament.name}] Message from {d['name']}",
                body=(
                    f"From: {d['name']} <{d['email']}>\n"
                    f"Tournament: {form.tournament.name}\n"
                    f"Form: {form.title}\n\n"
                    f"{d['message']}\n"
                ),
                to=recipients,
                reply_to=[d["email"]],
            ).send(fail_silently=True)
        return Response({"sent": bool(recipients)}, status=201)


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


def _sync_institution_from_response(response: FormResponse, new_status: str) -> None:
    """Propagate a Stage-1 raw-submission review decision onto the institution it
    created, so the PUBLIC surfaces reflect it.

    The public directory and the team-form school list both gate on
    ``Institution.status`` (they exclude ``rejected``/``withdrawn``), NOT on the
    raw ``FormResponse.status``. Without this, rejecting a submission in "Review
    raw submissions" left the school visible to the public — the reported bug.

    Rejecting hides the school; un-rejecting (accept/submit/waitlist) restores it.
    Only the ``registered`` <-> ``rejected`` pair is toggled — a deliberate
    ``withdrawn`` (school pulled out, also hidden) is left intact.
    """
    from apps.teams.models import Institution, InstitutionStatus

    iid = (response.mapped_entities or {}).get("institution_id")
    if not iid:
        return
    inst = Institution.objects.filter(id=iid, deleted_at__isnull=True).first()
    if inst is None:
        return
    if new_status == ResponseStatus.REJECTED:
        target = (
            inst.status
            if inst.status == InstitutionStatus.WITHDRAWN
            else InstitutionStatus.REJECTED
        )
    elif inst.status == InstitutionStatus.REJECTED:
        target = InstitutionStatus.REGISTERED
    else:
        target = inst.status
    if target != inst.status:
        inst.status = target
        inst.save(update_fields=["status", "updated_at"])


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
        # A Stage-1 review decision must reach the public surfaces, which gate on
        # the mapped institution's status — keep the two in lockstep.
        if form.purpose == FormPurpose.ORGANIZATION_REGISTRATION:
            _sync_institution_from_response(r, new_status)
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
        # Directory opt-out (W2 owner report: with deep category trees, every
        # chain question became its own filter/stat — 25 dropdowns of noise).
        # A field is excluded when it says `directory: false` (the generator
        # stamps that on chain questions; admins toggle it in the builder) or,
        # for forms generated before the flag, when its key is a category
        # chain field per the form's structural settings. The single
        # "Competition" filter + the competitions payload cover those.
        settings = form.settings or {}
        chain_keys = set((settings.get("category_fields") or {}).values())
        for keys in (settings.get("category_fields_all") or {}).values():
            chain_keys.update(keys)
        # The generated sports selector duplicates the Competitions grouping.
        if settings.get("sports_field"):
            chain_keys.add(settings["sports_field"])
        # The institution-name field is typically a dropdown of canonical school
        # names, so the stored institution name is the chosen option's VALUE (a
        # slug like "amazing_school"). Build value->label to show the human name,
        # and drop the field as a directory column — it would only duplicate the
        # row's own name.
        name_field_key = (settings.get("bindings") or {}).get("institution_name")
        name_label_map: dict[str, str] = {}
        name_col_label = "Institution"
        if name_field_key:
            for f in _choice_fields(form.schema or {}):
                if f.get("key") == name_field_key:
                    name_col_label = f.get("label") or name_col_label
                    for o in f.get("options") or []:
                        no = _norm_option(o)
                        name_label_map[str(no["value"])] = no["label"]
            chain_keys.add(name_field_key)
        cfields = [
            f for f in cfields
            if f.get("directory") is not False and f.get("key") not in chain_keys
        ]
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
        # Structural competition entries (W2-E): each institution's selected
        # category leaves, labelled from the live sports config — the public
        # page groups by sport → category without re-parsing raw answers.
        from apps.tournaments.services.sports import iter_leaves, leaf_label

        # Per-option images set in the builder (e.g. a school logo) → show each
        # institution's logo on the directory, matched from its submission.
        opt_images = _schema_option_images(form.schema)

        def _entry_logo(inst):
            if not inst.source_response_id:
                return None
            return _match_option_image(answers.get(inst.source_response_id), opt_images)

        sports_cfg = form.tournament.sports or []
        entries = [
            {
                "name": name_label_map.get(i.name, i.name),
                "region": i.region,
                "kind": i.kind,
                "logo": _entry_logo(i),
                "competitions": [
                    {"leaf_key": lk, "label": leaf_label(sports_cfg, lk)}
                    for lk in (i.attributes or {}).get("leaves") or []
                ],
                "values": {
                    k: answers.get(i.source_response_id, {}).get(k)
                    for k in choice_keys
                    if i.source_response_id and k in answers.get(i.source_response_id, {})
                },
            }
            for i in insts
        ]
        # Order by the human label now shown (insts were ordered by the slug name).
        entries.sort(key=lambda e: (e["name"] or "").lower())
        leaf_counts: dict[str, int] = {}
        for e in entries:
            for c in e["competitions"]:
                leaf_counts[c["leaf_key"]] = leaf_counts.get(c["leaf_key"], 0) + 1
        competitions = [
            {
                "leaf_key": lf["leaf_key"],
                "label": leaf_label(sports_cfg, lf["leaf_key"]),
                "count": leaf_counts.get(lf["leaf_key"], 0),
            }
            for lf in iter_leaves(sports_cfg)
        ]
        # Headline KPI preference (owner 2026-06-10): the public page defaults
        # to the total PLUS per-game (top-level sport) registration counts;
        # admins can reduce it to the total only from the builder's settings.
        kpi_mode = settings.get("directory_kpis")
        if kpi_mode not in ("games", "total"):
            kpi_mode = "games"
        # Admin-set custom headline-stat names, keyed by game (top-level sport
        # key); the page falls back to the sport name for any key absent here.
        kpi_labels = settings.get("kpi_labels")
        if not isinstance(kpi_labels, dict):
            kpi_labels = {}
        return Response(
            {
                "tournament_name": form.tournament.name,
                "form_title": form.title,
                "name_label": name_col_label,
                "filters": filters,
                "entries": entries,
                "competitions": competitions,
                "count": len(entries),
                "kpi_mode": kpi_mode,
                "kpi_labels": kpi_labels,
                # Lets the directory page link back to the registration form
                # while it is still accepting submissions.
                "form_open": is_open(form),
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


class FormRegenerateView(GenericAPIView):
    """`POST /api/forms/{id}:regenerate/` — rebuild a GENERATED form's schema
    from the tournament's CURRENT sports/category config (invariant 10: the
    regenerate half of regenerate/keep). Hand-built forms are refused — only
    forms carrying the generator's settings tags can be rebuilt. Bindings,
    structural tags and the staleness fingerprint are refreshed; title,
    status and share links are preserved. Audited via update_form."""

    permission_classes: ClassVar[list[type[BasePermission]]] = [IsAuthenticated]

    def post(self, request, form_id):
        from apps.forms.services.generation import (
            build_team_form_schema,
            reconcile_institution_form_schema,
        )
        from apps.tournaments.services.sports import sports_inputs_hash

        form = _get_manageable_form(request.user, form_id)
        settings = form.settings or {}
        if not (settings.get("generated_from_sports") or settings.get("generated_from")):
            raise DRFValidationError({"detail": "not_a_generated_form"})
        t = form.tournament

        if form.purpose == FormPurpose.ORGANIZATION_REGISTRATION:
            # Smart rebuild: MERGE the sports deltas onto the admin's current
            # form (keep custom fields + edits), don't replace it (invariant 10).
            schema, cat_meta = reconcile_institution_form_schema(
                form.schema, t.sports or [], settings
            )
            new_settings = {
                **settings,
                "sports_field": "sports",
                **cat_meta,
                "inputs_hash": sports_inputs_hash(t.sports),
            }
        elif form.purpose == FormPurpose.TEAM_REGISTRATION:
            org_form = (
                Form.objects.filter(
                    tournament=t, stage="org_registration", deleted_at__isnull=True
                ).order_by("created_at").first()
                or Form.objects.filter(
                    tournament=t,
                    purpose=FormPurpose.ORGANIZATION_REGISTRATION,
                    deleted_at__isnull=True,
                ).order_by("created_at").first()
            )
            schema, bindings = build_team_form_schema(org_form, tournament=t)
            new_settings = {
                **settings,
                "bindings": bindings,
                "inputs_hash": sports_inputs_hash(t.sports),
            }
        else:
            raise DRFValidationError({"detail": "unsupported_purpose"})

        update_form(form, {"schema": schema}, user=request.user, request=request)
        form.settings = new_settings
        form.save(update_fields=["settings", "updated_at"])
        form.refresh_from_db()
        return Response(FormSerializer(form).data)
