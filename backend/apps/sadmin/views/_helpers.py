"""Shared view helpers — context processor logic and HTMX partial render."""
from __future__ import annotations

import uuid
from typing import Any

from django.http import HttpRequest
from django.shortcuts import render


def impersonation_context(request: HttpRequest) -> dict[str, Any]:
    """Resolve the impersonated user (if any) into a template-friendly dict.

    Adds two keys:
    * ``impersonating_user_id`` — UUID or None
    * ``impersonating_email`` — string or None (drives the banner partial)
    """
    raw = None
    try:
        raw = request.session.get("impersonating_user_id")
    except Exception:
        return {"impersonating_user_id": None, "impersonating_email": None}

    if not raw:
        return {"impersonating_user_id": None, "impersonating_email": None}

    try:
        uid = uuid.UUID(str(raw))
    except (ValueError, TypeError):
        return {"impersonating_user_id": None, "impersonating_email": None}

    try:
        from apps.accounts.models import User

        u = User.objects.filter(pk=uid).first()
        return {
            "impersonating_user_id": uid,
            "impersonating_email": u.email if u else None,
        }
    except Exception:
        return {"impersonating_user_id": uid, "impersonating_email": None}


def render_sadmin(request: HttpRequest, template: str, ctx: dict[str, Any] | None = None):
    """Render with impersonation context auto-merged."""
    base_ctx = impersonation_context(request)
    if ctx:
        base_ctx.update(ctx)
    return render(request, template, base_ctx)


def render_verb_result(request: HttpRequest, *, ok: bool, message: str):
    return render(
        request,
        "sadmin/_verb_result.html",
        {"ok": ok, "message": message},
    )
