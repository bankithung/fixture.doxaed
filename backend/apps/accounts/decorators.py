"""DRF-compatible decorators for the accounts app.

v1Users.md Appendix B.18 lock: any "sensitive verb" (suspend,
impersonate, transfer ownership, force-disable 2FA, delete Org) MUST
re-prompt for password regardless of session age. The frontend handles
the prompt UI; the backend enforces a recent-reauth marker on the
session.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from functools import wraps

from django.conf import settings
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

REAUTH_SESSION_KEY = "last_password_reauth"


def require_recent_password_reauth(within_minutes: int | None = None):
    """DRF view decorator. 403s with ``{"detail": "password_reauth_required"}``
    if the session has no recent reauth marker within ``within_minutes``
    (default ``settings.SENSITIVE_REAUTH_WINDOW_MINUTES``).

    The companion ``POST /api/accounts/auth/reauth/`` endpoint sets
    ``request.session[REAUTH_SESSION_KEY] = now.isoformat()`` on success.
    """

    def decorator(view_func: Callable) -> Callable:
        @wraps(view_func)
        def _wrapped(request, *args, **kwargs):
            window = within_minutes
            if window is None:
                window = getattr(settings, "SENSITIVE_REAUTH_WINDOW_MINUTES", 5)
            session = getattr(request, "session", None)
            stamp = session.get(REAUTH_SESSION_KEY) if session is not None else None
            if stamp:
                try:
                    when = datetime.fromisoformat(stamp)
                except ValueError:
                    when = None
                if when is not None:
                    if timezone.is_naive(when):
                        when = timezone.make_aware(when, timezone.get_current_timezone())
                    if timezone.now() - when <= timedelta(minutes=window):
                        return view_func(request, *args, **kwargs)
            return Response(
                {"detail": "password_reauth_required"},
                status=status.HTTP_403_FORBIDDEN,
            )

        return _wrapped

    return decorator
