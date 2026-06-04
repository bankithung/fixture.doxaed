"""Session-fixation defenses.

v1Users.md Appendix B.11 lock: any auth-state change MUST cycle the
session key so a pre-existing session ID cannot be replayed against
the elevated identity. Examples:

- Successful login (handled by ``django.contrib.auth.login`` + our
  explicit ``cycle_key()`` after).
- Successful invite acceptance (organizations agent calls this helper
  from the accept-invite verb).
- Successful password reset (the reset service deletes all sessions,
  forcing fresh login — implicit cycle).
- Successful 2FA enrollment / disable (cycles to invalidate prior
  pre-2FA cookies).
"""
from __future__ import annotations

from django.http import HttpRequest


def cycle_session_on_role_change(request: HttpRequest) -> None:
    """Rotate the session key while preserving session data.

    Idempotent: safe to call even if the session is empty / not yet
    persisted. Calling on an unauthenticated request is a no-op as far
    as security is concerned, but Django still emits a fresh key.
    """
    session = getattr(request, "session", None)
    if session is None:
        return
    session.cycle_key()
