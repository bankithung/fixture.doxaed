"""permissions URL routes.

Mounted at /api/permissions/ from fixture/urls.py.
"""
from __future__ import annotations

from django.urls import path

from apps.permissions.views import (
    MatrixView,
    ModuleCatalogView,
    MyEffectiveModulesView,
    MyModulesBySlugView,
    UserGrantsBySlugView,
    UserGrantsView,
)

app_name = "permissions_app"

urlpatterns = [
    path("modules/", ModuleCatalogView.as_view(), name="module-catalog"),
    path("me/modules/", MyEffectiveModulesView.as_view(), name="my-modules"),
    # Existing UUID-routed per-user grants endpoint (preserved for back-compat).
    path(
        "orgs/<uuid:org_uuid>/users/<uuid:user_uuid>/grants/",
        UserGrantsView.as_view(),
        name="user-grants",
    ),
    # Slug aliases for the SPA. Order matters: the matrix path must come
    # BEFORE the catch-all `<str:slug>/...` patterns so it doesn't get
    # shadowed when slug happens to literally be "grants".
    path(
        "orgs/<slug:slug>/grants/matrix/",
        MatrixView.as_view(),
        name="matrix",
    ),
    path(
        "orgs/<slug:slug>/me/modules/",
        MyModulesBySlugView.as_view(),
        name="my-modules-by-slug",
    ),
    path(
        "orgs/<slug:slug>/users/<uuid:user_uuid>/grants/",
        UserGrantsBySlugView.as_view(),
        name="user-grants-by-slug",
    ),
]
