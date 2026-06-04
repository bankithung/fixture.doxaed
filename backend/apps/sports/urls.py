"""URL routes for the sports catalog (read-only in Phase 1A)."""
from __future__ import annotations

from django.urls import path

from apps.sports.views import SportDetailView, SportListView

app_name = "sports"

urlpatterns = [
    path("", SportListView.as_view(), name="sport-list"),
    path("<slug:code>/", SportDetailView.as_view(), name="sport-detail"),
]
