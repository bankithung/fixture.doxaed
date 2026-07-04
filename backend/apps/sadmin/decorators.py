"""View decorators for the Super-admin console.

v1Users.md §1.5/§1.8 lock: every view in apps/sadmin/views/ MUST be
gated by ``@superadmin_required``. Non-Super-admin requesters get a
404 (NOT 403, NOT a redirect) so the surface's existence is not
leaked. (B.15 IP allowlist further hides the surface at network
level.)
"""
from __future__ import annotations

from collections.abc import Callable
from functools import wraps

from django.http import Http404, HttpRequest, HttpResponse, HttpResponseRedirect
from django.urls import reverse


def superadmin_required(view_func: Callable[..., HttpResponse]) -> Callable[..., HttpResponse]:
    """Gate the sadmin surface.

    - Anonymous → 302 to /sadmin/login/?next=... (so the SA can bootstrap a
      session without bouncing through the SPA).
    - Authenticated-but-NOT-Super-admin → 404. Real users hitting the
      surface still see no evidence it exists (§1.5 hide invariant).
    """

    @wraps(view_func)
    def _wrapped(request: HttpRequest, *args, **kwargs) -> HttpResponse:
        user = getattr(request, "user", None)
        is_auth = bool(user is not None and getattr(user, "is_authenticated", False))
        if not is_auth:
            login_url = reverse("sadmin:login")
            return HttpResponseRedirect(f"{login_url}?next={request.path}")
        if (
            not getattr(user, "is_superuser", False)
            or getattr(user, "is_active", True) is False
            or getattr(user, "deleted_at", None) is not None
        ):
            raise Http404
        return view_func(request, *args, **kwargs)

    return _wrapped
