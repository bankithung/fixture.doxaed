from __future__ import annotations

from django.urls import path

from apps.notifications.views import (
    MarkAllReadView,
    MarkReadView,
    NotificationListView,
    NotificationPrefsView,
)

# Mounted at /api/notifications/
urlpatterns = [
    path("", NotificationListView.as_view(), name="notification-list"),
    path("prefs/", NotificationPrefsView.as_view(), name="notification-prefs"),
    path("read-all/", MarkAllReadView.as_view(), name="notification-read-all"),
    path(
        "<uuid:notification_id>/read/",
        MarkReadView.as_view(),
        name="notification-read",
    ),
]
