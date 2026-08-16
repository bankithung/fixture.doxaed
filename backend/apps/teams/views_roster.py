"""Tournament-scoped participants endpoints (spec 2026-08-17).

The organizer's view of the layer the public sheet writes into. It answers the
question the owner actually asked — "can I see if one student is in multiple
sports?" — by returning, for each declared person, every team they are on.

Access mirrors the houses console: a tournament manager sees the whole event; a
house manager in a within-school tournament sees exactly their own houses, and
nobody else's children.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Q
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.teams.models import (
    Institution,
    Player,
    RosterMember,
    RosterMemberKind,
    TeamGroup,
    TeamStaff,
)
from apps.teams.services import roster as svc
from apps.teams.services.houses import manageable_house_ids
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.views import _get_tournament_or_404

#: Columns a caller may set directly. Anything else the event asks for rides on
#: ``attributes`` — the sheet is data, so it grows without a schema change.
WRITABLE = (
    "class_section", "roll_no", "gender", "date_of_birth",
    "contact_email", "contact_phone",
)


def _as_drf(exc: DjangoValidationError):
    detail = getattr(exc, "message", None) or (
        exc.messages[0] if exc.messages else "invalid"
    )
    return DRFValidationError({"detail": detail})


def _fields_from(data: dict) -> dict:
    out = {k: data[k] for k in WRITABLE if k in data}
    # A blank date must clear the column rather than fail coercion on "".
    if out.get("date_of_birth") in ("", None):
        out.pop("date_of_birth", None)
    return out


def _payload(m: RosterMember, entries: dict) -> dict:
    return {
        "id": str(m.id),
        "full_name": m.person.full_name,
        "kind": m.kind,
        "class_section": m.class_section,
        "roll_no": m.roll_no,
        "gender": m.gender,
        "date_of_birth": (
            m.date_of_birth.isoformat() if m.date_of_birth else None
        ),
        "contact_email": m.contact_email,
        "contact_phone": m.contact_phone,
        "attributes": m.attributes or {},
        "institution": (
            {"id": str(m.institution_id), "name": m.institution.name}
            if m.institution_id
            else None
        ),
        "group": (
            {"id": str(m.group_id), "name": m.group.name} if m.group_id else None
        ),
        # The point of the layer: one person, every competition they are in.
        "entries": entries.get(m.id, []),
    }


def _entries_for(tournament, members: list[RosterMember]) -> dict:
    """Which teams each declared person is on — as a player, or in charge.

    Keyed on the ``Person`` for players (that is what a Player row references)
    and on the member for staff, then collapsed back onto the member so one row
    on screen shows everything that person is committed to.
    """
    by_person: dict = {}
    for m in members:
        by_person.setdefault(m.person_id, []).append(m)
    out: dict = {}
    players = (
        Player.objects.filter(
            tournament=tournament,
            person_id__in=list(by_person),
            deleted_at__isnull=True,
            team__deleted_at__isnull=True,
        )
        .select_related("team")
    )
    for p in players:
        for m in by_person.get(p.person_id, []):
            out.setdefault(m.id, []).append({
                "team_id": str(p.team_id),
                "team": p.team.name,
                "leaf_key": p.team.leaf_key,
                "role": "player",
            })
    staff = (
        TeamStaff.objects.filter(member__in=members, team__deleted_at__isnull=True)
        .select_related("team")
    )
    for s in staff:
        out.setdefault(s.member_id, []).append({
            "team_id": str(s.team_id),
            "team": s.team.name,
            "leaf_key": s.team.leaf_key,
            "role": s.role or "in_charge",
        })
    return out


class TournamentRosterView(APIView):
    """GET the declared participants; POST to declare one by hand.

    The organizer's own entry path: most rows arrive through the public sheet,
    but a school that phones in its list must not need one.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        mine = manageable_house_ids(t, request.user)
        qs = svc.roster_for(t)
        if mine is not None:
            # A house manager sees their own houses and nothing else. An empty
            # set means no houses, which correctly yields an empty list.
            qs = qs.filter(group_id__in=list(mine))
        inst_id = request.query_params.get("institution")
        if inst_id:
            qs = qs.filter(institution_id=inst_id)
        kind = request.query_params.get("kind")
        if kind in RosterMemberKind.values:
            qs = qs.filter(kind=kind)
        group_id = request.query_params.get("group")
        if group_id:
            qs = qs.filter(group_id=group_id)
        q = (request.query_params.get("q") or "").strip()
        if q:
            qs = qs.filter(
                Q(person__full_name__icontains=q)
                | Q(class_section__icontains=q)
                | Q(roll_no__icontains=q)
            )
        members = list(qs)
        entries = _entries_for(t, members)
        payload = [_payload(m, entries) for m in members]
        return Response({
            "can_manage": can_manage_tournament(request.user, t),
            "roster_mode": t.roster_mode,
            "scope": t.scope,
            "group_kind": t.group_kind,
            "counts": {
                "students": sum(
                    1 for m in members if m.kind == RosterMemberKind.STUDENT
                ),
                "teachers": sum(
                    1 for m in members if m.kind == RosterMemberKind.TEACHER
                ),
                # How many people are committed to more than one competition —
                # the number a scheduler actually needs before drawing a day.
                "multi_entry": sum(
                    1 for p in payload if len({e["team_id"] for e in p["entries"]}) > 1
                ),
            },
            "members": payload,
        })

    def post(self, request, tournament_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        data = request.data
        inst, group = _resolve_competitor(request, t, data)
        try:
            member = svc.declare_member(
                tournament=t,
                institution=inst,
                group=group,
                full_name=str(data.get("full_name") or ""),
                kind=str(data.get("kind") or RosterMemberKind.STUDENT),
                attributes=data.get("attributes") or None,
                by=request.user,
                request=request,
                **_fields_from(data),
            )
        except DjangoValidationError as exc:
            raise _as_drf(exc) from exc
        return Response(_payload(member, _entries_for(t, [member])), status=201)


def _resolve_competitor(request, t, data):
    """(institution, group) a hand-declared participant belongs to, refusing
    anything the caller is not entitled to write."""
    mine = manageable_house_ids(t, request.user)
    group = None
    gid = data.get("group_id") or data.get("house_id")
    if gid:
        group = TeamGroup.objects.filter(
            id=gid, organization=t.organization, deleted_at__isnull=True
        ).first()
        if group is None:
            raise DRFValidationError({"detail": "house_not_found"})
    if mine is not None:
        # House-scoped caller: they must name one of THEIR houses.
        if group is None or str(group.id) not in mine:
            raise DRFValidationError({"detail": "house_access_required"})
    elif not can_manage_tournament(request.user, t):
        raise DRFValidationError({"detail": "forbidden"})

    iid = data.get("institution_id")
    inst = (
        Institution.objects.filter(
            id=iid, tournament=t, deleted_at__isnull=True
        ).first()
        if iid
        else Institution.objects.filter(
            tournament=t, deleted_at__isnull=True
        ).order_by("created_at").first()
    )
    if inst is None:
        raise DRFValidationError({"detail": "institution_not_found"})
    return inst, group


class TournamentRosterDetailView(APIView):
    """PATCH to correct a declared person; DELETE to withdraw them."""

    permission_classes = [IsAuthenticated]

    def _resolve(self, request, tournament_id, member_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        member = (
            RosterMember.objects.filter(
                id=member_id, tournament=t, deleted_at__isnull=True
            )
            .select_related("person", "institution", "group")
            .first()
        )
        if member is None:
            raise DRFValidationError({"detail": "participant_not_found"})
        mine = manageable_house_ids(t, request.user)
        if mine is not None:
            if member.group_id is None or str(member.group_id) not in mine:
                raise DRFValidationError({"detail": "house_access_required"})
        elif not can_manage_tournament(request.user, t):
            raise DRFValidationError({"detail": "forbidden"})
        return t, member

    def patch(self, request, tournament_id, member_id):
        t, member = self._resolve(request, tournament_id, member_id)
        data = request.data
        try:
            svc.update_member(
                member=member,
                full_name=(
                    str(data["full_name"]) if "full_name" in data else None
                ),
                kind=str(data["kind"]) if "kind" in data else None,
                attributes=data.get("attributes") or None,
                by=request.user,
                request=request,
                **_fields_from(data),
            )
        except DjangoValidationError as exc:
            raise _as_drf(exc) from exc
        member.refresh_from_db()
        return Response(_payload(member, _entries_for(t, [member])))

    def delete(self, request, tournament_id, member_id):
        _t, member = self._resolve(request, tournament_id, member_id)
        try:
            svc.withdraw_member(member=member, by=request.user, request=request)
        except DjangoValidationError as exc:
            raise _as_drf(exc) from exc
        return Response(status=204)
