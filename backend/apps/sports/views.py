"""Read-only sports-catalog views.

Public read access — the catalog is platform metadata; anyone (including
unauthenticated visitors on the marketing surfaces) can see what sports
the platform plans to support.
"""
from __future__ import annotations

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics
from rest_framework.permissions import AllowAny

from apps.sports.models import Sport, SportCategory, SportStatus
from apps.sports.serializers import SportSerializer


@extend_schema(
    parameters=[
        OpenApiParameter(
            name="status",
            description="Filter by lifecycle status (planned/coming_soon/active/deprecated).",
            required=False,
            type=str,
        ),
        OpenApiParameter(
            name="category",
            description="Filter by category band (team/racket/combat/etc).",
            required=False,
            type=str,
        ),
    ]
)
class SportListView(generics.ListAPIView):
    """``GET /api/sports/`` — list every sport in the catalog.

    Unfiltered by default; supports ``?status=`` and ``?category=`` query
    params for convenience. Always ordered by ``display_order`` ascending
    (the model's default ordering).
    """

    serializer_class = SportSerializer
    permission_classes = [AllowAny]
    pagination_class = None

    def get_queryset(self):
        qs = Sport.objects.all()
        status = self.request.query_params.get("status")
        if status and status in {s.value for s in SportStatus}:
            qs = qs.filter(status=status)
        category = self.request.query_params.get("category")
        if category and category in {c.value for c in SportCategory}:
            qs = qs.filter(category=category)
        return qs


class SportDetailView(generics.RetrieveAPIView):
    """``GET /api/sports/<code>/`` — fetch a single sport by code."""

    serializer_class = SportSerializer
    permission_classes = [AllowAny]
    queryset = Sport.objects.all()
    lookup_field = "code"
    lookup_url_kwarg = "code"
