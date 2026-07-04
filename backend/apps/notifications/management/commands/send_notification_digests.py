"""Daily digest sender — one branded email per opted-in user summarizing the
in-app notifications they have not read since the last digest. Wired to a
systemd timer in deploy/ (fixture-digest.timer); safe to re-run — a user with
nothing unread since their stamp is skipped, and the stamp only advances on a
successful send."""
from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.accounts.services.mailer import send_branded_email
from apps.notifications.models import Notification, NotificationPreference

MAX_ITEMS = 10


class Command(BaseCommand):
    help = "Email opted-in users a digest of unread notifications."

    def handle(self, *args, **options):
        now = timezone.now()
        base = getattr(settings, "FRONTEND_BASE_URL", "").rstrip("/")
        sent = skipped = 0
        prefs = NotificationPreference.objects.filter(
            digest=True
        ).select_related("user")
        for pref in prefs.iterator():
            user = pref.user
            if not user.email or not user.is_active:
                skipped += 1
                continue
            since = pref.digest_sent_at or (now - timedelta(days=1))
            unread = list(
                Notification.objects.filter(
                    user=user, read_at__isnull=True, created_at__gt=since
                ).order_by("-created_at")[: MAX_ITEMS + 1]
            )
            if not unread:
                skipped += 1
                continue
            items = [
                {"title": n.title, "body": n.body} for n in unread[:MAX_ITEMS]
            ]
            ok = send_branded_email(
                subject=f"Your Fixture digest: {len(unread)} update"
                + ("s" if len(unread) != 1 else ""),
                to=user.email,
                template="notification_digest",
                context={
                    "count": len(unread),
                    "items": items,
                    "more": max(0, len(unread) - MAX_ITEMS),
                    "bell_url": f"{base}/me/notifications",
                },
                fail_silently=True,
            )
            if ok:
                pref.digest_sent_at = now
                pref.save(update_fields=["digest_sent_at", "updated_at"])
                sent += 1
            else:
                skipped += 1
        self.stdout.write(f"digests sent={sent} skipped={skipped}")
