from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.notifications.models import Notification
from apps.notifications.serializers import NotificationSerializer
from apps.notifications.services.dispatch import mark_all_read, mark_read
from apps.notifications.services.prefs import resolved_prefs, update_prefs


class NotificationListView(GenericAPIView):
    """`GET /api/notifications/` — the current user's notifications + unread count."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = Notification.objects.filter(user=request.user)[:50]
        unread = Notification.objects.filter(
            user=request.user, read_at__isnull=True
        ).count()
        return Response(
            {
                "results": NotificationSerializer(qs, many=True).data,
                "unread_count": unread,
            }
        )


class MarkReadView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, notification_id):
        n = Notification.objects.filter(id=notification_id, user=request.user).first()
        if n is None:
            raise NotFound("notification_not_found")
        mark_read(notification=n, user=request.user)
        return Response(NotificationSerializer(n).data)


class MarkAllReadView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        return Response({"marked": mark_all_read(user=request.user)})


class NotificationPrefsView(GenericAPIView):
    """`GET/PUT /api/notifications/prefs/` — the per-kind channel matrix the
    settings page renders and saves. PUT takes partial payloads
    ({"kinds": {"match_assignment": {"email": false}}, "digest": true}) and
    is naturally idempotent."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(resolved_prefs(request.user))

    def put(self, request):
        kinds = request.data.get("kinds")
        digest = request.data.get("digest")
        if kinds is not None and not isinstance(kinds, dict):
            raise ValidationError({"kinds": "must be an object"})
        try:
            update_prefs(
                user=request.user,
                kinds=kinds,
                digest=None if digest is None else bool(digest),
            )
        except DjangoValidationError as e:
            raise ValidationError({"detail": e.messages[0]}) from e
        return Response(resolved_prefs(request.user))
