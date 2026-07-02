"""Notification dispatcher. Creates durable Notification rows (idempotent) and
publishes a post-commit delivery signal (SSE transport lands with apps.live)."""
from __future__ import annotations

import logging
import uuid as _uuid

from django.db import transaction
from django.utils import timezone

from apps.notifications.models import Notification

logger = logging.getLogger(__name__)


def _publish(user_id, notification_id) -> None:
    """Post-commit hook — SSE fan-out to the user's notification stream
    (apps.live.sse.notification_stream). Best-effort: delivery failure never
    affects the committed row (the bell's poll remains the fallback)."""
    logger.info("notification committed user=%s id=%s", user_id, notification_id)
    try:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer

        from apps.live.sse import user_notification_group

        layer = get_channel_layer()
        if layer is not None:
            async_to_sync(layer.group_send)(
                user_notification_group(str(user_id)),
                {
                    "type": "notification.tick",
                    "data": {"id": str(notification_id)},
                },
            )
    except Exception:  # pragma: no cover - push is best-effort
        logger.exception("notification SSE fan-out failed")


def create_notification(
    *, user, kind: str, title: str, body: str = "", url: str = "",
    tournament=None, event_id: _uuid.UUID | None = None,
) -> Notification:
    if event_id is not None:
        prior = Notification.objects.filter(event_id=event_id).first()
        if prior is not None:
            return prior
    notif = Notification.objects.create(
        user=user, kind=kind, title=title[:200], body=body, url=url[:300],
        tournament=tournament, event_id=event_id,
    )
    nid, uid = notif.id, user.id
    transaction.on_commit(lambda: _publish(uid, nid))
    return notif


def notify_many(*, users, kind: str, title: str, body: str = "", url: str = "", tournament=None):
    return [
        create_notification(
            user=u, kind=kind, title=title, body=body, url=url, tournament=tournament
        )
        for u in users
    ]


def mark_read(*, notification: Notification, user) -> bool:
    if notification.user_id != user.id:
        return False
    if notification.read_at is None:
        notification.read_at = timezone.now()
        notification.save(update_fields=["read_at"])
    return True


def mark_all_read(*, user) -> int:
    return Notification.objects.filter(user=user, read_at__isnull=True).update(
        read_at=timezone.now()
    )
