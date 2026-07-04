"""Middleware for the Super-admin console (B.15 IP allowlist).

The IP allowlist is opt-in: if ``settings.SADMIN_IP_ALLOWLIST`` is
unset/empty, the middleware is a no-op (dev default). When set to a
list of CIDR strings or single IPs, requests with a remote IP outside
the list to any path starting with ``/sadmin/`` get a 404 — never
403, never redirect (don't reveal that the surface exists).
"""
from __future__ import annotations

import ipaddress
import logging
from collections.abc import Callable, Iterable

from django.conf import settings
from django.http import Http404, HttpRequest, HttpResponse

logger = logging.getLogger(__name__)


def _client_ip(request: HttpRequest) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
    return forwarded or request.META.get("REMOTE_ADDR") or None


def _ip_in_allowlist(ip_str: str | None, allowlist: Iterable[str]) -> bool:
    if not ip_str:
        return False
    try:
        addr = ipaddress.ip_address(ip_str)
    except (ValueError, TypeError):
        return False
    for entry in allowlist:
        entry = (entry or "").strip()
        if not entry:
            continue
        try:
            if "/" in entry:
                network = ipaddress.ip_network(entry, strict=False)
                if addr in network:
                    return True
            else:
                if addr == ipaddress.ip_address(entry):
                    return True
        except (ValueError, TypeError):
            logger.warning("SADMIN_IP_ALLOWLIST contains invalid entry: %r", entry)
            continue
    return False


class SadminIPAllowlistMiddleware:
    """Block /sadmin/* requests from non-allowlisted IPs with a 404.

    No-op when ``SADMIN_IP_ALLOWLIST`` is not configured.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        path = request.path or ""
        if path.startswith("/sadmin/") or path == "/sadmin":
            allowlist = getattr(settings, "SADMIN_IP_ALLOWLIST", None) or []
            if allowlist:
                if not _ip_in_allowlist(_client_ip(request), allowlist):
                    raise Http404
        return self.get_response(request)
