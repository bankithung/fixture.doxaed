from __future__ import annotations

from django.urls import path

from apps.teams.views import PublicRegistrationView

# Mounted at /api/register/ — public school self-registration via shared link.
urlpatterns = [
    path("<str:token>/", PublicRegistrationView.as_view(), name="public-registration"),
]
