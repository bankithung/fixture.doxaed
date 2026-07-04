"""Season / house / house-points API for institution operators (P4).

Org-scoped (the operator org owns its seasons and houses); org admin or
co-organizer manages, any active member reads. The house table is live and
day-zero-friendly (every house at 0). All writes idempotent on event_id
where it matters (the append-only ledger).
"""
from __future__ import annotations

import uuid as _uuid

from django.core.exceptions import ValidationError as DjangoValidationError
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.organizations.models import (
    MembershipRole,
    Organization,
    OrganizationMembership,
)
from apps.teams.models import HousePointSource, Season, TeamGroup, TeamGroupKind
from apps.teams.services.house_points import (
    award_house_points,
    record_meet_event_result,
    season_house_table,
)

_MANAGE_ROLES = (MembershipRole.ADMIN, MembershipRole.CO_ORGANIZER)


def _org_or_404(user, org_uuid) -> tuple[Organization, bool]:
    """(org, can_manage) — members see, admins/co-organizers manage; no
    existence leak for outsiders (404, invariant 2)."""
    org = get_object_or_404(Organization, pk=org_uuid)
    memberships = OrganizationMembership.objects.filter(
        user=user, organization=org, is_active=True
    ).values_list("role", flat=True)
    roles = set(memberships)
    if not roles:
        raise NotFound("organization_not_found")
    return org, bool(roles & set(_MANAGE_ROLES))


class SeasonSerializer(serializers.Serializer):
    label = serializers.CharField(max_length=32)
    starts_on = serializers.DateField(required=False, allow_null=True)
    ends_on = serializers.DateField(required=False, allow_null=True)
    is_current = serializers.BooleanField(required=False, default=False)


def _season_dict(s: Season) -> dict:
    return {
        "id": str(s.id), "label": s.label,
        "starts_on": s.starts_on, "ends_on": s.ends_on,
        "is_current": s.is_current,
    }


class OrgSeasonsView(GenericAPIView):
    """`GET/POST /api/orgs/{uuid}/seasons/`."""

    permission_classes = [IsAuthenticated]

    def get(self, request, uuid):
        org, _ = _org_or_404(request.user, uuid)
        return Response({
            "seasons": [
                _season_dict(s)
                for s in Season.objects.filter(organization=org).order_by("-label")
            ]
        })

    def post(self, request, uuid):
        org, can_manage = _org_or_404(request.user, uuid)
        if not can_manage:
            raise PermissionDenied("not_org_manager")
        ser = SeasonSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if Season.objects.filter(organization=org, label=data["label"]).exists():
            raise DRFValidationError({"detail": "season_label_exists"})
        if data.get("is_current"):
            Season.objects.filter(organization=org, is_current=True).update(
                is_current=False
            )
        season = Season.objects.create(organization=org, **data)
        return Response(_season_dict(season), status=201)


class GroupSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    kind = serializers.ChoiceField(
        choices=TeamGroupKind.values, default=TeamGroupKind.HOUSE
    )
    colour = serializers.CharField(
        max_length=16, required=False, allow_blank=True, default=""
    )


class SeasonGroupsView(GenericAPIView):
    """`GET/POST /api/orgs/{uuid}/seasons/{season_id}/groups/`."""

    permission_classes = [IsAuthenticated]

    def _season(self, user, org_uuid, season_id):
        org, can_manage = _org_or_404(user, org_uuid)
        season = Season.objects.filter(pk=season_id, organization=org).first()
        if season is None:
            raise NotFound("season_not_found")
        return org, season, can_manage

    def get(self, request, uuid, season_id):
        _, season, _ = self._season(request.user, uuid, season_id)
        return Response({
            "groups": [
                {"id": str(g.id), "name": g.name, "kind": g.kind,
                 "colour": g.colour}
                for g in TeamGroup.objects.filter(season=season).order_by("name")
            ]
        })

    def post(self, request, uuid, season_id):
        org, season, can_manage = self._season(request.user, uuid, season_id)
        if not can_manage:
            raise PermissionDenied("not_org_manager")
        ser = GroupSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if TeamGroup.objects.filter(season=season, name=data["name"]).exists():
            raise DRFValidationError({"detail": "group_name_exists"})
        g = TeamGroup.objects.create(organization=org, season=season, **data)
        return Response(
            {"id": str(g.id), "name": g.name, "kind": g.kind, "colour": g.colour},
            status=201,
        )


class HousePointsAwardSerializer(serializers.Serializer):
    group_id = serializers.UUIDField()
    points = serializers.IntegerField(min_value=-999, max_value=999)
    reason = serializers.CharField(max_length=200)
    source = serializers.ChoiceField(
        choices=HousePointSource.values, default=HousePointSource.JUDGED
    )
    event_id = serializers.UUIDField(required=False)


class SeasonHouseTableView(GenericAPIView):
    """`GET /api/orgs/{uuid}/seasons/{season_id}/house-table/` — the live
    board every notice-board flagpole update comes from.
    `POST .../house-points/` (same view family) appends a judged award."""

    permission_classes = [IsAuthenticated]

    def get(self, request, uuid, season_id):
        org, _ = _org_or_404(request.user, uuid)
        season = Season.objects.filter(pk=season_id, organization=org).first()
        if season is None:
            raise NotFound("season_not_found")
        return Response({
            "season": _season_dict(season),
            "table": season_house_table(season),
        })


class SeasonHousePointsView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, uuid, season_id):
        org, can_manage = _org_or_404(request.user, uuid)
        if not can_manage:
            raise PermissionDenied("not_org_manager")
        season = Season.objects.filter(pk=season_id, organization=org).first()
        if season is None:
            raise NotFound("season_not_found")
        ser = HousePointsAwardSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        group = TeamGroup.objects.filter(
            pk=data["group_id"], season=season
        ).first()
        if group is None:
            raise DRFValidationError({"detail": "group_not_in_season"})
        try:
            entry = award_house_points(
                season=season, group=group, points=data["points"],
                reason=data["reason"], by=request.user, source=data["source"],
                event_id=data.get("event_id"), request=request,
            )
        except DjangoValidationError as e:
            raise DRFValidationError(
                {"detail": getattr(e, "message", "invalid_award")}
            )
        return Response(
            {"id": str(entry.id), "points": entry.points,
             "group_id": str(group.id)},
            status=201,
        )

class MeetResultSerializer(serializers.Serializer):
    event_label = serializers.CharField(max_length=150)
    """Ordered group ids, winner first."""
    placements = serializers.ListField(
        child=serializers.UUIDField(), min_length=1, max_length=12,
    )
    relay = serializers.BooleanField(required=False, default=False)
    place_points = serializers.ListField(
        child=serializers.IntegerField(min_value=0, max_value=99),
        required=False, min_length=1, max_length=12,
    )
    event_id = serializers.UUIDField(required=False)


class SeasonMeetResultView(GenericAPIView):
    """`POST /api/orgs/{uuid}/seasons/{season_id}/meet-results/` — MEET MODE
    (P4): one event's placements in, the whole points ladder lands in the
    house table (7-5-4-3-2-1, x2 relays, custom ladders legal)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, uuid, season_id):
        org, can_manage = _org_or_404(request.user, uuid)
        if not can_manage:
            raise PermissionDenied("not_org_manager")
        season = Season.objects.filter(pk=season_id, organization=org).first()
        if season is None:
            raise NotFound("season_not_found")
        ser = MeetResultSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        try:
            entries = record_meet_event_result(
                season=season,
                event_label=data["event_label"],
                placements=[str(x) for x in data["placements"]],
                by=request.user,
                relay=data["relay"],
                place_points=data.get("place_points"),
                event_id=data.get("event_id"),
                request=request,
            )
        except DjangoValidationError as e:
            raise DRFValidationError(
                {"detail": getattr(e, "message", "invalid_meet_result")}
            )
        return Response(
            {"entries": len(entries), "table": season_house_table(season)},
            status=201,
        )

