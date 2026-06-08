"""Branded transactional email helpers.

Renders the HTML templates under ``templates/emails/`` with a plain-text
alternative and sends a multipart message. Keep callers thin — they build a
context and call one of the ``send_*`` helpers.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

logger = logging.getLogger(__name__)


def send_branded_email(
    *,
    subject: str,
    to: str,
    template: str,
    context: Mapping[str, Any],
    fail_silently: bool = True,
) -> bool:
    """Render ``emails/<template>.{html,txt}`` and send as multipart.

    Returns True on success. When ``fail_silently`` (the default for the
    user-facing auth flows, which must never break on a mail hiccup), a send
    failure is logged and swallowed.
    """
    ctx = {"frontend_base_url": settings.FRONTEND_BASE_URL, **dict(context)}
    try:
        text_body = render_to_string(f"emails/{template}.txt", ctx)
        html_body = render_to_string(f"emails/{template}.html", ctx)
        msg = EmailMultiAlternatives(subject=subject, body=text_body, to=[to])
        msg.attach_alternative(html_body, "text/html")
        msg.send(fail_silently=False)
        return True
    except Exception:  # noqa: BLE001 — auth flows stay best-effort
        logger.exception("Failed to send branded email %r to %s", template, to)
        if not fail_silently:
            raise
        return False


def send_verification_email(
    *, user: Any, token: str, ttl_hours: int, fail_silently: bool = True
) -> bool:
    verify_url = f"{settings.FRONTEND_BASE_URL}/verify-email?token={token}"
    return send_branded_email(
        subject="Verify your email · Fixture",
        to=user.email,
        template="verify_email",
        context={"user": user, "verify_url": verify_url, "ttl_hours": ttl_hours},
        fail_silently=fail_silently,
    )
