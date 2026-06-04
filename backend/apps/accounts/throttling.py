"""DRF throttle classes for the accounts app.

v1Users.md Appendix B.11 commits to:

  Org self-signup (Path B, §2.3) — 3/hr/IP, 1/day/email

The default DRF ``AnonRateThrottle`` from ``settings.base.py`` is
60/min — three orders of magnitude looser than the spec. Apply a
view-scoped throttle to ``signup`` so the public endpoint follows the
locked anti-abuse budget.

The ``rate`` is read from ``settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['signup']``
so the threshold is settable from a single config knob and overridable
in tests.
"""
from __future__ import annotations

from rest_framework.throttling import SimpleRateThrottle


class SignupRateThrottle(SimpleRateThrottle):
    """Per-IP rate limit for the public Path B signup endpoint.

    Scope key: ``signup`` (matches
    ``REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['signup']``). Cache key
    is the client IP — anonymous requests share buckets per remote
    address.
    """

    scope = "signup"

    def get_cache_key(self, request, view) -> str | None:  # pragma: no cover - thin
        ident = self.get_ident(request)
        if ident is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}
