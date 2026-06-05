from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.notifications.models import Notification
from apps.notifications.serializers import NotificationSerializer
from apps.notifications.services.dispatch import mark_all_read, mark_read


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
