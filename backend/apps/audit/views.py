"""DRF views for the audit app.

v1Users.md Appendix A.2 ``org.audit_log`` module gates the org-scoped
audit feed for in-org admins / co_organizers / game_coordinators /
referees. Reads only — no write surface. The append-only invariant is
enforced at the Postgres role layer (see
``apps/audit/migrations/0002_audit_append_only.py``).

Cursor pagination uses the ``-created_at, -id`` ordering. Cursor is a
URL-safe base64 of ``"<iso8601_created_at>|<uuid>"``. Stable across
concurrent inserts because ``created_at`` ties are broken by the
UUID v7 primary key (which is itself time-ordered).
"""
from __future__ import annotations

import base64
import uuid
from datetime import datetime

from django.http import Http404
from drf_spectacular.utils import OpenApiParameter, OpenApiTypes, extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.models import AuditEvent
from apps.audit.serializers import (
    AuditEventListResponseSerializer,
    AuditEventSerializer,
)
from apps.permissions.permissions import HasModule

# Default and max page size for the cursor-paginated list endpoint.
_DEFAULT_LIMIT = 50
_MAX_LIMIT = 200


def _resolve_org_by_slug_or_uuid(value: str):
    """Resolve an Organization by slug or UUID. Soft-deleted rows return None."""
    from apps.organizations.models import Organization

    if not value:
        return None
    try:
        as_uuid = uuid.UUID(str(value))
    except (ValueError, TypeError):
        as_uuid = None

    if as_uuid is not None:
        org = Organization.objects.filter(
            id=as_uuid, deleted_at__isnull=True
        ).first()
        if org is not None:
            return org
    return Organization.objects.filter(
        slug=str(value).lower(), deleted_at__isnull=True
    ).first()


def _encode_cursor(created_at: datetime, row_id: uuid.UUID) -> str:
    payload = f"{created_at.isoformat()}|{row_id}".encode()
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID] | None:
    try:
        # Restore base64 padding.
        pad = "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode((cursor + pad).encode("ascii")).decode("utf-8")
        ts_str, id_str = raw.split("|", 1)
        return datetime.fromisoformat(ts_str), uuid.UUID(id_str)
    except (ValueError, TypeError, UnicodeDecodeError):
        return None


def _parse_iso8601(value: str) -> datetime | None:
    """Parse an ISO8601 timestamp; tolerant of missing timezone."""
    if not value:
        return None
    try:
        # Python <3.11 datetime.fromisoformat doesn't accept a 'Z' suffix.
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except (ValueError, TypeError):
        return None


class OrgAuditListView(APIView):
    """GET /api/audit/orgs/<slug>/

    Org-scoped, append-only audit feed. Cursor-paginated.

    Query params:
      * ``cursor`` — opaque pagination cursor (urlsafe-base64).
      * ``limit`` — page size; default 50, max 200.
      * ``actor_id`` — UUID of the actor user to filter by.
      * ``event_type`` — exact match (e.g. ``user_login_success``).
      * ``from`` / ``to`` — ISO8601 timestamps; inclusive lower / exclusive upper bound.
    """

    permission_classes = [IsAuthenticated, HasModule("org.audit_log")]

    def get_organization(self):
        slug = self.kwargs.get("slug")
        return _resolve_org_by_slug_or_uuid(slug)

    @extend_schema(
        parameters=[
            OpenApiParameter(name="cursor", required=False, type=OpenApiTypes.STR),
            OpenApiParameter(name="limit", required=False, type=OpenApiTypes.INT),
            OpenApiParameter(name="actor_id", required=False, type=OpenApiTypes.UUID),
            OpenApiParameter(name="event_type", required=False, type=OpenApiTypes.STR),
            OpenApiParameter(name="from", required=False, type=OpenApiTypes.DATETIME),
            OpenApiParameter(name="to", required=False, type=OpenApiTypes.DATETIME),
        ],
        responses={200: AuditEventListResponseSerializer},
        description=(
            "Cursor-paginated, org-scoped audit event feed. "
            "Read-only. Module-gated by `org.audit_log`."
        ),
    )
    def get(self, request, slug: str):
        org = self.get_organization()
        if org is None:
            raise Http404("Organization not found.")

        qs = AuditEvent.objects.filter(organization_id=org.id)

        # Filters
        actor_id = (request.query_params.get("actor_id") or "").strip()
        if actor_id:
            try:
                qs = qs.filter(actor_user_id=uuid.UUID(actor_id))
            except (ValueError, TypeError):
                return Response(
                    {"detail": "Invalid actor_id; expected a UUID."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        event_type = (request.query_params.get("event_type") or "").strip()
        if event_type:
            qs = qs.filter(event_type=event_type)

        from_ts = _parse_iso8601((request.query_params.get("from") or "").strip())
        if from_ts is not None:
            qs = qs.filter(created_at__gte=from_ts)

        to_ts = _parse_iso8601((request.query_params.get("to") or "").strip())
        if to_ts is not None:
            qs = qs.filter(created_at__lt=to_ts)

        # Pagination
        try:
            limit = int(request.query_params.get("limit") or _DEFAULT_LIMIT)
        except (ValueError, TypeError):
            limit = _DEFAULT_LIMIT
        limit = max(1, min(limit, _MAX_LIMIT))

        qs = qs.select_related("actor_user").order_by("-created_at", "-id")

        cursor_raw = (request.query_params.get("cursor") or "").strip()
        if cursor_raw:
            decoded = _decode_cursor(cursor_raw)
            if decoded is None:
                return Response(
                    {"detail": "Invalid cursor."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            cur_ts, cur_id = decoded
            # Strictly less-than ordering tuple to skip the row that
            # produced the cursor while keeping ordering stable.
            qs = qs.filter(
                # (created_at < cur_ts) OR (created_at = cur_ts AND id < cur_id)
                # — mapped to two ORM queries combined with Q for safety.
            )
            from django.db.models import Q

            qs = qs.filter(
                Q(created_at__lt=cur_ts)
                | Q(created_at=cur_ts, id__lt=cur_id)
            )

        rows = list(qs[: limit + 1])
        has_more = len(rows) > limit
        page = rows[:limit]

        next_cursor: str | None = None
        if has_more and page:
            last = page[-1]
            next_cursor = _encode_cursor(last.created_at, last.id)

        return Response(
            {
                "results": AuditEventSerializer(page, many=True).data,
                "next_cursor": next_cursor,
                "previous_cursor": cursor_raw or None,
            }
        )
