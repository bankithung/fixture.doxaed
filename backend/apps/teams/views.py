from __future__ import annotations

from django.db import IntegrityError
from django.db.models import Count, F, Q
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.teams.models import (
    Institution,
    InstitutionStatus,
    RegistrationLink,
    Team,
)
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
from apps.teams.services.withdrawal import withdraw_team
from apps.teams.throttling import RegistrationRateThrottle
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_access_module
from apps.tournaments.scope import accessible_tournaments


def _can_register(user, tournament) -> bool:
    """Team/institution writes: manager OR the tournament.team_registration
    module (catalog default for game_coordinator/team_manager) — spec
    2026-06-10 P5 two-layer gate."""
    return can_access_module(user, tournament, "tournament.team_registration")


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
        if not _can_register(request.user, tournament):
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


class TeamSeedsView(GenericAPIView):
    """`PUT /api/tournaments/{id}/teams/seeds/` — bulk seed assignment for a
    competition (redesign spec §4.3: Team.seed finally becomes settable).
    Body `{leaf_key?, seeds: [{team_id, seed|null}], event_id}`. Gate:
    tournament.bracket_editor; idempotent on `event_id` (invariant 3);
    audited (`team_seeds_updated`)."""

    permission_classes = [IsAuthenticated]

    def put(self, request, tournament_id):
        from django.db import transaction

        from apps.audit.models import ActorRole, AuditEvent
        from apps.audit.services import emit_audit

        tournament = (
            Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
            .select_related("organization")
            .first()
        )
        if tournament is None or not accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists():
            raise NotFound("tournament_not_found")
        if not can_access_module(request.user, tournament, "tournament.bracket_editor"):
            raise PermissionDenied("not_tournament_manager")

        event_id = request.data.get("event_id")
        if event_id:
            prior = AuditEvent.objects.filter(
                idempotency_key=event_id, event_type="team_seeds_updated"
            ).first()
            if prior is not None:  # replay (invariant 3)
                payload = prior.payload_after or {}
                return Response(
                    {
                        "updated": len(payload.get("seeds") or []),
                        "leaf_key": payload.get("leaf_key", ""),
                    }
                )

        leaf_key = str(request.data.get("leaf_key") or "")
        rows = request.data.get("seeds")
        if not isinstance(rows, list) or not rows:
            raise DRFValidationError({"detail": "seeds_required"})
        parsed: list[tuple[str, int | None]] = []
        for row in rows:
            if not isinstance(row, dict) or not row.get("team_id"):
                raise DRFValidationError({"detail": "each row needs a team_id"})
            seed = row.get("seed")
            if seed is not None:
                if isinstance(seed, bool) or not isinstance(seed, (int, str)):
                    raise DRFValidationError({"detail": "invalid_seed"})
                try:
                    seed = int(seed)
                except ValueError:
                    raise DRFValidationError({"detail": "invalid_seed"})
                if not 1 <= seed <= 32767:
                    raise DRFValidationError({"detail": "invalid_seed"})
            parsed.append((str(row["team_id"]), seed))

        scope = Team.objects.filter(tournament=tournament, deleted_at__isnull=True)
        if leaf_key:
            scope = scope.filter(leaf_key=leaf_key)
        by_id = {str(t.id): t for t in scope}
        unknown = sorted(tid for tid, _ in parsed if tid not in by_id)
        if unknown:
            raise DRFValidationError(
                {"detail": "unknown_team_ids", "team_ids": unknown}
            )

        with transaction.atomic():
            for tid, seed in parsed:
                team = by_id[tid]
                team.seed = seed
                team.save(update_fields=["seed", "updated_at"])
            emit_audit(
                actor_user=request.user,
                actor_role=ActorRole.ADMIN,
                event_type="team_seeds_updated",
                target_type="tournament",
                target_id=tournament.id,
                organization_id=tournament.organization_id,
                tournament_id=tournament.id,
                idempotency_key=event_id,
                payload_after={
                    "leaf_key": leaf_key,
                    "seeds": [
                        {"team_id": tid, "seed": seed} for tid, seed in parsed
                    ],
                },
                request=request,
            )
        return Response({"updated": len(parsed), "leaf_key": leaf_key})


class TeamWithdrawView(GenericAPIView):
    """`POST /api/tournaments/{id}/teams/{team_id}/withdraw/` — minimal
    withdrawal executor (redesign spec §7 inc 16, §9 A7): marks the team
    withdrawn and walkovers its remaining scheduled matches. Body
    `{event_id?, reason?}`. Gate: tournament.bracket_editor; idempotent
    (invariant 3); audited (`team_withdrawn`)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, team_id):
        tournament = (
            Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
            .select_related("organization")
            .first()
        )
        if tournament is None or not accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists():
            raise NotFound("tournament_not_found")
        if not can_access_module(request.user, tournament, "tournament.bracket_editor"):
            raise PermissionDenied("not_tournament_manager")
        team = Team.objects.filter(
            id=team_id, tournament=tournament, deleted_at__isnull=True
        ).first()
        if team is None:
            raise NotFound("team_not_found")
        try:
            result = withdraw_team(
                team=team,
                by=request.user,
                event_id=request.data.get("event_id") or None,
                reason=str(request.data.get("reason") or ""),
                request=request,
            )
        except ValueError as exc:
            raise DRFValidationError({"detail": str(exc)}) from exc
        return Response(result)


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
        if not _can_register(request.user, tournament):
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
        from django.db.models import Prefetch

        from apps.teams.models import Player

        qs = (
            Team.objects.filter(tournament_id=tournament_id, deleted_at__isnull=True)
            .select_related("institution")
            .annotate(
                player_count=Count(
                    "players", filter=Q(players__deleted_at__isnull=True)
                )
            )
            .prefetch_related(
                Prefetch(
                    "players",
                    queryset=Player.objects.filter(deleted_at__isnull=True)
                    .select_related("person")
                    .order_by("jersey_no", "created_at"),
                    to_attr="roster",
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
                    "sport": t.sport,
                    "leaf_key": t.leaf_key,
                    "status": t.status,
                    # Current seed (nullable) — the SeedListEditor prefills
                    # its order from this (redesign §6 screen 3).
                    "seed": t.seed,
                    "player_count": t.player_count,
                    # The roster inline (school-tournament scale): the Teams
                    # tab expands a team to show its players with no extra
                    # request.
                    "players": [
                        {
                            "id": str(p.id),
                            "full_name": p.person.full_name if p.person_id else "",
                            "jersey_no": p.jersey_no,
                            "position": p.position,
                            "captain": p.captain,
                        }
                        for p in t.roster
                    ],
                }
                for t in qs
            ]
        )


def _institution_dict(
    i: Institution,
    answers: dict | None = None,
    sports_cfg: list | None = None,
) -> dict:
    from apps.tournaments.services.sports import leaf_label

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
        # Whether a team-registration access code has been issued/emailed to
        # this school (the admin's per-school send/resend UI keys off this).
        "has_team_code": bool(i.team_code_hash),
        # The registration-form answers that created this row (for the admin's
        # flexible table columns + filters). Empty for direct admin-added rows.
        "answers": answers or {},
        # The competitions (category leaves) the institution entered, labelled
        # from the live sports config — mirrors the public directory so the
        # admin list can filter by competition instead of raw chain answers.
        "competitions": [
            {"leaf_key": lk, "label": leaf_label(sports_cfg or [], lk)}
            for lk in (i.attributes or {}).get("leaves") or []
        ],
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
        institutions = list(qs)
        # Bulk-load the registration answers that created each institution.
        from apps.forms.models import FormResponse

        resp_ids = [i.source_response_id for i in institutions if i.source_response_id]
        answers_by_resp = (
            {r.id: (r.answers or {}) for r in FormResponse.objects.filter(id__in=resp_ids)}
            if resp_ids
            else {}
        )
        sports_cfg = (
            Tournament.objects.filter(id=tournament_id)
            .values_list("sports", flat=True)
            .first()
            or []
        )
        return Response(
            [
                _institution_dict(
                    i,
                    answers_by_resp.get(i.source_response_id) if i.source_response_id else None,
                    sports_cfg,
                )
                for i in institutions
            ]
        )

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
        if not _can_register(request.user, tournament):
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
        if not _can_register(request.user, inst.tournament):
            raise PermissionDenied("not_tournament_manager")
        changed = []
        for field in ("name", "kind", "region", "short_name", "contact_name",
                      "contact_email", "contact_phone", "status"):
            if field in request.data:
                if (
                    field == "status"
                    and request.data[field] not in InstitutionStatus.values
                ):
                    raise DRFValidationError({"detail": "invalid_status"})
                setattr(inst, field, request.data[field])
                changed.append(field)
        if changed:
            inst.save(update_fields=[*changed, "updated_at"])
        inst.team_count = inst.teams.filter(deleted_at__isnull=True).count()
        return Response(_institution_dict(inst))


class TeamAccessCodesView(GenericAPIView):
    """`POST /api/tournaments/{id}/team-codes/` — (re)issue team-registration
    access codes to registered institutions (manager-only). Default fills only
    institutions without a code (safe after late registrations); body
    ``{"force": true}`` rotates every code."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        t = Tournament.objects.filter(
            id=tournament_id, deleted_at__isnull=True
        ).first()
        if t is None or not accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists():
            raise NotFound("tournament_not_found")
        if not can_access_module(request.user, t, "forms"):
            raise PermissionDenied("not_tournament_manager")
        from apps.forms.models import Form

        form = (
            Form.objects.filter(
                tournament=t, purpose="team_registration",
                deleted_at__isnull=True, status="open",
            )
            .order_by("-created_at")
            .first()
        )
        if form is None:
            raise DRFValidationError({"detail": "no_open_team_form"})
        from apps.teams.services.access import issue_team_access_codes

        out = issue_team_access_codes(
            tournament=t, form=form,
            only_missing=not bool(request.data.get("force")),
            institution_ids=request.data.get("institution_ids") or None,
            request=request, actor=request.user,
        )
        return Response(out)


class InstitutionEditLinkView(GenericAPIView):
    """`POST /api/tournaments/{id}/institutions/{institution_id}/edit-link/` —
    mint a TEMPORARY, single-submission link a school uses to add or edit its
    OWN details on the Stage-1 form (manager-only).

    The link opens the institution-registration form prefilled with the
    school's previous answers, bound to the institution (a rename updates the
    row, never duplicates it), works even after Stage 1 closed, expires in 7
    days, and is spent after one submission. Re-issuing deactivates earlier
    links for the same school — "resend" always means ONE live link."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, institution_id):
        from datetime import timedelta

        from django.utils import timezone

        t = Tournament.objects.filter(
            id=tournament_id, deleted_at__isnull=True
        ).first()
        if t is None or not accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists():
            raise NotFound("tournament_not_found")
        if not can_access_module(request.user, t, "forms"):
            raise PermissionDenied("not_tournament_manager")
        inst = Institution.objects.filter(
            id=institution_id, tournament=t, deleted_at__isnull=True
        ).first()
        if inst is None:
            raise NotFound("institution_not_found")

        from apps.forms.models import Form, FormShareLink
        from apps.forms.services.links import create_share_link, institution_prefill

        org_form = (
            Form.objects.filter(
                tournament=t, purpose="organization_registration",
                deleted_at__isnull=True,
            )
            .order_by("-created_at")
            .first()
        )
        if org_form is None:
            raise DRFValidationError({"detail": "no_institution_form"})

        # One live link per school: kill earlier grants before minting.
        for old in FormShareLink.objects.filter(form=org_form, is_active=True):
            if (old.bound_entity or {}).get("institution_id") == str(inst.id):
                old.is_active = False
                old.save(update_fields=["is_active"])

        # Prefill with the school's full previous answers when we have them,
        # else at least its identity/contact fields.
        prefill = None
        if inst.source_response_id:
            from apps.forms.models import FormResponse

            prior = FormResponse.objects.filter(id=inst.source_response_id).first()
            prefill = prior.answers if prior is not None else None
        if not prefill:
            prefill, _label = institution_prefill(org_form, inst)
            name_key = (org_form.settings or {}).get("bindings", {}).get(
                "institution_name"
            )
            if name_key:
                prefill[name_key] = inst.name

        expires_at = timezone.now() + timedelta(days=7)
        _link, token = create_share_link(
            form=org_form, created_by=request.user, label=f"edit:{inst.name}",
            expires_at=expires_at, max_submissions=1,
            bound_entity={"institution_id": str(inst.id)}, prefill=prefill,
        )
        return Response(
            {"path": f"/r/{token}", "expires_at": expires_at.isoformat()},
            status=201,
        )


class TeamCalendarLinkView(GenericAPIView):
    """`POST /api/tournaments/{id}/teams/{team_id}/calendar-link/` — mint a
    signed per-team iCal token (trust layer, increment H). Allowed for a
    tournament manager OR the authenticated registered contact of the team's
    institution (that team's authorized context); other members 403,
    outsiders 404 (no existence leak). The token rides the public
    `calendar.ics` URL — same `django.core.signing` pattern as the
    team-access share links."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, team_id):
        from django.conf import settings as django_settings

        from apps.teams.services.calendar import make_calendar_token
        from apps.tournaments.permissions import can_manage_tournament

        tournament = (
            Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
            .select_related("organization")
            .first()
        )
        if tournament is None:
            raise NotFound("tournament_not_found")
        team = (
            Team.objects.filter(
                id=team_id, tournament=tournament, deleted_at__isnull=True
            )
            .select_related("institution")
            .first()
        )
        accessible = accessible_tournaments(request.user).filter(
            id=tournament_id
        ).exists()
        if team is None:
            if not accessible:
                raise NotFound("tournament_not_found")
            raise NotFound("team_not_found")
        contact_email = (
            (team.institution.contact_email or "")
            if team.institution_id and team.institution
            else ""
        ).strip().lower()
        is_contact = bool(contact_email) and request.user.email == contact_email
        if not (can_manage_tournament(request.user, tournament) or is_contact):
            if not accessible:
                raise NotFound("tournament_not_found")
            raise PermissionDenied("not_authorized_for_team")

        token = make_calendar_token(team)
        base = getattr(
            django_settings, "PUBLIC_BASE_URL", "https://fixture.doxaed.com"
        )
        return Response({
            "token": token,
            "url": f"{base}/api/public/teams/{team.id}/calendar.ics?token={token}",
        })


class PublicTeamCalendarView(GenericAPIView):
    """`GET /api/public/teams/{team_id}/calendar.ics?token=` — the team's
    schedule as an iCal feed (trust layer, increment H). AllowAny but
    capability-gated: a missing, tampered, or another team's token → 403."""

    permission_classes = [AllowAny]

    def get(self, request, team_id):
        from django.http import HttpResponse

        from apps.teams.services.calendar import (
            read_calendar_token,
            team_calendar_ics,
        )

        token = str(request.query_params.get("token") or "")
        if not token:
            raise PermissionDenied("calendar_token_required")
        payload = read_calendar_token(token)
        if not payload or str(payload.get("t")) != str(team_id):
            raise PermissionDenied("invalid_calendar_token")
        team = (
            Team.objects.filter(id=team_id, deleted_at__isnull=True)
            .select_related("tournament", "institution")
            .first()
        )
        if team is None:
            raise NotFound("team_not_found")
        return HttpResponse(
            team_calendar_ics(team),
            content_type="text/calendar; charset=utf-8",
        )
