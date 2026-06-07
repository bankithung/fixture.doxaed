"""Throttle for the public form submission + upload endpoints.

``/api/forms/{id}/public/`` and ``/api/forms/{id}/uploads/`` are AllowAny so
anyone with a form link can submit. Without a rate limit a leaked link could be
spammed. The ``rate`` is set as a class attribute (not read from settings) so it
works without a ``DEFAULT_THROTTLE_RATES`` entry — same approach as
``apps/teams/throttling.py``. The dev cache is in-memory; that's fine.
"""
from __future__ import annotations

from rest_framework.throttling import SimpleRateThrottle


class PublicFormThrottle(SimpleRateThrottle):
    scope = "public_form"
    rate = "30/hour"

    def get_cache_key(self, request, view) -> str | None:
        ident = self.get_ident(request)
        if ident is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}
