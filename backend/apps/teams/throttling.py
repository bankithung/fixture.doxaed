"""Throttle for the public school-registration endpoint.

`/api/register/{token}/` is AllowAny so anyone with a shared link can submit.
Without a rate limit a leaked link could be spammed to create unlimited teams.
Throttle POST per client IP (GET, which just resolves the link, is exempt).
Rate read from ``REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['school_registration']``.
"""
from __future__ import annotations

from rest_framework.throttling import SimpleRateThrottle


class RegistrationRateThrottle(SimpleRateThrottle):
    scope = "school_registration"

    def allow_request(self, request, view) -> bool:
        if request.method != "POST":
            return True  # GET resolves link context; don't throttle it
        return super().allow_request(request, view)

    def get_cache_key(self, request, view) -> str | None:
        ident = self.get_ident(request)
        if ident is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}
