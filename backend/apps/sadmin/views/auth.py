"""Super-admin login / logout (HTML form, NOT API).

Trade-off: /sadmin/login/ MUST be public (otherwise no entry path for
the Super-admin), so the *login URL* itself is no longer hidden the way
the rest of /sadmin/ is. The dashboard and every other view beyond
login still 404 for non-Super-admins, preserving the §1.5 surface-hiding
invariant for everything past authentication.

The form posts to itself, calls Django's `authenticate`/`login`, cycles
the session key (B.11 fixation defense), and emits an audit row. Only
`is_superuser=True` users are accepted — regular users are rejected
with the same generic error to avoid existence enumeration.
"""
from __future__ import annotations

from django.contrib import messages as dj_messages
from django.contrib.auth import authenticate
from django.contrib.auth import login as django_login
from django.contrib.auth import logout as django_logout
from django.http import HttpRequest, HttpResponse, HttpResponseRedirect
from django.shortcuts import render
from django.urls import reverse
from django.views.decorators.http import require_http_methods, require_POST

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit


@require_http_methods(["GET", "POST"])
def sadmin_login(request: HttpRequest) -> HttpResponse:
    if request.user.is_authenticated and request.user.is_superuser:
        return HttpResponseRedirect(reverse("sadmin:dashboard"))

    error: str | None = None
    if request.method == "POST":
        email = (request.POST.get("email") or "").strip().lower()
        password = request.POST.get("password") or ""
        user = authenticate(request, username=email, password=password)
        if user is None or not user.is_active or not user.is_superuser:
            error = "Invalid credentials."
        else:
            django_login(request, user)
            request.session.cycle_key()
            emit_audit(
                actor_user=user,
                actor_role=ActorRole.SUPER_ADMIN,
                event_type="sadmin_login",
                target_type="user",
                target_id=user.id,
                request=request,
            )
            dj_messages.success(request, "Signed in.")
            next_url = request.GET.get("next") or reverse("sadmin:dashboard")
            return HttpResponseRedirect(next_url)

    return render(request, "sadmin/login.html", {"error": error})


@require_POST
def sadmin_logout(request: HttpRequest) -> HttpResponse:
    user = request.user if request.user.is_authenticated else None
    if user is not None and user.is_superuser:
        emit_audit(
            actor_user=user,
            actor_role=ActorRole.SUPER_ADMIN,
            event_type="sadmin_logout",
            target_type="user",
            target_id=user.id,
            request=request,
        )
    django_logout(request)
    return HttpResponseRedirect(reverse("sadmin:login"))
