"""Public Guest Lens routes (AllowAny) — mounted at ``/api/lens/`` from the
root urlconf. The manager tree lives in ``apps/tournaments/urls.py``; the
public album route sits next to the badges public routes in ``fixture/urls.py``.
"""
from __future__ import annotations

from django.urls import path

from apps.lens.views import (
    LensPassContextView,
    LensPassPhotoDetailView,
    LensPassPhotosView,
)

urlpatterns = [
    path("p/<str:token>/", LensPassContextView.as_view(), name="lens-pass-context"),
    path(
        "p/<str:token>/photos/",
        LensPassPhotosView.as_view(),
        name="lens-pass-photos",
    ),
    path(
        "p/<str:token>/photos/<uuid:upload_ref>/",
        LensPassPhotoDetailView.as_view(),
        name="lens-pass-photo-detail",
    ),
]
