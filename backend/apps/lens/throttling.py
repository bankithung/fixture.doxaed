"""Throttle for the public Guest Lens upload endpoints.

Keyed on the pass token from the URL (fallback: client IP) so one school's
36-photo batch behind a NAT never exhausts another school's budget. POST-only
(spec D14): loading the pass page or listing photos must never count. The
``rate`` is a class attribute (no ``DEFAULT_THROTTLE_RATES`` entry needed) —
same approach as ``apps/forms/throttling.py``.
"""
from __future__ import annotations

import hashlib

from rest_framework.throttling import SimpleRateThrottle


class LensJoinThrottle(SimpleRateThrottle):
    """Code guessing on the shared card, capped per IP.

    Keyed on the client, NOT the card token: the whole event scans one card,
    so a token key would let one school's typos lock out every other school.
    The per-school lockout in ``passes.verify_code`` is the other half — this
    bounds a single attacker, that bounds attempts against one school.
    """

    scope = "lens_join"
    rate = "30/hour"

    def get_cache_key(self, request, view) -> str | None:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        ident = self.get_ident(request)
        if ident is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}


class LensUploadThrottle(SimpleRateThrottle):
    scope = "lens_upload"
    rate = "120/hour"

    def get_cache_key(self, request, view) -> str | None:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        token = (getattr(view, "kwargs", None) or {}).get("token") or ""
        if token:
            ident = hashlib.sha256(token.encode("utf-8")).hexdigest()
        else:
            ident = self.get_ident(request)
        if ident is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}
