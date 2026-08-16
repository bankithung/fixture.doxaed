"""Tournament-scoped house endpoints (spec 2026-08-16 §D4/§D5).

The Houses & members stage. Distinct from ``views_houses.py``, which is the
ORG-level season/points console: this one is about who competes in one event.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Count, Q
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.teams.models import TeamGroup, TeamGroupMembership, TournamentHouse
from apps.teams.services import houses as svc
from apps.tournaments.models import TournamentScope
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.views import _get_tournament_or_404


def _as_drf(exc: DjangoValidationError):
    detail = getattr(exc, "message", None) or (exc.messages[0] if exc.messages else "invalid")
    return DRFValidationError({"detail": detail})


def _house_payload(group: TeamGroup, *, teams: int = 0, members=None) -> dict:
    return {
        "id": str(group.id),
        "name": group.name,
        "kind": group.kind,
        "colour": group.colour,
        "teams": teams,
        "members": [
            {
                "id": str(m.id),
                "user_id": str(m.user_id),
                "name": getattr(m.user, "full_name", "") or m.user.email,
                "email": m.user.email,
                "role": m.role,
            }
            for m in (members or [])
        ],
    }


def _require_intra(tournament):
    if tournament.scope != TournamentScope.INTRA_SCHOOL:
        raise DRFValidationError({"detail": "houses_require_intra_school_scope"})


def _require_manager(user, tournament):
    if not can_manage_tournament(user, tournament):
        raise DRFValidationError({"detail": "forbidden"})


class TournamentHouseListView(APIView):
    """GET the houses in this event; POST to add one."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        _require_intra(t)
        groups = list(
            svc.houses_for(t).annotate(
                team_count=Count(
                    "teams",
                    filter=Q(teams__tournament=t, teams__deleted_at__isnull=True),
                    distinct=True,
                )
            )
        )
        members = {}
        for m in TeamGroupMembership.objects.filter(
            group__in=groups, revoked_at__isnull=True
        ).select_related("user"):
            members.setdefault(m.group_id, []).append(m)
        mine = svc.manageable_house_ids(t, request.user)
        return Response(
            {
                "scope": t.scope,
                "group_kind": t.group_kind,
                "can_manage": can_manage_tournament(request.user, t),
                # None = unrestricted; a list = the houses this user acts for.
                "my_houses": None if mine is None else sorted(mine),
                "houses": [
                    _house_payload(
                        g,
                        teams=getattr(g, "team_count", 0),
                        members=members.get(g.id, []),
                    )
                    for g in groups
                ],
            }
        )

    def post(self, request, tournament_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        _require_intra(t)
        _require_manager(request.user, t)
        try:
            group = svc.create_house(
                tournament=t,
                name=request.data.get("name") or "",
                colour=request.data.get("colour") or "",
                kind=request.data.get("kind") or None,
                by=request.user,
                request=request,
            )
        except DjangoValidationError as exc:
            raise _as_drf(exc) from exc
        return Response(_house_payload(group), status=201)


class TournamentHouseDetailView(APIView):
    """PATCH to rename/recolour; DELETE to withdraw from this event
    (``?retire=1`` retires it for the whole season)."""

    permission_classes = [IsAuthenticated]

    def _resolve(self, request, tournament_id, house_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        _require_intra(t)
        group = TeamGroup.objects.filter(
            id=house_id,
            organization=t.organization,
            deleted_at__isnull=True,
        ).first()
        if group is None or not TournamentHouse.objects.filter(
            tournament=t, group=group
        ).exists():
            raise DRFValidationError({"detail": "house_not_found"})
        return t, group

    def patch(self, request, tournament_id, house_id):
        t, group = self._resolve(request, tournament_id, house_id)
        _require_manager(request.user, t)
        try:
            svc.update_house(
                tournament=t,
                group=group,
                name=request.data.get("name"),
                colour=request.data.get("colour"),
                by=request.user,
                request=request,
            )
        except DjangoValidationError as exc:
            raise _as_drf(exc) from exc
        return Response(_house_payload(group))

    def delete(self, request, tournament_id, house_id):
        t, group = self._resolve(request, tournament_id, house_id)
        _require_manager(request.user, t)
        retire = str(request.query_params.get("retire", "")).lower() in ("1", "true")
        try:
            if retire:
                svc.retire_house(tournament=t, group=group, by=request.user, request=request)
            else:
                svc.remove_house(tournament=t, group=group, by=request.user, request=request)
        except DjangoValidationError as exc:
            raise _as_drf(exc) from exc
        return Response(status=204)


class TournamentHouseMemberView(APIView):
    """POST a user into a house; DELETE ``?user=<uuid>`` to revoke."""

    permission_classes = [IsAuthenticated]

    def _resolve(self, request, tournament_id, house_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        _require_intra(t)
        _require_manager(request.user, t)
        group = TeamGroup.objects.filter(
            id=house_id, organization=t.organization, deleted_at__isnull=True
        ).first()
        if group is None:
            raise DRFValidationError({"detail": "house_not_found"})
        return t, group

    def post(self, request, tournament_id, house_id):
        from django.contrib.auth import get_user_model

        t, group = self._resolve(request, tournament_id, house_id)
        raw = request.data.get("user_id") or request.data.get("email") or ""
        User = get_user_model()
        user = (
            User.objects.filter(id=raw).first()
            if "-" in str(raw)
            else User.objects.filter(email__iexact=str(raw)).first()
        )
        if user is None:
            user = User.objects.filter(email__iexact=str(raw)).first()
        if user is None:
            raise DRFValidationError({"detail": "user_not_found"})
        try:
            svc.add_house_member(
                tournament=t, group=group, user=user, by=request.user, request=request,
            )
        except DjangoValidationError as exc:
            raise _as_drf(exc) from exc
        members = TeamGroupMembership.objects.filter(
            group=group, revoked_at__isnull=True
        ).select_related("user")
        return Response(_house_payload(group, members=members), status=201)

    def delete(self, request, tournament_id, house_id):
        t, group = self._resolve(request, tournament_id, house_id)
        target = request.query_params.get("user") or ""
        membership = TeamGroupMembership.objects.filter(
            group=group, user_id=target, revoked_at__isnull=True
        ).first()
        if membership is None:
            raise DRFValidationError({"detail": "member_not_found"})
        svc.remove_house_member(
            tournament=t, membership=membership, by=request.user, request=request,
        )
        return Response(status=204)
