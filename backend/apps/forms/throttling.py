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
    rate = "60/hour"

    def get_cache_key(self, request, view) -> str | None:
        # Only throttle write attempts (submissions/uploads). Loading or
        # previewing a form (GET/HEAD/OPTIONS) must NEVER count toward the
        # anti-spam budget — otherwise viewing/testing a form exhausts it.
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        ident = self.get_ident(request)
        if ident is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}


class TeamAccessThrottle(SimpleRateThrottle):
    """Tighter budget for the access-code exchange — codes are short, so the
    endpoint gets 15 attempts/hour per IP on top of the per-institution
    failure lockout in ``apps.teams.services.access``."""

    scope = "team_access"
    rate = "15/hour"

    def get_cache_key(self, request, view) -> str | None:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        ident = self.get_ident(request)
        if ident is None:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}
